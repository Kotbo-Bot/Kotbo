/**
 * Automod des tags : applique les règles posées sur le tag de serveur affiché
 * par un membre, détecte les vagues d'arrivées et les adoptions en masse d'un
 * même tag, programme les escalades et alimente la liste partagée entre les
 * serveurs Kotbo.
 *
 * La décision elle-même (quelle règle, quelle action) vit dans tagRules.ts ;
 * ce module la lit, agit sur Discord et note tout au journal.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
} from 'discord.js';
import type { TagAutomodConfig, TagAutomodRule } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { getCachedGuild } from '../../../utils/cache.js';
import { resolveLogChannel } from '../../../utils/logChannel.js';
import { resolveGuildLocale, type BotLocale } from '../../../utils/i18n.js';
import { extractPrimaryGuildTag, guildIconUrl } from '../../core/serverTagService.js';
import { applyAutoSanction, autoSanctionLabel, formatMinutes } from '../autoSanction.js';
import { getActiveJail, releaseJail } from '../jailService.js';
import { createTicketWorkspace, resolveTicketPanelType } from '../../features/ticketService.js';
import {
  decideTag,
  isAllowed,
  isSanctionAction,
  normalizeTagAction,
  renderTagMessage,
  ruleMatches,
  waveThreshold,
  type DisplayedTag,
  type RuleLike,
  type TagAction,
  type TagHit,
  type TagTrigger,
} from './tagRules.js';

// ── Textes envoyés sur Discord ──────────────────────────────────────────────

const TEXT = {
  fr: {
    alertTitle: 'Automod des tags',
    testSuffix: ' · mode test, rien appliqué',
    member: 'Membre',
    tag: 'Tag',
    server: 'Serveur du tag',
    trigger: 'Déclencheur',
    action: 'Action',
    rule: 'Règle',
    escalation: 'Escalade',
    escalationValue: (action: string, delay: string) => `${action} dans ${delay} si le tag est toujours là`,
    fleet: (n: number) => `Bloqué par ${n} serveur${n > 1 ? 's' : ''} Kotbo`,
    failed: '⚠️ Action impossible (permissions ou hiérarchie des rôles)',
    waveTitle: (n: number, tag: string) => `Vague de ${n} arrivées avec le tag ${tag}`,
    adoptTitle: (n: number, tag: string) => `${n} membres ont pris le tag ${tag}`,
    waveDesc: (action: string, block: string) => `Action appliquée : **${action}**.${block}`,
    waveBlock: (h: number) => ` Le tag est bloqué pendant ${h} h.`,
    banAll: 'Tout bannir',
    ignore: 'Ignorer et lever',
    blockForever: 'Bloquer définitivement',
    ticketReason: (tag: string) => `Tag ${tag} non autorisé`,
    defaultTicket: 'Bonjour {user}, ton profil affiche le tag **{tag}** ({server}), qui n\'est pas autorisé ici. Merci de le retirer de ton profil.',
    defaultDm: 'Bonjour, sur ce serveur le tag **{tag}** ({server}) n\'est pas autorisé. Merci de le retirer de ton profil.',
    delayNone: 'dès que possible',
    reason: (label: string, tag: string) => `Automod des tags : ${label} (${tag})`,
    released: 'Tag retiré : quarantaine levée.',
    noPerm: 'Tu n\'as pas les permissions nécessaires.',
    waveGone: 'Cette vague n\'existe plus.',
    done: (n: number) => `C'est fait pour ${n} membre${n > 1 ? 's' : ''}.`,
    statusBanned: (who: string) => `Vague bannie par ${who}`,
    statusIgnored: (who: string) => `Vague ignorée par ${who}`,
    statusBlocked: (who: string) => `Tag bloqué définitivement par ${who}`,
  },
  en: {
    alertTitle: 'Tag automod',
    testSuffix: ' · test mode, nothing applied',
    member: 'Member',
    tag: 'Tag',
    server: 'Tag server',
    trigger: 'Trigger',
    action: 'Action',
    rule: 'Rule',
    escalation: 'Escalation',
    escalationValue: (action: string, delay: string) => `${action} in ${delay} if the tag is still there`,
    fleet: (n: number) => `Blocked by ${n} Kotbo server${n > 1 ? 's' : ''}`,
    failed: '⚠️ Action not possible (permissions or role hierarchy)',
    waveTitle: (n: number, tag: string) => `Wave of ${n} joins with the ${tag} tag`,
    adoptTitle: (n: number, tag: string) => `${n} members took the ${tag} tag`,
    waveDesc: (action: string, block: string) => `Action applied: **${action}**.${block}`,
    waveBlock: (h: number) => ` The tag is blocked for ${h} h.`,
    banAll: 'Ban everyone',
    ignore: 'Ignore and lift',
    blockForever: 'Block permanently',
    ticketReason: (tag: string) => `Tag ${tag} not allowed`,
    defaultTicket: 'Hi {user}, your profile shows the **{tag}** tag ({server}), which is not allowed here. Please remove it from your profile.',
    defaultDm: 'Hi, the **{tag}** tag ({server}) is not allowed on this server. Please remove it from your profile.',
    delayNone: 'as soon as possible',
    reason: (label: string, tag: string) => `Tag automod: ${label} (${tag})`,
    released: 'Tag removed: quarantine lifted.',
    noPerm: 'You do not have the required permissions.',
    waveGone: 'This wave no longer exists.',
    done: (n: number) => `Done for ${n} member${n > 1 ? 's' : ''}.`,
    statusBanned: (who: string) => `Wave banned by ${who}`,
    statusIgnored: (who: string) => `Wave ignored by ${who}`,
    statusBlocked: (who: string) => `Tag permanently blocked by ${who}`,
  },
} as const;

const TRIGGER_LABELS: Record<BotLocale, Record<TagTrigger, string>> = {
  fr: {
    JOIN: 'Arrivée', TAG_CHANGE: 'Changement de tag', RESCAN: 'Analyse du serveur', WAVE: 'Vague d\'arrivées',
    NEW_ACCOUNT: 'Compte récent', MASS_ADOPT: 'Adoption en masse', IMPERSONATION: 'Imitation du tag du serveur',
    SHARED_LIST: 'Liste partagée Kotbo', ALLOWLIST: 'Tag hors liste blanche', ESCALATION: 'Escalade',
  },
  en: {
    JOIN: 'Join', TAG_CHANGE: 'Tag change', RESCAN: 'Server scan', WAVE: 'Join wave',
    NEW_ACCOUNT: 'New account', MASS_ADOPT: 'Mass adoption', IMPERSONATION: 'Server tag impersonation',
    SHARED_LIST: 'Kotbo shared list', ALLOWLIST: 'Tag outside the allowlist', ESCALATION: 'Escalation',
  },
};

const ACTION_LABELS: Record<BotLocale, Record<'ALERT' | 'DM' | 'TICKET' | 'ROLE', string>> = {
  fr: { ALERT: 'Alerte au staff', DM: 'Message privé', TICKET: 'Ticket ouvert', ROLE: 'Rôle ajouté' },
  en: { ALERT: 'Staff alert', DM: 'Direct message', TICKET: 'Ticket opened', ROLE: 'Role added' },
};

export function tagActionLabel(action: TagAction, durationMin: number | null, locale: BotLocale): string {
  if (action === 'ALERT' || action === 'DM' || action === 'TICKET' || action === 'ROLE') return ACTION_LABELS[locale][action];
  // Les libellés de sanction sont ceux de l'Automod (français) : repris tels quels en français.
  if (locale === 'fr') return autoSanctionLabel(action, durationMin);
  const d = durationMin ? ` ${formatMinutes(durationMin)}` : '';
  return { WARN: 'Warning', TIMEOUT: `Timeout${d}`, KICK: 'Kick', SOFTBAN: 'Softban', BAN: `Ban${d}`, JAIL: `Quarantine${d}` }[action];
}

// ── État par serveur (cache 60 s) ───────────────────────────────────────────

type GuildState = { config: TagAutomodConfig | null; rules: TagAutomodRule[]; ownTag: string | null; at: number };
const STATE_TTL_MS = 60_000;
const stateCache = new Map<string, GuildState>();

export function invalidateTagAutomod(guildId: string): void {
  stateCache.delete(guildId);
}

export async function getTagAutomodState(guildId: string): Promise<GuildState> {
  const cached = stateCache.get(guildId);
  if (cached && Date.now() - cached.at < STATE_TTL_MS) return cached;
  const [config, rules, own] = await Promise.all([
    prisma.tagAutomodConfig.findUnique({ where: { guildId } }).catch(() => null),
    prisma.tagAutomodRule.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }).catch(() => []),
    prisma.discordExternalGuild.findUnique({ where: { guildId }, select: { tag: true } }).catch(() => null),
  ]);
  const state = { config, rules, ownTag: own?.tag ?? null, at: Date.now() };
  stateCache.set(guildId, state);
  return state;
}

// ── Liste partagée de la flotte ─────────────────────────────────────────────

/** Nombre de serveurs Kotbo distincts qui doivent signaler un serveur pour qu'il entre dans la liste partagée. */
export const FLEET_MIN_REPORTERS = 3;
const FLEET_TTL_MS = 10 * 60_000;
let fleetCache: { counts: Map<string, number>; at: number } | null = null;

