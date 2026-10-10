/**
 * Statistiques Kotbo × AegisAI : compteurs par heure et salon, et par jour et
 * membre. Tampon mémoire vidé en base toutes les 60 s par le flush groupé
 * d'Analytics. Jamais de contenu, seulement des comptes.
 *
 * L'appelant décide si le message compte (`AegisJob.countStats`, qui suit
 * `Guild.analyticsEnabled`) : ici on additionne.
 */
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from '../../analytics/analyticsBulkFlush.js';
import type { AegisEmotion } from './aegisClient.js';

const SEP = '\u0001';
const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;

const HOURLY_COLUMNS = ['analyzed', 'toxic', 'severe', 'toxicityMilli', 'emotionAnalyzed', 'joy', 'sad', 'anger', 'fear', 'surprise', 'neutral'] as const;
const MEMBER_COLUMNS = ['analyzed', 'toxic', 'toxicityMilli', 'emotionAnalyzed', 'joy', 'sad', 'anger', 'fear', 'surprise', 'neutral'] as const;

type Counters = Partial<Record<(typeof HOURLY_COLUMNS)[number], number>>;

const hourly = new Map<string, Counters>();
const members = new Map<string, Counters>();
let timer: ReturnType<typeof setInterval> | null = null;

export type AegisObservation = {
  guildId: string;
  channelId: string;
  userId: string;
  at: Date;
  /** Score 0-1, absent si la toxicité n'a pas été demandée. */
  toxicity?: number;
  emotion?: AegisEmotion;
  /** Seuils du serveur, en points (0-100). */
  reviewThreshold: number;
  autoThreshold: number;
};

function add(map: Map<string, Counters>, key: string, delta: Counters): void {
  const cur = map.get(key) ?? {};
  for (const [col, value] of Object.entries(delta) as Array<[keyof Counters, number]>) {
    cur[col] = (cur[col] ?? 0) + value;
  }
  map.set(key, cur);
}

/** Compteurs apportés par une observation. Pur, pour les tests. */
export function countersFor(obs: Pick<AegisObservation, 'toxicity' | 'emotion' | 'reviewThreshold' | 'autoThreshold'>): Counters {
  const delta: Counters = {};
  if (obs.toxicity !== undefined) {
    const points = obs.toxicity * 100;
    delta.analyzed = 1;
    delta.toxicityMilli = Math.round(obs.toxicity * 1000);
    if (points >= obs.reviewThreshold) delta.toxic = 1;
    if (points >= obs.autoThreshold) delta.severe = 1;
  }
  if (obs.emotion) {
    delta.emotionAnalyzed = 1;
    delta[obs.emotion] = 1;
  }
  return delta;
}

export function recordAegisObservation(obs: AegisObservation): void {
  const delta = countersFor(obs);
  if (Object.keys(delta).length === 0) return;
  ensureFlusher();
  const iso = obs.at.toISOString();
  const dateKey = iso.slice(0, 10);
  const hour = obs.at.getUTCHours();
  add(hourly, [obs.guildId, dateKey, hour, obs.channelId].join(SEP), delta);
  const { severe: _severe, ...memberDelta } = delta;
  add(members, [obs.guildId, dateKey, obs.userId].join(SEP), memberDelta);
  if (hourly.size + members.size >= 20_000) void flushAegisStats();
}

const HOURLY_TARGET: BulkTarget = {
  label: 'AegisHourlyStats',
  table: 'aegis_hourly_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'hour', type: 'int' },
    { name: 'channelId', type: 'text' },
  ],
  counterColumns: HOURLY_COLUMNS,
  createMany: (data) => prisma.aegisHourlyStat.createMany({ data: data as never, skipDuplicates: true }),
};

const MEMBER_TARGET: BulkTarget = {
  label: 'AegisMemberDailyStats',
  table: 'aegis_member_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'userId', type: 'text' },
  ],
  counterColumns: MEMBER_COLUMNS,
  createMany: (data) => prisma.aegisMemberDailyStat.createMany({ data: data as never, skipDuplicates: true }),
};

function drain(map: Map<string, Counters>, columns: readonly string[], intKeyIndex: number | null): BulkRow[] {
  const rows: BulkRow[] = [];
  for (const [key, data] of map) {
    const keys: Array<string | number> = key.split(SEP);
    if (intKeyIndex !== null) keys[intKeyIndex] = Number(keys[intKeyIndex]);
    const row = buildBulkRow(keys, columns, data);
    if (row) rows.push(row);
  }
  map.clear();
  return rows;
}

let inFlight: Promise<void> | null = null;

export async function flushAegisStats(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const hourlyRows = drain(hourly, HOURLY_COLUMNS, 2);
    const memberRows = drain(members, MEMBER_COLUMNS, null);
    await flushBulk(HOURLY_TARGET, hourlyRows);
    await flushBulk(MEMBER_TARGET, memberRows);
  })()
    .catch((err) => logger.error('AegisStats', 'Flush des statistiques AegisAI impossible :', err))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function ensureFlusher(): void {
  if (timer) return;
  timer = setInterval(() => void flushAegisStats(), FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  process.on('beforeExit', () => void flushAegisStats());
}
