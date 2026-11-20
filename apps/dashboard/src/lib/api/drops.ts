/** Drops aléatoires. */
import type { DropGlobalSettings, DropOutcomes, DropType, DropTypeSettings } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

import { m } from '../i18n';
export interface DropConfigEntry extends DropTypeSettings {
  type: DropType;
  /** Prochaine apparition planifiée, jamais affichée à la minute près aux membres. */
  nextDropAt: string | null;
}

export interface DropHistoryEntry {
  id: string;
  type: DropType;
  /** Pièce tombée, pour un drop d'objet. `null` sinon, ou si l'objet a été supprimé. */
  item: { name: string; emoji: string } | null;
  mode: string;
  channelId: string;
  amount: number;
  /** Montant déjà multiplié : le drapeau ne sert qu'à l'affichage. */
  jackpot: boolean;
  maxClaims: number;
  claimCount: number;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
}

/**
 * Gabarits de l'annonce dans la langue du serveur, trous compris (`{amount}`, `{resource}`,
 * `{winners}`, `{closes}`), pour l'aperçu.
 */
export interface DropAnnouncementLabels {
  locale: string;
  title: string;
  jackpotTitle: string;
  claimButton: string;
  first: string;
  race: string;
  window: string;
  resources: Record<DropType, string>;
}

export interface DropsDataResult extends DropGlobalSettings {
  configs: DropConfigEntry[];
  /** Drops terminés sur les sept derniers jours, et ceux qui ont expiré sans gagnant. */
  weeklyOutcomes: Record<DropType, DropOutcomes>;
  /** Ramassages dont le versement a été abandonné après trop de reprises en échec. */
  abandonedClaims: number;
  announcement: DropAnnouncementLabels;
  recentDrops: DropHistoryEntry[];
  /** Il reste des drops plus anciens que la première page. */
  recentDropsHasMore: boolean;
}

export interface DropHistoryPage {
  drops: DropHistoryEntry[];
  hasMore: boolean;
}

/** Gagnant d'un drop. `name` vide quand le membre a quitté le serveur. */
export interface DropWinner {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  amount: number;
  claimedAt: string;
  /** Versé, en attente de reprise, ou abandonné après trop d'échecs. */
  status: 'paid' | 'pending' | 'abandoned';
}

export async function fetchDropsData(guildId = authStore.selectedGuildId): Promise<DropsDataResult | null> {
  return dashboardRequest('/drops', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Drops):',
    silent: true,
  });
}

export async function updateDropGlobalSettings(
  payload: Partial<DropGlobalSettings>,
  guildId = authStore.selectedGuildId,
): Promise<DropGlobalSettings | null> {
  return dashboardRequest('/drops', {
    method: 'PUT',
    successMessage: m.api_ok_update_drop_global_settings(),
    payload,
    guildId,
    errorContext: 'API Error (Update Drops Settings):',
  });
}

export async function updateDropTypeSettings(
  type: DropType,
  payload: Partial<DropTypeSettings>,
  guildId = authStore.selectedGuildId,
): Promise<DropConfigEntry | null> {
  return dashboardRequest(`/drops/${type}`, {
    method: 'PUT',
    successMessage: m.api_ok_update_drop_type_settings(),
    payload,
    guildId,
    errorContext: `API Error (Update Drop ${type}):`,
  });
}

/** Page de l'historique : filtrée par type, et reprise sous le dernier drop affiché. */
export async function fetchDropHistory(
  filter: { type?: DropType; before?: string },
  guildId = authStore.selectedGuildId,
): Promise<DropHistoryPage | null> {
  const query = new URLSearchParams();
  if (filter.type) query.set('type', filter.type);
  if (filter.before) query.set('before', filter.before);
  const suffix = query.size > 0 ? `?${query}` : '';
  return dashboardRequest(`/drops/history${suffix}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Drop History):',
  });
}

export async function fetchDropWinners(dropId: string, guildId = authStore.selectedGuildId): Promise<DropWinner[] | null> {
  const result = await dashboardRequest<{ winners: DropWinner[] }>(`/drops/history/${encodeURIComponent(dropId)}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Drop Winners):',
  });
  return result?.winners ?? null;
}
