/**
 * Suivi des boosts : boost en cours recopié sur le profil, historique des
 * débuts/arrêts (BoostEvent) et point quotidien du serveur (GuildBoostSnapshot).
 *
 * Discord ne garde que la date de début du boost en cours : sans ces écritures,
 * un arrêt de boost ne laisse aucune trace. Le rattrapage horaire recolle les
 * boosts posés ou retirés pendant que le bot était éteint.
 */
import type { Client, Guild, GuildMember } from 'discord.js';
import { boostMonths, boostTierFor } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isGuildActivated } from '../../utils/activation.js';
import { memberProfileIdentity } from '../moderation/memberIdentityService.js';
import { notify } from '../notifications/notifyService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/**
 * Aligne le profil et l'historique sur le boost réel du membre.
 *
 * L'écriture du profil est conditionnée à la valeur lue : de deux événements
 * concurrents (mise à jour, membre disponible, rattrapage), un seul gagne et
 * note l'événement, les autres ne font rien.
 */
export async function syncMemberBoost(member: GuildMember, now = new Date()): Promise<'start' | 'stop' | 'restart' | null> {
  if (member.user.bot) return null;
  const guildId = member.guild.id;
  const userId = member.id;
  const live = member.premiumSince;
  const profile = await prisma.memberProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { boostingSince: true },
  });
  const stored = profile?.boostingSince ?? null;
  if (sameInstant(live, stored)) return null;

  const claimed = profile
    ? (await prisma.memberProfile.updateMany({
        where: { guildId, userId, boostingSince: stored },
        data: { boostingSince: live },
      })).count > 0
    : await prisma.memberProfile
        .create({ data: { guildId, userId, ...memberProfileIdentity(member), boostingSince: live } })
        .then(() => true, () => false);
  if (!claimed) return null;

  if (live && !stored) {
    // Daté du vrai début du boost, même rattrapé des heures plus tard.
    await prisma.boostEvent.create({ data: { guildId, userId, type: 'START', boostingSince: live, createdAt: live } });
    return 'start';
  }
  if (!live && stored) {
    await prisma.boostEvent.create({ data: { guildId, userId, type: 'STOP', boostingSince: stored, createdAt: now } });
    void notifyBoostLost(member.guild, member.displayName, userId, stored, now);
    return 'stop';
  }
  // Nouvelle date de début : l'arrêt a eu lieu pendant que le bot ne voyait rien.
  await prisma.boostEvent.createMany({
    data: [
      { guildId, userId, type: 'STOP', boostingSince: stored, createdAt: live! },
      { guildId, userId, type: 'START', boostingSince: live, createdAt: live! },
    ],
  });
  return 'restart';
}

/** Un booster qui quitte le serveur perd son boost : Discord ne l'annonce pas autrement. */
export async function stopBoostOnLeave(guild: Guild, userId: string, name: string, now = new Date()): Promise<void> {
  const profile = await prisma.memberProfile.findUnique({
    where: { guildId_userId: { guildId: guild.id, userId } },
    select: { boostingSince: true },
  });
  const stored = profile?.boostingSince;
  if (!stored) return;
  const { count } = await prisma.memberProfile.updateMany({
    where: { guildId: guild.id, userId, boostingSince: stored },
    data: { boostingSince: null },
  });
  if (count === 0) return;
  await prisma.boostEvent.create({ data: { guildId: guild.id, userId, type: 'STOP', boostingSince: stored, createdAt: now } });
  void notifyBoostLost(guild, name, userId, stored, now);
}

function durationLabel(since: Date, now: Date): string {
  const months = boostMonths(since, now);
  if (months >= 1) return `${months} mois`;
  const days = Math.max(1, Math.round((now.getTime() - since.getTime()) / DAY_MS));
  return `${days} jour${days > 1 ? 's' : ''}`;
}

async function notifyBoostLost(guild: Guild, name: string, userId: string, since: Date, now: Date): Promise<void> {
  try {
    await notify({
      guildId: guild.id,
      userId: guild.ownerId,
      kind: 'community.boost_lost',
      title: '💔 Boost perdu',
      message: `${name} ne booste plus le serveur, après ${durationLabel(since, now)} de boost.`,
      severity: 'WARNING',
      link: '/analytics/boosts',
      actorId: userId,
      groupKey: 'boost-lost',
    });
  } catch (err) {
    logger.warn('Boosts', `Notification de boost perdu impossible sur ${guild.id}:`, err);
  }
}