/**
 * Pour chaque serveur, nombre de serveurs Kotbo qui l'ont bloqué (règle
 * « bloquer ce serveur » posée à la main) ou qui y ont subi une vague.
 */
export async function getFleetTagCounts(): Promise<Map<string, number>> {
  if (fleetCache && Date.now() - fleetCache.at < FLEET_TTL_MS) return fleetCache.counts;
  const rows = await prisma.$queryRaw<Array<{ tagGuildId: string; n: number }>>`
    SELECT s."tagGuildId", COUNT(DISTINCT s.g)::int AS n FROM (
      SELECT "tagGuildId", "reporterGuildId" AS g FROM "tag_risk_reports"
      UNION
      SELECT "targetGuildId" AS "tagGuildId", "guildId" AS g FROM "tag_automod_rules"
       WHERE "targetType" = 'SERVER' AND "effect" = 'BLOCK' AND "enabled" = true
         AND "targetGuildId" IS NOT NULL AND "source" <> 'WAVE'
    ) s GROUP BY s."tagGuildId"
  `.catch(() => []);
  const counts = new Map(rows.map((r) => [r.tagGuildId, Number(r.n)]));
  fleetCache = { counts, at: Date.now() };
  return counts;
}

export async function isFleetFlagged(tagGuildId: string): Promise<boolean> {
  return ((await getFleetTagCounts()).get(tagGuildId) ?? 0) >= FLEET_MIN_REPORTERS;
}

