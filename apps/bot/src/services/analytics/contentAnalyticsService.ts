/**
 * contentAnalyticsService.ts
 *
 * Lectures de la nouvelle page Analytics : stats de contenu, activité filtrée,
 * arbre des salons par catégorie, détail d'une catégorie, options de filtres.
 *
 * Toutes les fonctions prennent une période (clés de jour UTC, bornes
 * incluses) et, pour celles qui s'y prêtent, un périmètre : salons retenus,
 * membres retenus (rôle), membres exclus (staff).
 */

import { Prisma } from '@prisma/client';
import { ChannelType, type Client, type Guild, type GuildBasedChannel } from 'discord.js';
import { prismaRead } from '../../utils/db.js';
import { CONTENT_COUNTER_COLUMNS, domainFamily, type ContentCounter } from './messageContentAnalyzer.js';
import { getContentStatsBackfillStatus } from './contentStatsBackfillService.js';

// ── Période et périmètre ───────────────────────────────────────────────────

export interface DateRange {
  start: string;
  end: string;
  /** Période de même longueur juste avant, pour les écarts. */
  prevStart: string;
  prevEnd: string;
  days: number;
}

const DAY_MS = 24 * 3600 * 1000;
export const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => keyOf(new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS));

/** `period` en jours (1 à 365) ou `startDate`/`endDate` (ISO ou datetime-local). */
export function parseRange(params: URLSearchParams, now = new Date()): DateRange {
  const startRaw = params.get('startDate');
  const endRaw = params.get('endDate');
  let start: string;
  let end: string;
  if (startRaw && endRaw && !Number.isNaN(Date.parse(startRaw)) && !Number.isNaN(Date.parse(endRaw))) {
    start = keyOf(new Date(startRaw));
    end = keyOf(new Date(endRaw));
    if (start > end) [start, end] = [end, start];
    // Au-delà d'un an, les requêtes par membre deviennent lourdes pour peu d'intérêt.
    if (Date.parse(end) - Date.parse(start) > 365 * DAY_MS) start = addDays(end, -365);
  } else {
    const period = Math.min(365, Math.max(1, Number.parseInt(params.get('period') ?? '30', 10) || 30));
    end = keyOf(now);
    start = addDays(end, -(period - 1));
  }
  const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
  return { start, end, prevEnd: addDays(start, -1), prevStart: addDays(start, -days), days };
}

export interface AnalyticsScope {
  /** Salons retenus (null = tous). Une catégorie est dépliée en ses salons. */
  channelIds: string[] | null;
  /** Membres retenus (null = tous), par exemple les porteurs d'un rôle. */
  userIds: string[] | null;
  /** Membres exclus, par exemple le staff. */
  excludeUserIds: string[];
  channelFilter: string | null;
  roleFilter: string | null;
  excludeStaff: boolean;
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

export async function resolveScope(client: Client, guildId: string, params: URLSearchParams): Promise<AnalyticsScope> {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const channelParam = params.get('channel');
  const roleParam = params.get('role');
  const userParam = params.get('userId');
  const excludeStaff = params.get('excludeStaff') === '1';

  let channelIds: string[] | null = null;
  let channelFilter: string | null = null;
  if (channelParam && SNOWFLAKE_RE.test(channelParam)) {
    channelFilter = channelParam;
    const channel = guild?.channels.cache.get(channelParam);
    channelIds = channel?.type === ChannelType.GuildCategory
      ? guild!.channels.cache.filter((c) => c.parentId === channelParam).map((c) => c.id)
      : [channelParam];
    if (channelIds.length === 0) channelIds = [channelParam];
    // channel_daily_stats range les messages d'un fil sous l'id du fil : on
    // ajoute les fils actifs connus pour qu'ils suivent leur salon.
    if (guild) {
      const parents = new Set(channelIds);
      for (const c of guild.channels.cache.values()) {
        if (c.isThread() && c.parentId && parents.has(c.parentId)) channelIds.push(c.id);
      }
    }
  }

  let userIds: string[] | null = null;
  let roleFilter: string | null = null;
  if (userParam && SNOWFLAKE_RE.test(userParam)) {
    userIds = [userParam];
  } else if (roleParam && SNOWFLAKE_RE.test(roleParam) && guild) {
    roleFilter = roleParam;
    userIds = guild.roles.cache.get(roleParam)?.members.map((m) => m.id) ?? [];
  }

  let excludeUserIds: string[] = [];
  if (excludeStaff) {
    const staff = await prismaRead.staffMember.findMany({ where: { guildId }, select: { userId: true } });
    excludeUserIds = staff.map((s) => s.userId);
  }

  return { channelIds, userIds, excludeUserIds, channelFilter, roleFilter, excludeStaff };
}

export function scopeCacheKey(scope: AnalyticsScope, range: DateRange): string {
  const users = scope.userIds && scope.userIds.length === 1 && !scope.roleFilter ? `u${scope.userIds[0]}` : '';
  return [range.start, range.end, scope.channelFilter ?? '', scope.roleFilter ?? '', scope.excludeStaff ? 's' : '', users].join(':');
}

export const hasUserScope = (scope: AnalyticsScope) => scope.userIds !== null || scope.excludeUserIds.length > 0;

/** Conditions SQL sur "channelId" / "userId" selon le périmètre. `alias` préfixe les colonnes. */
export function scopeSql(scope: AnalyticsScope, opts: { channels?: boolean; users?: boolean } = {}): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (opts.channels !== false && scope.channelIds) {
    parts.push(scope.channelIds.length > 0 ? Prisma.sql`"channelId" IN (${Prisma.join(scope.channelIds)})` : Prisma.sql`FALSE`);
  }
  if (opts.users !== false) {
    if (scope.userIds) parts.push(scope.userIds.length > 0 ? Prisma.sql`"userId" IN (${Prisma.join(scope.userIds)})` : Prisma.sql`FALSE`);
    if (scope.excludeUserIds.length > 0) parts.push(Prisma.sql`"userId" NOT IN (${Prisma.join(scope.excludeUserIds)})`);
  }
  return parts.length === 0 ? Prisma.empty : Prisma.sql` AND ${Prisma.join(parts, ' AND ')}`;
}