/** Le serveur descend d'un niveau : prévenir le propriétaire. */
export async function notifyTierDrop(guild: Guild, fromTier: number, toTier: number): Promise<void> {
  try {
    await notify({
      guildId: guild.id,
      userId: guild.ownerId,
      kind: 'community.boost_lost',
      title: '📉 Niveau de boost perdu',
      message: `Le serveur passe du niveau ${fromTier} au niveau ${toTier} (${guild.premiumSubscriptionCount ?? 0} boost(s)).`,
      severity: 'WARNING',
      link: '/analytics/boosts',
    });
  } catch (err) {
    logger.warn('Boosts', `Notification de perte de niveau impossible sur ${guild.id}:`, err);
  }
}

/** Rattrape les boosts vus dans le cache, puis note le point du jour. */
export async function runBoostSnapshots(client: Client): Promise<void> {
  const dateKey = new Date().toISOString().slice(0, 10);
  for (const guild of client.guilds.cache.values()) {
    if (!isGuildActivated(guild.id)) continue;
    try {
      await reconcileGuildBoosts(guild);
      const boosterCount = await prisma.memberProfile.count({
        where: { guildId: guild.id, boostingSince: { not: null }, guildLeftAt: null, isBot: false },
      });
      const boostCount = guild.premiumSubscriptionCount ?? 0;
      const tier = guild.premiumTier ?? boostTierFor(boostCount);
      await prisma.guildBoostSnapshot.upsert({
        where: { guildId_dateKey: { guildId: guild.id, dateKey } },
        create: { guildId: guild.id, dateKey, boostCount, boosterCount, tier },
        update: { boostCount, boosterCount, tier },
      });
    } catch (err) {
      logger.warn('Boosts', `Point de boost impossible sur ${guild.id}:`, err);
    }
  }
}

async function reconcileGuildBoosts(guild: Guild): Promise<void> {
  for (const member of guild.members.cache.values()) {
    if (member.premiumSince) await syncMemberBoost(member);
  }
  const stale = await prisma.memberProfile.findMany({
    where: { guildId: guild.id, boostingSince: { not: null } },
    select: { userId: true, displayName: true, guildLeftAt: true },
  });
  for (const row of stale) {
    const member = guild.members.cache.get(row.userId);
    if (member) {
      if (!member.premiumSince) await syncMemberBoost(member);
    } else if (row.guildLeftAt) {
      await stopBoostOnLeave(guild, row.userId, row.displayName ?? row.userId);
    }
    // Absent du cache mais toujours là : on ne sait pas, on attend un événement.
  }
}

// ─── Lecture ────────────────────────────────────────────────────────────────

export type BoostPeriod = { start: string; end: string | null; days: number };

export type MemberBoostStats = {
  boostingSince: string | null;
  totalDays: number;
  periodCount: number;
  periods: BoostPeriod[];
};

type EventRow = { userId: string; type: string; boostingSince: Date | null; createdAt: Date };

/** Périodes de boost reconstruites à partir des événements, dans l'ordre chronologique. */
export function buildBoostPeriods(events: EventRow[], liveSince: Date | null, now = new Date()): Array<{ start: Date; end: Date | null }> {
  const periods: Array<{ start: Date; end: Date | null }> = [];
  let open: { start: Date; end: Date | null } | null = null;
  for (const e of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (e.type === 'START') {
      if (open) open.end = e.createdAt;
      open = { start: e.boostingSince ?? e.createdAt, end: null };
      periods.push(open);
    } else if (e.type === 'STOP') {
      if (open) open.end = e.createdAt;
      else periods.push({ start: e.boostingSince ?? e.createdAt, end: e.createdAt });
      open = null;
    }
  }
  // Boost en cours connu de Discord mais sans événement (historique d'avant le suivi).
  if (liveSince && !(open && sameInstant(open.start, liveSince))) {
    if (open) open.end = liveSince;
    periods.push({ start: liveSince, end: null });
  } else if (!liveSince && open) {
    open.end = now;
  }
  return periods;
}

function periodDays(p: { start: Date; end: Date | null }, now: Date): number {
  return Math.max(0, ((p.end ?? now).getTime() - p.start.getTime()) / DAY_MS);
}