async function reportToFleet(tagGuildId: string, reporterGuildId: string): Promise<void> {
  await prisma.tagRiskReport.upsert({
    where: { tagGuildId_reporterGuildId_kind: { tagGuildId, reporterGuildId, kind: 'WAVE' } },
    create: { tagGuildId, reporterGuildId, kind: 'WAVE' },
    update: { count: { increment: 1 }, lastAt: new Date() },
  }).catch((err) => logger.debug('TagAutomod', `Signalement flotte impossible: ${String(err)}`));
  fleetCache = null;
}

// ── Outils ──────────────────────────────────────────────────────────────────

export function displayedTag(member: GuildMember): DisplayedTag | null {
  const extracted = extractPrimaryGuildTag(member.user as never);
  return extracted ? { guildId: extracted.guildId, tag: extracted.tag } : null;
}

function isExempt(member: GuildMember, config: TagAutomodConfig): boolean {
  if (member.user.bot || member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (config.exemptUserIds.includes(member.id)) return true;
  return config.exemptRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

const externalNameCache = new Map<string, { name: string | null; icon: string | null; at: number }>();
async function tagServerInfo(guildId: string): Promise<{ name: string | null; iconUrl: string | null }> {
  const cached = externalNameCache.get(guildId);
  if (cached && Date.now() - cached.at < 3_600_000) return { name: cached.name, iconUrl: cached.icon };
  const row = await prisma.discordExternalGuild.findUnique({ where: { guildId }, select: { name: true, icon: true } }).catch(() => null);
  const info = { name: row?.name ?? null, icon: guildIconUrl(guildId, row?.icon) };
  if (externalNameCache.size > 5000) externalNameCache.clear();
  externalNameCache.set(guildId, { ...info, at: Date.now() });
  return { name: info.name, iconUrl: info.icon };
}

async function alertChannel(guild: Guild, config: TagAutomodConfig | null) {
  const fallback = (await getCachedGuild(guild.id))?.logChannelId;
  return resolveLogChannel(guild, config?.alertChannelId ?? fallback, 'TagAutomod');
}

async function recentTicketExists(guildId: string, userId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const n = await prisma.tagAutomodEvent.count({
    where: { guildId, userId, action: 'TICKET', status: { in: ['APPLIED', 'PENDING'] }, createdAt: { gte: since } },
  }).catch(() => 0);
  return n > 0;
}

async function openTagTicket(member: GuildMember, reason: string, description: string): Promise<void> {
  const guildConfig = await prisma.guild.findUnique({ where: { id: member.guild.id } });
  if (!guildConfig) throw new Error('guild config missing');
  const locale = await resolveGuildLocale(member.guild.id, member.guild.preferredLocale);
  await createTicketWorkspace(member.client, {
    guild: member.guild,
    user: { id: member.id, username: member.user.username },
    ticketType: resolveTicketPanelType(guildConfig as unknown as Record<string, unknown>, null),
    guildConfig,
    reason,
    description,
    locale,
  });
}

// ── Application d'une décision ──────────────────────────────────────────────

type ApplyOptions = { dryRun?: boolean; silent?: boolean; waveId?: string | null; allowEscalation?: boolean };

/** Applique une décision à un membre et la note au journal. Ne lève jamais. */
export async function applyTagHit(
  member: GuildMember,
  tag: DisplayedTag,
  hit: TagHit,
  config: TagAutomodConfig,
  opts: ApplyOptions = {},
): Promise<'APPLIED' | 'DRY_RUN' | 'PENDING' | 'FAILED' | 'SKIPPED'> {
  const guild = member.guild;
  const locale = await resolveGuildLocale(guild.id, guild.preferredLocale);
  const t = TEXT[locale];
  const server = await tagServerInfo(tag.guildId);
  const tagText = tag.tag ?? '?';
  const label = tagActionLabel(hit.action, hit.durationMin, locale);
  const dry = opts.dryRun || config.testMode;
  const escalate = opts.allowEscalation !== false && hit.escalateAfterMin && hit.escalateAction && !['KICK', 'SOFTBAN', 'BAN'].includes(hit.action);
  const vars = {
    user: `<@${member.id}>`,
    tag: tagText,
    server: server.name ?? tag.guildId,
    delay: hit.escalateAfterMin ? formatMinutes(hit.escalateAfterMin) : t.delayNone,
  };

  let status: 'APPLIED' | 'DRY_RUN' | 'PENDING' | 'FAILED' | 'SKIPPED' = dry ? 'DRY_RUN' : 'APPLIED';
  if (!dry) {
    try {
      switch (hit.action) {
        case 'ALERT':
          break;
        case 'DM':
          await member.send(renderTagMessage(hit.message || t.defaultDm, vars)).catch(() => null);
          break;
        case 'TICKET':
          if (await recentTicketExists(guild.id, member.id)) status = 'SKIPPED';
          else await openTagTicket(member, t.ticketReason(tagText), renderTagMessage(hit.message || t.defaultTicket, vars));
          break;
        case 'ROLE':
          if (!hit.roleId) status = 'FAILED';
          else await member.roles.add(hit.roleId, t.reason(label, tagText));
          break;
        default: {
          const result = await applyAutoSanction({
            client: member.client,
            guild,
            user: member.user,
            member,
            action: hit.action,
            durationMin: hit.durationMin,
            reason: t.reason(label, tagText),
            jailSource: 'TAG_AUTOMOD',
          });
          if (!result.done) status = 'FAILED';
        }
      }
    } catch (err) {
      logger.warn('TagAutomod', `${hit.action} impossible pour ${member.id} (${guild.id}): ${String(err)}`);
      status = 'FAILED';
    }
    if (status === 'APPLIED' && escalate) status = 'PENDING';
  }

  await prisma.tagAutomodEvent.create({
    data: {
      guildId: guild.id,
      userId: member.id,
      userTag: member.user.tag,
      tagGuildId: tag.guildId,
      tag: tag.tag,
      trigger: hit.trigger,
      ruleId: hit.rule?.id ?? null,
      waveId: opts.waveId ?? null,
      action: hit.action,
      status,
      detail: hit.rule?.name ?? null,
      dueAt: status === 'PENDING' ? new Date(Date.now() + hit.escalateAfterMin! * 60_000) : null,
      escalateAction: escalate ? hit.escalateAction : null,
      escalateDurationMin: escalate ? hit.escalateDurationMin : null,
    },
  }).catch((err) => logger.debug('TagAutomod', `Journal impossible: ${String(err)}`));

  if (!opts.silent) {
    const fleetCount = (await getFleetTagCounts()).get(tag.guildId) ?? 0;
    const embed = new EmbedBuilder()
      .setColor(status === 'FAILED' ? 0xef4444 : dry ? 0x94a3b8 : isSanctionAction(hit.action) ? 0xf97316 : 0x6366f1)
      .setTitle(`${t.alertTitle}${dry ? t.testSuffix : ''}`)
      .addFields(
        { name: t.member, value: `<@${member.id}> \`${member.user.tag}\``, inline: false },
        { name: t.tag, value: `\`${tagText}\``, inline: true },
        { name: t.server, value: server.name ?? `\`${tag.guildId}\``, inline: true },
        { name: t.trigger, value: TRIGGER_LABELS[locale][hit.trigger], inline: true },
        { name: t.action, value: label, inline: true },
      )
      .setThumbnail(member.displayAvatarURL())
      .setTimestamp();
    if (hit.rule) embed.addFields({ name: t.rule, value: hit.rule.name, inline: true });
    if (escalate) embed.addFields({ name: t.escalation, value: t.escalationValue(tagActionLabel(hit.escalateAction!, hit.escalateDurationMin, locale), formatMinutes(hit.escalateAfterMin!)), inline: false });
    if (fleetCount > 0) embed.setFooter({ text: t.fleet(fleetCount) });
    if (status === 'FAILED') embed.setDescription(t.failed);
    const channel = await alertChannel(guild, config);
    await channel?.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  }
  return status;
}

/** Le tag ne pose plus de problème : on lève la quarantaine de l'automod et on clôt les escalades en attente. */
async function releaseCleared(member: GuildMember): Promise<void> {
  await prisma.tagAutomodEvent.updateMany({
    where: { guildId: member.guild.id, userId: member.id, status: 'PENDING' },
    data: { status: 'RESOLVED', dueAt: null },
  }).catch(() => null);
  const jail = await getActiveJail(member.guild.id, member.id).catch(() => null);
  if (jail?.source === 'TAG_AUTOMOD') {
    const locale = await resolveGuildLocale(member.guild.id, member.guild.preferredLocale);
    await releaseJail(member.client, member.guild.id, member.id, { note: TEXT[locale].released, onlySource: 'TAG_AUTOMOD' }).catch(() => null);
  }
}

// ── Vagues ──────────────────────────────────────────────────────────────────

type Entry = { userId: string; at: number };
const windows = new Map<string, Entry[]>();
const openWaves = new Map<string, { id: string; at: number }>();
const joinRateCache = new Map<string, { perDay: number; at: number }>();

async function joinsPerDay(guildId: string): Promise<number> {
  const cached = joinRateCache.get(guildId);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.perDay;
  const since = new Date(Date.now() - 7 * 86_400_000);
  const n = await prisma.memberInvite.count({ where: { guildId, joinedAt: { gte: since } } }).catch(() => 0);
  const perDay = n / 7;
  joinRateCache.set(guildId, { perDay, at: Date.now() });
  return perDay;
}

function pushWindow(key: string, userId: string, windowMs: number): Entry[] {
  const now = Date.now();
  const list = (windows.get(key) ?? []).filter((e) => now - e.at < windowMs && e.userId !== userId);
  list.push({ userId, at: now });
  if (windows.size > 10_000) windows.clear();
  windows.set(key, list);
  return list;
}

async function sendWaveAlert(guild: Guild, config: TagAutomodConfig, waveId: string, kind: 'ARRIVALS' | 'MASS_ADOPT', tag: DisplayedTag, userIds: string[], action: TagAction, durationMin: number | null): Promise<void> {
  const locale = await resolveGuildLocale(guild.id, guild.preferredLocale);
  const t = TEXT[locale];
  const tagText = tag.tag ?? '?';
  const server = await tagServerInfo(tag.guildId);
  const blocked = kind === 'ARRIVALS' && config.waveBlockHours > 0;
  const list = userIds.slice(0, 40).map((id) => `<@${id}>`).join(' ');
  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(kind === 'ARRIVALS' ? t.waveTitle(userIds.length, tagText) : t.adoptTitle(userIds.length, tagText))
    .setDescription(`${config.testMode ? `${t.testSuffix.replace(/^ · /, '')}\n` : ''}${t.waveDesc(tagActionLabel(action, durationMin, locale), blocked ? t.waveBlock(config.waveBlockHours) : '')}\n\n${list}${userIds.length > 40 ? ` +${userIds.length - 40}` : ''}`)
    .addFields({ name: t.server, value: server.name ?? `\`${tag.guildId}\``, inline: true })
    .setTimestamp();
  if (server.iconUrl) embed.setThumbnail(server.iconUrl);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tagwave:ban:${waveId}`).setLabel(t.banAll).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tagwave:block:${waveId}`).setLabel(t.blockForever).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`tagwave:ignore:${waveId}`).setLabel(t.ignore).setStyle(ButtonStyle.Secondary),
  );
  const channel = await alertChannel(guild, config);
  const message = await channel?.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
  if (message) {
    await prisma.tagWave.update({ where: { id: waveId }, data: { alertChannelId: message.channelId, alertMessageId: message.id } }).catch(() => null);
  }
}