// ── Contenu ────────────────────────────────────────────────────────────────

const SUM_COLUMNS = Prisma.raw(CONTENT_COUNTER_COLUMNS.map((c) => `COALESCE(SUM("${c}"), 0)::int AS "${c}"`).join(', '));

export type ContentTotals = Record<ContentCounter, number>;

async function sumCounters(guildId: string, start: string, end: string, scope: AnalyticsScope): Promise<ContentTotals> {
  const rows = await prismaRead.$queryRaw<ContentTotals[]>`
    SELECT ${SUM_COLUMNS}
    FROM "message_content_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}${scopeSql(scope)}
  `;
  return rows[0] ?? (Object.fromEntries(CONTENT_COUNTER_COLUMNS.map((c) => [c, 0])) as ContentTotals);
}

/**
 * Les classements n'existent que par salon OU par membre (voir le modèle).
 * Avec les deux filtres à la fois, le salon l'emporte et on le signale.
 */
function itemScopeSql(scope: AnalyticsScope): { sql: Prisma.Sql; basis: 'server' | 'channel' | 'member' } {
  if (scope.channelIds) {
    return { sql: Prisma.sql` AND "userId" = ''${scopeSql(scope, { users: false })}`, basis: 'channel' };
  }
  if (hasUserScope(scope)) {
    return { sql: Prisma.sql` AND "channelId" = ''${scopeSql(scope, { channels: false })}`, basis: 'member' };
  }
  return { sql: Prisma.sql` AND "userId" = ''`, basis: 'server' };
}

interface ItemRow { kind: string; key: string; count: number }

async function topItems(guildId: string, range: DateRange, scope: AnalyticsScope, kinds: string[], limit: number): Promise<ItemRow[]> {
  const { sql } = itemScopeSql(scope);
  return prismaRead.$queryRaw<ItemRow[]>`
    SELECT "kind", "key", SUM("count")::int AS "count"
    FROM "content_item_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}
      AND "kind" IN (${Prisma.join(kinds)})${sql}
    GROUP BY "kind", "key"
    ORDER BY "count" DESC
    LIMIT ${limit}
  `;
}

interface AssetInfo {
  name: string | null;
  animated: boolean;
  sourceGuildId: string | null;
  sourceGuildName: string | null;
  status: string;
}

async function loadAssets(ids: string[]): Promise<Map<string, AssetInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await prismaRead.discordAssetSource.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, animated: true, sourceGuildId: true, sourceGuildName: true, status: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

