/**
 * Lecture des données Kotbo × AegisAI pour le dashboard : section « Climat »
 * d'Analytics (toxicité, émotions, salons, heures) et fiche d'un membre.
 * Tout se lit dans les agrégats, jamais dans le contenu des messages.
 */
import type { Client } from 'discord.js';
import { prismaRead } from '../../../utils/db.js';
import { dayKeys, type DateRange } from '../../analytics/contentAnalyticsService.js';
import { AEGIS_EMOTIONS, type AegisEmotion } from './aegisClient.js';

type EmotionCounts = Record<AegisEmotion, number>;

type AggRow = {
  analyzed: number;
  toxic: number;
  severe: number;
  toxicityMilli: number;
  emotionAnalyzed: number;
} & EmotionCounts;

const SUMS = `
  COALESCE(SUM("analyzed"), 0)::int AS "analyzed",
  COALESCE(SUM("toxic"), 0)::int AS "toxic",
  COALESCE(SUM("severe"), 0)::int AS "severe",
  COALESCE(SUM("toxicityMilli"), 0)::bigint AS "toxicityMilli",
  COALESCE(SUM("emotionAnalyzed"), 0)::int AS "emotionAnalyzed",
  COALESCE(SUM("joy"), 0)::int AS "joy",
  COALESCE(SUM("sad"), 0)::int AS "sad",
  COALESCE(SUM("anger"), 0)::int AS "anger",
  COALESCE(SUM("fear"), 0)::int AS "fear",
  COALESCE(SUM("surprise"), 0)::int AS "surprise",
  COALESCE(SUM("neutral"), 0)::int AS "neutral"`;

const EMPTY: AggRow = { analyzed: 0, toxic: 0, severe: 0, toxicityMilli: 0, emotionAnalyzed: 0, joy: 0, sad: 0, anger: 0, fear: 0, surprise: 0, neutral: 0 };