async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

/**
 * Suit les arrivées (ou les adoptions) d'un même tag. Renvoie true quand le
 * membre a été traité par une vague, pour ne pas lui appliquer aussi la règle
 * individuelle.
 */
async function trackWave(member: GuildMember, tag: DisplayedTag, state: GuildState, kind: 'ARRIVALS' | 'MASS_ADOPT'): Promise<boolean> {
  const config = state.config!;
  if (kind === 'ARRIVALS' && !config.waveEnabled) return false;
  if (kind === 'MASS_ADOPT' && !config.massAdoptEnabled) return false;
  if (isAllowed(state.rules, tag)) return false;

  const { threshold, windowSec } = kind === 'ARRIVALS'
    ? waveThreshold(config, await joinsPerDay(member.guild.id))
    : { threshold: Math.max(2, config.massAdoptThreshold), windowSec: Math.max(1, config.massAdoptWindowMin) * 60 };
  const action = normalizeTagAction(kind === 'ARRIVALS' ? config.waveAction : config.massAdoptAction);
  const durationMin = kind === 'ARRIVALS' ? config.waveDurationMin : null;
  const trigger: TagTrigger = kind === 'ARRIVALS' ? 'WAVE' : 'MASS_ADOPT';
  const key = `${kind}:${member.guild.id}:${tag.guildId}`;
  const windowMs = windowSec * 1000;
  const entries = pushWindow(key, member.id, windowMs);
  const hitFor = (): TagHit => ({ trigger, action, durationMin, rule: null, roleId: null, message: null, escalateAfterMin: null, escalateAction: null, escalateDurationMin: null });

  // Vague déjà ouverte : le retardataire la rejoint.
  const open = openWaves.get(key);
  if (open && Date.now() - open.at < windowMs * 3) {
    await prisma.tagWave.update({ where: { id: open.id }, data: { userIds: { push: member.id } } }).catch(() => null);
    await applyTagHit(member, tag, hitFor(), config, { silent: true, waveId: open.id, allowEscalation: false });
    return true;
  }
  if (entries.length < threshold) return false;

  const userIds = entries.map((e) => e.userId);
  const wave = await prisma.tagWave.create({
    data: { guildId: member.guild.id, tagGuildId: tag.guildId, tag: tag.tag, userIds, kind },
  });
  openWaves.set(key, { id: wave.id, at: Date.now() });
  windows.delete(key);

  for (const userId of userIds) {
    const target = userId === member.id ? member : await fetchMember(member.guild, userId);
    if (target && !isExempt(target, config)) {
      await applyTagHit(target, tag, hitFor(), config, { silent: true, waveId: wave.id, allowEscalation: false });
    }
  }

  if (kind === 'ARRIVALS' && !config.testMode) {
    if (config.waveBlockHours > 0) {
      const server = await tagServerInfo(tag.guildId);
      await prisma.tagAutomodRule.create({
        data: {
          guildId: member.guild.id,
          name: `${tag.tag ?? tag.guildId} (vague)`,
          targetType: 'SERVER',
          targetGuildId: tag.guildId,
          targetName: server.name,
          targetIcon: server.iconUrl,
          action,
          durationMin,
          expiresAt: new Date(Date.now() + config.waveBlockHours * 3_600_000),
          source: 'WAVE',
        },
      }).catch(() => null);
      invalidateTagAutomod(member.guild.id);
    }
    if (config.waveReportFleet) await reportToFleet(tag.guildId, member.guild.id);
  }

  await sendWaveAlert(member.guild, config, wave.id, kind, tag, userIds, action, durationMin);
  return true;
}