type Origin = 'unicode' | 'guild' | 'external' | 'standard';
const originOfKind = (kind: string): Origin => (kind.split('_')[1] as Origin) ?? 'unicode';

export interface EmojiEntry {
  key: string;
  origin: Origin;
  count: number;
  name: string | null;
  animated: boolean;
  imageUrl: string | null;
  sourceName: string | null;
}

function emojiEntry(row: ItemRow, assets: Map<string, AssetInfo>, guild: Guild | null): EmojiEntry {
  const origin = originOfKind(row.kind);
  if (origin === 'unicode') {
    return { key: row.key, origin, count: row.count, name: null, animated: false, imageUrl: null, sourceName: null };
  }
  const asset = assets.get(row.key);
  const cached = guild?.client.emojis.cache.get(row.key);
  const animated = asset?.animated ?? cached?.animated ?? false;
  return {
    key: row.key,
    origin,
    count: row.count,
    name: asset?.name ?? cached?.name ?? null,
    animated,
    imageUrl: `https://cdn.discordapp.com/emojis/${row.key}.${animated ? 'gif' : 'webp'}?size=64`,
    sourceName: origin === 'guild' ? guild?.name ?? null : asset?.sourceGuildName ?? null,
  };
}

export interface SourceServerEntry {
  guildId: string | null;
  name: string | null;
  count: number;
  /** Nombre d'emojis ou de stickers distincts venus de ce serveur. */
  items: number;
}

