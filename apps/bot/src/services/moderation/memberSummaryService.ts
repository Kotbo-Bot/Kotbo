/**
 * Synthèse d'un membre pour la colonne de droite de sa fiche : ce qu'il pèse
 * sur le serveur (niveau, réputation, économie, invitations, support) et les
 * signaux qui méritent l'attention du staff.
 *
 * Chaque bloc est indépendant et tolère sa propre panne : une fiche qui
 * s'affiche sans le solde vaut mieux qu'une fiche qui ne s'affiche pas.
 */
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export type SignalTone = 'info' | 'warning' | 'danger';

export interface MemberSignal {
  key: string;
  label: string;
  tone: SignalTone;
}

export interface MemberSummary {
  level: { level: number; xp: number; rank: number } | null;
  reputation: { received: number; given: number };
  economy: { balance: number; rank: number } | null;
  invites: { total: number; stillHere: number; leftWithinWeek: number };
  support: { tickets: number; openTickets: number; averageRating: number | null; ratings: number };
  community: { suggestions: number; forms: number; giveawayWins: number };
  joins: number;
  signals: MemberSignal[];
}

const DAY = 86_400_000;

async function safe<T>(label: string, fallback: T, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    logger.warn('MemberSummary', `Bloc ${label} indisponible :`, err);
    return fallback;
  }
}

export interface SignalInputs {
  accountCreatedAt: Date | null;
  joinedAt: Date | null;
  isSuspectedDC: boolean;
  activeSanctions: number;
  recentWarns: number;
  pendingReports: number;
  linkedAccounts: number;
  joins: number;
  invitedLeftWithinWeek: number;
  invitedTotal: number;
}

/**
 * Signaux d'attention, du plus grave au plus léger. Chacun se lit seul, comme
 * les badges de risque d'un outil antifraude : aucun score opaque.
 */
export function buildSignals(input: SignalInputs): MemberSignal[] {
  const signals: MemberSignal[] = [];
  if (input.activeSanctions > 0) signals.push({ key: 'active_sanction', label: `${input.activeSanctions} sanction(s) en cours`, tone: 'danger' });
  if (input.isSuspectedDC) signals.push({ key: 'suspected_alt', label: 'Suspecté de double compte', tone: 'danger' });
  if (input.pendingReports > 0) signals.push({ key: 'reports', label: `${input.pendingReports} signalement(s) en attente`, tone: 'warning' });
  if (input.recentWarns >= 2) signals.push({ key: 'warns', label: `${input.recentWarns} avertissements en 30 jours`, tone: 'warning' });
  if (input.accountCreatedAt && input.joinedAt) {
    const ageAtJoin = input.joinedAt.getTime() - input.accountCreatedAt.getTime();
    if (ageAtJoin < 7 * DAY) signals.push({ key: 'young_account', label: 'Compte créé moins de 7 jours avant son arrivée', tone: 'warning' });
    else if (ageAtJoin < 30 * DAY) signals.push({ key: 'young_account', label: 'Compte créé moins de 30 jours avant son arrivée', tone: 'info' });
  }
  if (input.linkedAccounts > 0) signals.push({ key: 'linked', label: `${input.linkedAccounts} compte(s) lié(s)`, tone: 'info' });
  if (input.joins >= 3) signals.push({ key: 'rejoins', label: `Arrivé ${input.joins} fois sur le serveur`, tone: 'info' });
  if (input.invitedTotal >= 5 && input.invitedLeftWithinWeek / input.invitedTotal >= 0.5) {
    signals.push({ key: 'invite_churn', label: 'La moitié de ses invités repartent en moins d’une semaine', tone: 'warning' });
  }
  return signals;
}

