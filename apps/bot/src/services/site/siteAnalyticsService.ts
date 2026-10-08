/**
 * Fréquentation des sites communautaires, sans cookie.
 *
 * Même principe que la télémétrie du dashboard : des agrégats par jour, et
 * des visiteurs uniques comptés par un hash salé du jour (adresse IP +
 * navigateur + site). Le sel est tiré au hasard, ne vit qu'en cache (48 h) et
 * n'est jamais écrit : une fois expiré, plus rien ne relie un hash à une
 * adresse, ni deux jours entre eux. Les robots ne sont pas comptés.
 *
 * Les vues sont mises en tampon et écrites par lots (createMany puis un seul
 * UPDATE), comme les autres analytics.
 */

import crypto from 'node:crypto';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from '../analytics/analyticsBulkFlush.js';

const SEP = '\u0001';
const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;
const MAX_BUFFERED_KEYS = 50_000;
const SALT_TTL_SECONDS = 2 * 24 * 3600;
const DAY_MS = 24 * 3600 * 1000;
export const SITE_ANALYTICS_RETENTION_DAYS = 180;

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|discord|telegram|whatsapp|curl|wget|python-requests|httpclient|headless|lighthouse|monitor|uptime/i;

const viewBuffer = new Map<string, number>();
const visitorBuffer = new Set<string>();
const saltByDay = new Map<string, string>();

export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function dailySalt(dateKey: string): Promise<string> {
  const known = saltByDay.get(dateKey);
  if (known) return known;
  const salt = await cache.wrap(`site-analytics:salt:${dateKey}`, SALT_TTL_SECONDS, async () => crypto.randomBytes(16).toString('hex'));
  saltByDay.set(dateKey, salt);
  for (const day of saltByDay.keys()) {
    if (day < dateKeyOf(new Date(Date.parse(dateKey) - DAY_MS))) saltByDay.delete(day);
  }
  return salt;
}

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_UA.test(userAgent);
}

export function deviceOf(userAgent: string): 'mobile' | 'tablet' | 'desktop' {
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(userAgent)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

/** Domaine d'origine d'une visite, ou "direct". Le site lui-même ne compte pas comme source. */
export function referrerHost(referrer: string | null | undefined, ownHost: string): string {
  if (!referrer) return 'direct';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase();
    if (!host || host === ownHost.replace(/^www\./, '').toLowerCase()) return 'direct';
    return host.slice(0, 100);
  } catch {
    return 'direct';
  }
}

export interface SiteHit {
  siteId: string;
  guildId: string;
  /** Chemin relatif au site : `/`, `/wiki/regles`… */
  path: string;
  referrer: string | null;
  userAgent: string | null;
  ip: string;
  host: string;
}

function bump(key: string): void {
  viewBuffer.set(key, (viewBuffer.get(key) ?? 0) + 1);
}

export async function recordSiteHit(hit: SiteHit): Promise<void> {
  if (isBotUserAgent(hit.userAgent)) return;
  ensureSiteAnalyticsFlusher();
  const dateKey = dateKeyOf(new Date());
  const path = hit.path.slice(0, 200) || '/';
  const base = [hit.siteId, hit.guildId, dateKey];
  bump([...base, 'all', ''].join(SEP));
  bump([...base, 'path', path].join(SEP));
  bump([...base, 'referrer', referrerHost(hit.referrer, hit.host)].join(SEP));
  bump([...base, 'device', deviceOf(hit.userAgent ?? '')].join(SEP));

  const salt = await dailySalt(dateKey);
  const visitor = crypto.createHash('sha256').update(`${salt}:${hit.siteId}:${hit.ip}:${hit.userAgent ?? ''}`).digest('hex').slice(0, 32);
  visitorBuffer.add([hit.siteId, dateKey, 'all', visitor].join(SEP));
  visitorBuffer.add([hit.siteId, dateKey, `path:${path}`, visitor].join(SEP));

  if (viewBuffer.size + visitorBuffer.size >= MAX_BUFFERED_KEYS) void flushSiteAnalytics();
}

const VIEW_TARGET: BulkTarget = {
  label: 'SiteDailyStats',
  table: 'site_daily_stats',
  keys: [
    { name: 'siteId', type: 'text' },
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'dimension', type: 'text' },
    { name: 'key', type: 'text' },
  ],
  counterColumns: ['views'],
  createMany: (data) => prisma.siteDailyStat.createMany({ data: data as never, skipDuplicates: true }),
};

async function runFlush(): Promise<void> {
  const views = [...viewBuffer.entries()];
  viewBuffer.clear();
  const visitors = [...visitorBuffer];
  visitorBuffer.clear();

  const rows: BulkRow[] = [];
  for (const [key, count] of views) {
    const row = buildBulkRow(key.split(SEP), ['views'], { views: count });
    if (row) rows.push(row);
  }
  await flushBulk(VIEW_TARGET, rows);

  for (let i = 0; i < visitors.length; i += 500) {
    const data = visitors.slice(i, i + 500).map((key) => {
      const [siteId, dateKey, scope, visitorHash] = key.split(SEP);
      return { siteId: siteId!, dateKey: dateKey!, scope: scope!, visitorHash: visitorHash! };
    });
    await prisma.siteVisitor
      .createMany({ data, skipDuplicates: true })
      .catch((error) => logger.error('SiteAnalytics', `Visiteurs non enregistrés (offset ${i}) :`, error));
  }
}

