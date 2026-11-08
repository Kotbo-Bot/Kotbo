/**
 * channelLinkStatsService.ts
 *
 * Trafic des ponts : par jour, pont et salon, les messages partis du salon, les
 * copies qui y sont arrivées et celles perdues en route. Des nombres seuls,
 * jamais l'auteur. Tampon mémoire vidé en base toutes les 60 s par le flush
 * groupé commun. Suit `Guild.analyticsEnabled` du serveur propriétaire du pont.
 */

import { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isAnalyticsCollectionEnabled } from '../analytics/analyticsConsent.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from '../analytics/analyticsBulkFlush.js';
import { dayKeys } from '../analytics/contentAnalyticsService.js';

const SEP = '\u0001';
const COLUMNS = ['sent', 'received', 'failed'] as const;
type Counter = (typeof COLUMNS)[number];
type Counts = Record<Counter, number>;

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;
const buffer = new Map<string, Counts>();
let timer: ReturnType<typeof setInterval> | null = null;

export async function recordLinkTraffic(
  group: { id: string; ownerGuildId: string },
  guildId: string,
  channelId: string,
  counter: Counter,
): Promise<void> {
  try {
    if (!(await isAnalyticsCollectionEnabled(group.ownerGuildId))) return;
    ensureFlusher();
    const key = [group.id, new Date().toISOString().slice(0, 10), guildId, channelId].join(SEP);
    const cur = buffer.get(key) ?? { sent: 0, received: 0, failed: 0 };
    cur[counter] += 1;
    buffer.set(key, cur);
    if (buffer.size >= 20_000) void flushChannelLinkStats();
  } catch (err) {
    logger.warn('ChannelLinkStats', 'Message de pont non compté :', err);
  }
}

const TARGET: BulkTarget = {
  label: 'ChannelLinkGroupDailyStats',
  table: 'channel_link_group_daily_stats',
  keys: [
    { name: 'groupId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'guildId', type: 'text' },
    { name: 'channelId', type: 'text' },
  ],
  counterColumns: COLUMNS,
};

let inFlight: Promise<void> | null = null;

export async function flushChannelLinkStats(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const entries = [...buffer.entries()];
    buffer.clear();
    const rows: BulkRow[] = [];
    for (const [key, data] of entries) {
      const row = buildBulkRow(key.split(SEP), COLUMNS, data);
      if (row) rows.push(row);
    }
    await flushBulk(TARGET, rows);
  })()
    .catch((err) => logger.error('ChannelLinkStats', 'Flush du trafic des ponts impossible :', err))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function ensureFlusher(): void {
  if (timer) return;
  timer = setInterval(() => void flushChannelLinkStats(), FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  process.on('beforeExit', () => void flushChannelLinkStats());
}

// ── Lecture ────────────────────────────────────────────────────────────────

export type LinkStatRow = Counts & { groupId: string; dateKey: string; guildId: string; channelId: string };

export type LinkGroupStats = Counts & {
  /** Messages partis de tous les salons, jour par jour, du plus ancien au plus récent. */
  daily: number[];
  /** Clé `guildId:channelId`. */
  channels: Record<string, Counts>;
};

export function summarizeLinkStats(rows: LinkStatRow[], days: string[]): Map<string, LinkGroupStats> {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const byGroup = new Map<string, LinkGroupStats>();
  for (const r of rows) {
    const g = byGroup.get(r.groupId) ?? { sent: 0, received: 0, failed: 0, daily: days.map(() => 0), channels: {} };
    for (const c of COLUMNS) g[c] += r[c];
    const i = dayIndex.get(r.dateKey);
    if (i !== undefined) g.daily[i] = (g.daily[i] ?? 0) + r.sent;
    const ch = (g.channels[`${r.guildId}:${r.channelId}`] ??= { sent: 0, received: 0, failed: 0 });
    for (const c of COLUMNS) ch[c] += r[c];
    byGroup.set(r.groupId, g);
  }
  return byGroup;
}

export async function getLinkGroupStats(groupIds: string[], days = 30): Promise<Map<string, LinkGroupStats>> {
  if (groupIds.length === 0) return new Map();
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await prismaRead.channelLinkGroupDailyStat.findMany({
    where: { groupId: { in: groupIds }, dateKey: { gte: start, lte: end } },
    select: { groupId: true, dateKey: true, guildId: true, channelId: true, sent: true, received: true, failed: true },
    take: 200_000,
  });
  return summarizeLinkStats(rows, dayKeys(start, end));
}