export async function getMemberSummary(guildId: string, userId: string): Promise<MemberSummary> {
  const now = Date.now();

  const [profile, level, reputation, economy, invited, support, community, moderation, joins] = await Promise.all([
    safe('profil', null, () => prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { accountCreatedAt: true, guildJoinedAt: true, isSuspectedDC: true },
    })),
    safe('niveau', null, async () => {
      const row = await prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { level: true, xp: true } });
      if (!row) return null;
      const ahead = await prisma.memberLevel.count({ where: { guildId, xp: { gt: row.xp } } });
      return { level: row.level, xp: row.xp, rank: ahead + 1 };
    }),
    safe('réputation', { received: 0, given: 0 }, async () => {
      const [received, given] = await Promise.all([
        prisma.reputationVote.aggregate({ where: { guildId, receiverId: userId }, _sum: { value: true } }),
        prisma.reputationVote.count({ where: { guildId, giverId: userId } }),
      ]);
      return { received: received._sum.value ?? 0, given };
    }),
    safe('économie', null, async () => {
      const row = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { balance: true } });
      if (!row) return null;
      const ahead = await prisma.rpgProfile.count({ where: { guildId, balance: { gt: row.balance } } });
      return { balance: row.balance, rank: ahead + 1 };
    }),
    safe('invitations', [] as Array<{ joinedAt: Date; leftAt: Date | null }>, () => prisma.memberInvite.findMany({
      where: { guildId, inviterId: userId },
      select: { joinedAt: true, leftAt: true },
      take: 5_000,
    })),
    safe('support', { tickets: 0, openTickets: 0, averageRating: null as number | null, ratings: 0 }, async () => {
      const [tickets, openTickets, ratings] = await Promise.all([
        prisma.ticket.count({ where: { guildId, userId } }),
        prisma.ticket.count({ where: { guildId, userId, status: { in: ['OPEN', 'CLAIMED'] } } }),
        prisma.ticketSatisfaction.aggregate({ where: { guildId, userId }, _avg: { rating: true }, _count: { _all: true } }),
      ]);
      return {
        tickets,
        openTickets,
        averageRating: ratings._avg.rating === null ? null : Math.round(ratings._avg.rating * 10) / 10,
        ratings: ratings._count._all,
      };
    }),
    safe('communauté', { suggestions: 0, forms: 0, giveawayWins: 0 }, async () => {
      const [suggestions, forms, giveawayWins] = await Promise.all([
        prisma.suggestion.count({ where: { guildId, userId } }),
        prisma.customFormSubmission.count({ where: { guildId, userId } }),
        prisma.giveaway.count({ where: { guildId, winners: { has: userId } } }),
      ]);
      return { suggestions, forms, giveawayWins };
    }),
    safe('modération', { activeSanctions: 0, recentWarns: 0, pendingReports: 0, linkedAccounts: 0 }, async () => {
      const [activeSanctions, recentWarns, pendingReports, linkedAccounts] = await Promise.all([
        prisma.sanction.count({
          where: { guildId, targetUserId: userId, status: 'ACTIVE', archivedAt: null, type: { in: ['TIMEOUT', 'TEMP_BAN', 'BAN'] } },
        }),
        prisma.sanction.count({
          where: { guildId, targetUserId: userId, type: 'WARN', archivedAt: null, createdAt: { gte: new Date(now - 30 * DAY) } },
        }),
        prisma.memberReport.count({ where: { guildId, targetId: userId, status: 'PENDING' } }),
        prisma.linkedAccount.count({ where: { guildId, status: 'VALIDATED', OR: [{ user1Id: userId }, { user2Id: userId }] } }),
      ]);
      return { activeSanctions, recentWarns, pendingReports, linkedAccounts };
    }),
    safe('arrivées', 0, () => prisma.memberInvite.count({ where: { guildId, userId } })),
  ]);

  const leftWithinWeek = invited.filter((row) => row.leftAt && row.leftAt.getTime() - row.joinedAt.getTime() < 7 * DAY).length;
  const invites = { total: invited.length, stillHere: invited.filter((row) => !row.leftAt).length, leftWithinWeek };

  return {
    level,
    reputation,
    economy,
    invites,
    support,
    community,
    joins,
    signals: buildSignals({
      accountCreatedAt: profile?.accountCreatedAt ?? null,
      joinedAt: profile?.guildJoinedAt ?? null,
      isSuspectedDC: profile?.isSuspectedDC ?? false,
      ...moderation,
      joins,
      invitedLeftWithinWeek: leftWithinWeek,
      invitedTotal: invites.total,
    }),
  };
}
