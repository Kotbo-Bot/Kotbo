import { formatWallClockInTimezone } from '@kotbo/contracts';
import {
  REPUTATION_DAILY_LIMIT,
  reputationPeriodStart,
  type ReputationPeriod,
} from '@kotbo/shared';
import prisma, { prismaRead } from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildTimezone } from '../../utils/timezone.js';

export interface ReputationSettings {
  dailyLimit: number;
}

export const DEFAULT_REPUTATION_SETTINGS: Readonly<ReputationSettings> = {
  dailyLimit: REPUTATION_DAILY_LIMIT.default,
};

export interface ReputationProfile {
  userId: string;
  totalRep: number;
  rank: number;
  votesGivenToday: number;
  dailyLimit: number;
  canVote: boolean;
}

/** Motif d'un refus de vote. Traduit par l'appelant, dans la langue du serveur. */
export type RepRefusalCode = 'SELF' | 'BOT' | 'DAILY_LIMIT' | 'ALREADY_TODAY';

export type GiveRepResult =
  | { success: true; newTotal: number }
  | { success: false; code: RepRefusalCode };

export interface ReputationLeaderboard {
  entries: Array<{ userId: string; totalRep: number; rank: number }>;
  totalVoters: number;
}

/** Motif temps réel : la page Réputation se recharge dès qu'un vote ou un réglage bouge. */
export const REPUTATION_REALTIME_REASON = 'reputation_updated';

// ── Réglages ─────────────────────────────────────────────────────────────────

/** Le dashboard invalide à chaque sauvegarde : le TTL ne couvre que les oublis. */
const CONFIG_TTL_SECONDS = 300;

function configCacheKey(guildId: string): string {
  return `guild:${guildId}:reputation-config`;
}

export async function getReputationConfig(guildId: string): Promise<ReputationSettings> {
  const cached = await cache.get<ReputationSettings>(configCacheKey(guildId));
  if (cached) return cached;

  // Primaire : juste après une sauvegarde, un réplica en retard remettrait
  // l'ancienne valeur en cache pour cinq minutes.
  const row = await prisma.reputationConfig.findUnique({ where: { guildId } }).catch((err) => {
    logger.error('Reputation', `Lecture des réglages de ${guildId} impossible`, err);
    return undefined;
  });
  // Une lecture ratée n'est pas mise en cache : elle ne doit pas figer les défauts.
  if (row === undefined) return { ...DEFAULT_REPUTATION_SETTINGS };

  const settings: ReputationSettings = row ? { dailyLimit: row.dailyLimit } : { ...DEFAULT_REPUTATION_SETTINGS };
  await cache.set(configCacheKey(guildId), settings, CONFIG_TTL_SECONDS);
  return settings;
}

export async function invalidateReputationConfigCache(guildId: string): Promise<void> {
  await cache.delete(configCacheKey(guildId));
}

/** Écrit les réglages validés par l'appelant. */
export async function saveReputationConfig(guildId: string, patch: Partial<ReputationSettings>): Promise<ReputationSettings> {
  const row = await prisma.reputationConfig.upsert({
    where: { guildId },
    create: { guildId, ...DEFAULT_REPUTATION_SETTINGS, ...patch },
    update: patch,
  });
  await invalidateReputationConfigCache(guildId);
  broadcastDashboardStateChange(guildId, REPUTATION_REALTIME_REASON);
  return { dailyLimit: row.dailyLimit };
}

// ── Votes ────────────────────────────────────────────────────────────────────

async function currentRepDay(guildId: string): Promise<string> {
  return formatWallClockInTimezone(new Date(), await resolveGuildTimezone(guildId)).slice(0, 10);
}

export async function getVotesGivenToday(guildId: string, userId: string): Promise<number> {
  const day = await currentRepDay(guildId);
  return prismaRead.reputationVote.count({
    where: { guildId, giverId: userId, day },
  });
}

export async function giveRep(
  guildId: string,
  giverId: string,
  receiverId: string,
  reason?: string,
  options: { receiverIsBot?: boolean; channelId?: string; messageId?: string } = {},
): Promise<GiveRepResult> {
  if (giverId === receiverId) return { success: false, code: 'SELF' };
  if (options.receiverIsBot) return { success: false, code: 'BOT' };

  const [day, { dailyLimit }] = await Promise.all([currentRepDay(guildId), getReputationConfig(guildId)]);
  const limitReached: GiveRepResult = { success: false, code: 'DAILY_LIMIT' };

  // Lectures sur le primaire : un réplica en retard laisserait passer un double clic.
  const votesToday = await prisma.reputationVote.count({ where: { guildId, giverId, day } });
  if (votesToday >= dailyLimit) return limitReached;

  let voteId: string;
  try {
    const vote = await prisma.reputationVote.create({
      data: {
        guildId,
        giverId,
        receiverId,
        value: 1,
        reason,
        day,
        channelId: options.channelId ?? null,
        messageId: options.messageId ?? null,
      },
      select: { id: true },
    });
    voteId = vote.id;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { success: false, code: 'ALREADY_TODAY' };
    throw err;
  }

  // L'index unique ne couvre que le couple donneur/receveur : des votes simultanés
  // vers des membres différents peuvent dépasser la limite, on annule alors celui-ci.
  const votesAfter = await prisma.reputationVote.count({ where: { guildId, giverId, day } });
  if (votesAfter > dailyLimit) {
    await prisma.reputationVote.delete({ where: { id: voteId } }).catch(() => null);
    return limitReached;
  }

  const newTotal = await receivedTotal(guildId, receiverId, prisma);

  logger.debug('Reputation', `${giverId} → +rep → ${receiverId} (guild: ${guildId})`);
  broadcastDashboardStateChange(guildId, REPUTATION_REALTIME_REASON);

  return { success: true, newTotal };
}

