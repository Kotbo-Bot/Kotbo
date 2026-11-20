/**
 * audienceInsightsService.ts
 *
 * Membres et rétention d'Analytics :
 *   - engagement : actifs par jour, semaine glissante et mois glissant
 *     (DAU / WAU / MAU) et adhérence DAU/MAU, comme Mixpanel ou GA4 ;
 *   - cohortes d'activité : part de chaque semaine d'arrivée encore active
 *     S+1, S+2… (les cohortes historiques ne mesuraient que la présence) ;
 *   - entonnoir d'arrivée : arrivée → premier message → actif à 7 j → actif
 *     à 30 j, et le même entonnoir par source d'invitation ;
 *   - cycle de vie : nouveaux, réguliers, occasionnels, en baisse, dormants,
 *     réactivés, avec la liste des membres à relancer.
 *
 * « Actif » veut dire : au moins un message ou une minute de vocal ce jour-là
 * (member_daily_stats). Le périmètre de rôle et l'exclusion du staff
 * s'appliquent ; un filtre de salon ne s'y applique pas (ces tables ne sont
 * pas tenues par salon), la réponse le signale par `channelIgnored`.
 */

import { Prisma } from '@prisma/client';
import type { Client } from 'discord.js';
import { prismaRead } from '../../utils/db.js';
import { extractPrimaryGuildTag } from '../core/serverTagService.js';
import { addDays, dayKeys, scopeSql, type AnalyticsScope, type DateRange } from './contentAnalyticsService.js';

const DAY_MS = 24 * 3600 * 1000;
const ACTIVE = Prisma.sql`("messagesCount" > 0 OR "voiceMinutes" > 0)`;
const userScope = (scope: AnalyticsScope) => scopeSql(scope, { channels: false });

function inScope(scope: AnalyticsScope, userId: string): boolean {
  if (scope.userIds && !scope.userIds.includes(userId)) return false;
  return !scope.excludeUserIds.includes(userId);
}

// ── Engagement ─────────────────────────────────────────────────────────────

export interface EngagementPoint { dateKey: string; dau: number; wau: number; mau: number }

async function engagementSeries(guildId: string, start: string, end: string, step: number, scope: AnalyticsScope): Promise<EngagementPoint[]> {
  // Pour chaque jour d : actifs le jour d, sur [d-6, d] et sur [d-29, d].
  const rows = await prismaRead.$queryRaw<Array<{ day: string; dau: number; wau: number; mau: number }>>`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
      COUNT(DISTINCT "userId") FILTER (WHERE "dateKey" = to_char(d, 'YYYY-MM-DD'))::int AS dau,
      COUNT(DISTINCT "userId") FILTER (WHERE "dateKey" >= to_char(d - interval '6 days', 'YYYY-MM-DD'))::int AS wau,
      COUNT(DISTINCT "userId")::int AS mau
    FROM generate_series(${start}::date, ${end}::date, make_interval(days => ${step}::int)) AS d
    JOIN "member_daily_stats" ON "guildId" = ${guildId}
      AND "dateKey" >= to_char(d - interval '29 days', 'YYYY-MM-DD')
      AND "dateKey" <= to_char(d, 'YYYY-MM-DD')
      AND ${ACTIVE}${userScope(scope)}
    GROUP BY d ORDER BY d
  `;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const keys = dayKeys(start, end).filter((_, i) => i % step === 0);
  return keys.map((dateKey) => {
    const r = byDay.get(dateKey);
    return { dateKey, dau: r?.dau ?? 0, wau: r?.wau ?? 0, mau: r?.mau ?? 0 };
  });
}

export async function getEngagement(guildId: string, range: DateRange, scope: AnalyticsScope) {
  // Au-delà de trois mois, un point par semaine : chaque point relit 30 jours.
  const step = range.days > 92 ? 7 : 1;
  const [points, prev] = await Promise.all([
    engagementSeries(guildId, range.start, range.end, step, scope),
    engagementSeries(guildId, range.prevStart, range.prevEnd, step, scope),
  ]);
  return {
    range,
    step,
    channelIgnored: scope.channelIds !== null,
    points: points.map((p, i) => ({
      ...p,
      prevDau: prev[i]?.dau ?? 0,
      prevWau: prev[i]?.wau ?? 0,
      prevMau: prev[i]?.mau ?? 0,
    })),
  };
}

