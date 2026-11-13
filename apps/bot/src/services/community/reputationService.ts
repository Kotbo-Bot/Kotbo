import { formatWallClockInTimezone } from '@kotbo/contracts';
import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildTimezone } from '../../utils/timezone.js';

export const REP_DAILY_VOTE_LIMIT = 3;

export interface ReputationProfile {
  userId: string;
  totalRep: number;
  rank: number;
  votesGivenToday: number;
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
  options: { receiverIsBot?: boolean } = {},
): Promise<GiveRepResult> {
  if (giverId === receiverId) return { success: false, code: 'SELF' };
  if (options.receiverIsBot) return { success: false, code: 'BOT' };

  const day = await currentRepDay(guildId);
  const limitReached: GiveRepResult = { success: false, code: 'DAILY_LIMIT' };

  // Lectures sur le primaire : un réplica en retard laisserait passer un double clic.
  const votesToday = await prisma.reputationVote.count({ where: { guildId, giverId, day } });
  if (votesToday >= REP_DAILY_VOTE_LIMIT) return limitReached;

  let voteId: string;
  try {
    const vote = await prisma.reputationVote.create({
      data: { guildId, giverId, receiverId, value: 1, reason, day },
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
  if (votesAfter > REP_DAILY_VOTE_LIMIT) {
    await prisma.reputationVote.delete({ where: { id: voteId } }).catch(() => null);
    return limitReached;
  }

  const newTotal = await receivedTotal(guildId, receiverId, prisma);

  logger.debug('Reputation', `${giverId} → +rep → ${receiverId} (guild: ${guildId})`);

  return { success: true, newTotal };
}

/** Réputation reçue par un membre sur ce serveur. */
async function receivedTotal(guildId: string, userId: string, db: typeof prismaRead = prismaRead): Promise<number> {
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
  const [totalRep, votesToday] = await Promise.all([
    receivedTotal(guildId, userId),
    getVotesGivenToday(guildId, userId),
  ]);
  const rank = await rankOf(guildId, totalRep);

  return {
    userId,
    totalRep,
    rank,
    votesGivenToday: votesToday,
    canVote: votesToday < REP_DAILY_VOTE_LIMIT,
  };
}

export async function getReputationLeaderboard(guildId: string, limit = 15): Promise<ReputationLeaderboard> {
  const reps = await prismaRead.reputationVote.groupBy({
    by: ['receiverId'],
    where: { guildId },
    _sum: { value: true },
    orderBy: { _sum: { value: 'desc' } },
    take: limit,
  });

  const totalVoters = await prismaRead.reputationVote.groupBy({
    by: ['giverId'],
    where: { guildId },
  });

  return {
    entries: reps.map((r, i) => ({
      userId: r.receiverId,
      totalRep: r._sum.value ?? 0,
      rank: i + 1,
    })),
    totalVoters: totalVoters.length,
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getReputationDashboardData(guildId: string) {
  const [leaderboard, recentVotes, totalVotes, votesLast7Days] = await Promise.all([
    getReputationLeaderboard(guildId, 20),
    prismaRead.reputationVote.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { giverId: true, receiverId: true, reason: true, createdAt: true },
    }),
    prismaRead.reputationVote.count({ where: { guildId } }),
    prismaRead.reputationVote.count({ where: { guildId, createdAt: { gte: new Date(Date.now() - WEEK_MS) } } }),
  ]);

  return { leaderboard, recentVotes, totalVotes, votesLast7Days };
}