/** `bigint` de Postgres → number. */
function normalize<T extends Partial<AggRow>>(row: T): T {
  const out = { ...row };
  for (const key of Object.keys(out) as Array<keyof T>) {
    if (typeof out[key] === 'bigint') out[key] = Number(out[key]) as T[keyof T];
  }
  return out;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function emotionsOf(row: EmotionCounts): EmotionCounts {
  return Object.fromEntries(AEGIS_EMOTIONS.map((e) => [e, row[e] ?? 0])) as EmotionCounts;
}

/** Émotion la plus fréquente hors « neutre », ou neutre s'il n'y a qu'elle. */
export function dominantEmotion(row: EmotionCounts): AegisEmotion | null {
  let best: AegisEmotion | null = null;
  for (const emotion of AEGIS_EMOTIONS) {
    if (emotion === 'neutral' || !row[emotion]) continue;
    if (!best || row[emotion] > row[best]) best = emotion;
  }
  if (best) return best;
  return row.neutral ? 'neutral' : null;
}

/** Résumé d'un agrégat : taux, moyenne, émotions. Pur, pour les tests. */
export function summarize(row: AggRow) {
  return {
    analyzed: row.analyzed,
    toxic: row.toxic,
    severe: row.severe,
    toxicRate: pct(row.toxic, row.analyzed),
    avgToxicity: row.analyzed > 0 ? Math.round(row.toxicityMilli / row.analyzed) / 10 : null,
    emotionAnalyzed: row.emotionAnalyzed,
    emotions: emotionsOf(row),
    dominant: dominantEmotion(row),
  };
}

async function totals(guildId: string, start: string, end: string): Promise<AggRow> {
  const rows = await prismaRead.$queryRawUnsafe<AggRow[]>(
    `SELECT ${SUMS} FROM "aegis_hourly_stats" WHERE "guildId" = $1 AND "dateKey" BETWEEN $2 AND $3`,
    guildId, start, end,
  );
  return rows[0] ? normalize(rows[0]) : EMPTY;
}

async function daily(guildId: string, start: string, end: string): Promise<Map<string, AggRow>> {
  const rows = await prismaRead.$queryRawUnsafe<Array<AggRow & { dateKey: string }>>(
    `SELECT "dateKey", ${SUMS} FROM "aegis_hourly_stats"
     WHERE "guildId" = $1 AND "dateKey" BETWEEN $2 AND $3 GROUP BY "dateKey"`,
    guildId, start, end,
  );
  return new Map(rows.map((r) => [r.dateKey, normalize(r)]));
}

function series(keys: string[], byDay: Map<string, AggRow>) {
  return keys.map((dateKey) => {
    const row = byDay.get(dateKey) ?? EMPTY;
    return {
      dateKey,
      analyzed: row.analyzed,
      toxic: row.toxic,
      severe: row.severe,
      toxicRate: pct(row.toxic, row.analyzed),
      avgToxicity: row.analyzed > 0 ? Math.round(row.toxicityMilli / row.analyzed) / 10 : null,
      ...emotionsOf(row),
    };
  });
}

export async function getClimateAnalytics(client: Client, guildId: string, range: DateRange) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const [config, current, previous, byDay, byPrevDay, heatRows, channelRows, memberRows, detectionRows] = await Promise.all([
    prismaRead.aegisConfig.findUnique({ where: { guildId }, select: { enabled: true, reviewThreshold: true, autoThreshold: true } }),
    totals(guildId, range.start, range.end),
    totals(guildId, range.prevStart, range.prevEnd),
    daily(guildId, range.start, range.end),
    daily(guildId, range.prevStart, range.prevEnd),
    // Jour ISO (1 = lundi) × heure UTC.
    prismaRead.$queryRawUnsafe<Array<{ dow: number; hour: number; analyzed: number; toxic: number; anger: number }>>(
      `SELECT EXTRACT(ISODOW FROM "dateKey"::date)::int AS "dow", "hour",
              COALESCE(SUM("analyzed"), 0)::int AS "analyzed", COALESCE(SUM("toxic"), 0)::int AS "toxic",
              COALESCE(SUM("anger"), 0)::int AS "anger"
       FROM "aegis_hourly_stats" WHERE "guildId" = $1 AND "dateKey" BETWEEN $2 AND $3
       GROUP BY 1, 2`,
      guildId, range.start, range.end,
    ),
    prismaRead.$queryRawUnsafe<Array<AggRow & { channelId: string }>>(
      `SELECT "channelId", ${SUMS} FROM "aegis_hourly_stats"
       WHERE "guildId" = $1 AND "dateKey" BETWEEN $2 AND $3
       GROUP BY "channelId" ORDER BY SUM("toxic") DESC, SUM("analyzed") DESC LIMIT 25`,
      guildId, range.start, range.end,
    ),
    prismaRead.$queryRawUnsafe<Array<{ userId: string; analyzed: number; toxic: number; toxicityMilli: number }>>(
      `SELECT "userId", COALESCE(SUM("analyzed"), 0)::int AS "analyzed", COALESCE(SUM("toxic"), 0)::int AS "toxic",
              COALESCE(SUM("toxicityMilli"), 0)::bigint AS "toxicityMilli"
       FROM "aegis_member_daily_stats" WHERE "guildId" = $1 AND "dateKey" BETWEEN $2 AND $3
       GROUP BY "userId" HAVING SUM("toxic") > 0 ORDER BY SUM("toxic") DESC LIMIT 15`,
      guildId, range.start, range.end,
    ),
    prismaRead.aegisDetection.groupBy({
      by: ['kind', 'status'],
      where: { guildId, createdAt: { gte: new Date(`${range.start}T00:00:00Z`), lte: new Date(`${range.end}T23:59:59.999Z`) } },
      _count: { _all: true },
    }),
  ]);

  const days = dayKeys(range.start, range.end);
  const prevDays = dayKeys(range.prevStart, range.prevEnd);

  // Mini-courbe de toxicité des salons du classement.
  const channelIds = channelRows.map((r) => r.channelId);
  const sparkRows = channelIds.length
    ? await prismaRead.$queryRawUnsafe<Array<{ channelId: string; dateKey: string; toxic: number }>>(
      `SELECT "channelId", "dateKey", COALESCE(SUM("toxic"), 0)::int AS "toxic" FROM "aegis_hourly_stats"
       WHERE "guildId" = $1 AND "dateKey" BETWEEN $2 AND $3 AND "channelId" = ANY($4::text[])
       GROUP BY 1, 2`,
      guildId, range.start, range.end, channelIds,
    )
    : [];
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const sparks = new Map<string, number[]>();
  for (const row of sparkRows) {
    const spark = sparks.get(row.channelId) ?? days.map(() => 0);
    const i = dayIndex.get(row.dateKey);
    if (i !== undefined) spark[i] = row.toxic;
    sparks.set(row.channelId, spark);
  }

  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ analyzed: 0, toxic: 0, anger: 0 })));
  for (const row of heatRows) {
    const cell = heatmap[(row.dow - 1 + 7) % 7]?.[row.hour];
    if (cell) Object.assign(cell, { analyzed: row.analyzed, toxic: row.toxic, anger: row.anger });
  }

  const detections = { byKind: {} as Record<string, number>, byStatus: {} as Record<string, number>, total: 0 };
  for (const row of detectionRows) {
    detections.byKind[row.kind] = (detections.byKind[row.kind] ?? 0) + row._count._all;
    detections.byStatus[row.status] = (detections.byStatus[row.status] ?? 0) + row._count._all;
    detections.total += row._count._all;
  }
  const decided = (detections.byStatus.CONFIRMED ?? 0) + (detections.byStatus.DISMISSED ?? 0) + (detections.byStatus.AUTO ?? 0);

  return {
    enabled: config?.enabled ?? false,
    thresholds: config ? { review: config.reviewThreshold, auto: config.autoThreshold } : null,
    range,
    current: summarize(current),
    previous: summarize(previous),
    daily: series(days, byDay),
    previousDaily: series(prevDays, byPrevDay),
    heatmap,
    channels: channelRows.map((raw) => {
      const row = normalize(raw);
      return {
        channelId: row.channelId,
        name: guild?.channels.cache.get(row.channelId)?.name ?? null,
        ...summarize(row),
        spark: sparks.get(row.channelId) ?? days.map(() => 0),
      };
    }),
    members: memberRows.map((raw) => {
      const row = normalize(raw);
      const member = guild?.members.cache.get(row.userId);
      return {
        userId: row.userId,
        name: member?.displayName ?? null,
        avatar: member?.displayAvatarURL({ size: 64 }) ?? null,
        analyzed: row.analyzed,
        toxic: row.toxic,
        toxicRate: pct(row.toxic, row.analyzed),
        avgToxicity: row.analyzed > 0 ? Math.round(row.toxicityMilli / row.analyzed) / 10 : null,
      };
    }),
    detections: {
      ...detections,
      falsePositiveRate: pct(detections.byStatus.DISMISSED ?? 0, decided),
    },
  };
}

