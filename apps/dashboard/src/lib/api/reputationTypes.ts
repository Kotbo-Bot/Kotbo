import type { ReputationPeriod, ReputationTier } from '@kotbo/shared';

export interface ReputationConfig {
  dailyLimit: number;
  /** Remercier en réagissant avec `reactionEmoji` (unicode brut ou id d'emoji custom). */
  reactionEnabled: boolean;
  reactionEmoji: string | null;
  /** Gains du membre remercié, par remerciement reçu. */
  xpPerRep: number;
  coinsPerRep: number;
  /** Salon des annonces de palier. `null` = rôle donné sans annonce. */
  announceChannelId: string | null;
  /** Garde-fous du donneur, en jours. `0` = aucune exigence. */
  minAccountAgeDays: number;
  minMemberDays: number;
  /** Jours avant de remercier à nouveau le même membre. `1` = dès le lendemain. */
  sameMemberCooldownDays: number;
  /** Rôles qui ne peuvent ni remercier ni être remerciés. */
  excludedRoleIds: string[];
  /** Salons où l'on ne remercie pas. */
  excludedChannelIds: string[];
  /** Triés par seuil croissant. */
  tiers: ReputationTier[];
}

/** `ADJUSTMENT` : points donnés ou retirés à la main par le staff, `value` signé. */
export type ReputationVoteKind = 'VOTE' | 'ADJUSTMENT';

/** Gabarits de l'annonce de palier dans la langue du serveur, trous compris (`{user}`, `{role}`, `{threshold}`). */
export interface ReputationAnnouncementLabels {
  locale: string;
  title: string;
  body: string;
}

export interface ReputationLeaderboardEntry {
  userId: string;
  totalRep: number;
  rank: number;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ReputationStats {
  totalVotes: number;
  votesLast7Days: number;
  activeGivers7Days: number;
  lastVoteAt: string | null;
}

export interface ReputationData {
  config: ReputationConfig;
  leaderboard: { entries: ReputationLeaderboardEntry[]; totalVoters: number };
  stats: ReputationStats;
  /** Absent d'un bot plus ancien : l'aperçu de l'annonce est alors masqué. */
  announcement: ReputationAnnouncementLabels | null;
  /** Rôles de palier que le bot ne peut pas donner (supprimés, gérés, trop hauts). */
  unmanageableTierRoleIds: string[];
}

export interface ReputationVote {
  id: string;
  /** Absent d'un bot plus ancien : un vote. */
  kind?: ReputationVoteKind;
  value?: number;
  giverId: string;
  receiverId: string;
  reason: string | null;
  createdAt: string;
  giverName: string | null;
  giverAvatarUrl: string | null;
  receiverName: string | null;
  receiverAvatarUrl: string | null;
  /** Lien vers le message remercié, quand le vote en vient. */
  messageUrl: string | null;
}

export interface ReputationVotePage {
  votes: ReputationVote[];
  nextCursor: string | null;
}
