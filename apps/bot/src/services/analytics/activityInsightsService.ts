/**
 * activityInsightsService.ts
 *
 * Lectures des vues Messages et Vocal d'Analytics : séries par jour enrichies
 * (membres actifs, arrivées, départs), pas horaire, classements filtrés avec
 * écart et mini-courbe, ventilation par salon ou catégorie, pics et creux
 * inhabituels, annotations posées sur les courbes.
 *
 * Tout suit le périmètre de la page (salon, rôle, staff exclu) quand une table
 * le permet ; sinon la réponse le dit (`available: false`) au lieu de servir
 * un chiffre du serveur entier sous un filtre qui ne s'applique pas.
 */

import { Prisma } from '@prisma/client';
import type { Client, Guild } from 'discord.js';
import { prisma, prismaRead } from '../../utils/db.js';
import {
  addDays,
  dailyActivity,
  dayKeys,
  getActivityAnalytics,
  hasUserScope,
  scopeSql,
  type AnalyticsScope,
  type DateRange,
} from './contentAnalyticsService.js';
import { BucketZoner, ZONE_MARGIN_DAYS, shiftKey } from './zonedBuckets.js';

export type ActivityMetric = 'messages' | 'voice';

// ── Outils ─────────────────────────────────────────────────────────────────

/** Un fil compte pour son salon parent. */
function channelParent(guild: Guild | null, id: string): string {
  const channel = guild?.channels.cache.get(id);
  return channel?.isThread() && channel.parentId ? channel.parentId : id;
}

/** Catégorie d'un salon (ou du salon parent d'un fil) ; null = sans catégorie. */
function channelCategory(guild: Guild | null, id: string): string | null {
  const base = guild?.channels.cache.get(channelParent(guild, id));
  return base && 'parentId' in base ? (base.parentId ?? null) : null;
}

/** Ramène une série longue à `max` points en sommant des paquets de jours. */
export function bucketize(values: number[], max = 30): number[] {
  if (values.length <= max) return values;
  const size = Math.ceil(values.length / max);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size).reduce((s, v) => s + v, 0));
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ── Séries par jour enrichies ──────────────────────────────────────────────

async function dailyActiveMembers(guildId: string, start: string, end: string, scope: AnalyticsScope): Promise<Map<string, number>> {
  const rows = scope.channelIds
    ? await prismaRead.$queryRaw<Array<{ dateKey: string; n: number }>>`
        SELECT "dateKey", COUNT(DISTINCT "userId")::int AS n FROM "message_content_daily_stats"
        WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end} AND "messages" > 0${scopeSql(scope)}
        GROUP BY "dateKey"
      `
    : await prismaRead.$queryRaw<Array<{ dateKey: string; n: number }>>`
        SELECT "dateKey", COUNT(DISTINCT "userId")::int AS n FROM "member_daily_stats"
        WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}
          AND ("messagesCount" > 0 OR "voiceMinutes" > 0)${scopeSql(scope, { channels: false })}
        GROUP BY "dateKey"
      `;
  return new Map(rows.map((r) => [r.dateKey, r.n]));
}

async function dailyFlow(guildId: string, start: string, end: string): Promise<Map<string, { joined: number; left: number }>> {
  const rows = await prismaRead.guildDailyStat.findMany({
    where: { guildId, dateKey: { gte: start, lte: end } },
    select: { dateKey: true, membersJoined: true, membersLeft: true },
  });
  return new Map(rows.map((r) => [r.dateKey, { joined: r.membersJoined, left: r.membersLeft }]));
}

export interface Anomaly {
  dateKey: string;
  metric: 'messages' | 'voiceMinutes';
  value: number;
  /** Valeur habituelle : médiane des quatre mêmes jours de semaine précédents. */
  expected: number;
  direction: 'up' | 'down';
  /** Salon qui pèse le plus ce jour-là, pour expliquer un pic. */
  driver: { channelId: string; name: string | null; share: number } | null;
}

const ANOMALY_LIMIT = 6;

/**
 * Pics et creux inhabituels. Un jour est comparé aux quatre mêmes jours de
 * semaine qui le précèdent (le samedi au samedi), ce qui absorbe le creux
 * normal du week-end. Il faut au moins trois jours de référence connus, et
 * des volumes suffisants pour qu'un « +200 % » ne soit pas passé de 1 à 3.
 */