/** Regroupe des occurrences externes par serveur d'origine ; les inconnus ensemble. */
function groupBySource(rows: ItemRow[], assets: Map<string, AssetInfo>): SourceServerEntry[] {
  const groups = new Map<string, SourceServerEntry>();
  for (const row of rows) {
    const asset = assets.get(row.key);
    const known = asset?.status === 'resolved' && (asset.sourceGuildId || asset.sourceGuildName);
    const groupKey = known ? asset!.sourceGuildId ?? `name:${asset!.sourceGuildName}` : 'unknown';
    const entry = groups.get(groupKey) ?? {
      guildId: known ? asset!.sourceGuildId : null,
      name: known ? asset!.sourceGuildName : null,
      count: 0,
      items: 0,
    };
    entry.count += row.count;
    entry.items += 1;
    groups.set(groupKey, entry);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export async function getContentAnalytics(client: Client, guildId: string, range: DateRange, scope: AnalyticsScope) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const itemBasis = itemScopeSql(scope).basis;

  const [totals, previous, emojiRows, reactionRows, externalEmojiRows, externalReactionRows, stickerRows, externalStickerRows, domainRows, gifChannelRows, backfill] = await Promise.all([
    sumCounters(guildId, range.start, range.end, scope),
    sumCounters(guildId, range.prevStart, range.prevEnd, scope),
    topItems(guildId, range, scope, ['emoji_unicode', 'emoji_guild', 'emoji_external'], 16),
    topItems(guildId, range, scope, ['reaction_unicode', 'reaction_guild', 'reaction_external'], 16),
    topItems(guildId, range, scope, ['emoji_external'], 500),
    topItems(guildId, range, scope, ['reaction_external'], 500),
    topItems(guildId, range, scope, ['sticker_guild', 'sticker_external', 'sticker_standard'], 10),
    topItems(guildId, range, scope, ['sticker_external'], 500),
    topItems(guildId, range, scope, ['domain'], 15),
    prismaRead.$queryRaw<Array<{ channelId: string; gifs: number }>>`
      SELECT "channelId", SUM("typeGif")::int AS "gifs"
      FROM "message_content_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}${scopeSql(scope)}
      GROUP BY "channelId" HAVING SUM("typeGif") > 0
      ORDER BY "gifs" DESC LIMIT 5
    `,
    getContentStatsBackfillStatus(guildId),
  ]);

  const assetIds = [...new Set([
    ...emojiRows, ...reactionRows, ...externalEmojiRows, ...externalReactionRows, ...stickerRows, ...externalStickerRows,
  ].filter((r) => r.kind !== 'emoji_unicode' && r.kind !== 'reaction_unicode').map((r) => r.key))];
  const assets = await loadAssets(assetIds);

  const stickerEntries = stickerRows.map((row) => {
    const asset = assets.get(row.key);
    const origin = originOfKind(row.kind);
    return {
      key: row.key,
      origin,
      count: row.count,
      name: asset?.name ?? guild?.stickers.cache.get(row.key)?.name ?? null,
      imageUrl: `https://media.discordapp.net/stickers/${row.key}.png?size=96`,
      sourceName: origin === 'guild' ? guild?.name ?? null : origin === 'standard' ? null : asset?.sourceGuildName ?? null,
    };
  });

  return {
    range,
    itemBasis,
    totals,
    previous,
    emojis: emojiRows.map((r) => emojiEntry(r, assets, guild)),
    reactions: reactionRows.map((r) => emojiEntry(r, assets, guild)),
    emojiServers: groupBySource(externalEmojiRows, assets).slice(0, 8),
    reactionServers: groupBySource(externalReactionRows, assets).slice(0, 8),
    stickers: stickerEntries,
    stickerServers: groupBySource(externalStickerRows, assets).slice(0, 8),
    domains: domainRows.map((r) => ({ domain: r.key, family: domainFamily(r.key), count: r.count })),
    gifChannels: gifChannelRows.map((r) => ({
      channelId: r.channelId,
      name: guild?.channels.cache.get(r.channelId)?.name ?? null,
      count: r.gifs,
    })),
    backfill: backfill ? { status: backfill.status, processed: backfill.processedMessages ?? 0, total: backfill.totalMessages ?? 0 } : null,
  };
}

// ── Activité filtrée ───────────────────────────────────────────────────────

export interface DayRow { dateKey: string; messages: number; voiceMinutes: number }

export function dayKeys(start: string, end: string): string[] {
  const keys: string[] = [];
  for (let k = start; k <= end; k = addDays(k, 1)) keys.push(k);
  return keys;
}

export async function dailyActivity(guildId: string, start: string, end: string, scope: AnalyticsScope): Promise<{ rows: DayRow[]; voiceAvailable: boolean }> {
  const users = hasUserScope(scope);
  if (scope.channelIds && users) {
    // Salon ET membres : seules les stats de contenu croisent les deux. Pas de vocal.
    const rows = await prismaRead.$queryRaw<DayRow[]>`
      SELECT "dateKey", SUM("messages")::int AS "messages", 0 AS "voiceMinutes"
      FROM "message_content_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}${scopeSql(scope)}
      GROUP BY "dateKey"
    `;
    return { rows, voiceAvailable: false };
  }
  if (scope.channelIds) {
    const rows = await prismaRead.$queryRaw<DayRow[]>`
      SELECT "dateKey", SUM("messagesCount")::int AS "messages", SUM("voiceMinutes")::int AS "voiceMinutes"
      FROM "channel_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}${scopeSql(scope, { users: false })}
      GROUP BY "dateKey"
    `;
    return { rows, voiceAvailable: true };
  }
  if (users) {
    const rows = await prismaRead.$queryRaw<DayRow[]>`
      SELECT "dateKey", SUM("messagesCount")::int AS "messages", SUM("voiceMinutes")::int AS "voiceMinutes"
      FROM "member_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}${scopeSql(scope, { channels: false })}
      GROUP BY "dateKey"
    `;
    return { rows, voiceAvailable: true };
  }
  const rows = await prismaRead.$queryRaw<DayRow[]>`
    SELECT "dateKey", "messagesCount"::int AS "messages", "voiceMinutes"::int AS "voiceMinutes"
    FROM "guild_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}
  `;
  return { rows, voiceAvailable: true };
}

async function activeMembers(guildId: string, start: string, end: string, scope: AnalyticsScope): Promise<number> {
  if (scope.channelIds) {
    const rows = await prismaRead.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(DISTINCT "userId")::int AS n FROM "message_content_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end} AND "messages" > 0${scopeSql(scope)}
    `;
    return rows[0]?.n ?? 0;
  }
  const rows = await prismaRead.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(DISTINCT "userId")::int AS n FROM "member_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}
      AND ("messagesCount" > 0 OR "voiceMinutes" > 0)${scopeSql(scope, { channels: false })}
  `;
  return rows[0]?.n ?? 0;
}

async function joinsAndLeaves(guildId: string, start: string, end: string): Promise<{ joined: number; left: number }> {
  const agg = await prismaRead.guildDailyStat.aggregate({
    where: { guildId, dateKey: { gte: start, lte: end } },
    _sum: { membersJoined: true, membersLeft: true },
  });
  return { joined: agg._sum.membersJoined ?? 0, left: agg._sum.membersLeft ?? 0 };
}

/** Regroupe les fils sous leur salon parent, puis retrie. */
function foldTopChannels(guild: Guild | null, rows: Array<{ channelId: string; messages: number }>) {
  const byId = new Map<string, { channelId: string; name: string | null; messages: number }>();
  for (const row of rows) {
    const channel = guild?.channels.cache.get(row.channelId);
    const id = channel?.isThread() && channel.parentId ? channel.parentId : row.channelId;
    const entry = byId.get(id) ?? { channelId: id, name: guild?.channels.cache.get(id)?.name ?? null, messages: 0 };
    entry.messages += row.messages;
    byId.set(id, entry);
  }
  return [...byId.values()].sort((a, b) => b.messages - a.messages);
}

export async function getActivityAnalytics(client: Client, guildId: string, range: DateRange, scope: AnalyticsScope, includeBots = false) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const [cur, prev, activeNow, activePrev, flowNow, flowPrev, topChannelRows] = await Promise.all([
    dailyActivity(guildId, range.start, range.end, scope),
    dailyActivity(guildId, range.prevStart, range.prevEnd, scope),
    activeMembers(guildId, range.start, range.end, scope),
    activeMembers(guildId, range.prevStart, range.prevEnd, scope),
    joinsAndLeaves(guildId, range.start, range.end),
    joinsAndLeaves(guildId, range.prevStart, range.prevEnd),
    prismaRead.$queryRaw<Array<{ channelId: string; messages: number }>>`
      SELECT "channelId", SUM("messagesCount")::int AS "messages"
      FROM "channel_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}${scopeSql(scope, { users: false })}
      GROUP BY "channelId" ORDER BY "messages" DESC LIMIT 40
    `,
  ]);

  const byDay = (rows: DayRow[]) => new Map(rows.map((r) => [r.dateKey, r]));
  const curMap = byDay(cur.rows);
  const prevMap = byDay(prev.rows);
  const prevKeys = dayKeys(range.prevStart, range.prevEnd);
  const series = dayKeys(range.start, range.end).map((key, i) => ({
    dateKey: key,
    messages: curMap.get(key)?.messages ?? 0,
    voiceMinutes: curMap.get(key)?.voiceMinutes ?? 0,
    prevMessages: prevMap.get(prevKeys[i]!)?.messages ?? 0,
    prevVoiceMinutes: prevMap.get(prevKeys[i]!)?.voiceMinutes ?? 0,
  }));
  const sum = (key: 'messages' | 'voiceMinutes' | 'prevMessages' | 'prevVoiceMinutes') => series.reduce((s, d) => s + d[key], 0);

  const memberCount = guild
    ? includeBots
      ? guild.memberCount
      : Math.max(0, guild.memberCount - guild.members.cache.filter((m) => m.user.bot).size)
    : null;

  return {
    range,
    voiceAvailable: cur.voiceAvailable,
    joinsFiltered: false,
    kpis: {
      messages: { value: sum('messages'), previous: sum('prevMessages') },
      activeMembers: { value: activeNow, previous: activePrev },
      voiceMinutes: { value: sum('voiceMinutes'), previous: sum('prevVoiceMinutes') },
      netJoins: { value: flowNow.joined - flowNow.left, previous: flowPrev.joined - flowPrev.left },
      joined: flowNow.joined,
      left: flowNow.left,
      memberCount,
    },
    series,
    topChannels: foldTopChannels(guild, topChannelRows).slice(0, 5),
  };
}

// ── Salons et catégories ───────────────────────────────────────────────────

const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const LISTED_TYPES = new Set([
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia,
  ChannelType.GuildVoice, ChannelType.GuildStageVoice,
]);

interface ChannelStat { messages: number; voiceMinutes: number }

async function channelStats(guildId: string, start: string, end: string): Promise<Map<string, ChannelStat>> {
  const rows = await prismaRead.$queryRaw<Array<{ channelId: string; messages: number; voiceMinutes: number }>>`
    SELECT "channelId", SUM("messagesCount")::int AS "messages", SUM("voiceMinutes")::int AS "voiceMinutes"
    FROM "channel_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}
    GROUP BY "channelId"
  `;
  return new Map(rows.map((r) => [r.channelId, { messages: r.messages, voiceMinutes: r.voiceMinutes }]));
}

async function lastActivity(guildId: string, channelIds: string[]): Promise<Map<string, string>> {
  if (channelIds.length === 0) return new Map();
  const rows = await prismaRead.$queryRaw<Array<{ channelId: string; last: string }>>`
    SELECT "channelId", MAX("dateKey") AS "last"
    FROM "channel_daily_stats"
    WHERE "guildId" = ${guildId} AND "channelId" IN (${Prisma.join(channelIds)})
      AND ("messagesCount" > 0 OR "voiceMinutes" > 0)
    GROUP BY "channelId"
  `;
  return new Map(rows.map((r) => [r.channelId, r.last]));
}

/** Rattache les stats des fils à leur salon parent, et écarte ce qui n'est plus sur le serveur. */
function foldThreads(guild: Guild, stats: Map<string, ChannelStat>): { byChannel: Map<string, ChannelStat>; orphan: ChannelStat } {
  const byChannel = new Map<string, ChannelStat>();
  const orphan: ChannelStat = { messages: 0, voiceMinutes: 0 };
  for (const [id, stat] of stats) {
    const channel = guild.channels.cache.get(id);
    const targetId = channel?.isThread() ? channel.parentId : channel ? id : null;
    const target = targetId ? byChannel.get(targetId) ?? { messages: 0, voiceMinutes: 0 } : orphan;
    target.messages += stat.messages;
    target.voiceMinutes += stat.voiceMinutes;
    if (targetId) byChannel.set(targetId, target);
  }
  return { byChannel, orphan };
}

async function authorsByChannel(guildId: string, start: string, end: string): Promise<Map<string, number>> {
  const rows = await prismaRead.$queryRaw<Array<{ channelId: string; n: number }>>`
    SELECT "channelId", COUNT(DISTINCT "userId")::int AS n
    FROM "message_content_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end} AND "messages" > 0
    GROUP BY "channelId"
  `;
  return new Map(rows.map((r) => [r.channelId, r.n]));
}

function sortedChildren(guild: Guild, parentId: string | null): GuildBasedChannel[] {
  return [...guild.channels.cache.values()]
    .filter((c) => LISTED_TYPES.has(c.type) && (c.parentId ?? null) === parentId)
    .sort((a, b) => {
      const av = VOICE_TYPES.has(a.type) ? 1 : 0;
      const bv = VOICE_TYPES.has(b.type) ? 1 : 0;
      return av - bv || ('rawPosition' in a && 'rawPosition' in b ? a.rawPosition - b.rawPosition : 0);
    });
}

const channelKind = (c: GuildBasedChannel) => (VOICE_TYPES.has(c.type) ? 'voice' : c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia ? 'forum' : 'text');

export async function getChannelTree(client: Client, guildId: string, range: DateRange) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { range, categories: [], totals: { messages: 0, voiceMinutes: 0 }, orphan: null };

  const [curRaw, prevRaw, authors] = await Promise.all([
    channelStats(guildId, range.start, range.end),
    channelStats(guildId, range.prevStart, range.prevEnd),
    authorsByChannel(guildId, range.start, range.end),
  ]);
  const cur = foldThreads(guild, curRaw);
  const prev = foldThreads(guild, prevRaw);
  const last = await lastActivity(guildId, [...guild.channels.cache.filter((c) => LISTED_TYPES.has(c.type)).keys()]);

  let totalMessages = cur.orphan.messages;
  let totalVoice = cur.orphan.voiceMinutes;
  for (const stat of cur.byChannel.values()) {
    totalMessages += stat.messages;
    totalVoice += stat.voiceMinutes;
  }

  const channelRow = (c: GuildBasedChannel) => {
    const stat = cur.byChannel.get(c.id) ?? { messages: 0, voiceMinutes: 0 };
    const before = prev.byChannel.get(c.id) ?? { messages: 0, voiceMinutes: 0 };
    return {
      id: c.id,
      name: c.name,
      kind: channelKind(c),
      messages: stat.messages,
      voiceMinutes: stat.voiceMinutes,
      prevMessages: before.messages,
      prevVoiceMinutes: before.voiceMinutes,
      authors: authors.get(c.id) ?? 0,
      lastActiveDate: last.get(c.id) ?? null,
    };
  };

  const categoryRow = (id: string | null, name: string | null) => {
    const channels = sortedChildren(guild, id).map(channelRow);
    const sum = (k: 'messages' | 'voiceMinutes' | 'prevMessages' | 'prevVoiceMinutes' | 'authors') => channels.reduce((s, c) => s + c[k], 0);
    return {
      id,
      name,
      messages: sum('messages'),
      voiceMinutes: sum('voiceMinutes'),
      prevMessages: sum('prevMessages'),
      prevVoiceMinutes: sum('prevVoiceMinutes'),
      // Somme par salon : un membre actif dans deux salons compte deux fois.
      authors: sum('authors'),
      channels,
    };
  };

  const categories = [
    categoryRow(null, null),
    ...[...guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildCategory)
      .sort((a, b) => ('rawPosition' in a && 'rawPosition' in b ? a.rawPosition - b.rawPosition : 0))
      .map((c) => categoryRow(c.id, c.name)),
  ].filter((c) => c.channels.length > 0);

  return {
    range,
    totals: { messages: totalMessages, voiceMinutes: totalVoice },
    orphan: cur.orphan.messages + cur.orphan.voiceMinutes > 0 ? cur.orphan : null,
    categories,
  };
}