export async function getMemberBoostStats(guildId: string, userId: string, liveSince: Date | null, now = new Date()): Promise<MemberBoostStats> {
  const events = await prisma.boostEvent
    .findMany({ where: { guildId, userId }, orderBy: { createdAt: 'asc' }, take: 500 })
    .catch(() => []);
  const periods = buildBoostPeriods(events, liveSince, now);
  return {
    boostingSince: liveSince?.toISOString() ?? null,
    totalDays: Math.round(periods.reduce((sum, p) => sum + periodDays(p, now), 0)),
    periodCount: periods.length,
    periods: periods
      .slice(-20)
      .reverse()
      .map((p) => ({ start: p.start.toISOString(), end: p.end?.toISOString() ?? null, days: Math.round(periodDays(p, now)) })),
  };
}

export type BoostAnalytics = {
  boostCount: number;
  tier: number;
  boosterCount: number;
  started: number;
  stopped: number;
  avgCurrentDays: number | null;
  avgEndedDays: number | null;
  series: Array<{ date: string; boostCount: number | null; boosterCount: number | null }>;
  boosters: Array<{ userId: string; since: string }>;
  formerBoosters: Array<{ userId: string; since: string | null; endedAt: string }>;
  events: Array<{ userId: string; type: 'START' | 'STOP'; at: string; since: string | null }>;
};

export async function getBoostAnalytics(client: Client, guildId: string, days: number, now = new Date()): Promise<BoostAnalytics> {
  const guild = client.guilds.cache.get(guildId);
  const from = new Date(now.getTime() - days * DAY_MS);
  const fromKey = from.toISOString().slice(0, 10);

  const [profiles, snapshots, windowEvents, recentStops] = await Promise.all([
    prisma.memberProfile.findMany({
      where: { guildId, boostingSince: { not: null }, guildLeftAt: null, isBot: false },
      select: { userId: true, boostingSince: true },
      orderBy: { boostingSince: 'asc' },
    }),
    prisma.guildBoostSnapshot.findMany({ where: { guildId, dateKey: { gte: fromKey } }, orderBy: { dateKey: 'asc' } }),
    prisma.boostEvent.findMany({ where: { guildId, createdAt: { gte: from } }, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.boostEvent.findMany({ where: { guildId, type: 'STOP' }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);

  // Le cache Discord fait foi pour les boosters en ligne pas encore resynchronisés.
  const current = new Map(profiles.map((p) => [p.userId, p.boostingSince!]));
  if (guild) {
    for (const m of guild.members.cache.values()) {
      if (m.user.bot) continue;
      if (m.premiumSince) current.set(m.id, m.premiumSince);
      else current.delete(m.id);
    }
  }

  const boostCount = guild?.premiumSubscriptionCount ?? snapshots.at(-1)?.boostCount ?? 0;
  const currentDays = [...current.values()].map((since) => (now.getTime() - since.getTime()) / DAY_MS);
  const stops = windowEvents.filter((e) => e.type === 'STOP');
  const endedDays = stops
    .filter((e) => e.boostingSince)
    .map((e) => (e.createdAt.getTime() - e.boostingSince!.getTime()) / DAY_MS);
  const avg = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

  const byDate = new Map(snapshots.map((s) => [s.dateKey, s]));
  const series: BoostAnalytics['series'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    const snap = byDate.get(date);
    series.push({ date, boostCount: snap?.boostCount ?? null, boosterCount: snap?.boosterCount ?? null });
  }

  const formerSeen = new Set<string>();
  const formerBoosters: BoostAnalytics['formerBoosters'] = [];
  for (const e of recentStops) {
    if (current.has(e.userId) || formerSeen.has(e.userId)) continue;
    formerSeen.add(e.userId);
    formerBoosters.push({ userId: e.userId, since: e.boostingSince?.toISOString() ?? null, endedAt: e.createdAt.toISOString() });
  }

  return {
    boostCount,
    tier: guild?.premiumTier ?? boostTierFor(boostCount),
    boosterCount: current.size,
    started: windowEvents.filter((e) => e.type === 'START').length,
    stopped: stops.length,
    avgCurrentDays: avg(currentDays),
    avgEndedDays: avg(endedDays),
    series,
    boosters: [...current.entries()]
      .sort((a, b) => a[1].getTime() - b[1].getTime())
      .map(([userId, since]) => ({ userId, since: since.toISOString() })),
    formerBoosters,
    events: windowEvents.map((e) => ({
      userId: e.userId,
      type: e.type === 'STOP' ? 'STOP' : 'START',
      at: e.createdAt.toISOString(),
      since: e.boostingSince?.toISOString() ?? null,
    })),
  };
}
