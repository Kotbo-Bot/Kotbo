/**
 * reactionRoleStatsService.ts
 *
 * Rôles-boutons pour Analytics : un compteur par jour, menu et rôle des rôles
 * pris et retirés depuis les panneaux. Seuls les clics comptent : un rôle
 * donné à la main ne dit rien de ce que plébiscitent les membres. Tampon
 * mémoire vidé en base toutes les 60 s par le flush groupé commun. Suit
 * `Guild.analyticsEnabled`.
 *
 * Lecture : totaux et écart avec la période d'avant, courbe jour par jour, et
 * chaque rôle de menu avec ses prises, ses retraits, sa mini-courbe et le
 * nombre de membres qui le portent aujourd'hui.
 */

import type { Client } from 'discord.js';
import { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isAnalyticsCollectionEnabled } from './analyticsConsent.js';
import { buildBulkRow, flushBulk, type BulkRow, type BulkTarget } from './analyticsBulkFlush.js';
import { dayKeys, type DateRange } from './contentAnalyticsService.js';

const SEP = '\u0001';
const COLUMNS = ['added', 'removed'] as const;
const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? '60000', 10) || 60000;
const buffer = new Map<string, { added: number; removed: number }>();
let timer: ReturnType<typeof setInterval> | null = null;

export interface ReactionRoleChange {
  guildId: string;
  menuId: string;
  roleId: string;
  change: 'added' | 'removed';
}

export async function recordReactionRoleChange(event: ReactionRoleChange): Promise<void> {
  try {
    if (!(await isAnalyticsCollectionEnabled(event.guildId))) return;
    ensureFlusher();
    const key = [event.guildId, new Date().toISOString().slice(0, 10), event.menuId, event.roleId].join(SEP);
    const cur = buffer.get(key) ?? { added: 0, removed: 0 };
    cur[event.change] += 1;
    buffer.set(key, cur);
    if (buffer.size >= 20_000) void flushReactionRoleStats();
  } catch (err) {
    logger.warn('ReactionRoleStats', 'Clic de rôle non compté :', err);
  }
}

const TARGET: BulkTarget = {
  label: 'ReactionRoleDailyStats',
  table: 'reaction_role_daily_stats',
  keys: [
    { name: 'guildId', type: 'text' },
    { name: 'dateKey', type: 'text' },
    { name: 'menuId', type: 'text' },
    { name: 'roleId', type: 'text' },
  ],
  counterColumns: COLUMNS,
};

let inFlight: Promise<void> | null = null;

export async function flushReactionRoleStats(): Promise<void> {
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
    .catch((err) => logger.error('ReactionRoleStats', 'Flush des rôles-boutons impossible :', err))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function ensureFlusher(): void {
  if (timer) return;
  timer = setInterval(() => void flushReactionRoleStats(), FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  process.on('beforeExit', () => void flushReactionRoleStats());
}

// ── Lecture ────────────────────────────────────────────────────────────────

export type ReactionRoleStatRow = { dateKey: string; menuId: string; roleId: string; added: number; removed: number };

/**
 * Agrège les lignes de la période et de celle d'avant. Un rôle n'apparaît que
 * s'il a bougé sur la période : la période d'avant ne sert qu'aux écarts.
 */
export function summarizeReactionRoleStats(
  rows: ReactionRoleStatRow[],
  prevRows: ReactionRoleStatRow[],
  days: string[],
  prevDays: string[],
) {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const prevIndex = new Map(prevDays.map((d, i) => [d, i]));
  const daily = days.map((dateKey) => ({ dateKey, added: 0, removed: 0, previousAdded: 0, previousRemoved: 0 }));
  const roles = new Map<string, { menuId: string; roleId: string; added: number; removed: number; previousAdded: number; spark: number[] }>();
  const keyOf = (r: ReactionRoleStatRow) => `${r.menuId}${SEP}${r.roleId}`;

  for (const r of rows) {
    const i = dayIndex.get(r.dateKey);
    const day = i === undefined ? undefined : daily[i];
    if (day) {
      day.added += r.added;
      day.removed += r.removed;
    }
    const role = roles.get(keyOf(r)) ?? { menuId: r.menuId, roleId: r.roleId, added: 0, removed: 0, previousAdded: 0, spark: days.map(() => 0) };
    role.added += r.added;
    role.removed += r.removed;
    if (i !== undefined) role.spark[i] = (role.spark[i] ?? 0) + r.added;
    roles.set(keyOf(r), role);
  }

  let previousAdded = 0;
  let previousRemoved = 0;
  for (const r of prevRows) {
    previousAdded += r.added;
    previousRemoved += r.removed;
    const i = prevIndex.get(r.dateKey);
    const day = i === undefined ? undefined : daily[i];
    if (day) {
      day.previousAdded += r.added;
      day.previousRemoved += r.removed;
    }
    const role = roles.get(keyOf(r));
    if (role) role.previousAdded += r.added;
  }

  const added = daily.reduce((s, d) => s + d.added, 0);
  const removed = daily.reduce((s, d) => s + d.removed, 0);
  return {
    totals: { added, removed, net: added - removed, previousAdded, previousRemoved },
    daily,
    roles: [...roles.values()]
      .sort((a, b) => b.added - a.added)
      .map((r) => ({ menuId: r.menuId, roleId: r.roleId, added: r.added, removed: r.removed, net: r.added - r.removed, previousAdded: r.previousAdded, spark: r.spark })),
  };
}

export async function getReactionRoleAnalytics(client: Client, guildId: string, range: DateRange) {
  const select = { dateKey: true, menuId: true, roleId: true, added: true, removed: true } as const;
  const [rows, prevRows] = await Promise.all([
    prismaRead.reactionRoleDailyStat.findMany({ where: { guildId, dateKey: { gte: range.start, lte: range.end } }, select, take: 200_000 }),
    prismaRead.reactionRoleDailyStat.findMany({ where: { guildId, dateKey: { gte: range.prevStart, lte: range.prevEnd } }, select, take: 200_000 }),
  ]);
  const summary = summarizeReactionRoleStats(rows, prevRows, dayKeys(range.start, range.end), dayKeys(range.prevStart, range.prevEnd));

  const menuIds = [...new Set(summary.roles.map((r) => r.menuId))];
  const menus = menuIds.length > 0
    ? await prismaRead.reactionRoleMenu.findMany({ where: { guildId, id: { in: menuIds } }, select: { id: true, title: true } })
    : [];
  const titleOf = new Map(menus.map((menu) => [menu.id, menu.title]));
  const guild = client.guilds.cache.get(guildId) ?? null;

  return {
    range,
    totals: summary.totals,
    daily: summary.daily,
    roles: summary.roles.map((r) => {
      const role = guild?.roles.cache.get(r.roleId) ?? null;
      return {
        ...r,
        // `null` : menu ou rôle supprimé depuis, les clics passés restent comptés.
        menuTitle: titleOf.get(r.menuId) ?? null,
        roleName: role?.name ?? null,
        roleColor: role && role.color !== 0 ? `#${role.color.toString(16).padStart(6, '0')}` : null,
        holders: role ? role.members.size : null,
      };
    }),
  };
}
