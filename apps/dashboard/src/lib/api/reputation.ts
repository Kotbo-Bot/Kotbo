/** Réputation : remerciements entre membres. */
import type { ReputationPeriod } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import { m } from '../i18n';

export interface ReputationConfig {
  dailyLimit: number;
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
}

export interface ReputationVote {
  id: string;
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
  return dashboardRequest(`/reputation?period=${period}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Reputation):',
    silent: true,
  });
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
  return dashboardRequest('/reputation/config', {
    method: 'PATCH',
    successMessage: m.api_ok_update_reputation_config(),
    payload,
    guildId,
    errorContext: 'API Error (Update Reputation Config):',
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
