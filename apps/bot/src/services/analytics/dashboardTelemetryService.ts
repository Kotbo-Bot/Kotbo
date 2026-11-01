/**
 * dashboardTelemetryService.ts
 *
 * Télémétrie produit du dashboard : le navigateur agrège ses événements et les
 * envoie par lot (POST /api/dashboard/telemetry), on les ajoute ici à un tampon
 * mémoire vidé toutes les 60 s par le flush groupé des autres analytics.
 *
 * Visiteurs uniques : l'ID Discord n'est jamais écrit. On en garde un hash
 * salé dont le sel est tiré au hasard chaque jour et ne vit qu'en cache
 * (Redis, 48 h) ; une fois le sel expiré, plus personne ne peut relier un hash
 * à un compte, ni deux jours entre eux.
 *
 * Ne suit pas `Guild.analyticsEnabled` : ce sont les usages de Kotbo par les
 * gestionnaires, pas les données des membres. Les admins globaux sont écartés
 * en amont, par la route.
 */

import crypto from 'node:crypto';
import { DASHBOARD_TELEMETRY_LIMITS, type DashboardTelemetryEntry } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from './analyticsBulkFlush.js';

const SEP = '\u0001';
const MAX_BUFFERED_KEYS = 50_000;
const FLUSH_INTERVAL_MS =
  Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;
const SALT_TTL_SECONDS = 2 * 24 * 3600;
const VISITOR_CHUNK_SIZE = 500;
const DAY_MS = 24 * 3600 * 1000;
/** Garde-fou contre le débordement de la colonne INTEGER sur une ligne très chaude. */
const MAX_BUFFERED_VALUE = 1_500_000_000;

const STAT_COLUMNS = ['count', 'valueSum'] as const;

const statBuffer = new Map<string, { count: number; valueSum: number }>();
const visitorBuffer = new Set<string>();
const saltByDay = new Map<string, string>();

export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function dailySalt(dateKey: string): Promise<string> {
  const known = saltByDay.get(dateKey);
  if (known) return known;
  const salt = await cache.wrap(`dash-telemetry:salt:${dateKey}`, SALT_TTL_SECONDS, async () =>
    crypto.randomBytes(16).toString('hex'),
  );
  saltByDay.set(dateKey, salt);
  // On ne garde que le jour courant et la veille en mémoire.
  for (const day of saltByDay.keys()) {
    if (day < dateKeyOf(new Date(Date.parse(dateKey) - DAY_MS))) saltByDay.delete(day);
  }
  return salt;
}

export async function visitorHashFor(userId: string, dateKey: string): Promise<string> {
  const salt = await dailySalt(dateKey);
  return crypto.createHash('sha256').update(`${salt}:${userId}`).digest('hex').slice(0, 32);
}

/** Portées sur lesquelles une vue de page compte un visiteur. */
export function visitorScopesFor(entry: Pick<DashboardTelemetryEntry, 'page' | 'feature'>): string[] {
  const scopes = ['all', `page:${entry.page}`];
  if (entry.feature) scopes.push(`feature:${entry.feature}`);
  return scopes;
}

/**
 * Ajoute un lot déjà validé (voir `sanitizeTelemetryEntry`) aux compteurs du
 * jour. Les vues de page comptent aussi le visiteur sur leurs portées.
 */
export async function recordTelemetryBatch(
  userId: string,
  entries: DashboardTelemetryEntry[],
  now: Date = new Date(),
): Promise<void> {
  if (entries.length === 0) return;
  const dateKey = dateKeyOf(now);
  let visitorHash: string | null = null;

  for (const entry of entries) {
    const key = [dateKey, entry.guildId, entry.page, entry.tab, entry.feature, entry.event, entry.dimension].join(SEP);
    const existing = statBuffer.get(key) ?? { count: 0, valueSum: 0 };
    existing.count += entry.count;
    existing.valueSum = Math.min(existing.valueSum + entry.valueSum, MAX_BUFFERED_VALUE);
    statBuffer.set(key, existing);

    if (entry.event === 'page_view' || entry.event === 'session_start') {
      visitorHash ??= await visitorHashFor(userId, dateKey);
      const scopes = entry.event === 'session_start' ? ['all'] : visitorScopesFor(entry);
      for (const scope of scopes) {
        visitorBuffer.add([dateKey, entry.guildId, scope, visitorHash].join(SEP));
      }
    }
  }

  if (statBuffer.size + visitorBuffer.size >= MAX_BUFFERED_KEYS) void flushDashboardTelemetry();
}