// ── Points d'entrée ─────────────────────────────────────────────────────────

/**
 * Évalue un membre à son arrivée ou au changement de son tag. Sans tag (ou
 * avec un tag redevenu acceptable), lève ce que l'automod avait posé.
 */
export async function evaluateTagMember(member: GuildMember, trigger: 'JOIN' | 'TAG_CHANGE'): Promise<void> {
  const state = await getTagAutomodState(member.guild.id);
  const config = state.config;
  if (!config?.enabled) return;
  if (trigger === 'JOIN' && !config.onJoin) return;
  if (trigger === 'TAG_CHANGE' && !config.onTagChange) return;

  const tag = displayedTag(member);
  if (!tag) {
    if (trigger === 'TAG_CHANGE') await releaseCleared(member);
    return;
  }
  if (isExempt(member, config) || tag.guildId === member.guild.id) return;

  if (await trackWave(member, tag, state, trigger === 'JOIN' ? 'ARRIVALS' : 'MASS_ADOPT')) return;

  const hit = decideTag(config, state.rules, {
    tag,
    trigger,
    ownGuildId: member.guild.id,
    ownTag: state.ownTag,
    accountAgeDays: (Date.now() - member.user.createdTimestamp) / 86_400_000,
    sharedFlagged: config.sharedListEnabled ? await isFleetFlagged(tag.guildId) : false,
  });
  if (!hit) {
    if (trigger === 'TAG_CHANGE') await releaseCleared(member);
    return;
  }
  await applyTagHit(member, tag, hit, config);
}