let flushInFlight: Promise<void> | null = null;

export async function flushSiteAnalytics(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = runFlush()
    .catch((error) => logger.error('SiteAnalytics', 'Flush de la fréquentation impossible :', error))
    .finally(() => {
      flushInFlight = null;
    });
  return flushInFlight;
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureSiteAnalyticsFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flushSiteAnalytics(), FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
  process.on('beforeExit', () => void flushSiteAnalytics());
}

export async function pruneSiteAnalytics(now: Date = new Date()): Promise<void> {
  const cutoff = dateKeyOf(new Date(now.getTime() - SITE_ANALYTICS_RETENTION_DAYS * DAY_MS));
  await prisma.$transaction([
    prisma.siteDailyStat.deleteMany({ where: { dateKey: { lt: cutoff } } }),
    prisma.siteVisitor.deleteMany({ where: { dateKey: { lt: cutoff } } }),
  ]);
}

// ─── Lecture (dashboard) ────────────────────────────────────────────────────

export interface SiteAnalyticsReport {
  from: string;
  to: string;
  totals: { views: number; visitors: number };
  previous: { views: number; visitors: number };
  daily: Array<{ date: string; views: number; visitors: number }>;
  pages: Array<{ path: string; views: number; visitors: number }>;
  referrers: Array<{ host: string; views: number }>;
  devices: Array<{ device: string; views: number }>;
}

function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) days.push(dateKeyOf(new Date(t)));
  return days;
}

/** Fréquentation d'un site sur `days` jours, comparée à la période précédente. */
export async function getSiteAnalytics(siteId: string, days: number): Promise<SiteAnalyticsReport> {
  const span = Math.min(180, Math.max(1, Math.round(days)));
  const to = dateKeyOf(new Date());
  const from = dateKeyOf(new Date(Date.now() - (span - 1) * DAY_MS));
  const prevTo = dateKeyOf(new Date(Date.parse(from) - DAY_MS));
  const prevFrom = dateKeyOf(new Date(Date.parse(from) - span * DAY_MS));

  const [stats, visitorsByDay, pageVisitors, prevViews, prevVisitors] = await Promise.all([
    prisma.siteDailyStat.findMany({ where: { siteId, dateKey: { gte: from, lte: to } }, select: { dateKey: true, dimension: true, key: true, views: true } }),
    prisma.siteVisitor.groupBy({ by: ['dateKey'], where: { siteId, scope: 'all', dateKey: { gte: from, lte: to } }, _count: { _all: true } }),
    prisma.siteVisitor.groupBy({ by: ['scope'], where: { siteId, scope: { startsWith: 'path:' }, dateKey: { gte: from, lte: to } }, _count: { _all: true } }),
    prisma.siteDailyStat.aggregate({ where: { siteId, dimension: 'all', dateKey: { gte: prevFrom, lte: prevTo } }, _sum: { views: true } }),
    prisma.siteVisitor.count({ where: { siteId, scope: 'all', dateKey: { gte: prevFrom, lte: prevTo } } }),
  ]);

  const viewsByDay = new Map<string, number>();
  const pages = new Map<string, number>();
  const referrers = new Map<string, number>();
  const devices = new Map<string, number>();
  for (const s of stats) {
    if (s.dimension === 'all') viewsByDay.set(s.dateKey, (viewsByDay.get(s.dateKey) ?? 0) + s.views);
    else if (s.dimension === 'path') pages.set(s.key, (pages.get(s.key) ?? 0) + s.views);
    else if (s.dimension === 'referrer') referrers.set(s.key, (referrers.get(s.key) ?? 0) + s.views);
    else if (s.dimension === 'device') devices.set(s.key, (devices.get(s.key) ?? 0) + s.views);
  }
  const visitorsDay = new Map(visitorsByDay.map((v) => [v.dateKey, v._count._all]));
  const visitorsPage = new Map(pageVisitors.map((v) => [v.scope.slice(5), v._count._all]));
  const daily = dayRange(from, to).map((date) => ({ date, views: viewsByDay.get(date) ?? 0, visitors: visitorsDay.get(date) ?? 0 }));

  return {
    from,
    to,
    totals: { views: daily.reduce((s, d) => s + d.views, 0), visitors: daily.reduce((s, d) => s + d.visitors, 0) },
    previous: { views: prevViews._sum.views ?? 0, visitors: prevVisitors },
    daily,
    pages: [...pages.entries()]
      .map(([path, views]) => ({ path, views, visitors: visitorsPage.get(path) ?? 0 }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 20),
    referrers: [...referrers.entries()].map(([host, views]) => ({ host, views })).sort((a, b) => b.views - a.views).slice(0, 15),
    devices: [...devices.entries()].map(([device, views]) => ({ device, views })).sort((a, b) => b.views - a.views),
  };
}
