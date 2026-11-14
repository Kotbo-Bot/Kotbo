/** Réputation : remerciements entre membres. */
import type { ReputationPeriod, ReputationTier } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import { m } from '../i18n';
import { toReputationConfig, toReputationData } from '../reputationData';

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

export async function fetchReputationData(
  period: ReputationPeriod = 'all',
  guildId = authStore.selectedGuildId,
): Promise<ReputationData | null> {
  const raw = await dashboardRequest<unknown>(`/reputation?period=${period}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Reputation):',
    silent: true,
  });
  return toReputationData(raw);
}

/** Page de l'historique, reprise sous le dernier vote affiché. */
export async function fetchReputationVotes(
  filter: { period?: ReputationPeriod; userId?: string; cursor?: string },
  guildId = authStore.selectedGuildId,
): Promise<ReputationVotePage | null> {
  const query = new URLSearchParams();
  if (filter.period) query.set('period', filter.period);
  if (filter.userId) query.set('userId', filter.userId);
  if (filter.cursor) query.set('cursor', filter.cursor);
  const suffix = query.size > 0 ? `?${query}` : '';
  return dashboardRequest(`/reputation/votes${suffix}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Reputation Votes):',
  });
}

export async function updateReputationConfig(
  payload: Partial<ReputationConfig>,
  guildId = authStore.selectedGuildId,
): Promise<{ config: ReputationConfig } | null> {
  const raw = await dashboardRequest<{ config?: unknown }>('/reputation/config', {
    method: 'PATCH',
    successMessage: m.api_ok_update_reputation_config(),
    payload,
    guildId,
    errorContext: 'API Error (Update Reputation Config):',
  });
  const config = toReputationConfig(raw?.config);
  return config ? { config } : null;
}

export interface MemberReputation {
  totalRep: number;
  rank: number;
  receivedVotes: number;
  givenVotes: number;
  receivedLast7Days: number;
  recent: Array<{
    id: string;
    kind: ReputationVoteKind;
    value: number;
    giverId: string;
    giverName: string | null;
    reason: string | null;
    createdAt: string;
  }>;
}

/** Réputation d'un membre, pour sa fiche. `null` sans accès au module ou s'il est éteint. */
export async function fetchMemberReputation(userId: string, guildId = authStore.selectedGuildId): Promise<MemberReputation | null> {
  return dashboardRequest(`/reputation/members/${encodeURIComponent(userId)}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Member Reputation):',
    silent: true,
  });
}

/** Donne (`amount` > 0) ou retire des points à un membre. */
export async function adjustReputation(
  payload: { userId: string; amount: number; reason: string | null },
  guildId = authStore.selectedGuildId,
): Promise<{ before: number; after: number } | null> {
  return dashboardRequest('/reputation/adjustments', {
    method: 'POST',
    successMessage: m.api_ok_adjust_reputation(),
    payload,
    guildId,
    errorContext: 'API Error (Adjust Reputation):',
  });
}

/** Remet à zéro la réputation reçue par un membre, ou celle de tout le serveur. */
export async function resetReputation(
  target: { scope: 'member'; userId: string } | { scope: 'guild' },
  guildId = authStore.selectedGuildId,
): Promise<{ removed: number; members?: number } | null> {
  return dashboardRequest('/reputation/reset', {
    method: 'POST',
    successMessage: m.api_ok_reset_reputation(),
    payload: target,
    guildId,
    errorContext: 'API Error (Reset Reputation):',
  });
}

export async function deleteReputationVote(voteId: string, guildId = authStore.selectedGuildId): Promise<{ deleted: boolean } | null> {
  return dashboardRequest(`/reputation/votes/${encodeURIComponent(voteId)}`, {
    method: 'DELETE',
    successMessage: m.api_ok_delete_reputation_vote(),
    guildId,
    errorContext: 'API Error (Delete Reputation Vote):',
  });
}