/** Escalades arrivées à échéance et blocages temporaires expirés. */
export async function runTagAutomodSweep(client: Client): Promise<void> {
  const expired = await prisma.tagAutomodRule.findMany({
    where: { source: 'WAVE', expiresAt: { lt: new Date() } },
    select: { id: true, guildId: true },
  }).catch(() => []);
  if (expired.length) {
    await prisma.tagAutomodRule.deleteMany({ where: { id: { in: expired.map((r) => r.id) } } }).catch(() => null);
    for (const r of expired) invalidateTagAutomod(r.guildId);
  }

  const due = await prisma.tagAutomodEvent.findMany({
    where: { status: 'PENDING', dueAt: { lte: new Date() } },
    take: 50,
    orderBy: { dueAt: 'asc' },
  }).catch(() => []);
  for (const event of due) {
    const guild = client.guilds.cache.get(event.guildId);
    const member = guild ? await fetchMember(guild, event.userId) : null;
    const state = guild ? await getTagAutomodState(guild.id) : null;
    const rule = state?.rules.find((r) => r.id === event.ruleId) as RuleLike | undefined;
    const tag = member ? displayedTag(member) : null;
    const stillThere = Boolean(member && tag && state?.config?.enabled && (!rule || ruleMatches(rule, tag)));
    await prisma.tagAutomodEvent.update({ where: { id: event.id }, data: { status: stillThere ? 'APPLIED' : 'RESOLVED', dueAt: null } }).catch(() => null);
    if (!stillThere || !member || !tag || !state?.config || !event.escalateAction) continue;
    await applyTagHit(member, tag, {
      trigger: 'ESCALATION',
      action: normalizeTagAction(event.escalateAction),
      durationMin: event.escalateDurationMin,
      rule: rule ?? null,
      roleId: null,
      message: null,
      escalateAfterMin: null,
      escalateAction: null,
      escalateDurationMin: null,
    }, state.config, { allowEscalation: false });
  }
}

