/**
 * contentStatsService.ts
 *
 * Tampon mémoire des stats de contenu (message_content_daily_stats et
 * content_item_daily_stats), vidé en base toutes les 60 s par le même flush
 * groupé que les autres analytics. Le tracker live et le rattrapage depuis
 * message_logs y déposent leurs compteurs.
 *
 * La collecte suit `Guild.analyticsEnabled` : c'est à l'appelant de le
 * vérifier (voir contentStatsTracker.ts), le rattrapage le fait une fois par
 * serveur plutôt qu'à chaque message.
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from './analyticsBulkFlush.js';
import {
  CONTENT_COUNTER_COLUMNS,
  type ContentAnalysis,
  type ContentCounter,
  type ContentCounters,
} from './messageContentAnalyzer.js';
import { noteAssets, flushPendingAssets, type AssetSighting } from './assetSourceService.js';

export type ContentItemKind =
  | 'emoji_unicode' | 'emoji_guild' | 'emoji_external'
  | 'sticker_guild' | 'sticker_external' | 'sticker_standard'
  | 'reaction_unicode' | 'reaction_guild' | 'reaction_external'
  | 'domain';

const SEP = '\u0001';
/** Coupe-circuit mémoire : au-delà, on vide sans attendre le minuteur. */
const MAX_BUFFERED_KEYS = 50_000;
const FLUSH_INTERVAL_MS =
  Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;

const counterBuffer = new Map<string, ContentCounters>();
const itemBuffer = new Map<string, number>();

export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function queueContentCounters(
  guildId: string,
  dateKey: string,
  channelId: string,
  userId: string,
  counters: ContentCounters,
): void {
  const key = [guildId, dateKey, channelId, userId].join(SEP);
  const existing = counterBuffer.get(key) ?? {};
  for (const [col, value] of Object.entries(counters) as Array<[ContentCounter, number]>) {
    if (value) existing[col] = (existing[col] ?? 0) + value;
  }
  counterBuffer.set(key, existing);
  maybeFlushEarly();
}

/**
 * Une occurrence alimente deux lignes : celle du salon (userId vide) et celle
 * du membre (channelId vide). Voir le commentaire du modèle Prisma.
 */
export function queueContentItem(
  guildId: string,
  dateKey: string,
  kind: ContentItemKind,
  itemKey: string,
  channelId: string,
  userId: string,
  count = 1,
): void {
  for (const [c, u] of [[channelId, ''], ['', userId]] as const) {
    const key = [guildId, dateKey, kind, itemKey, c, u].join(SEP);
    itemBuffer.set(key, (itemBuffer.get(key) ?? 0) + count);
  }
  maybeFlushEarly();
}

/** Dépose l'analyse complète d'un message : compteurs, classements, provenances. */
export function recordMessageAnalysis(
  guildId: string,
  dateKey: string,
  channelId: string,
  userId: string,
  analysis: ContentAnalysis,
): void {
  queueContentCounters(guildId, dateKey, channelId, userId, analysis.counters);

  const sightings: AssetSighting[] = [];
  for (const emoji of analysis.customEmojis) {
    queueContentItem(guildId, dateKey, emoji.origin === 'guild' ? 'emoji_guild' : 'emoji_external', emoji.id, channelId, userId);
    sightings.push({ kind: 'emoji', id: emoji.id, name: emoji.name, animated: emoji.animated, guildId: emoji.origin === 'guild' ? guildId : null });
  }
  for (const emoji of analysis.unicodeEmojis) {
    queueContentItem(guildId, dateKey, 'emoji_unicode', emoji, channelId, userId);
  }
  for (const sticker of analysis.stickers) {
    queueContentItem(guildId, dateKey, `sticker_${sticker.origin}`, sticker.id, channelId, userId);
    sightings.push({ kind: 'sticker', id: sticker.id, name: sticker.name, animated: false, guildId: sticker.origin === 'guild' ? guildId : null, standard: sticker.origin === 'standard' });
  }
  for (const domain of analysis.domains) {
    queueContentItem(guildId, dateKey, 'domain', domain, channelId, userId);
  }
  if (sightings.length > 0) noteAssets(sightings);
}

const COUNTER_TARGET: BulkTarget = {
  label: 'MessageContentDailyStats',
  table: 'message_content_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'channelId', type: 'text' },
    { name: 'userId', type: 'text' },
  ],
  counterColumns: CONTENT_COUNTER_COLUMNS,
};

const ITEM_COLUMNS = ['count'] as const;

const ITEM_TARGET: BulkTarget = {
  label: 'ContentItemDailyStats',
  table: 'content_item_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'kind', type: 'text' },
    { name: 'key', type: 'text' },
    { name: 'channelId', type: 'text' },
    { name: 'userId', type: 'text' },
  ],
  counterColumns: ITEM_COLUMNS,
};

async function runFlush(): Promise<void> {
  const counterEntries = [...counterBuffer.entries()];
  counterBuffer.clear();
  const itemEntries = [...itemBuffer.entries()];
  itemBuffer.clear();

  const counterRows: BulkRow[] = [];
  for (const [key, data] of counterEntries) {
    const row = buildBulkRow(key.split(SEP), CONTENT_COUNTER_COLUMNS, data);
    if (row) counterRows.push(row);
  }
  const itemRows: BulkRow[] = [];
  for (const [key, count] of itemEntries) {
    const row = buildBulkRow(key.split(SEP), ITEM_COLUMNS, { count });
    if (row) itemRows.push(row);
  }

  await flushBulk(COUNTER_TARGET, counterRows);
  await flushBulk(ITEM_TARGET, itemRows);
  await flushPendingAssets();
}

let flushInFlight: Promise<void> | null = null;

/** Vide les tampons. Un flush déjà en cours est rejoint, pas doublé. */
export async function flushContentStats(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = runFlush()
    .catch((error) => logger.error('ContentStats', 'Flush des stats de contenu impossible :', error))
    .finally(() => {
      flushInFlight = null;
    });
  return flushInFlight;
}

function maybeFlushEarly(): void {
  if (counterBuffer.size + itemBuffer.size >= MAX_BUFFERED_KEYS) void flushContentStats();
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startContentStatsFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flushContentStats(), FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
  process.on('beforeExit', () => void flushContentStats());
}

/** Taille des tampons, pour les tests. */
export function contentBufferSizes(): { counters: number; items: number } {
  return { counters: counterBuffer.size, items: itemBuffer.size };
}
