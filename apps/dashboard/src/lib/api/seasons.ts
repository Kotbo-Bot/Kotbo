/** Saisons de leveling : classement de l'XP gagnée sur une période. */
import type { SeasonAnnouncementLabels, SeasonReward, SeasonRewardOutcome, SeasonStats, SeasonTierReward } from '@kotbo/shared';
import type { BotRoleAccess } from '@kotbo/contracts';
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';
import { m } from '../i18n';

export type SeasonStatus = 'UPCOMING' | 'ACTIVE' | 'ENDED';

export interface Season {
  id: string;
  number: number;
  name: string;
  status: SeasonStatus;
  startDate: string;
  endDate: string;
  rewards: SeasonReward[];
  /** Paliers d'XP. Absents d'un bot plus ancien. */
  tiers?: SeasonTierReward[];
  topRoleId: string | null;
  /** Salon des annonces d'ouverture et de clôture. Absent d'un bot plus ancien. */
  announceChannelId?: string | null;
  /** À la clôture, une saison de même durée prend la suite. Absent d'un bot plus ancien. */
  autoRenew?: boolean;
  /** Rappel dans le salon d'annonce pendant les dernières 24 h. Absent d'un bot plus ancien. */
  remindBeforeEnd?: boolean;
  /** Ce qui a réellement été remis à la clôture ; vide avant la clôture ou d'un bot plus ancien. */
  grantedRewards?: SeasonRewardOutcome[];
  /** Bilan chiffré figé à la clôture ; `null` avant, ou pour une saison close par un bot plus ancien. */
  stats?: SeasonStats | null;
  _count?: { snapshots: number };
}

interface Identity {
  displayName: string | null;
  avatarUrl: string | null;
}

/** `xp` : XP gagnée pendant la saison. */
export interface SeasonStanding extends Identity {
  userId: string;
  rank: number;
  xp: number;
  level: number;
  messagesCount: number;
  voiceMinutes: number;
}

export interface RankedStanding extends Identity {
  userId: string;
  rank: number;
  rp: number;
  tier: { name: string; color: string } | null;
}

export interface SeasonsData {
  seasons: Season[];
  activeSeason: Season | null;
  activeLeaderboard: SeasonStanding[];
  /** Absent d'un bot plus ancien. */
  activeTotals?: { participants: number; totalXp: number } | null;
  activeRankedLeaderboard?: RankedStanding[];
  /** Gabarits des annonces dans la langue du serveur. Absent d'un bot plus ancien. */
  announcement?: SeasonAnnouncementLabels;
  /** Ce que le bot peut attribuer ; `null` serveur hors cache, absent d'un bot plus ancien. */
  botRoleAccess?: BotRoleAccess | null;
}

export interface SeasonPayload {
  name: string;
  startDate: string;
  endDate: string;
  rewards: SeasonReward[];
  tiers: SeasonTierReward[];
  topRoleId: string | null;
  announceChannelId: string | null;
  autoRenew: boolean;
  remindBeforeEnd: boolean;
}

export async function fetchSeasonsData(guildId = authStore.selectedGuildId): Promise<SeasonsData | null> {
  return dashboardRequest<SeasonsData>('/seasons', { method: 'GET', guildId, errorContext: 'API Error (Seasons):', silent: true });
}

export async function fetchSeasonLeaderboard(seasonId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ leaderboard: SeasonStanding[]; rankedStandings?: RankedStanding[] }>(`/seasons/${seasonId}/leaderboard`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Season Leaderboard):',
  });
}

export async function createSeason(payload: SeasonPayload, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation('/seasons', { method: 'POST', successMessage: m.api_ok_create_season(), payload, guildId, errorContext: 'API Error (Create Season):' });
}

export async function updateSeason(seasonId: string, payload: SeasonPayload, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation(`/seasons/${seasonId}`, { method: 'PATCH', successMessage: m.api_ok_update_season(), payload, guildId, errorContext: 'API Error (Update Season):' });
}

export async function deleteSeason(seasonId: string, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation(`/seasons/${seasonId}`, { method: 'DELETE', successMessage: m.api_ok_delete_season(), guildId, errorContext: 'API Error (Delete Season):' });
}

export async function startSeason(seasonId: string, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation(`/seasons/${seasonId}/start`, { method: 'POST', successMessage: m.api_ok_start_season(), guildId, errorContext: 'API Error (Start Season):' });
}

export async function endSeason(seasonId: string, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation(`/seasons/${seasonId}/end`, { method: 'POST', successMessage: m.api_ok_end_season(), guildId, errorContext: 'API Error (End Season):' });
}

/** Redonne ce qui n'a pas été remis à la clôture (rôle refusé, membre parti, Économie éteinte). */
export async function retrySeasonRewards(seasonId: string, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation(`/seasons/${seasonId}/rewards/retry`, { method: 'POST', successMessage: m.api_ok_retry_season_rewards(), guildId, errorContext: 'API Error (Retry Season Rewards):' });
}