const STAT_TARGET: BulkTarget = {
  label: 'DashboardTelemetryDailyStats',
  table: 'dashboard_telemetry_daily_stats',
  keys: [
    { name: 'dateKey', type: 'text' },
    { name: 'guildId', type: 'text' },
    { name: 'page', type: 'text' },
    { name: 'tab', type: 'text' },
    { name: 'feature', type: 'text' },
    { name: 'event', type: 'text' },
    { name: 'dimension', type: 'text' },
  ],
  counterColumns: STAT_COLUMNS,
};

async function runFlush(): Promise<void> {
  const statEntries = [...statBuffer.entries()];
  statBuffer.clear();
  const visitorEntries = [...visitorBuffer];
  visitorBuffer.clear();

  const rows: BulkRow[] = [];
  for (const [key, data] of statEntries) {
    const row = buildBulkRow(key.split(SEP), STAT_COLUMNS, data);
    if (row) rows.push(row);
  }
  await flushBulk(STAT_TARGET, rows);

  for (let i = 0; i < visitorEntries.length; i += VISITOR_CHUNK_SIZE) {
    const data = visitorEntries.slice(i, i + VISITOR_CHUNK_SIZE).map((key) => {
      const [dateKey, guildId, scope, visitorHash] = key.split(SEP);
      return { dateKey: dateKey!, guildId: guildId!, scope: scope!, visitorHash: visitorHash! };
    });
    await prisma.dashboardTelemetryVisitor
      .createMany({ data, skipDuplicates: true })
      .catch((error) => logger.error('DashboardTelemetry', `Visiteurs non enregistrés (offset ${i}) :`, error));
  }
}

let flushInFlight: Promise<void> | null = null;

/** Vide les tampons. Un flush déjà en cours est rejoint, pas doublé. */
export async function flushDashboardTelemetry(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = runFlush()
    .catch((error) => logger.error('DashboardTelemetry', 'Flush de la télémétrie impossible :', error))
    .finally(() => {
      flushInFlight = null;
    });
  return flushInFlight;
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Démarré à la première réception : un bot sans dashboard n'arme aucun minuteur. */
export function ensureDashboardTelemetryFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flushDashboardTelemetry(), FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
  process.on('beforeExit', () => void flushDashboardTelemetry());
}

/** Purge au-delà de la rétention (180 jours). Appelée par le cron quotidien. */
export async function pruneDashboardTelemetry(now: Date = new Date()): Promise<void> {
  const cutoff = dateKeyOf(new Date(now.getTime() - DASHBOARD_TELEMETRY_LIMITS.retentionDays * DAY_MS));
  try {
    const [stats, visitors] = await Promise.all([
      prisma.dashboardTelemetryDailyStat.deleteMany({ where: { dateKey: { lt: cutoff } } }),
      prisma.dashboardTelemetryVisitor.deleteMany({ where: { dateKey: { lt: cutoff } } }),
    ]);
    if (stats.count + visitors.count > 0) {
      logger.info('DashboardTelemetry', `${stats.count} agrégats et ${visitors.count} visiteurs de plus de 180 jours purgés.`);
    }
  } catch (error) {
    logger.error('DashboardTelemetry', 'Purge de la télémétrie en échec :', error);
  }
}

/** Taille des tampons, pour les tests. */
export function telemetryBufferSizes(): { stats: number; visitors: number } {
  return { stats: statBuffer.size, visitors: visitorBuffer.size };
}