// ── Cohortes d'activité ────────────────────────────────────────────────────

export const COHORT_WEEKS = 12;

/** Lundi (UTC) de la semaine d'une date. */
function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - weekday * DAY_MS).toISOString().slice(0, 10);
}

export async function getActivityCohorts(guildId: string, scope: AnalyticsScope, now = new Date()) {
  const thisMonday = mondayOf(now);
  const since = addDays(thisMonday, -7 * (COHORT_WEEKS - 1));
  const profiles = await prismaRead.memberProfile.findMany({
    where: { guildId, isBot: false, guildJoinedAt: { gte: new Date(`${since}T00:00:00Z`) } },
    select: { userId: true, guildJoinedAt: true },
  });
  const cohortOf = new Map<string, string>();
  for (const p of profiles) {
    if (p.guildJoinedAt && inScope(scope, p.userId)) cohortOf.set(p.userId, mondayOf(p.guildJoinedAt));
  }
  const ids = [...cohortOf.keys()];
  const activity = ids.length > 0
    ? await prismaRead.$queryRaw<Array<{ userId: string; dateKey: string }>>`
        SELECT DISTINCT "userId", "dateKey" FROM "member_daily_stats"
        WHERE "guildId" = ${guildId} AND "dateKey" >= ${since} AND ${ACTIVE}
          AND "userId" IN (${Prisma.join(ids)})
      `
    : [];

  const weeks = Array.from({ length: COHORT_WEEKS }, (_, i) => addDays(since, i * 7));
  const size = new Map<string, number>();
  for (const week of cohortOf.values()) size.set(week, (size.get(week) ?? 0) + 1);
  // (cohorte, décalage) → membres actifs distincts.
  const active = new Map<string, Set<string>>();
  for (const row of activity) {
    const cohort = cohortOf.get(row.userId);
    if (!cohort) continue;
    const offset = Math.floor((Date.parse(`${mondayOf(new Date(`${row.dateKey}T00:00:00Z`))}T00:00:00Z`) - Date.parse(`${cohort}T00:00:00Z`)) / (7 * DAY_MS));
    if (offset < 0) continue;
    const key = `${cohort}|${offset}`;
    const set = active.get(key) ?? new Set<string>();
    set.add(row.userId);
    active.set(key, set);
  }

  return {
    weeks: COHORT_WEEKS,
    channelIgnored: scope.channelIds !== null,
    cohorts: weeks.map((week, wi) => {
      const n = size.get(week) ?? 0;
      // Une cohorte de la semaine k n'a que COHORT_WEEKS - k semaines de recul.
      const horizon = COHORT_WEEKS - wi;
      return {
        week,
        size: n,
        retention: Array.from({ length: COHORT_WEEKS }, (_, offset) =>
          offset >= horizon || n === 0 ? null : Math.round(((active.get(`${week}|${offset}`)?.size ?? 0) / n) * 1000) / 10),
      };
    }),
  };
}

// ── Entonnoir d'arrivée ────────────────────────────────────────────────────

export interface FunnelSteps {
  joined: number;
  stayed: number;
  firstMessage: number;
  /** Membres arrivés depuis assez longtemps pour juger l'étape. */
  eligible7: number;
  active7: number;
  eligible30: number;
  active30: number;
  medianDaysToFirstMessage: number | null;
}

interface Arrival { userId: string; joinedAt: Date; leftAt: Date | null }

/**
 * Étapes d'un groupe d'arrivées. « Actif à 7 j » = au moins un jour actif
 * entre J+7 et J+13 ; « actif à 30 j » = entre J+30 et J+44. Un membre arrivé
 * trop récemment ne compte pas dans l'étape (ni au numérateur ni au
 * dénominateur) : sinon le taux baisserait mécaniquement en fin de période.
 */
