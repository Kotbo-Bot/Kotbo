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
  /** Triés par seuil croissant. */
  tiers: ReputationTier[];
}

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

export async function deleteReputationVote(voteId: string, guildId = authStore.selectedGuildId): Promise<{ deleted: boolean } | null> {
  return dashboardRequest(`/reputation/votes/${encodeURIComponent(voteId)}`, {
    method: 'DELETE',
    successMessage: m.api_ok_delete_reputation_vote(),
    guildId,
    errorContext: 'API Error (Delete Reputation Vote):',
  });
}