export function detectAnomalies(
  days: string[],
  history: Map<string, number>,
  metric: Anomaly['metric'],
): Omit<Anomaly, 'driver'>[] {
  const minVolume = metric === 'messages' ? 20 : 60;
  const found: Array<Omit<Anomaly, 'driver'> & { score: number }> = [];
  for (const dateKey of days) {
    const reference = [7, 14, 21, 28]
      .map((n) => history.get(addDays(dateKey, -n)))
      .filter((v): v is number => v !== undefined);
    if (reference.length < 3) continue;
    const expected = median(reference);
    const value = history.get(dateKey) ?? 0;
    if (value >= minVolume && value >= expected * 1.8 && value - expected >= minVolume / 2) {
      found.push({ dateKey, metric, value, expected: Math.round(expected), direction: 'up', score: value / Math.max(1, expected) });
    } else if (expected >= minVolume * 1.5 && value <= expected * 0.35) {
      found.push({ dateKey, metric, value, expected: Math.round(expected), direction: 'down', score: expected / Math.max(1, value) });
    }
  }
  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, ANOMALY_LIMIT)
    .map(({ score: _score, ...rest }) => rest)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

async function anomalyDrivers(
  guild: Guild | null,
  guildId: string,
  scope: AnalyticsScope,
  anomalies: Omit<Anomaly, 'driver'>[],
): Promise<Anomaly[]> {
  const ups = anomalies.filter((a) => a.direction === 'up');
  if (ups.length === 0) return anomalies.map((a) => ({ ...a, driver: null }));
  const keys = [...new Set(ups.map((a) => a.dateKey))];
  const users = hasUserScope(scope);
  const rows = users
    ? await prismaRead.$queryRaw<Array<{ dateKey: string; channelId: string; messages: number; voiceMinutes: number }>>`
        SELECT "dateKey", "channelId", SUM("messages")::int AS "messages", 0 AS "voiceMinutes"
        FROM "message_content_daily_stats"
        WHERE "guildId" = ${guildId} AND "dateKey" IN (${Prisma.join(keys)})${scopeSql(scope)}
        GROUP BY "dateKey", "channelId"
      `
    : await prismaRead.$queryRaw<Array<{ dateKey: string; channelId: string; messages: number; voiceMinutes: number }>>`
        SELECT "dateKey", "channelId", SUM("messagesCount")::int AS "messages", SUM("voiceMinutes")::int AS "voiceMinutes"
        FROM "channel_daily_stats"
        WHERE "guildId" = ${guildId} AND "dateKey" IN (${Prisma.join(keys)})${scopeSql(scope, { users: false })}
        GROUP BY "dateKey", "channelId"
      `;

  return anomalies.map((a) => {
    if (a.direction !== 'up' || (users && a.metric === 'voiceMinutes')) return { ...a, driver: null };
    const field = a.metric === 'messages' ? 'messages' : 'voiceMinutes';
    const byChannel = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      if (r.dateKey !== a.dateKey) continue;
      const id = channelParent(guild, r.channelId);
      byChannel.set(id, (byChannel.get(id) ?? 0) + r[field]);
      total += r[field];
    }
    const top = [...byChannel.entries()].sort((x, y) => y[1] - x[1])[0];
    if (!top || total === 0) return { ...a, driver: null };
    return {
      ...a,
      driver: { channelId: top[0], name: guild?.channels.cache.get(top[0])?.name ?? null, share: Math.round((top[1] / total) * 1000) / 10 },
    };
  });
}

/**
 * Réponse de /analytics/activity : celle de `getActivityAnalytics`, dont la
 * série porte en plus les membres actifs, arrivées et départs du jour (pour
 * que chaque tuile puisse piloter la courbe), et les jours inhabituels.
 */
