/**
 * commandStatsService.ts
 *
 * Usage des commandes slash pour Analytics : un compteur par jour, commande
 * (« ticket ouvrir » avec sa sous-commande) et membre — utilisations,
 * échecs, durée cumulée. Tampon mémoire vidé en base toutes les 60 s par le
 * flush groupé commun. Suit `Guild.analyticsEnabled`.
 *
 * Lecture : totaux et écart avec la période d'avant, courbe jour par jour,
 * classement des commandes (utilisateurs distincts, taux d'échec, durée
 * moyenne, mini-courbe) et membres qui s'en servent le plus. Avant la
 * collecte par jour, seul existait un cumul sans date : il est rendu à part
 * (`allTime`) quand la période n'a encore rien.
 */

import type { Client } from 'discord.js';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isAnalyticsCollectionEnabled } from './analyticsConsent.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from './analyticsBulkFlush.js';
import { dayKeys, type DateRange } from './contentAnalyticsService.js';

const SEP = '\u0001';
const COLUMNS = ['uses', 'errors', 'totalMs'] as const;
const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;
const buffer = new Map<string, { uses: number; errors: number; totalMs: number }>();
let timer: ReturnType<typeof setInterval> | null = null;

export interface CommandUsageEvent {
  guildId: string;
  commandName: string;
  userId: string;
  durationMs: number;
  success: boolean;
}

/** Nom affiché d'une commande : commande, groupe et sous-commande. */
export function commandLabel(name: string, group: string | null, sub: string | null): string {
  return [name, group, sub].filter(Boolean).join(' ').slice(0, 100);
}

export async function recordCommandUsage(event: CommandUsageEvent): Promise<void> {
  try {
    if (!(await isAnalyticsCollectionEnabled(event.guildId))) return;
    ensureFlusher();
    const key = [event.guildId, new Date().toISOString().slice(0, 10), event.commandName, event.userId].join(SEP);
    const cur = buffer.get(key) ?? { uses: 0, errors: 0, totalMs: 0 };
    cur.uses += 1;
    if (!event.success) cur.errors += 1;
    cur.totalMs += Math.max(0, Math.min(600_000, Math.round(event.durationMs)));
    buffer.set(key, cur);
    if (buffer.size >= 20_000) void flushCommandStats();
  } catch (err) {
    logger.warn('CommandStats', 'Usage de commande non compté :', err);
  }
}

const TARGET: BulkTarget = {
  label: 'CommandUsageDailyStats',
  table: 'command_usage_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'commandName', type: 'text' },
    { name: 'userId', type: 'text' },
  ],
  counterColumns: COLUMNS,
};

let inFlight: Promise<void> | null = null;

export async function flushCommandStats(): Promise<void> {
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
    .catch((err) => logger.error('CommandStats', 'Flush des commandes impossible :', err))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function ensureFlusher(): void {
  if (timer) return;
  timer = setInterval(() => void flushCommandStats(), FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  process.on('beforeExit', () => void flushCommandStats());
}

// ── Lecture ────────────────────────────────────────────────────────────────

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function bucketize(values: number[], max = 30): number[] {
  if (values.length <= max) return values;
  const size = Math.ceil(values.length / max);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size).reduce((s, v) => s + v, 0));
  return out;
}