export async function getCategoryDetail(client: Client, guildId: string, categoryId: string, range: DateRange) {
  const guild = client.guilds.cache.get(guildId);
  const category = guild?.channels.cache.get(categoryId);
  if (!guild || !category || category.type !== ChannelType.GuildCategory) return null;

  const children = sortedChildren(guild, categoryId);
  const childIds = children.map((c) => c.id);
  // Les fils actifs comptent pour leur salon parent.
  const threadParent = new Map<string, string>();
  for (const c of guild.channels.cache.values()) {
    if (c.isThread() && c.parentId && childIds.includes(c.parentId)) threadParent.set(c.id, c.parentId);
  }
  const statIds = [...childIds, ...threadParent.keys()];
  const scopeIds = statIds.length > 0 ? statIds : ['0'];

  const seriesScope: AnalyticsScope = {
    channelIds: scopeIds, userIds: null, excludeUserIds: [], channelFilter: null, roleFilter: null, excludeStaff: false,
  };
  const [tree, textDays, voiceSessions, memberMessages, guildTotals, prevGuildTotals, currentSeries, previousSeries] = await Promise.all([
    getChannelTree(client, guildId, range),
    prismaRead.$queryRaw<Array<{ dateKey: string; userId: string; messages: number }>>`
      SELECT "dateKey", "userId", SUM("messages")::int AS "messages"
      FROM "message_content_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}
        AND "channelId" IN (${Prisma.join(childIds.length > 0 ? childIds : ['0'])}) AND "messages" > 0
      GROUP BY "dateKey", "userId"
    `,
    prismaRead.dcVoiceSession.findMany({
      where: {
        guildId,
        channelId: { in: scopeIds },
        joinedAt: { gte: new Date(`${range.start}T00:00:00Z`), lte: new Date(`${range.end}T23:59:59Z`) },
      },
      select: { userId: true, joinedAt: true, leftAt: true },
      take: 50_000,
    }),
    prismaRead.$queryRaw<Array<{ userId: string; messages: number }>>`
      SELECT "userId", SUM("messages")::int AS "messages"
      FROM "message_content_daily_stats"
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}
        AND "channelId" IN (${Prisma.join(childIds.length > 0 ? childIds : ['0'])})
      GROUP BY "userId" ORDER BY "messages" DESC LIMIT 50
    `,
    prismaRead.guildDailyStat.aggregate({ where: { guildId, dateKey: { gte: range.start, lte: range.end } }, _sum: { messagesCount: true, voiceMinutes: true } }),
    prismaRead.guildDailyStat.aggregate({ where: { guildId, dateKey: { gte: range.prevStart, lte: range.prevEnd } }, _sum: { messagesCount: true, voiceMinutes: true } }),
    dailyActivity(guildId, range.start, range.end, seriesScope),
    dailyActivity(guildId, range.prevStart, range.prevEnd, seriesScope),
  ]);

  // Messages et vocal jour par jour, la période et celle d'avant alignées : les
  // courbes de la fiche, avec la comparaison en pointillé.
  const fillDays = (rows: DayRow[], start: string, end: string): DayRow[] => {
    const byKey = new Map(rows.map((r) => [r.dateKey, r]));
    return dayKeys(start, end).map((dateKey) => ({
      dateKey,
      messages: Number(byKey.get(dateKey)?.messages ?? 0),
      voiceMinutes: Number(byKey.get(dateKey)?.voiceMinutes ?? 0),
    }));
  };
  const series = {
    current: fillDays(currentSeries.rows, range.start, range.end),
    previous: fillDays(previousSeries.rows, range.prevStart, range.prevEnd),
  };

  const row = tree.categories.find((c) => c.id === categoryId);
  const channels = row?.channels ?? [];

  // Membres actifs par jour : texte seul, vocal seul, les deux.
  const textByDay = new Map<string, Set<string>>();
  for (const r of textDays) {
    const set = textByDay.get(r.dateKey) ?? new Set<string>();
    set.add(r.userId);
    textByDay.set(r.dateKey, set);
  }
  const voiceByDay = new Map<string, Set<string>>();
  const voiceByUser = new Map<string, number>();
  for (const s of voiceSessions) {
    const key = keyOf(s.joinedAt);
    const set = voiceByDay.get(key) ?? new Set<string>();
    set.add(s.userId);
    voiceByDay.set(key, set);
    const minutes = s.leftAt ? Math.max(0, Math.round((s.leftAt.getTime() - s.joinedAt.getTime()) / 60000)) : 0;
    voiceByUser.set(s.userId, (voiceByUser.get(s.userId) ?? 0) + minutes);
  }
  const allActive = new Set<string>();
  const daily = dayKeys(range.start, range.end).map((dateKey) => {
    const text = textByDay.get(dateKey) ?? new Set<string>();
    const voice = voiceByDay.get(dateKey) ?? new Set<string>();
    let both = 0;
    for (const id of text) {
      allActive.add(id);
      if (voice.has(id)) both += 1;
    }
    for (const id of voice) allActive.add(id);
    return { dateKey, textOnly: text.size - both, voiceOnly: voice.size - both, both };
  });

  const members = new Map<string, { messages: number; voiceMinutes: number }>();
  for (const r of memberMessages) members.set(r.userId, { messages: r.messages, voiceMinutes: voiceByUser.get(r.userId) ?? 0 });
  for (const [userId, minutes] of voiceByUser) {
    if (!members.has(userId)) members.set(userId, { messages: 0, voiceMinutes: minutes });
  }
  const topMembers = [...members.entries()]
    .sort((a, b) => (b[1].messages + b[1].voiceMinutes / 10) - (a[1].messages + a[1].voiceMinutes / 10))
    .slice(0, 8)
    .map(([userId, stat]) => {
      const member = guild.members.cache.get(userId);
      return {
        userId,
        name: member?.displayName ?? null,
        avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? null,
        ...stat,
      };
    });

  const serverMessages = guildTotals._sum.messagesCount ?? 0;
  const serverVoice = guildTotals._sum.voiceMinutes ?? 0;
  const prevServerMessages = prevGuildTotals._sum.messagesCount ?? 0;
  const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

  return {
    range,
    id: categoryId,
    name: category.name,
    kpis: {
      messages: { value: row?.messages ?? 0, previous: row?.prevMessages ?? 0 },
      voiceMinutes: { value: row?.voiceMinutes ?? 0, previous: row?.prevVoiceMinutes ?? 0 },
      activeMembers: allActive.size,
      messageShare: { value: share(row?.messages ?? 0, serverMessages), previous: share(row?.prevMessages ?? 0, prevServerMessages) },
      voiceShare: share(row?.voiceMinutes ?? 0, serverVoice),
    },
    daily,
    series,
    // La timeline vocale n'est gardée que 60 jours.
    voiceHistoryDays: 60,
    channels,
    topMembers,
  };
}

// ── Options de filtres ─────────────────────────────────────────────────────

export async function getFilterOptions(client: Client, guildId: string) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { categories: [], roles: [] };

  const categories = [
    { id: null as string | null, name: null as string | null },
    ...[...guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildCategory)
      .sort((a, b) => ('rawPosition' in a && 'rawPosition' in b ? a.rawPosition - b.rawPosition : 0))
      .map((c) => ({ id: c.id as string | null, name: c.name as string | null })),
  ]
    .map((cat) => ({
      ...cat,
      channels: sortedChildren(guild, cat.id).map((c) => ({ id: c.id, name: c.name, kind: channelKind(c) })),
    }))
    .filter((cat) => cat.channels.length > 0);

  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, members: r.members.size }));

  return { categories, roles };
}