export async function getActivityInsights(client: Client, guildId: string, range: DateRange, scope: AnalyticsScope, includeBots = false) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const baselineStart = addDays(range.start, -28);
  const [base, activeNow, activePrev, flow, history] = await Promise.all([
    getActivityAnalytics(client, guildId, range, scope, includeBots),
    dailyActiveMembers(guildId, range.start, range.end, scope),
    dailyActiveMembers(guildId, range.prevStart, range.prevEnd, scope),
    dailyFlow(guildId, range.prevStart, range.end),
    dailyActivity(guildId, baselineStart, range.end, scope),
  ]);

  const prevKeys = dayKeys(range.prevStart, range.prevEnd);
  const series = base.series.map((d, i) => {
    const prevKey = prevKeys[i]!;
    return {
      ...d,
      activeMembers: activeNow.get(d.dateKey) ?? 0,
      prevActiveMembers: activePrev.get(prevKey) ?? 0,
      joined: flow.get(d.dateKey)?.joined ?? 0,
      left: flow.get(d.dateKey)?.left ?? 0,
      prevJoined: flow.get(prevKey)?.joined ?? 0,
      prevLeft: flow.get(prevKey)?.left ?? 0,
    };
  });

  const days = dayKeys(range.start, range.end);
  const messageHistory = new Map(history.rows.map((r) => [r.dateKey, r.messages]));
  const voiceHistory = new Map(history.rows.map((r) => [r.dateKey, r.voiceMinutes]));
  const raw = [
    ...detectAnomalies(days, messageHistory, 'messages'),
    ...(history.voiceAvailable ? detectAnomalies(days, voiceHistory, 'voiceMinutes') : []),
  ];
  const anomalies = await anomalyDrivers(guild, guildId, scope, raw);

  return { ...base, series, anomalies };
}

// ── Pas horaire ────────────────────────────────────────────────────────────

/** Au-delà, une courbe heure par heure devient illisible. */
export const HOURLY_MAX_DAYS = 14;

interface HourPoint { key: string; messages: number; voiceMinutes: number; activeMembers: number }

/**
 * Série heure par heure, dans le fuseau du lecteur. Les créneaux horaires ne
 * sont tenus que pour le serveur entier : sous un filtre de salon ou de rôle,
 * la réponse est marquée indisponible et la page reste au pas du jour.
 */
