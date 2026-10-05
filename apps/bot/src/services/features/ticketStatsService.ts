/**
 * Performance du support : ce qu'un responsable regarde chaque semaine dans
 * un outil comme Zendesk Explore.
 *
 * - volume : tickets ouverts et fermés par jour ;
 * - délais : première réponse et résolution, en médiane et au 90e centile
 *   (la moyenne cache les tickets oubliés, le P90 les montre) ;
 * - respect des objectifs de service quand le serveur en a fixé ;
 * - satisfaction des membres ;
 * - file actuelle ;
 * - le même découpage par membre du staff, par type et par étiquette.
 */
import prisma from '../../utils/db.js';
import { BucketZoner } from '../analytics/zonedBuckets.js';
import { computeSla, waitingOn, type SlaConfig } from './ticketHelpdesk.js';

const MAX_TICKETS = 20_000;

export interface DurationStats {
  count: number;
  /** En minutes. */
  median: number | null;
  p90: number | null;
}

export interface AgentStats {
  userId: string;
  name: string;
  handled: number;
  closed: number;
  firstResponse: DurationStats;
  resolution: DurationStats;
  rating: number | null;
  ratings: number;
  openNow: number;
}

/** Une mesure jour par jour, sur la période et sur celle d'avant (même longueur). */
export interface DailySeries {
  created: number[];
  closed: number[];
  /** Médiane en minutes, par jour d'ouverture. */
  firstResponse: (number | null)[];
  /** Médiane en minutes, par jour de fermeture. */
  resolution: (number | null)[];
  /** Note moyenne du jour. */
  satisfaction: (number | null)[];
}

export interface TicketStats {
  window: { days: number; from: string; to: string };
  /** Séries pour la courbe pilotée par les tuiles, comme dans Analytics. */
  daily: { dates: string[]; current: DailySeries; previous: DailySeries };
  /** Totaux de la période d'avant, pour les écarts des tuiles. */
  previous: { created: number; closed: number; firstResponseMedian: number | null; resolutionMedian: number | null; satisfaction: number | null };
  timezone: string;
  volume: { created: number; closed: number; byDay: Array<{ date: string; created: number; closed: number }> };
  firstResponse: DurationStats;
  resolution: DurationStats;
  sla: {
    configured: boolean;
    firstResponseMinutes: number | null;
    resolutionHours: number | null;
    firstResponseMet: number | null;
    resolutionMet: number | null;
  };
  satisfaction: { average: number | null; count: number; distribution: number[] };
  backlog: { active: number; unassigned: number; waitingStaff: number; breached: number; oldestActiveAt: string | null };
  agents: AgentStats[];
  byType: Array<{ label: string; count: number; resolution: DurationStats }>;
  byTag: Array<{ tag: string; count: number }>;
}

/** Quantile par interpolation linéaire, sur un tableau quelconque. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return Math.round(value * 10) / 10;
}

export function durationStats(minutes: number[]): DurationStats {
  return { count: minutes.length, median: quantile(minutes, 0.5), p90: quantile(minutes, 0.9) };
}

const minutesBetween = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / 60_000);

/** Comptes, médianes et moyennes par jour, dans l'ordre de `keys`. */
export function dailySeries(
  keys: string[],
  zoner: BucketZoner,
  created: Array<{ createdAt: Date; firstResponseAt: Date | null }>,
  closed: Array<{ createdAt: Date; closedAt: Date | null }>,
  ratings: Array<{ createdAt: Date; rating: number }>,
): DailySeries {
  const index = new Map(keys.map((key, i) => [key, i]));
  const bucket = () => keys.map(() => [] as number[]);
  const createdCount = keys.map(() => 0);
  const closedCount = keys.map(() => 0);
  const frt = bucket();
  const res = bucket();
  const notes = bucket();

  for (const ticket of created) {
    const i = index.get(zoner.fromDate(ticket.createdAt).dateKey);
    if (i === undefined) continue;
    createdCount[i] += 1;
    if (ticket.firstResponseAt) frt[i].push(minutesBetween(ticket.createdAt, ticket.firstResponseAt));
  }
  for (const ticket of closed) {
    if (!ticket.closedAt) continue;
    const i = index.get(zoner.fromDate(ticket.closedAt).dateKey);
    if (i === undefined) continue;
    closedCount[i] += 1;
    res[i].push(minutesBetween(ticket.createdAt, ticket.closedAt));
  }
  for (const row of ratings) {
    const i = index.get(zoner.fromDate(row.createdAt).dateKey);
    if (i !== undefined) notes[i].push(row.rating);
  }

  return {
    created: createdCount,
    closed: closedCount,
    firstResponse: frt.map((values) => quantile(values, 0.5)),
    resolution: res.map((values) => quantile(values, 0.5)),
    satisfaction: notes.map((values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null)),
  };
}

