/**
 * adminInsightsService.ts
 *
 * Lectures transverses pour la console admin : activite de toute la flotte,
 * fiche d'un serveur, supervision des modules d'analyse (AegisAI, Kotbo
 * Vision). Uniquement des agregats deja stockes : aucun contenu de message,
 * aucune ecriture.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { getAegisQueueStats } from '../moderation/aegis/aegisQueue.js';

const DAY_MS = 86_400_000;

export function clampDays(raw: string | null, fallback = 30): number {
  const days = raw ? Number(raw) : Number.NaN;
  if (!Number.isInteger(days)) return fallback;
  return Math.min(90, Math.max(7, days));
}

/** Cles `YYYY-MM-DD` (UTC), comme celles ecrites par les collecteurs. */
export function dateKeysBack(days: number, now = Date.now()): string[] {
  return Array.from({ length: days }, (_, index) => new Date(now - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10));
}

/** Grille jour de semaine (0 = lundi) x heure, a partir de lignes horaires. */
export function foldHeat(rows: { dateKey: string; hour: number; value: number }[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const row of rows) {
    const weekday = (new Date(`${row.dateKey}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (row.hour >= 0 && row.hour < 24) grid[weekday][row.hour] += row.value;
  }
  return grid;
}

/** Variation en pourcentage ; null quand la periode de reference est vide. */
export function deltaPercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export interface HealthSignal {
  tone: 'danger' | 'warning' | 'info' | 'success';
  label: string;
}

export interface GuildHealthInput {
  activated: boolean;
  onboardingDone: boolean;
  accessExpiresAt: Date | null;
  enabledModules: number;
  memberCount: number;
  /** Messages par jour, du plus ancien au plus recent. */
  messages: number[];
  activeMembers: number[];
  joined: number;
  left: number;
}

/**
 * Note de sante d'un serveur (0-100) et les raisons qui l'expliquent.
 * Heuristique volontairement simple : elle sert a trier et a attirer l'oeil,
 * pas a decider seule.
 */
export function scoreGuildHealth(input: GuildHealthInput, now = Date.now()): { score: number; signals: HealthSignal[] } {
  const signals: HealthSignal[] = [];
  let score = 100;

  const last7 = input.messages.slice(-7).reduce((sum, value) => sum + value, 0);
  const prev7 = input.messages.slice(-14, -7).reduce((sum, value) => sum + value, 0);
  const silentDays = input.messages.length - 1 - input.messages.findLastIndex((value) => value > 0);

  if (!input.activated) {
    score -= 25;
    signals.push({ tone: 'warning', label: 'Serveur non activé : seules les fonctions de base sont disponibles.' });
  }
  if (!input.onboardingDone) {
    score -= 10;
    signals.push({ tone: 'info', label: 'Parcours de configuration jamais terminé.' });
  }
  if (input.accessExpiresAt) {
    const left = input.accessExpiresAt.getTime() - now;
    if (left > 0 && left < 3 * DAY_MS) {
      score -= 10;
      signals.push({ tone: 'warning', label: `L’accès expire dans ${Math.max(1, Math.ceil(left / DAY_MS))} jour(s).` });
    }
  }
  if (input.enabledModules === 0) {
    score -= 20;
    signals.push({ tone: 'warning', label: 'Aucun module activé : Kotbo ne fait rien sur ce serveur.' });
  } else if (input.enabledModules <= 2) {
    score -= 5;
    signals.push({ tone: 'info', label: `Seulement ${input.enabledModules} module(s) activé(s).` });
  }

  if (input.messages.every((value) => value === 0)) {
    score -= 30;
    signals.push({ tone: 'danger', label: 'Aucun message mesuré sur la période.' });
  } else {
    if (silentDays >= 3) {
      score -= 15;
      signals.push({ tone: 'warning', label: `Plus aucun message depuis ${silentDays} jours.` });
    }
    const trend = deltaPercent(last7, prev7);
    if (trend !== null && trend <= -40) {
      score -= 15;
      signals.push({ tone: 'warning', label: `Activité en baisse de ${Math.abs(trend).toFixed(0)} % sur 7 jours.` });
    } else if (trend !== null && trend >= 40) {
      signals.push({ tone: 'success', label: `Activité en hausse de ${trend.toFixed(0)} % sur 7 jours.` });
    }
  }

  const activeAvg = input.activeMembers.length > 0 ? input.activeMembers.reduce((sum, value) => sum + value, 0) / input.activeMembers.length : 0;
  if (input.memberCount >= 20 && activeAvg / input.memberCount < 0.02) {
    score -= 10;
    signals.push({ tone: 'info', label: 'Moins de 2 % des membres écrivent un jour donné.' });
  }
  if (input.left > input.joined && input.left - input.joined >= Math.max(5, input.memberCount * 0.03)) {
    score -= 10;
    signals.push({ tone: 'warning', label: `Le serveur perd des membres : ${input.joined} arrivées pour ${input.left} départs.` });
  }

  if (signals.length === 0) signals.push({ tone: 'success', label: 'Rien à signaler : serveur actif et bien configuré.' });
  return { score: Math.max(0, Math.min(100, score)), signals };
}

// ── Lecture du cache Discord, sur tous les shards ───────────────────────────

interface ChannelLabel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  parentName: string | null;
  guildId: string;
  guildName: string;
}

async function collectChannelLabels(client: Client, channelIds: string[]): Promise<Map<string, ChannelLabel>> {
  const read = (shard: Client, ctx: { ids: string[] }): ChannelLabel[] =>
    ctx.ids.flatMap((id) => {
      const channel = shard.channels.cache.get(id);
      if (!channel || !('guild' in channel)) return [];
      return [{
        id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId ?? null,
        parentName: channel.parent?.name ?? null,
        guildId: channel.guild.id,
        guildName: channel.guild.name,
      }];
    });
  const found = client.shard
    ? (await client.shard.broadcastEval(read, { context: { ids: channelIds } })).flat()
    : read(client, { ids: channelIds });
  return new Map(found.map((label) => [label.id, label]));
}

interface GuildLabel {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
}

async function collectGuildLabels(client: Client): Promise<Map<string, GuildLabel>> {
  const read = (shard: Client): GuildLabel[] =>
    shard.guilds.cache.map((guild) => ({ id: guild.id, name: guild.name, icon: guild.iconURL(), memberCount: guild.memberCount }));
  const found = client.shard ? (await client.shard.broadcastEval(read)).flat() : read(client);
  return new Map(found.map((label) => [label.id, label]));
}

interface GuildDetail {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  description: string | null;
  ownerId: string;
  memberCount: number;
  createdAt: string;
  joinedAt: string | null;
  premiumTier: number;
  boosts: number;
  locale: string;
  features: string[];
  rolesCount: number;
  emojisCount: number;
  shardId: number;
  botIsAdmin: boolean;
  channels: { id: string; name: string; type: number; parentId: string | null }[];
}

async function collectGuildDetail(client: Client, guildId: string): Promise<GuildDetail | null> {
  const read = (shard: Client, ctx: { guildId: string }): GuildDetail | null => {
    const guild = shard.guilds.cache.get(ctx.guildId);
    if (!guild) return null;
    return {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 128 }),
      banner: guild.bannerURL({ size: 1024 }),
      description: guild.description,
      ownerId: guild.ownerId,
      memberCount: guild.memberCount,
      createdAt: guild.createdAt.toISOString(),
      joinedAt: guild.joinedAt?.toISOString() ?? null,
      premiumTier: guild.premiumTier,
      boosts: guild.premiumSubscriptionCount ?? 0,
      locale: guild.preferredLocale,
      features: guild.features,
      rolesCount: guild.roles.cache.size,
      emojisCount: guild.emojis.cache.size,
      shardId: Number(shard.shard?.ids?.[0] ?? 0),
      botIsAdmin: guild.members.me?.permissions.has('Administrator') ?? false,
      channels: guild.channels.cache.map((channel) => ({ id: channel.id, name: channel.name, type: channel.type, parentId: channel.parentId ?? null })),
    };
  };
  if (!client.shard) return read(client, { guildId });
  const results = await client.shard.broadcastEval(read, { context: { guildId } });
  return results.find((result) => result !== null) ?? null;
}

// ── Activite de toute la flotte ─────────────────────────────────────────────

const DAILY_SUM = {
  messagesCount: true,
  reactionsCount: true,
  voiceMinutes: true,
  membersJoined: true,
  membersLeft: true,
  activeMembers: true,
  sanctionsCount: true,
} as const;

const CONTENT_SUM = {
  messages: true,
  withLink: true,
  withMedia: true,
  withEmoji: true,
  typeText: true,
  typeImage: true,
  typeGif: true,
  typeVideo: true,
  typeSticker: true,
  typeFile: true,
  typeVoice: true,
  typePoll: true,
  styleReply: true,
  styleMention: true,
  styleThread: true,
  lenShort: true,
  lenMedium: true,
  lenLong: true,
} as const;

function zeroed<K extends string>(sum: Partial<Record<K, number | null>> | null | undefined, keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, sum?.[key] ?? 0])) as Record<K, number>;
}

export async function getGlobalActivity(client: Client, days: number) {
  const keys = dateKeysBack(days);
  const previousKeys = dateKeysBack(days, Date.now() - days * DAY_MS);
  const range = { gte: keys[0], lte: keys[keys.length - 1] };

  const [daily, activeGuildRows, previous, hourly, byGuild, byChannel, content, guildLabels] = await Promise.all([
    prisma.guildDailyStat.groupBy({ by: ['dateKey'], where: { dateKey: range }, _sum: DAILY_SUM }),
    prisma.guildDailyStat.groupBy({ by: ['dateKey'], where: { dateKey: range, messagesCount: { gt: 0 } }, _count: { _all: true } }),
    prisma.guildDailyStat.aggregate({ where: { dateKey: { gte: previousKeys[0], lte: previousKeys[previousKeys.length - 1] } }, _sum: DAILY_SUM }),
    prisma.guildHourlyStat.groupBy({ by: ['dateKey', 'hour'], where: { dateKey: range }, _sum: { messagesCount: true } }),
    prisma.guildDailyStat.groupBy({ by: ['guildId'], where: { dateKey: range }, _sum: { messagesCount: true, voiceMinutes: true, activeMembers: true } }),
    // Les 300 salons les plus actifs suffisent a classer salons et categories.
    prisma.channelDailyStat.groupBy({
      by: ['guildId', 'channelId'],
      where: { dateKey: range },
      _sum: { messagesCount: true, voiceMinutes: true },
      orderBy: { _sum: { messagesCount: 'desc' } },
      take: 300,
    }),
    prisma.messageContentDailyStat.aggregate({ where: { dateKey: range }, _sum: CONTENT_SUM }),
    collectGuildLabels(client),
  ]);

  const dailyKeys = Object.keys(DAILY_SUM) as (keyof typeof DAILY_SUM)[];
  const dailyByKey = new Map(daily.map((row) => [row.dateKey, zeroed(row._sum, dailyKeys)]));
  const activeByKey = new Map(activeGuildRows.map((row) => [row.dateKey, row._count._all]));
  const series = keys.map((dateKey) => ({
    dateKey,
    ...(dailyByKey.get(dateKey) ?? zeroed(null, dailyKeys)),
    activeGuilds: activeByKey.get(dateKey) ?? 0,
  }));

  const totals = zeroed(
    Object.fromEntries(dailyKeys.map((key) => [key, series.reduce((sum, day) => sum + day[key], 0)])) as Record<keyof typeof DAILY_SUM, number>,
    dailyKeys,
  );
  const previousTotals = zeroed(previous._sum, dailyKeys);

  const labels = await collectChannelLabels(client, byChannel.map((row) => row.channelId));
  const channels = byChannel.map((row) => {
    const label = labels.get(row.channelId);
    return {
      channelId: row.channelId,
      guildId: row.guildId,
      name: label?.name ?? null,
      type: label?.type ?? null,
      categoryId: label?.parentId ?? null,
      categoryName: label?.parentName ?? null,
      guildName: label?.guildName ?? guildLabels.get(row.guildId)?.name ?? null,
      messages: row._sum.messagesCount ?? 0,
      voiceMinutes: row._sum.voiceMinutes ?? 0,
    };
  });

  const categories = new Map<string, { categoryId: string | null; name: string | null; guildId: string; guildName: string | null; messages: number; voiceMinutes: number; channels: number }>();
  for (const channel of channels) {
    const key = `${channel.guildId}:${channel.categoryId ?? '-'}`;
    const entry = categories.get(key) ?? { categoryId: channel.categoryId, name: channel.categoryName, guildId: channel.guildId, guildName: channel.guildName, messages: 0, voiceMinutes: 0, channels: 0 };
    entry.messages += channel.messages;
    entry.voiceMinutes += channel.voiceMinutes;
    entry.channels += 1;
    categories.set(key, entry);
  }

  const guilds = byGuild
    .map((row) => {
      const label = guildLabels.get(row.guildId);
      return {
        guildId: row.guildId,
        name: label?.name ?? null,
        icon: label?.icon ?? null,
        memberCount: label?.memberCount ?? 0,
        messages: row._sum.messagesCount ?? 0,
        voiceMinutes: row._sum.voiceMinutes ?? 0,
        // Moyenne quotidienne de membres ayant ecrit.
        activeMembers: Math.round((row._sum.activeMembers ?? 0) / days),
      };
    })
    .sort((a, b) => b.messages - a.messages);

  return {
    days,
    series,
    totals,
    previousTotals,
    heat: foldHeat(hourly.map((row) => ({ dateKey: row.dateKey, hour: row.hour, value: row._sum.messagesCount ?? 0 }))),
    guilds: guilds.slice(0, 20),
    measuredGuilds: guilds.filter((guild) => guild.messages > 0).length,
    silentGuilds: [...guildLabels.values()].filter((label) => !guilds.some((guild) => guild.guildId === label.id && guild.messages > 0)).length,
    channels: channels.slice(0, 20),
    categories: [...categories.values()].sort((a, b) => b.messages - a.messages).slice(0, 15),
    content: zeroed(content._sum, Object.keys(CONTENT_SUM) as (keyof typeof CONTENT_SUM)[]),
  };
}

// ── Fiche d'un serveur ──────────────────────────────────────────────────────

export async function getGuildSheet(client: Client, guildId: string, days: number) {
  const keys = dateKeysBack(days);
  const range = { gte: keys[0], lte: keys[keys.length - 1] };
  const since = new Date(Date.now() - days * DAY_MS);

  const [detail, db, daily, hourly, byChannel, modules, fleet, content, aegisConfig, aegisHourly, aegisKinds, visionReviews, visionHashes, visionLists, audit] = await Promise.all([
    collectGuildDetail(client, guildId),
    prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        activated: true,
        activatedAt: true,
        activationCode: true,
        plan: true,
        accessType: true,
        accessExpiresAt: true,
        onboardingCompletedAt: true,
        stripeSubscriptionStatus: true,
        stripeCancelAtPeriodEnd: true,
        stripeCurrentPeriodEnd: true,
        createdAt: true,
      },
    }),
    prisma.guildDailyStat.findMany({ where: { guildId, dateKey: range }, orderBy: { dateKey: 'asc' } }),
    prisma.guildHourlyStat.groupBy({ by: ['dateKey', 'hour'], where: { guildId, dateKey: range }, _sum: { messagesCount: true } }),
    prisma.channelDailyStat.groupBy({ by: ['channelId'], where: { guildId, dateKey: range }, _sum: { messagesCount: true, voiceMinutes: true, uniqueAuthors: true } }),
    prisma.moduleActivationStat.findMany({ where: { guildId }, select: { moduleName: true, enabled: true, activatedAt: true, lastUsedAt: true }, orderBy: { moduleName: 'asc' } }),
    prisma.guildDailyStat.groupBy({ by: ['guildId'], where: { dateKey: range }, _sum: { messagesCount: true } }),
    prisma.messageContentDailyStat.aggregate({ where: { guildId, dateKey: range }, _sum: CONTENT_SUM }),
    prisma.aegisConfig.findUnique({ where: { guildId }, select: { enabled: true, reviewThreshold: true, autoThreshold: true } }),
    prisma.aegisHourlyStat.aggregate({ where: { guildId, dateKey: range }, _sum: { analyzed: true, toxic: true, severe: true, toxicityMilli: true } }),
    prisma.aegisDetection.groupBy({ by: ['kind'], where: { guildId, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.visionReview.groupBy({ by: ['status'], where: { guildId, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.scamImageHash.count({ where: { guildId } }),
    prisma.visionList.count({ where: { guildId } }),
    prisma.adminAuditLog.findMany({
      where: { targetId: guildId },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, action: true, summary: true, outcome: true, actorName: true, actorId: true, createdAt: true },
    }),
  ]);

  if (!detail && !db) return null;

  const dayByKey = new Map(daily.map((row) => [row.dateKey, row]));
  const series = keys.map((dateKey) => {
    const row = dayByKey.get(dateKey);
    return {
      dateKey,
      messages: row?.messagesCount ?? 0,
      reactions: row?.reactionsCount ?? 0,
      voiceMinutes: row?.voiceMinutes ?? 0,
      activeMembers: row?.activeMembers ?? 0,
      joined: row?.membersJoined ?? 0,
      left: row?.membersLeft ?? 0,
      totalMembers: row?.totalMembers ?? 0,
      peakOnline: row?.peakOnline ?? 0,
      sanctions: row?.sanctionsCount ?? 0,
      warns: row?.warnsCount ?? 0,
      timeouts: row?.timeoutsCount ?? 0,
      kicks: row?.kicksCount ?? 0,
      bans: row?.bansCount ?? 0,
    };
  });
  const sum = (pick: (day: (typeof series)[number]) => number) => series.reduce((total, day) => total + pick(day), 0);

  const channelById = new Map((detail?.channels ?? []).map((channel) => [channel.id, channel]));
  const channels = byChannel
    .map((row) => {
      const channel = channelById.get(row.channelId);
      const parent = channel?.parentId ? channelById.get(channel.parentId) : undefined;
      return {
        channelId: row.channelId,
        name: channel?.name ?? null,
        type: channel?.type ?? null,
        categoryId: channel?.parentId ?? null,
        categoryName: parent?.name ?? null,
        messages: row._sum.messagesCount ?? 0,
        voiceMinutes: row._sum.voiceMinutes ?? 0,
        authors: row._sum.uniqueAuthors ?? 0,
      };
    })
    .sort((a, b) => b.messages - a.messages);

  const categories = new Map<string, { categoryId: string | null; name: string | null; messages: number; voiceMinutes: number; channels: number }>();
  for (const channel of channels) {
    const key = channel.categoryId ?? '-';
    const entry = categories.get(key) ?? { categoryId: channel.categoryId, name: channel.categoryName, messages: 0, voiceMinutes: 0, channels: 0 };
    entry.messages += channel.messages;
    entry.voiceMinutes += channel.voiceMinutes;
    entry.channels += 1;
    categories.set(key, entry);
  }

  // Place du serveur dans la flotte, sur la meme periode.
  const ranked = fleet.map((row) => ({ guildId: row.guildId, messages: row._sum.messagesCount ?? 0 })).sort((a, b) => b.messages - a.messages);
  const rankIndex = ranked.findIndex((row) => row.guildId === guildId);
  const fleetMedian = ranked.length > 0 ? ranked[Math.floor(ranked.length / 2)].messages : 0;

  const memberCount = detail?.memberCount ?? series.findLast((day) => day.totalMembers > 0)?.totalMembers ?? 0;
  const enabledModules = modules.filter((module) => module.enabled);
  const health = scoreGuildHealth({
    activated: db?.activated ?? false,
    onboardingDone: Boolean(db?.onboardingCompletedAt),
    accessExpiresAt: db?.accessExpiresAt ?? null,
    enabledModules: enabledModules.length,
    memberCount,
    messages: series.map((day) => day.messages),
    activeMembers: series.map((day) => day.activeMembers),
    joined: sum((day) => day.joined),
    left: sum((day) => day.left),
  });

  const analyzed = aegisHourly._sum.analyzed ?? 0;

  return {
    days,
    present: Boolean(detail),
    guild: detail ? { ...detail, channels: undefined, channelsCount: detail.channels.length } : { id: guildId, name: null },
    access: db,
    health,
    totals: {
      messages: sum((day) => day.messages),
      reactions: sum((day) => day.reactions),
      voiceMinutes: sum((day) => day.voiceMinutes),
      joined: sum((day) => day.joined),
      left: sum((day) => day.left),
      sanctions: sum((day) => day.sanctions),
      warns: sum((day) => day.warns),
      timeouts: sum((day) => day.timeouts),
      kicks: sum((day) => day.kicks),
      bans: sum((day) => day.bans),
      activeMembersAvg: Math.round(sum((day) => day.activeMembers) / days),
      memberCount,
    },
    fleet: { rank: rankIndex >= 0 ? rankIndex + 1 : null, of: ranked.length, median: fleetMedian },
    series,
    heat: foldHeat(hourly.map((row) => ({ dateKey: row.dateKey, hour: row.hour, value: row._sum.messagesCount ?? 0 }))),
    channels: channels.slice(0, 15),
    categories: [...categories.values()].sort((a, b) => b.messages - a.messages),
    content: zeroed(content._sum, Object.keys(CONTENT_SUM) as (keyof typeof CONTENT_SUM)[]),
    modules: modules.map((module) => ({
      name: module.moduleName,
      enabled: module.enabled,
      activatedAt: module.activatedAt?.toISOString() ?? null,
      lastUsedAt: module.lastUsedAt?.toISOString() ?? null,
    })),
    aegis: {
      enabled: aegisConfig?.enabled ?? false,
      reviewThreshold: aegisConfig?.reviewThreshold ?? null,
      autoThreshold: aegisConfig?.autoThreshold ?? null,
      analyzed,
      toxic: aegisHourly._sum.toxic ?? 0,
      severe: aegisHourly._sum.severe ?? 0,
      averageToxicity: analyzed > 0 ? (aegisHourly._sum.toxicityMilli ?? 0) / analyzed / 10 : 0,
      detections: Object.fromEntries(aegisKinds.map((row) => [row.kind, row._count._all])),
    },
    vision: {
      lists: visionLists,
      images: visionHashes,
      reviews: Object.fromEntries(visionReviews.map((row) => [row.status, row._count._all])),
    },
    audit: audit.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
  };
}

// ── Supervision des modules d'analyse ───────────────────────────────────────

export async function getAiSupervision(client: Client, days: number) {
  const keys = dateKeysBack(days);
  const range = { gte: keys[0], lte: keys[keys.length - 1] };
  const since = new Date(Date.now() - days * DAY_MS);

  const [
    queue, aegisEnabled, aegisConsent, aegisDaily, aegisEmotions, aegisByGuild,
    detectionKinds, detectionStatus, detectionActions, lateCount, pendingAegis,
    hashSources, globalHashes, domainCount, globalDomains, topDomains, textSamples,
    reviewStatus, visionLists, visionGuilds, newHashes, guildLabels,
  ] = await Promise.all([
    getAegisQueueStats(),
    prisma.aegisConfig.count({ where: { enabled: true } }),
    prisma.aegisConfig.count({ where: { trainingConsent: true } }),
    prisma.aegisHourlyStat.groupBy({ by: ['dateKey'], where: { dateKey: range }, _sum: { analyzed: true, toxic: true, severe: true, toxicityMilli: true } }),
    prisma.aegisHourlyStat.aggregate({ where: { dateKey: range }, _sum: { emotionAnalyzed: true, joy: true, sad: true, anger: true, fear: true, surprise: true, neutral: true } }),
    prisma.aegisHourlyStat.groupBy({ by: ['guildId'], where: { dateKey: range }, _sum: { analyzed: true, toxic: true, severe: true }, orderBy: { _sum: { analyzed: 'desc' } }, take: 10 }),
    prisma.aegisDetection.groupBy({ by: ['kind'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.aegisDetection.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.aegisDetection.groupBy({ by: ['action'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.aegisDetection.count({ where: { createdAt: { gte: since }, late: true } }),
    prisma.aegisDetection.count({ where: { status: 'PENDING' } }),
    prisma.scamImageHash.groupBy({ by: ['source'], _count: { _all: true } }),
    prisma.scamImageHash.count({ where: { guildId: null } }),
    prisma.scamDomain.count(),
    prisma.scamDomain.count({ where: { guildId: null } }),
    prisma.scamDomain.findMany({ orderBy: { hits: 'desc' }, take: 10, select: { domain: true, hits: true, source: true, guildId: true, lastSeenAt: true } }),
    prisma.scamTextSample.count(),
    prisma.visionReview.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.visionList.count({ where: { enabled: true } }),
    prisma.visionList.groupBy({ by: ['guildId'], where: { enabled: true } }),
    prisma.scamImageHash.count({ where: { createdAt: { gte: since } } }),
    collectGuildLabels(client),
  ]);

  const dailyByKey = new Map(aegisDaily.map((row) => [row.dateKey, row._sum]));
  const series = keys.map((dateKey) => {
    const row = dailyByKey.get(dateKey);
    const analyzed = row?.analyzed ?? 0;
    return {
      dateKey,
      analyzed,
      toxic: row?.toxic ?? 0,
      severe: row?.severe ?? 0,
      averageToxicity: analyzed > 0 ? (row?.toxicityMilli ?? 0) / analyzed / 10 : 0,
    };
  });
  const analyzed = series.reduce((sum, day) => sum + day.analyzed, 0);
  const counts = (rows: { _count: { _all: number } }[], key: string) =>
    Object.fromEntries(rows.map((row) => [(row as unknown as Record<string, string>)[key], row._count._all]));

  return {
    days,
    aegis: {
      queue,
      enabledGuilds: aegisEnabled,
      trainingConsentGuilds: aegisConsent,
      analyzed,
      toxic: series.reduce((sum, day) => sum + day.toxic, 0),
      severe: series.reduce((sum, day) => sum + day.severe, 0),
      late: lateCount,
      pendingReviews: pendingAegis,
      series,
      emotions: {
        analyzed: aegisEmotions._sum.emotionAnalyzed ?? 0,
        joy: aegisEmotions._sum.joy ?? 0,
        sad: aegisEmotions._sum.sad ?? 0,
        anger: aegisEmotions._sum.anger ?? 0,
        fear: aegisEmotions._sum.fear ?? 0,
        surprise: aegisEmotions._sum.surprise ?? 0,
        neutral: aegisEmotions._sum.neutral ?? 0,
      },
      kinds: counts(detectionKinds, 'kind'),
      status: counts(detectionStatus, 'status'),
      actions: counts(detectionActions, 'action'),
      guilds: aegisByGuild.map((row) => ({
        guildId: row.guildId,
        name: guildLabels.get(row.guildId)?.name ?? null,
        analyzed: row._sum.analyzed ?? 0,
        toxic: row._sum.toxic ?? 0,
        severe: row._sum.severe ?? 0,
      })),
    },
    vision: {
      enabledLists: visionLists,
      guildsWithLists: visionGuilds.length,
      images: hashSources.reduce((sum, row) => sum + row._count._all, 0),
      globalImages: globalHashes,
      newImages: newHashes,
      imageSources: counts(hashSources, 'source'),
      domains: domainCount,
      globalDomains,
      textSamples,
      reviews: counts(reviewStatus, 'status'),
      topDomains: topDomains.map((domain) => ({
        domain: domain.domain,
        hits: domain.hits,
        source: domain.source,
        global: domain.guildId === null,
        lastSeenAt: domain.lastSeenAt.toISOString(),
      })),
    },
  };
}