export function funnelOf(arrivals: Arrival[], activeDays: Map<string, string[]>, firstMessage: Map<string, string>, today: string): FunnelSteps {
  const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
  const delays: number[] = [];
  const steps: FunnelSteps = { joined: arrivals.length, stayed: 0, firstMessage: 0, eligible7: 0, active7: 0, eligible30: 0, active30: 0, medianDaysToFirstMessage: null };
  for (const a of arrivals) {
    const joinKey = a.joinedAt.toISOString().slice(0, 10);
    if (!a.leftAt || a.leftAt.getTime() - a.joinedAt.getTime() > 7 * DAY_MS) steps.stayed += 1;
    const first = firstMessage.get(a.userId);
    if (first && first >= joinKey) {
      steps.firstMessage += 1;
      delays.push(daysBetween(joinKey, first));
    }
    const days = (activeDays.get(a.userId) ?? []).map((d) => daysBetween(joinKey, d));
    if (daysBetween(joinKey, today) >= 14) {
      steps.eligible7 += 1;
      if (days.some((d) => d >= 7 && d <= 13)) steps.active7 += 1;
    }
    if (daysBetween(joinKey, today) >= 45) {
      steps.eligible30 += 1;
      if (days.some((d) => d >= 30 && d <= 44)) steps.active30 += 1;
    }
  }
  if (delays.length > 0) {
    delays.sort((x, y) => x - y);
    const mid = Math.floor(delays.length / 2);
    steps.medianDaysToFirstMessage = delays.length % 2 ? delays[mid]! : (delays[mid - 1]! + delays[mid]!) / 2;
  }
  return steps;
}

export async function getOnboardingFunnel(client: Client, guildId: string, range: DateRange, scope: AnalyticsScope) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const profiles = await prismaRead.memberProfile.findMany({
    where: {
      guildId,
      isBot: false,
      guildJoinedAt: { gte: new Date(`${range.start}T00:00:00Z`), lte: new Date(`${range.end}T23:59:59Z`) },
    },
    select: { userId: true, guildJoinedAt: true, guildLeftAt: true },
    take: 20_000,
  });
  const arrivals: Arrival[] = profiles
    .filter((p) => p.guildJoinedAt && inScope(scope, p.userId))
    .map((p) => ({ userId: p.userId, joinedAt: p.guildJoinedAt!, leftAt: p.guildLeftAt }));
  const ids = arrivals.map((a) => a.userId);

  const [rows, invites, guildInvites] = await Promise.all([
    ids.length > 0
      ? prismaRead.$queryRaw<Array<{ userId: string; dateKey: string; messages: number }>>`
          SELECT "userId", "dateKey", "messagesCount"::int AS messages FROM "member_daily_stats"
          WHERE "guildId" = ${guildId} AND "dateKey" >= ${range.start} AND ${ACTIVE}
            AND "userId" IN (${Prisma.join(ids)})
        `
      : Promise.resolve([]),
    ids.length > 0
      ? prismaRead.memberInvite.findMany({
          where: { guildId, userId: { in: ids } },
          select: { userId: true, inviteCode: true, inviterTag: true, joinedAt: true },
          orderBy: { joinedAt: 'desc' },
        })
      : Promise.resolve([]),
    prismaRead.guildInvite.findMany({ where: { guildId }, select: { code: true, sourceLabel: true } }),
  ]);

  const activeDays = new Map<string, string[]>();
  const firstMessage = new Map<string, string>();
  for (const r of rows) {
    const list = activeDays.get(r.userId) ?? [];
    list.push(r.dateKey);
    activeDays.set(r.userId, list);
    if (r.messages > 0) {
      const prev = firstMessage.get(r.userId);
      if (!prev || r.dateKey < prev) firstMessage.set(r.userId, r.dateKey);
    }
  }

  // Source : libellé posé sur le lien, lien personnalisé du serveur, code, ou inconnue.
  const labelOf = new Map(guildInvites.map((g) => [g.code, g.sourceLabel]));
  const vanity = guild?.vanityURLCode ?? null;
  const sourceOf = new Map<string, { key: string; label: string | null; kind: 'label' | 'vanity' | 'code' | 'unknown' }>();
  for (const inv of invites) {
    if (sourceOf.has(inv.userId)) continue;
    const code = inv.inviteCode;
    if (!code) sourceOf.set(inv.userId, { key: 'unknown', label: null, kind: 'unknown' });
    else if (vanity && code === vanity) sourceOf.set(inv.userId, { key: 'vanity', label: code, kind: 'vanity' });
    else if (labelOf.get(code)) sourceOf.set(inv.userId, { key: `label:${labelOf.get(code)}`, label: labelOf.get(code)!, kind: 'label' });
    else sourceOf.set(inv.userId, { key: `code:${code}`, label: inv.inviterTag ? `${code} (${inv.inviterTag})` : code, kind: 'code' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, { label: string | null; kind: string; arrivals: Arrival[] }>();
  for (const a of arrivals) {
    const src = sourceOf.get(a.userId) ?? { key: 'unknown', label: null, kind: 'unknown' as const };
    const g = groups.get(src.key) ?? { label: src.label, kind: src.kind, arrivals: [] };
    g.arrivals.push(a);
    groups.set(src.key, g);
  }

  const bySource = [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, kind: g.kind, ...funnelOf(g.arrivals, activeDays, firstMessage, today) }))
    .sort((a, b) => b.joined - a.joined)
    .slice(0, 12);

  return {
    range,
    channelIgnored: scope.channelIds !== null,
    overall: funnelOf(arrivals, activeDays, firstMessage, today),
    bySource,
  };
}