/** Climat d'un membre sur `days` jours, pour sa fiche. */
export async function getMemberClimate(guildId: string, userId: string, days = 30, includeExcerpts = false) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const [rows, detections] = await Promise.all([
    prismaRead.aegisMemberDailyStat.findMany({
      where: { guildId, userId, dateKey: { gte: start, lte: end } },
      orderBy: { dateKey: 'asc' },
    }),
    prismaRead.aegisDetection.findMany({
      where: { guildId, authorId: userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, kind: true, source: true, status: true, action: true, toxicity: true, emotion: true, channelId: true, createdAt: true, excerpt: true },
    }),
  ]);
  const byDay = new Map(rows.map((r) => [r.dateKey, r]));
  const total = rows.reduce<AggRow>((acc, r) => {
    const next = { ...acc };
    for (const key of Object.keys(EMPTY) as Array<keyof AggRow>) next[key] += (r as unknown as AggRow)[key] ?? 0;
    return next;
  }, { ...EMPTY });

  return {
    days: dayKeys(start, end).map((dateKey) => {
      const r = byDay.get(dateKey);
      return {
        dateKey,
        analyzed: r?.analyzed ?? 0,
        toxic: r?.toxic ?? 0,
        avgToxicity: r && r.analyzed > 0 ? Math.round(r.toxicityMilli / r.analyzed) / 10 : null,
      };
    }),
    summary: summarize(total),
    detections: detections.map((d) => ({ ...d, excerpt: includeExcerpts ? d.excerpt : null })),
  };
}