export async function getCommandAnalytics(client: Client, guildId: string, range: DateRange) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const [rows, prevRows] = await Promise.all([
    prismaRead.commandUsageDailyStat.findMany({
      where: { guildId, dateKey: { gte: range.start, lte: range.end } },
      select: { dateKey: true, commandName: true, userId: true, uses: true, errors: true, totalMs: true },
      take: 200_000,
    }),
    prismaRead.commandUsageDailyStat.findMany({
      where: { guildId, dateKey: { gte: range.prevStart, lte: range.prevEnd } },
      select: { dateKey: true, commandName: true, userId: true, uses: true },
      take: 200_000,
    }),
  ]);

  const days = dayKeys(range.start, range.end);
  const prevDays = dayKeys(range.prevStart, range.prevEnd);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const prevIndex = new Map(prevDays.map((d, i) => [d, i]));

  const daily = days.map(() => 0);
  const prevDaily = prevDays.map(() => 0);
  const commands = new Map<string, { uses: number; errors: number; totalMs: number; users: Set<string>; spark: number[] }>();
  const users = new Map<string, { uses: number; commands: Set<string> }>();
  let errors = 0;
  let totalMs = 0;
  for (const r of rows) {
    const i = dayIndex.get(r.dateKey);
    if (i !== undefined) daily[i] = (daily[i] ?? 0) + r.uses;
    const c = commands.get(r.commandName) ?? { uses: 0, errors: 0, totalMs: 0, users: new Set<string>(), spark: days.map(() => 0) };
    c.uses += r.uses;
    c.errors += r.errors;
    c.totalMs += r.totalMs;
    c.users.add(r.userId);
    if (i !== undefined) c.spark[i] = (c.spark[i] ?? 0) + r.uses;
    commands.set(r.commandName, c);
    const u = users.get(r.userId) ?? { uses: 0, commands: new Set<string>() };
    u.uses += r.uses;
    u.commands.add(r.commandName);
    users.set(r.userId, u);
    errors += r.errors;
    totalMs += r.totalMs;
  }
  const prevByCommand = new Map<string, number>();
  const prevUsers = new Set<string>();
  for (const r of prevRows) {
    const i = prevIndex.get(r.dateKey);
    if (i !== undefined) prevDaily[i] = (prevDaily[i] ?? 0) + r.uses;
    prevByCommand.set(r.commandName, (prevByCommand.get(r.commandName) ?? 0) + r.uses);
    prevUsers.add(r.userId);
  }
  const uses = daily.reduce((s, v) => s + v, 0);
  const prevUses = prevDaily.reduce((s, v) => s + v, 0);

  // Commandes déjà connues, jamais utilisées sur la période : candidates au ménage.
  const unused = [...prevByCommand.keys()].filter((name) => !commands.has(name)).slice(0, 20);

  const topUserIds = [...users.entries()].sort((a, b) => b[1].uses - a[1].uses).slice(0, 15).map(([id]) => id);
  const missing = topUserIds.filter((id) => !guild?.members.cache.has(id));
  const profiles = missing.length > 0
    ? await prismaRead.memberProfile.findMany({
        where: { guildId, userId: { in: missing } },
        select: { userId: true, displayName: true, globalName: true, username: true, avatarUrl: true },
      })
    : [];
  const profileOf = new Map(profiles.map((p) => [p.userId, p]));

  let allTime: Array<{ name: string; count: number }> | null = null;
  if (rows.length === 0 && prevRows.length === 0) {
    const legacy = await prismaRead.dashboardCommandUsage.groupBy({ by: ['commandName'], where: { guildId }, _sum: { count: true } });
    if (legacy.length > 0) {
      allTime = legacy.map((l) => ({ name: l.commandName, count: l._sum.count ?? 0 })).sort((a, b) => b.count - a.count).slice(0, 50);
    }
  }

  return {
    range,
    totals: {
      uses,
      previousUses: prevUses,
      users: users.size,
      previousUsers: prevUsers.size,
      commands: commands.size,
      errorRate: pct(errors, uses),
      avgMs: uses > 0 ? Math.round(totalMs / uses) : null,
    },
    daily: days.map((dateKey, i) => ({ dateKey, uses: daily[i] ?? 0, previous: prevDaily[i] ?? 0 })),
    commands: [...commands.entries()]
      .map(([name, c]) => ({
        name,
        uses: c.uses,
        previous: prevByCommand.get(name) ?? 0,
        users: c.users.size,
        share: pct(c.uses, uses) ?? 0,
        errorRate: pct(c.errors, c.uses),
        avgMs: c.uses > 0 ? Math.round(c.totalMs / c.uses) : null,
        spark: bucketize(c.spark),
      }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 50),
    topUsers: topUserIds.map((id) => {
      const u = users.get(id)!;
      const member = guild?.members.cache.get(id);
      const p = profileOf.get(id);
      return {
        userId: id,
        name: member?.displayName ?? p?.displayName ?? p?.globalName ?? p?.username ?? null,
        avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? p?.avatarUrl ?? null,
        uses: u.uses,
        commands: u.commands.size,
      };
    }),
    unused,
    allTime,
  };
}