// ── Cycle de vie ───────────────────────────────────────────────────────────

export type Segment = 'new' | 'reactivated' | 'declining' | 'regular' | 'casual' | 'dormant' | 'silent';
export const SEGMENTS: Segment[] = ['new', 'regular', 'casual', 'reactivated', 'declining', 'dormant', 'silent'];

export interface MemberWindows {
  /** Jours actifs sur les 14 derniers jours. */
  a14: number;
  /** Jours actifs sur les 28 derniers jours. */
  a28: number;
  /** Jours actifs sur les 28 jours d'avant (J-56 à J-29). */
  p28: number;
  /** Jours actifs sur les 28 jours qui précèdent les 14 derniers (J-42 à J-15). */
  gap28: number;
  /** Jours actifs avant J-42, dans les six derniers mois. */
  older: number;
}

/**
 * Segment d'un membre, par ordre de priorité : un nouveau reste « nouveau »
 * même s'il parle beaucoup, un réactivé prime sur régulier.
 */
export function segmentOf(w: MemberWindows | undefined, joinedDaysAgo: number | null): Segment {
  if (joinedDaysAgo !== null && joinedDaysAgo < 14) return 'new';
  if (!w) return 'silent';
  if (w.a14 > 0 && w.gap28 === 0 && w.older > 0) return 'reactivated';
  if (w.p28 >= 6 && w.a28 <= w.p28 * 0.5) return 'declining';
  if (w.a28 >= 8) return 'regular';
  if (w.a28 >= 1) return 'casual';
  if (w.p28 + w.older > 0) return 'dormant';
  return 'silent';
}

