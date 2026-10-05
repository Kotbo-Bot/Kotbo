/**
 * Rejoue une règle de modération sur l'historique des messages du serveur.
 *
 * Ce qu'on veut savoir avant d'activer une règle, comme dans l'aperçu des
 * règles d'un pare-feu : combien de messages elle aurait touchés, lesquels,
 * chez qui, dans quels salons, et - quand on modifie une règle existante - ce
 * que le changement ajoute ou retire par rapport à la version en service.
 *
 * La lecture est bornée (nombre de messages et durée) : un gros serveur a des
 * centaines de milliers de messages par mois, et une simulation doit répondre
 * pendant que l'administrateur attend devant sa page.
 */
import { PermissionFlagsBits, type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { BucketZoner } from '../analytics/zonedBuckets.js';
import { getOrCreateAutoModConfig } from './autoModService.js';
import {
  APPROXIMATE_KINDS,
  compileRule,
  falsePositiveHint,
  findSpamBursts,
  type CompiledRule,
  type RuleMatch,
  type SimulatedMessage,
  type SimulatedRule,
} from './ruleSimulation.js';

export const MAX_SIMULATION_DAYS = 30;
export const MAX_SCANNED_MESSAGES = 100_000;
const BATCH = 5_000;
const TIME_BUDGET_MS = 20_000;
const SAMPLE_LIMIT = 50;
const TOP_LIMIT = 8;

interface LoadedMessage extends SimulatedMessage {
  channelName: string;
  authorName: string;
  authorAvatar: string | null;
  deleted: boolean;
}

export interface SimulationSample {
  messageId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
  deleted: boolean;
  detail: string;
  highlights: Array<[number, number]>;
  falsePositiveHint: string | null;
}

export interface SimulationResult {
  matched: number;
  authors: number;
  /** Part des messages analysés, en pourcentage. */
  share: number;
  byDay: Array<{ date: string; count: number }>;
  topChannels: Array<{ channelId: string; name: string; count: number }>;
  topAuthors: Array<{ userId: string; name: string; avatar: string | null; count: number; isStaff: boolean }>;
  samples: SimulationSample[];
  /** Exemples signalés comme faux positifs probables, sur tout le résultat. */
  falsePositiveHints: number;
}

export interface SimulationReport {
  window: { days: number; from: string; to: string; firstMessageAt: string | null };
  timezone: string;
  scanned: number;
  exempted: number;
  truncated: boolean;
  approximate: boolean;
  draft: SimulationResult;
  baseline: SimulationResult | null;
  diff: { added: number; removed: number; addedSamples: SimulationSample[]; removedSamples: SimulationSample[] } | null;
  durationMs: number;
}

interface Exemptions {
  channels: Set<string>;
  isExempt: (authorId: string) => boolean;
}

/**
 * Exemptions du filtre en service, appliquées avec les rôles d'aujourd'hui :
 * l'historique ne garde pas les rôles qu'avait l'auteur au moment du message.
 */
async function loadExemptions(client: Client, guildId: string, rule: SimulatedRule): Promise<Exemptions> {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const member = (authorId: string) => guild?.members.cache.get(authorId) ?? null;

  if (rule.kind === 'scam') {
    // Le filtre anti-arnaque laisse passer quiconque peut gérer les messages.
    return {
      channels: new Set(),
      isExempt: (authorId) => !!member(authorId)?.permissions.has(PermissionFlagsBits.ManageMessages),
    };
  }

  const config = await getOrCreateAutoModConfig(guildId);
  const bypassRoles = new Set(config.bypassRoles);
  return {
    channels: new Set(config.bypassChannels),
    isExempt: (authorId) => {
      const current = member(authorId);
      if (!current) return false;
      if (current.permissions.has(PermissionFlagsBits.Administrator)) return true;
      return current.roles.cache.some((role) => bypassRoles.has(role.id));
    },
  };
}

async function loadMessages(guildId: string, since: Date, startedAt: number): Promise<{ messages: LoadedMessage[]; truncated: boolean }> {
  const messages: LoadedMessage[] = [];
  let cursor: string | undefined;
  let truncated = false;

  // Du plus récent au plus ancien : si la borne coupe, ce sont les messages
  // les plus anciens qui manquent, pas la semaine qu'on vient de vivre.
  while (messages.length < MAX_SCANNED_MESSAGES) {
    const rows = await prisma.messageLog.findMany({
      where: { guildId, isBot: false, createdAt: { gte: since } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(BATCH, MAX_SCANNED_MESSAGES - messages.length),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, messageId: true, channelId: true, channelName: true, authorId: true, authorName: true,
        authorAvatar: true, content: true, mentionedUserIds: true, createdAt: true, deletedAt: true,
      },
    });
    for (const row of rows) {
      messages.push({
        messageId: row.messageId,
        channelId: row.channelId,
        channelName: row.channelName,
        authorId: row.authorId,
        authorName: row.authorName,
        authorAvatar: row.authorAvatar,
        content: row.content,
        mentionCount: row.mentionedUserIds.length,
        createdAt: row.createdAt,
        deleted: row.deletedAt !== null,
      });
    }
    if (rows.length < BATCH) break;
    cursor = rows[rows.length - 1].id;
    if (Date.now() - startedAt > TIME_BUDGET_MS / 2) {
      truncated = true;
      break;
    }
  }
  if (messages.length >= MAX_SCANNED_MESSAGES) truncated = true;

  messages.reverse();
  return { messages, truncated };
}

function evaluate(compiled: CompiledRule, messages: LoadedMessage[]): Map<string, RuleMatch> {
  if (compiled.rule.kind === 'spam') return findSpamBursts(messages, compiled.rule);
  const matches = new Map<string, RuleMatch>();
  for (const message of messages) {
    if (!message.content) continue;
    const match = compiled.test(message);
    if (match) matches.set(message.messageId, match);
  }
  return matches;
}

function toSample(message: LoadedMessage, match: RuleMatch, staff: Set<string>): SimulationSample {
  return {
    messageId: message.messageId,
    channelId: message.channelId,
    channelName: message.channelName,
    authorId: message.authorId,
    authorName: message.authorName,
    authorAvatar: message.authorAvatar,
    content: message.content.slice(0, 1_000),
    createdAt: message.createdAt.toISOString(),
    deleted: message.deleted,
    detail: match.detail,
    highlights: match.highlights.filter(([, end]) => end <= 1_000),
    falsePositiveHint: falsePositiveHint(message, match, staff.has(message.authorId)),
  };
}

function summarize(
  matches: Map<string, RuleMatch>,
  byId: Map<string, LoadedMessage>,
  scanned: number,
  dayKeys: string[],
  zoner: BucketZoner,
  staff: Set<string>,
): SimulationResult {
  const perDay = new Map(dayKeys.map((key) => [key, 0]));
  const perChannel = new Map<string, { name: string; count: number }>();
  const perAuthor = new Map<string, { name: string; avatar: string | null; count: number }>();
  const samples: SimulationSample[] = [];
  let hints = 0;

  // Du plus récent au plus ancien pour les exemples.
  const ordered = [...matches.entries()]
    .map(([id, match]) => ({ message: byId.get(id)!, match }))
    .filter((entry) => entry.message)
    .sort((a, b) => b.message.createdAt.getTime() - a.message.createdAt.getTime());

  for (const { message, match } of ordered) {
    const key = zoner.fromDate(message.createdAt).dateKey;
    if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1);

    const channel = perChannel.get(message.channelId) ?? { name: message.channelName, count: 0 };
    channel.count += 1;
    perChannel.set(message.channelId, channel);

    const author = perAuthor.get(message.authorId) ?? { name: message.authorName, avatar: message.authorAvatar, count: 0 };
    author.count += 1;
    perAuthor.set(message.authorId, author);

    const sample = toSample(message, match, staff);
    if (sample.falsePositiveHint) hints += 1;
    if (samples.length < SAMPLE_LIMIT) samples.push(sample);
  }

  return {
    matched: matches.size,
    authors: perAuthor.size,
    share: scanned > 0 ? Math.round((matches.size / scanned) * 10_000) / 100 : 0,
    byDay: [...perDay.entries()].map(([date, count]) => ({ date, count })),
    topChannels: [...perChannel.entries()]
      .map(([channelId, value]) => ({ channelId, name: value.name, count: value.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_LIMIT),
    topAuthors: [...perAuthor.entries()]
      .map(([userId, value]) => ({ userId, name: value.name, avatar: value.avatar, count: value.count, isStaff: staff.has(userId) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_LIMIT),
    samples,
    falsePositiveHints: hints,
  };
}

/**
 * Jours couverts par la fenêtre, dans le fuseau d'affichage, du plus ancien au
 * plus récent. Une fenêtre glissante de N jours touche N + 1 jours civils : le
 * premier, entamé, est gardé pour qu'aucun message analysé ne sorte du graphique.
 */
export function windowDayKeys(zoner: BucketZoner, days: number, now: Date): string[] {
  const keys = new Set<string>();
  for (let offset = days; offset >= 0; offset -= 1) {
    keys.add(zoner.fromDate(new Date(now.getTime() - offset * 86_400_000)).dateKey);
  }
  return [...keys];
}

export async function simulateRule(
  client: Client,
  guildId: string,
  draft: SimulatedRule,
  options: { days: number; baseline?: SimulatedRule | null; timezone: string },
): Promise<SimulationReport> {
  const startedAt = Date.now();
  const days = Math.min(MAX_SIMULATION_DAYS, Math.max(1, Math.trunc(options.days) || 7));
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);

  let scam: Parameters<typeof compileRule>[1];
  if (draft.kind === 'scam' || options.baseline?.kind === 'scam') {
    const [{ detectScam }, { getRaidProtectionConfig }] = await Promise.all([
      import('./scamFilterService.js'),
      import('./raidProtectionService.js'),
    ]);
    scam = { config: await getRaidProtectionConfig(guildId), detect: detectScam };
  }

  const [exemptions, staffRows, loaded] = await Promise.all([
    loadExemptions(client, guildId, draft),
    prisma.staffMember.findMany({ where: { guildId }, select: { userId: true } }),
    loadMessages(guildId, since, startedAt),
  ]);
  const staff = new Set(staffRows.map((row) => row.userId));

  let exempted = 0;
  const messages = loaded.messages.filter((message) => {
    const skip = exemptions.channels.has(message.channelId) || exemptions.isExempt(message.authorId);
    if (skip) exempted += 1;
    return !skip;
  });
  const byId = new Map(messages.map((message) => [message.messageId, message]));

  const zoner = new BucketZoner(options.timezone);
  const dayKeys = windowDayKeys(zoner, days, now);

  const draftMatches = evaluate(compileRule(draft, scam), messages);
  const baselineMatches = options.baseline ? evaluate(compileRule(options.baseline, scam), messages) : null;

  let diff: SimulationReport['diff'] = null;
  if (baselineMatches) {
    const added = [...draftMatches.keys()].filter((id) => !baselineMatches.has(id));
    const removed = [...baselineMatches.keys()].filter((id) => !draftMatches.has(id));
    const recentFirst = (ids: string[], source: Map<string, RuleMatch>) => ids
      .map((id) => byId.get(id)!)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 20)
      .map((message) => toSample(message, source.get(message.messageId)!, staff));
    diff = {
      added: added.length,
      removed: removed.length,
      addedSamples: recentFirst(added, draftMatches),
      removedSamples: recentFirst(removed, baselineMatches),
    };
  }

  const report: SimulationReport = {
    window: {
      days,
      from: since.toISOString(),
      to: now.toISOString(),
      firstMessageAt: loaded.messages[0]?.createdAt.toISOString() ?? null,
    },
    timezone: options.timezone,
    scanned: messages.length,
    exempted,
    truncated: loaded.truncated,
    approximate: APPROXIMATE_KINDS.has(draft.kind),
    draft: summarize(draftMatches, byId, messages.length, dayKeys, zoner, staff),
    baseline: baselineMatches ? summarize(baselineMatches, byId, messages.length, dayKeys, zoner, staff) : null,
    diff,
    durationMs: Date.now() - startedAt,
  };

  logger.debug('RuleSimulation', `${guildId} ${draft.kind} : ${report.draft.matched}/${report.scanned} en ${report.durationMs} ms`);
  return report;
}