// ── Analyse du serveur ──────────────────────────────────────────────────────

export type TagScanMatch = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  tag: string | null;
  tagGuildId: string;
  action: TagAction;
  trigger: TagTrigger;
  ruleName: string | null;
};

const MAX_SCAN = 50_000;

async function scanTargets(guild: Guild): Promise<GuildMember[]> {
  const members = guild.memberCount <= MAX_SCAN
    ? await guild.members.fetch().catch(() => guild.members.cache)
    : guild.members.cache;
  return [...members.values()].filter((m) => !m.user.bot).slice(0, MAX_SCAN);
}

/**
 * Passe tous les membres au crible. Avec `draft`, ne teste que cette règle
 * (aperçu de l'assistant) ; sinon applique la configuration enregistrée.
 */
export async function scanTagMembers(guild: Guild, draft?: RuleLike): Promise<{ scanned: number; withTag: number; matches: TagScanMatch[] }> {
  const state = await getTagAutomodState(guild.id);
  const config = state.config;
  const members = await scanTargets(guild);
  const matches: TagScanMatch[] = [];
  let withTag = 0;
  for (const member of members) {
    const tag = displayedTag(member);
    if (!tag || tag.guildId === guild.id) continue;
    withTag++;
    if (config && isExempt(member, config)) continue;
    let action: TagAction | null = null;
    let trigger: TagTrigger = 'RESCAN';
    let ruleName: string | null = null;
    if (draft) {
      if (ruleMatches({ ...draft, enabled: true, expiresAt: null }, tag)) action = normalizeTagAction(draft.action);
      ruleName = draft.name;
    } else if (config) {
      const hit = decideTag(config, state.rules, {
        tag,
        trigger: 'RESCAN',
        ownGuildId: guild.id,
        ownTag: state.ownTag,
        accountAgeDays: (Date.now() - member.user.createdTimestamp) / 86_400_000,
        sharedFlagged: config.sharedListEnabled ? await isFleetFlagged(tag.guildId) : false,
      });
      if (hit) {
        action = hit.action;
        trigger = hit.trigger;
        ruleName = hit.rule?.name ?? null;
      }
    }
    if (!action) continue;
    matches.push({
      userId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      avatarUrl: member.displayAvatarURL({ size: 64 }),
      tag: tag.tag,
      tagGuildId: tag.guildId,
      action,
      trigger,
      ruleName,
    });
  }
  return { scanned: members.length, withTag, matches };
}

/** Applique la configuration à tous les membres concernés, en arrière-plan. */
export async function applyTagRescan(guild: Guild): Promise<number> {
  const state = await getTagAutomodState(guild.id);
  const config = state.config;
  if (!config) return 0;
  const { matches } = await scanTagMembers(guild);
  void (async () => {
    for (const match of matches) {
      const member = await fetchMember(guild, match.userId);
      const tag = member ? displayedTag(member) : null;
      if (!member || !tag) continue;
      const hit = decideTag(config, state.rules, {
        tag,
        trigger: 'RESCAN',
        ownGuildId: guild.id,
        ownTag: state.ownTag,
        accountAgeDays: (Date.now() - member.user.createdTimestamp) / 86_400_000,
        sharedFlagged: config.sharedListEnabled ? await isFleetFlagged(tag.guildId) : false,
      });
      if (hit) await applyTagHit(member, tag, { ...hit, trigger: 'RESCAN' }, config);
      await new Promise((r) => setTimeout(r, 400));
    }
  })().catch((err) => logger.warn('TagAutomod', `Analyse interrompue sur ${guild.id}: ${String(err)}`));
  return matches.length;
}