async function windowsAt(guildId: string, asOf: string, scope: AnalyticsScope) {
  const k14 = addDays(asOf, -14);
  const k28 = addDays(asOf, -28);
  const k42 = addDays(asOf, -42);
  const k56 = addDays(asOf, -56);
  const k180 = addDays(asOf, -180);
  const rows = await prismaRead.$queryRaw<Array<MemberWindows & { userId: string; last: string }>>`
    SELECT "userId",
      COUNT(*) FILTER (WHERE "dateKey" > ${k14})::int AS a14,
      COUNT(*) FILTER (WHERE "dateKey" > ${k28})::int AS a28,
      COUNT(*) FILTER (WHERE "dateKey" <= ${k28} AND "dateKey" > ${k56})::int AS p28,
      COUNT(*) FILTER (WHERE "dateKey" <= ${k14} AND "dateKey" > ${k42})::int AS gap28,
      COUNT(*) FILTER (WHERE "dateKey" <= ${k42})::int AS older,
      MAX("dateKey") AS last
    FROM "member_daily_stats"
    WHERE "guildId" = ${guildId} AND "dateKey" > ${k180} AND "dateKey" <= ${asOf} AND ${ACTIVE}${userScope(scope)}
    GROUP BY "userId"
  `;
  return new Map(rows.map((r) => [r.userId, r]));
}

export const LIFECYCLE_LIST_MAX = 100;

export async function getLifecycle(client: Client, guildId: string, range: DateRange, scope: AnalyticsScope) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const [members, now, before] = await Promise.all([
    prismaRead.memberProfile.findMany({
      where: { guildId, isBot: false, guildLeftAt: null },
      select: { userId: true, guildJoinedAt: true, displayName: true, globalName: true, username: true, avatarUrl: true },
    }),
    windowsAt(guildId, range.end, scope),
    windowsAt(guildId, range.prevEnd, scope),
  ]);

  const endMs = Date.parse(`${range.end}T23:59:59Z`);
  const prevEndMs = Date.parse(`${range.prevEnd}T23:59:59Z`);
  const counts = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<Segment, number>;
  const prevCounts = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<Segment, number>;
  const lists: Partial<Record<Segment, Array<Record<string, unknown>>>> = { declining: [], dormant: [], reactivated: [], new: [] };
  const transitions = new Map<string, number>();

  for (const p of members) {
    if (!inScope(scope, p.userId)) continue;
    const joinedMs = p.guildJoinedAt?.getTime() ?? null;
    const seg = segmentOf(now.get(p.userId), joinedMs === null ? null : Math.floor((endMs - joinedMs) / DAY_MS));
    counts[seg] += 1;
    // Un membre arrivé après la fin de la période d'avant n'y avait pas de segment.
    if (joinedMs === null || joinedMs <= prevEndMs) {
      const prevSeg = segmentOf(before.get(p.userId), joinedMs === null ? null : Math.floor((prevEndMs - joinedMs) / DAY_MS));
      prevCounts[prevSeg] += 1;
      if (prevSeg !== seg) transitions.set(`${prevSeg}>${seg}`, (transitions.get(`${prevSeg}>${seg}`) ?? 0) + 1);
    }
    const list = lists[seg];
    if (list) {
      const w = now.get(p.userId);
      const member = guild?.members.cache.get(p.userId);
      const tag = extractPrimaryGuildTag(member?.user);
      list.push({
        userId: p.userId,
        name: member?.displayName ?? p.displayName ?? p.globalName ?? p.username ?? null,
        avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? p.avatarUrl ?? null,
        lastActive: w?.last ?? null,
        recentDays: w?.a28 ?? 0,
        previousDays: w?.p28 ?? 0,
        joinedAt: p.guildJoinedAt?.toISOString() ?? null,
        serverTag: tag ? { tag: tag.tag, badgeUrl: tag.badgeUrl } : null,
      });
    }
  }

  // À relancer en premier : ceux qui étaient les plus présents.
  for (const [seg, list] of Object.entries(lists)) {
    list!.sort((a, b) => (seg === 'new' ? String(b.joinedAt).localeCompare(String(a.joinedAt)) : Number(b.previousDays) - Number(a.previousDays)));
    lists[seg as Segment] = list!.slice(0, LIFECYCLE_LIST_MAX);
  }

  return {
    asOf: range.end,
    prevAsOf: range.prevEnd,
    channelIgnored: scope.channelIds !== null,
    counts,
    prevCounts,
    transitions: [...transitions.entries()]
      .map(([key, count]) => {
        const [from, to] = key.split('>') as [Segment, Segment];
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    lists,
  };
}