export async function getActivityHourly(guildId: string, range: DateRange, scope: AnalyticsScope, timezone: string) {
  if (range.days > HOURLY_MAX_DAYS || scope.channelIds || hasUserScope(scope)) {
    return { available: false as const, timezone, points: [] as HourPoint[], prev: [] as HourPoint[] };
  }
  const zoner = new BucketZoner(timezone);
  const rows = await prismaRead.guildHourlyStat.findMany({
    where: {
      guildId,
      dateKey: { gte: shiftKey(range.prevStart, -ZONE_MARGIN_DAYS), lte: shiftKey(range.end, ZONE_MARGIN_DAYS) },
    },
    select: { dateKey: true, hour: true, messagesCount: true, voiceMinutes: true, activeMembers: true },
  });

  const byKey = new Map<string, HourPoint>();
  for (const r of rows) {
    const local = zoner.fromKeyHour(r.dateKey, r.hour);
    const key = `${local.dateKey} ${String(local.hour).padStart(2, '0')}`;
    const point = byKey.get(key) ?? { key, messages: 0, voiceMinutes: 0, activeMembers: 0 };
    point.messages += r.messagesCount;
    point.voiceMinutes += r.voiceMinutes;
    point.activeMembers = Math.max(point.activeMembers, r.activeMembers);
    byKey.set(key, point);
  }

  const now = zoner.fromDate(new Date());
  const nowKey = `${now.dateKey} ${String(now.hour).padStart(2, '0')}`;
  const hoursOf = (start: string, end: string) =>
    dayKeys(start, end).flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d} ${String(h).padStart(2, '0')}`));
  const pick = (key: string): HourPoint => byKey.get(key) ?? { key, messages: 0, voiceMinutes: 0, activeMembers: 0 };

  // Les heures à venir de la journée en cours ne sont pas des zéros.
  const currentKeys = hoursOf(range.start, range.end).filter((k) => k <= nowKey);
  const prevKeys = hoursOf(range.prevStart, range.prevEnd).slice(0, currentKeys.length);
  return { available: true as const, timezone, points: currentKeys.map(pick), prev: prevKeys.map(pick) };
}

// ── Classements ────────────────────────────────────────────────────────────

export interface RankingItem {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  value: number;
  previous: number;
  /** Part du total de la période, en %. */
  share: number;
  /** Mini-courbe, 30 points au plus. */
  spark: number[];
  deleted?: boolean;
}

export const RANKING_MAX = 500;

type Source = { table: Prisma.Sql; column: Prisma.Sql; scope: Prisma.Sql };

/** Table et colonne à lire pour une mesure par membre, ou null si le filtre ne s'y applique pas. */
function memberSource(metric: ActivityMetric, scope: AnalyticsScope): Source | null {
  if (scope.channelIds) {
    if (metric === 'voice') return null;
    return { table: Prisma.raw('"message_content_daily_stats"'), column: Prisma.raw('"messages"'), scope: scopeSql(scope) };
  }
  return {
    table: Prisma.raw('"member_daily_stats"'),
    column: Prisma.raw(metric === 'messages' ? '"messagesCount"' : '"voiceMinutes"'),
    scope: scopeSql(scope, { channels: false }),
  };
}

/** Idem par salon. */
function channelSource(metric: ActivityMetric, scope: AnalyticsScope): Source | null {
  if (hasUserScope(scope)) {
    if (metric === 'voice') return null;
    return { table: Prisma.raw('"message_content_daily_stats"'), column: Prisma.raw('"messages"'), scope: scopeSql(scope) };
  }
  return {
    table: Prisma.raw('"channel_daily_stats"'),
    column: Prisma.raw(metric === 'messages' ? '"messagesCount"' : '"voiceMinutes"'),
    scope: scopeSql(scope, { users: false }),
  };
}

async function sumOver(guildId: string, src: Source, start: string, end: string): Promise<number> {
  const rows = await prismaRead.$queryRaw<Array<{ v: number }>>`
    SELECT COALESCE(SUM(${src.column}), 0)::int AS v FROM ${src.table}
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}${src.scope}
  `;
  return rows[0]?.v ?? 0;
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

async function memberRankings(client: Client, guildId: string, range: DateRange, src: Source, limit: number, includeBots: boolean) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  // On lit plus large que demandé : les bots et les inconnus sont écartés après coup.
  const top = await prismaRead.$queryRaw<Array<{ userId: string; v: number }>>`
    SELECT "userId", SUM(${src.column})::int AS v FROM ${src.table}
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}${src.scope}
    GROUP BY "userId" HAVING SUM(${src.column}) > 0
    ORDER BY v DESC LIMIT ${Prisma.raw(String(Math.trunc(limit) + 50))}
  `;
  const ids = top.map((r) => r.userId);
  const profiles = ids.length > 0
    ? await prismaRead.memberProfile.findMany({
        where: { guildId, userId: { in: ids } },
        select: { userId: true, displayName: true, globalName: true, username: true, avatarUrl: true, isBot: true },
      })
    : [];
  const profileOf = new Map(profiles.map((p) => [p.userId, p]));

  const kept = top
    .filter((r) => {
      const member = guild?.members.cache.get(r.userId);
      const profile = profileOf.get(r.userId);
      // Un inconnu sans profil ni présence en cache n'est pas supposé humain.
      if (!member && !profile) return false;
      const isBot = member?.user.bot ?? profile?.isBot ?? false;
      return includeBots || !isBot;
    })
    .slice(0, limit);
  const keptIds = kept.map((r) => r.userId);

  const [prevRows, sparkRows, total, prevTotal] = await Promise.all([
    keptIds.length > 0
      ? prismaRead.$queryRaw<Array<{ userId: string; v: number }>>`
          SELECT "userId", SUM(${src.column})::int AS v FROM ${src.table}
          WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.prevStart} AND "dateKey" <= ${range.prevEnd}
            AND "userId" IN (${Prisma.join(keptIds)})${src.scope}
          GROUP BY "userId"
        `
      : Promise.resolve([]),
    keptIds.length > 0
      ? prismaRead.$queryRaw<Array<{ userId: string; dateKey: string; v: number }>>`
          SELECT "userId", "dateKey", SUM(${src.column})::int AS v FROM ${src.table}
          WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}
            AND "userId" IN (${Prisma.join(keptIds)})${src.scope}
          GROUP BY "userId", "dateKey"
        `
      : Promise.resolve([]),
    sumOver(guildId, src, range.start, range.end),
    sumOver(guildId, src, range.prevStart, range.prevEnd),
  ]);

  const prevOf = new Map(prevRows.map((r) => [r.userId, r.v]));
  const days = dayKeys(range.start, range.end);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const sparks = new Map<string, number[]>();
  for (const r of sparkRows) {
    const arr = sparks.get(r.userId) ?? new Array<number>(days.length).fill(0);
    const i = dayIndex.get(r.dateKey);
    if (i !== undefined) arr[i] = r.v;
    sparks.set(r.userId, arr);
  }

  const items: RankingItem[] = kept.map((r) => {
    const member = guild?.members.cache.get(r.userId);
    const profile = profileOf.get(r.userId);
    return {
      id: r.userId,
      name: member?.displayName ?? profile?.displayName ?? profile?.globalName ?? profile?.username ?? null,
      avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? profile?.avatarUrl ?? null,
      value: r.v,
      previous: prevOf.get(r.userId) ?? 0,
      share: share(r.v, total),
      spark: bucketize(sparks.get(r.userId) ?? new Array<number>(days.length).fill(0)),
    };
  });
  return { total, prevTotal, items };
}

async function channelRankings(client: Client, guildId: string, range: DateRange, src: Source, limit: number) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const [cur, prev] = await Promise.all(
    [[range.start, range.end], [range.prevStart, range.prevEnd]].map(([start, end]) =>
      prismaRead.$queryRaw<Array<{ channelId: string; v: number }>>`
        SELECT "channelId", SUM(${src.column})::int AS v FROM ${src.table}
        WHERE "guildId" = ${guildId} AND "dateKey" >= ${start} AND "dateKey" <= ${end}${src.scope}
        GROUP BY "channelId"
      `),
  );

  const fold = (rows: Array<{ channelId: string; v: number }>) => {
    const out = new Map<string, number>();
    for (const r of rows) {
      const id = channelParent(guild, r.channelId);
      out.set(id, (out.get(id) ?? 0) + r.v);
    }
    return out;
  };
  const curMap = fold(cur!);
  const prevMap = fold(prev!);
  const total = [...curMap.values()].reduce((s, v) => s + v, 0);
  const prevTotal = [...prevMap.values()].reduce((s, v) => s + v, 0);
  const top = [...curMap.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, limit);

  // Les fils des salons retenus entrent dans leur mini-courbe.
  const topIds = new Set(top.map(([id]) => id));
  const statIds = cur!.map((r) => r.channelId).filter((id) => topIds.has(channelParent(guild, id)));
  const days = dayKeys(range.start, range.end);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const sparks = new Map<string, number[]>();
  if (statIds.length > 0) {
    const rows = await prismaRead.$queryRaw<Array<{ channelId: string; dateKey: string; v: number }>>`
      SELECT "channelId", "dateKey", SUM(${src.column})::int AS v FROM ${src.table}
      WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}
        AND "channelId" IN (${Prisma.join(statIds)})${src.scope}
      GROUP BY "channelId", "dateKey"
    `;
    for (const r of rows) {
      const id = channelParent(guild, r.channelId);
      const arr = sparks.get(id) ?? new Array<number>(days.length).fill(0);
      const i = dayIndex.get(r.dateKey);
      if (i !== undefined) arr[i] = (arr[i] ?? 0) + r.v;
      sparks.set(id, arr);
    }
  }

  const items: RankingItem[] = top.map(([id, value]) => {
    const channel = guild?.channels.cache.get(id);
    return {
      id,
      name: channel?.name ?? null,
      avatarUrl: null,
      value,
      previous: prevMap.get(id) ?? 0,
      share: share(value, total),
      spark: bucketize(sparks.get(id) ?? new Array<number>(days.length).fill(0)),
      ...(channel ? {} : { deleted: true }),
    };
  });
  return { total, prevTotal, items };
}

export async function getActivityRankings(
  client: Client,
  guildId: string,
  range: DateRange,
  scope: AnalyticsScope,
  metric: ActivityMetric,
  dimension: 'members' | 'channels',
  limit: number,
  includeBots = false,
) {
  const capped = Math.min(RANKING_MAX, Math.max(1, limit));
  const src = dimension === 'members' ? memberSource(metric, scope) : channelSource(metric, scope);
  if (!src) return { available: false as const, metric, dimension, total: 0, prevTotal: 0, items: [] as RankingItem[] };
  const result = dimension === 'members'
    ? await memberRankings(client, guildId, range, src, capped, includeBots)
    : await channelRankings(client, guildId, range, src, capped);
  return { available: true as const, metric, dimension, ...result };
}

// ── Ventilation par salon ou catégorie ─────────────────────────────────────

export const BREAKDOWN_GROUPS = 5;

/**
 * Mesure jour par jour découpée entre les cinq salons (ou catégories) qui
 * pèsent le plus, le reste regroupé dans « Autres ». Sert l'aire empilée.
 */
export async function getActivityBreakdown(
  client: Client,
  guildId: string,
  range: DateRange,
  scope: AnalyticsScope,
  metric: ActivityMetric,
  dimension: 'channel' | 'category',
) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const days = dayKeys(range.start, range.end);
  const src = channelSource(metric, scope);
  if (!src) return { available: false as const, dates: days, groups: [], other: [] as number[] };

  const rows = await prismaRead.$queryRaw<Array<{ dateKey: string; channelId: string; v: number }>>`
    SELECT "dateKey", "channelId", SUM(${src.column})::int AS v FROM ${src.table}
    WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND "dateKey" <= ${range.end}${src.scope}
    GROUP BY "dateKey", "channelId"
  `;

  const NONE = '__none__';
  const groupOf = (channelId: string) =>
    dimension === 'channel' ? channelParent(guild, channelId) : (channelCategory(guild, channelId) ?? NONE);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const byGroup = new Map<string, number[]>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    const id = groupOf(r.channelId);
    const arr = byGroup.get(id) ?? new Array<number>(days.length).fill(0);
    const i = dayIndex.get(r.dateKey);
    if (i !== undefined) arr[i] = (arr[i] ?? 0) + r.v;
    byGroup.set(id, arr);
    totals.set(id, (totals.get(id) ?? 0) + r.v);
  }

  const ordered = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const kept = ordered.slice(0, BREAKDOWN_GROUPS);
  const other = new Array<number>(days.length).fill(0);
  for (const [id] of ordered.slice(BREAKDOWN_GROUPS)) {
    byGroup.get(id)!.forEach((v, i) => { other[i] = (other[i] ?? 0) + v; });
  }

  return {
    available: true as const,
    dates: days,
    groups: kept.map(([id, total]) => ({
      id: id === NONE ? null : id,
      name: id === NONE ? null : (guild?.channels.cache.get(id)?.name ?? null),
      total,
      values: byGroup.get(id)!,
    })),
    other,
  };
}

// ── Annotations ────────────────────────────────────────────────────────────

export const ANNOTATION_LABEL_MAX = 80;
const ANNOTATIONS_PER_GUILD_MAX = 1000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function listAnnotations(client: Client, guildId: string, start: string, end: string) {
  const rows = await prismaRead.analyticsAnnotation.findMany({
    where: { guildId, dateKey: { gte: start, lte: end } },
    orderBy: [{ dateKey: 'asc' }, { createdAt: 'asc' }],
    take: 300,
  });
  const guild = client.guilds.cache.get(guildId) ?? null;
  const missing = [...new Set(rows.map((r) => r.authorId))].filter((id) => !guild?.members.cache.has(id));
  const profiles = missing.length > 0
    ? await prismaRead.memberProfile.findMany({
        where: { guildId, userId: { in: missing } },
        select: { userId: true, displayName: true, globalName: true, username: true },
      })
    : [];
  const profileOf = new Map(profiles.map((p) => [p.userId, p]));
  return rows.map((r) => {
    const profile = profileOf.get(r.authorId);
    return {
      id: r.id,
      dateKey: r.dateKey,
      label: r.label,
      authorId: r.authorId,
      authorName: guild?.members.cache.get(r.authorId)?.displayName ?? profile?.displayName ?? profile?.globalName ?? profile?.username ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export type AnnotationInputError = 'invalid_date' | 'invalid_label' | 'too_many';

export function validateAnnotation(input: { dateKey?: unknown; label?: unknown }): { dateKey: string; label: string } | AnnotationInputError {
  const dateKey = typeof input.dateKey === 'string' ? input.dateKey : '';
  if (!DATE_KEY_RE.test(dateKey) || Number.isNaN(Date.parse(`${dateKey}T00:00:00Z`))) return 'invalid_date';
  const label = typeof input.label === 'string' ? input.label.replace(/\s+/g, ' ').trim() : '';
  if (label.length === 0 || label.length > ANNOTATION_LABEL_MAX) return 'invalid_label';
  return { dateKey, label };
}

export async function createAnnotation(guildId: string, authorId: string, input: { dateKey: string; label: string }) {
  const count = await prisma.analyticsAnnotation.count({ where: { guildId } });
  if (count >= ANNOTATIONS_PER_GUILD_MAX) return 'too_many' as const;
  return prisma.analyticsAnnotation.create({ data: { guildId, authorId, dateKey: input.dateKey, label: input.label } });
}

/** L'auteur retire sa note ; un administrateur du dashboard retire n'importe laquelle. */
export async function deleteAnnotation(guildId: string, id: string, userId: string, canManage: boolean) {
  const row = await prisma.analyticsAnnotation.findFirst({ where: { id, guildId } });
  if (!row) return 'not_found' as const;
  if (row.authorId !== userId && !canManage) return 'forbidden' as const;
  await prisma.analyticsAnnotation.delete({ where: { id } });
  return 'ok' as const;
}