// ── Boutons des alertes de vague ────────────────────────────────────────────

export async function handleTagWaveButton(interaction: ButtonInteraction<'cached'>): Promise<void> {
  const [, op, waveId] = interaction.customId.split(':');
  const locale = await resolveGuildLocale(interaction.guild.id, interaction.guild.preferredLocale);
  const t = TEXT[locale];
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const needed = op === 'ban' ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.ModerateMembers;
  if (!interaction.memberPermissions?.has(needed)) {
    await interaction.editReply({ content: t.noPerm });
    return;
  }
  const wave = await prisma.tagWave.findFirst({ where: { id: waveId, guildId: interaction.guild.id } }).catch(() => null);
  if (!wave) {
    await interaction.editReply({ content: t.waveGone });
    return;
  }
  const guild = interaction.guild;
  let done = 0;

  if (op === 'ban') {
    for (const userId of wave.userIds) {
      const member = await fetchMember(guild, userId);
      if (member && !member.bannable) continue;
      const ok = await guild.members.ban(userId, { deleteMessageSeconds: 3600, reason: t.reason('Ban', wave.tag ?? '?') }).then(() => true).catch(() => false);
      if (!ok) continue;
      done++;
      const { registerBanSanction } = await import('../sanctionService.js');
      await registerBanSanction({
        guildId: guild.id,
        target: { id: userId, tag: member?.user.tag ?? userId },
        moderator: { id: interaction.user.id, tag: interaction.user.tag },
        reason: t.reason('Ban', wave.tag ?? '?'),
        client: guild.client,
      }).catch(() => null);
    }
    await prisma.tagWave.update({ where: { id: wave.id }, data: { status: 'SANCTIONED' } }).catch(() => null);
  } else if (op === 'ignore') {
    for (const userId of wave.userIds) {
      const member = await fetchMember(guild, userId);
      const jail = await getActiveJail(guild.id, userId).catch(() => null);
      if (jail?.source === 'TAG_AUTOMOD') await releaseJail(guild.client, guild.id, userId, { note: t.statusIgnored(interaction.user.tag), onlySource: 'TAG_AUTOMOD' }).catch(() => null);
      if (member?.isCommunicationDisabled() && member.moderatable) await member.timeout(null).catch(() => null);
      done++;
    }
    await prisma.tagAutomodRule.deleteMany({ where: { guildId: guild.id, source: 'WAVE', targetGuildId: wave.tagGuildId } }).catch(() => null);
    await prisma.tagAutomodEvent.updateMany({ where: { waveId: wave.id, status: 'PENDING' }, data: { status: 'RESOLVED', dueAt: null } }).catch(() => null);
    await prisma.tagWave.update({ where: { id: wave.id }, data: { status: 'IGNORED' } }).catch(() => null);
  } else if (op === 'block' && wave.tagGuildId) {
    const temp = await prisma.tagAutomodRule.findFirst({ where: { guildId: guild.id, source: 'WAVE', targetGuildId: wave.tagGuildId } }).catch(() => null);
    if (temp) {
      await prisma.tagAutomodRule.update({ where: { id: temp.id }, data: { expiresAt: null, source: 'MANUAL', name: temp.name.replace(/ \(vague\)$/, '') } }).catch(() => null);
    } else {
      const state = await getTagAutomodState(guild.id);
      const server = await tagServerInfo(wave.tagGuildId);
      await prisma.tagAutomodRule.create({
        data: {
          guildId: guild.id,
          name: wave.tag ?? wave.tagGuildId,
          targetType: 'SERVER',
          targetGuildId: wave.tagGuildId,
          targetName: server.name,
          targetIcon: server.iconUrl,
          action: state.config?.waveAction ?? 'JAIL',
          durationMin: state.config?.waveDurationMin ?? null,
          createdBy: interaction.user.id,
        },
      }).catch(() => null);
    }
    fleetCache = null;
    done = wave.userIds.length;
    await prisma.tagWave.update({ where: { id: wave.id }, data: { status: 'BLOCKED' } }).catch(() => null);
  }
  invalidateTagAutomod(guild.id);

  const status = op === 'ban' ? t.statusBanned(interaction.user.tag) : op === 'ignore' ? t.statusIgnored(interaction.user.tag) : t.statusBlocked(interaction.user.tag);
  await interaction.message.edit({ components: [], content: `✅ ${status}` }).catch(() => null);
  await interaction.editReply({ content: t.done(done) });
}
