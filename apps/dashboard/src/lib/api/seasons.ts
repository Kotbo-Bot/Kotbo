/** Saisons de leveling : classement de l'XP gagnée sur une période. */
import type { SeasonReward } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';
import { m } from '../i18n';

export type SeasonStatus = 'UPCOMING' | 'ACTIVE' | 'ENDED' | 'ARCHIVED';

export interface Season {
  id: string;
  number: number;
  name: string;
  status: SeasonStatus;
  startDate: string;
  endDate: string;
  rewards: SeasonReward[];
  topRoleId: string | null;
  /** Salon des annonces d'ouverture et de clôture. Absent d'un bot plus ancien. */
  announceChannelId?: string | null;
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
}

export interface SeasonPayload {
  name: string;
  startDate: string;
  endDate: string;
  rewards: SeasonReward[];
  topRoleId: string | null;
  announceChannelId: string | null;
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