/** Réputation reçue par un membre sur ce serveur. */
export async function receivedTotal(guildId: string, userId: string, db: typeof prismaRead = prismaRead): Promise<number> {
  const agg = await db.reputationVote.aggregate({
    where: { guildId, receiverId: userId },
    _sum: { value: true },
  });
  return agg._sum.value ?? 0;
}

/**
 * Rang d'un total : nombre de membres strictement devant, plus un. Les ex aequo
 * partagent le rang, et rien n'oblige à charger tout le classement du serveur.
 */
async function rankOf(guildId: string, totalRep: number): Promise<number> {
  const rows = await prismaRead.$queryRaw<Array<{ above: bigint }>>`
    SELECT COUNT(*)::bigint AS above FROM (
      SELECT "receiverId" FROM reputation_votes
      WHERE "guildId" = ${guildId}
      GROUP BY "receiverId"
      HAVING SUM("value") > ${totalRep}
    ) AS ahead`;
  return Number(rows[0]?.above ?? 0) + 1;
}

export async function getReputation(guildId: string, userId: string): Promise<ReputationProfile> {
  const [totalRep, votesToday, { dailyLimit }] = await Promise.all([
    receivedTotal(guildId, userId),
    getVotesGivenToday(guildId, userId),
    getReputationConfig(guildId),
  ]);
  const rank = await rankOf(guildId, totalRep);

  return {
    userId,
    totalRep,
    rank,
    votesGivenToday: votesToday,
    dailyLimit,
    canVote: votesToday < dailyLimit,
  };
}

/** Filtre de date d'une période, à fondre dans un `where`. */
function periodFilter(period: ReputationPeriod): { createdAt?: { gte: Date } } {
  const since = reputationPeriodStart(period);
  return since ? { createdAt: { gte: since } } : {};
}

export async function getReputationLeaderboard(
  guildId: string,
  limit = 15,
  period: ReputationPeriod = 'all',
): Promise<ReputationLeaderboard> {
  const where = { guildId, ...periodFilter(period) };
  const [reps, voters] = await Promise.all([
    prismaRead.reputationVote.groupBy({
      by: ['receiverId'],
      where,
      _sum: { value: true },
      orderBy: { _sum: { value: 'desc' } },
      take: limit,
    }),
    prismaRead.reputationVote.groupBy({ by: ['giverId'], where }),
  ]);

  return {
    entries: reps.map((r, i) => ({
      userId: r.receiverId,
      totalRep: r._sum.value ?? 0,
      rank: i + 1,
    })),
    totalVoters: voters.length,
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getReputationDashboardData(guildId: string, period: ReputationPeriod) {
  const weekAgo = new Date(Date.now() - WEEK_MS);
  const [config, leaderboard, totalVotes, votesLast7Days, activeGivers, lastVote] = await Promise.all([
    getReputationConfig(guildId),
    getReputationLeaderboard(guildId, 20, period),
    prismaRead.reputationVote.count({ where: { guildId } }),
    prismaRead.reputationVote.count({ where: { guildId, createdAt: { gte: weekAgo } } }),
    prismaRead.reputationVote.groupBy({ by: ['giverId'], where: { guildId, createdAt: { gte: weekAgo } } }),
    prismaRead.reputationVote.findFirst({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  return {
    config,
    leaderboard,
    stats: {
      totalVotes,
      votesLast7Days,
      activeGivers7Days: activeGivers.length,
      lastVoteAt: lastVote?.createdAt ?? null,
    },
  };
}

export const REPUTATION_HISTORY_PAGE = 25;

export interface ReputationVoteFilter {
  period?: ReputationPeriod;
  userId?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Historique paginé, du plus récent au plus ancien. Le curseur est l'id du
 * dernier vote rendu ; une ligne de plus est lue pour savoir s'il en reste.
 */
export async function listReputationVotes(guildId: string, filter: ReputationVoteFilter = {}) {
  const limit = filter.limit ?? REPUTATION_HISTORY_PAGE;
  const rows = await prismaRead.reputationVote.findMany({
    where: {
      guildId,
      ...periodFilter(filter.period ?? 'all'),
      ...(filter.userId ? { OR: [{ giverId: filter.userId }, { receiverId: filter.userId }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      giverId: true,
      receiverId: true,
      reason: true,
      channelId: true,
      messageId: true,
      createdAt: true,
    },
  });

  const votes = rows.slice(0, limit);
  return { votes, nextCursor: rows.length > limit ? votes[votes.length - 1].id : null };
}

/** Retire un vote du serveur. `null` quand il n'existe pas ou appartient à un autre serveur. */
export async function deleteReputationVote(guildId: string, voteId: string) {
  const vote = await prisma.reputationVote.findFirst({
    where: { id: voteId, guildId },
    select: { id: true, guildId: true, giverId: true, receiverId: true },
  });
  if (!vote) return null;
  await prisma.reputationVote.delete({ where: { id: vote.id } });
  broadcastDashboardStateChange(guildId, REPUTATION_REALTIME_REASON);
  return vote;
}