export async function getTicketStats(guildId: string, days: number, timezone: string): Promise<TicketStats> {
  const span = Math.min(90, Math.max(7, Math.trunc(days) || 30));
  const now = new Date();
  const since = new Date(now.getTime() - span * 86_400_000);
  const prevSince = new Date(since.getTime() - span * 86_400_000);
  const zoner = new BucketZoner(timezone);

  const [guild, createdAll, closedAll, active, ratingsAll] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId }, select: { ticketSlaFirstResponseMinutes: true, ticketSlaResolutionHours: true } }),
    prisma.ticket.findMany({
      where: { guildId, createdAt: { gte: prevSince }, status: { notIn: ['PENDING', 'REJECTED'] } },
      select: {
        status: true, createdAt: true, firstResponseAt: true, firstResponderId: true, closedAt: true, claimedById: true,
        claimedByName: true, ticketTypeLabel: true, tags: true, lastMemberMessageAt: true, lastStaffMessageAt: true,
      },
      take: MAX_TICKETS,
    }),
    prisma.ticket.findMany({
      where: { guildId, closedAt: { gte: prevSince } },
      select: { createdAt: true, closedAt: true },
      take: MAX_TICKETS,
    }),
    prisma.ticket.findMany({
      where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } },
      select: {
        status: true, createdAt: true, firstResponseAt: true, closedAt: true, claimedById: true,
        lastMemberMessageAt: true, lastStaffMessageAt: true,
      },
      take: MAX_TICKETS,
    }),
    prisma.ticketSatisfaction.findMany({
      where: { guildId, createdAt: { gte: prevSince } },
      select: { rating: true, staffId: true, createdAt: true },
      take: MAX_TICKETS,
    }),
  ]);

  const created = createdAll.filter((ticket) => ticket.createdAt >= since);
  const createdPrev = createdAll.filter((ticket) => ticket.createdAt < since);
  const closedInWindow = closedAll.filter((ticket) => ticket.closedAt && ticket.closedAt >= since);
  const closedPrev = closedAll.filter((ticket) => ticket.closedAt && ticket.closedAt < since);
  const ratings = ratingsAll.filter((row) => row.createdAt >= since);
  const ratingsPrev = ratingsAll.filter((row) => row.createdAt < since);

  const sla: SlaConfig = {
    firstResponseMinutes: guild?.ticketSlaFirstResponseMinutes ?? null,
    resolutionHours: guild?.ticketSlaResolutionHours ?? null,
  };

  // ── Volume par jour ──
  const dayKeys: string[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const key = zoner.fromDate(new Date(now.getTime() - offset * 86_400_000)).dateKey;
    if (!dayKeys.includes(key)) dayKeys.push(key);
  }
  const perDay = new Map(dayKeys.map((key) => [key, { created: 0, closed: 0 }]));
  for (const ticket of created) {
    const entry = perDay.get(zoner.fromDate(ticket.createdAt).dateKey);
    if (entry) entry.created += 1;
  }
  for (const ticket of closedInWindow) {
    if (!ticket.closedAt) continue;
    const entry = perDay.get(zoner.fromDate(ticket.closedAt).dateKey);
    if (entry) entry.closed += 1;
  }

  // ── Délais et objectifs ──
  const frt: number[] = [];
  const resolution: number[] = [];
  let frtMeasured = 0;
  let frtMet = 0;
  let resMeasured = 0;
  let resMet = 0;
  for (const ticket of created) {
    if (ticket.firstResponseAt) frt.push(minutesBetween(ticket.createdAt, ticket.firstResponseAt));
    if (ticket.closedAt) resolution.push(minutesBetween(ticket.createdAt, ticket.closedAt));
    const clocks = computeSla(ticket, sla, now);
    if (clocks.firstResponse && clocks.firstResponse.status !== 'running' && clocks.firstResponse.status !== 'at_risk') {
      frtMeasured += 1;
      if (clocks.firstResponse.status === 'met') frtMet += 1;
    }
    if (clocks.resolution && clocks.resolution.status !== 'running' && clocks.resolution.status !== 'at_risk') {
      resMeasured += 1;
      if (clocks.resolution.status === 'met') resMet += 1;
    }
  }

  // ── Satisfaction ──
  const distribution = [0, 0, 0, 0, 0];
  for (const row of ratings) if (row.rating >= 1 && row.rating <= 5) distribution[row.rating - 1] += 1;
  const ratingTotal = ratings.reduce((sum, row) => sum + row.rating, 0);

  // ── File actuelle ──
  let breached = 0;
  let waitingStaff = 0;
  let oldest: Date | null = null;
  for (const ticket of active) {
    // Même règle que la vue « Dépassés » : ce qui demande une action
    // maintenant. Une première réponse arrivée en retard est comptée dans le
    // taux de respect, pas dans la file.
    const clocks = computeSla(ticket, sla, now);
    if ((clocks.firstResponse?.status === 'breached' && !clocks.firstResponse.completedAt) || clocks.resolution?.status === 'breached') breached += 1;
    if (waitingOn(ticket) === 'staff') waitingStaff += 1;
    if (!oldest || ticket.createdAt < oldest) oldest = ticket.createdAt;
  }

  // ── Par membre du staff ──
  const agents = new Map<string, { name: string; handled: number; closed: number; frt: number[]; resolution: number[] }>();
  const agent = (id: string, name: string | null) => {
    let entry = agents.get(id);
    if (!entry) {
      entry = { name: name ?? id, handled: 0, closed: 0, frt: [], resolution: [] };
      agents.set(id, entry);
    } else if (name && entry.name === id) {
      entry.name = name;
    }
    return entry;
  };
  for (const ticket of created) {
    if (ticket.claimedById) {
      const entry = agent(ticket.claimedById, ticket.claimedByName);
      entry.handled += 1;
      if (ticket.closedAt) {
        entry.closed += 1;
        entry.resolution.push(minutesBetween(ticket.createdAt, ticket.closedAt));
      }
    }
    if (ticket.firstResponderId && ticket.firstResponseAt) {
      agent(ticket.firstResponderId, ticket.firstResponderId === ticket.claimedById ? ticket.claimedByName : null)
        .frt.push(minutesBetween(ticket.createdAt, ticket.firstResponseAt));
    }
  }
  const ratingsByStaff = new Map<string, number[]>();
  for (const row of ratings) {
    if (!row.staffId) continue;
    ratingsByStaff.set(row.staffId, [...(ratingsByStaff.get(row.staffId) ?? []), row.rating]);
  }
  const openByStaff = new Map<string, number>();
  for (const ticket of active) if (ticket.claimedById) openByStaff.set(ticket.claimedById, (openByStaff.get(ticket.claimedById) ?? 0) + 1);

  const agentRows: AgentStats[] = [...agents.entries()].map(([userId, entry]) => {
    const own = ratingsByStaff.get(userId) ?? [];
    return {
      userId,
      name: entry.name,
      handled: entry.handled,
      closed: entry.closed,
      firstResponse: durationStats(entry.frt),
      resolution: durationStats(entry.resolution),
      rating: own.length ? Math.round((own.reduce((a, b) => a + b, 0) / own.length) * 10) / 10 : null,
      ratings: own.length,
      openNow: openByStaff.get(userId) ?? 0,
    };
  }).sort((a, b) => b.handled - a.handled || b.firstResponse.count - a.firstResponse.count);

  // ── Par type et par étiquette ──
  const types = new Map<string, number[]>();
  const typeCounts = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const ticket of created) {
    const label = ticket.ticketTypeLabel ?? 'Sans type';
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
    if (ticket.closedAt) types.set(label, [...(types.get(label) ?? []), minutesBetween(ticket.createdAt, ticket.closedAt)]);
    for (const tag of ticket.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }

  const prevKeys: string[] = [];
  for (let offset = 2 * span - 1; offset >= span; offset -= 1) {
    const key = zoner.fromDate(new Date(now.getTime() - offset * 86_400_000)).dateKey;
    if (!prevKeys.includes(key)) prevKeys.push(key);
  }
  const average = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);

  return {
    window: { days: span, from: since.toISOString(), to: now.toISOString() },
    daily: {
      dates: dayKeys,
      current: dailySeries(dayKeys, zoner, created, closedInWindow, ratings),
      // Alignée sur la période courante, jour pour jour : le 1er jour d'avant
      // sous le 1er jour d'aujourd'hui, comme les pointillés d'Analytics.
      previous: dailySeries(prevKeys.slice(-dayKeys.length), zoner, createdPrev, closedPrev, ratingsPrev),
    },
    previous: {
      created: createdPrev.length,
      closed: closedPrev.length,
      firstResponseMedian: quantile(createdPrev.flatMap((t) => (t.firstResponseAt ? [minutesBetween(t.createdAt, t.firstResponseAt)] : [])), 0.5),
      resolutionMedian: quantile(createdPrev.flatMap((t) => (t.closedAt ? [minutesBetween(t.createdAt, t.closedAt)] : [])), 0.5),
      satisfaction: average(ratingsPrev.map((row) => row.rating)),
    },
    timezone,
    volume: {
      created: created.length,
      closed: closedInWindow.length,
      byDay: [...perDay.entries()].map(([date, value]) => ({ date, ...value })),
    },
    firstResponse: durationStats(frt),
    resolution: durationStats(resolution),
    sla: {
      configured: sla.firstResponseMinutes !== null || sla.resolutionHours !== null,
      firstResponseMinutes: sla.firstResponseMinutes,
      resolutionHours: sla.resolutionHours,
      firstResponseMet: frtMeasured ? Math.round((frtMet / frtMeasured) * 1000) / 10 : null,
      resolutionMet: resMeasured ? Math.round((resMet / resMeasured) * 1000) / 10 : null,
    },
    satisfaction: {
      average: ratings.length ? Math.round((ratingTotal / ratings.length) * 10) / 10 : null,
      count: ratings.length,
      distribution,
    },
    backlog: {
      active: active.length,
      unassigned: active.filter((ticket) => ticket.status === 'OPEN' && !ticket.claimedById).length,
      waitingStaff,
      breached,
      oldestActiveAt: oldest?.toISOString() ?? null,
    },
    agents: agentRows.slice(0, 30),
    byType: [...typeCounts.entries()]
      .map(([label, count]) => ({ label, count, resolution: durationStats(types.get(label) ?? []) }))
      .sort((a, b) => b.count - a.count),
    byTag: [...tags.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 20),
  };
}
