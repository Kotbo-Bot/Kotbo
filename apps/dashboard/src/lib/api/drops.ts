/** Drops aléatoires. */
import type { DropGlobalSettings, DropType, DropTypeSettings } from '@kotbo/shared';
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
  maxClaims: number;
  claimCount: number;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
}

export interface DropsDataResult extends DropGlobalSettings {
  configs: DropConfigEntry[];
  recentDrops: DropHistoryEntry[];
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
