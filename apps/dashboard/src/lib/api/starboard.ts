/** Starlight : messages mis à la une par les réactions des membres. */
import type { StarboardPeriod, StarboardSettings, StarboardSort } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import { m } from '../i18n';
import {
  toStarboardConfig,
  toStarboardOverview,
  type StarboardEntryItem,
  type StarboardEntryPage,
  type StarboardMessageLabels,
  type StarboardOverview,
  type StarboardStats,
} from '../starboardData';

export type {
  StarboardEntryItem,
  StarboardEntryPage,
  StarboardMessageLabels,
  StarboardOverview,
  StarboardStats,
};

export async function fetchStarboardOverview(guildId = authStore.selectedGuildId): Promise<StarboardOverview | null> {
  const raw = await dashboardRequest<unknown>('/starboard', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Starboard):',
    silent: true,
  });
  return toStarboardOverview(raw);
}

/** Page de la galerie, reprise sous le dernier message affiché. */
export async function fetchStarboardEntries(
  filter: { period: StarboardPeriod; sort: StarboardSort; channelId?: string; authorId?: string; cursor?: string },
  guildId = authStore.selectedGuildId,
): Promise<StarboardEntryPage | null> {
  const query = new URLSearchParams({ period: filter.period, sort: filter.sort });
  if (filter.channelId) query.set('channelId', filter.channelId);
  if (filter.authorId) query.set('authorId', filter.authorId);
  if (filter.cursor) query.set('cursor', filter.cursor);
  return dashboardRequest(`/starboard/entries?${query}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Starboard Entries):',
  });
}

export async function updateStarboardConfig(
  payload: Partial<StarboardSettings>,
  guildId = authStore.selectedGuildId,
): Promise<{ config: StarboardSettings } | null> {
  const raw = await dashboardRequest<{ config?: unknown }>('/starboard', {
    method: 'PATCH',
    successMessage: m.starboard_save_success(),
    payload,
    guildId,
    errorContext: 'API Error (Update Starboard Config):',
  });
  const config = toStarboardConfig(raw?.config);
  return config ? { config } : null;
}

/** Retire un message de la une ; il n'y revient plus tant que le retrait n'est pas annulé. */
export async function blockStarboardEntry(entryId: string, guildId = authStore.selectedGuildId): Promise<{ entry: StarboardEntryItem } | null> {
  return dashboardRequest(`/starboard/entries/${encodeURIComponent(entryId)}/block`, {
    method: 'POST',
    successMessage: m.starboard_block_success(),
    guildId,
    errorContext: 'API Error (Block Starboard Entry):',
  });
}

/** Annule le retrait : le message revient à la une s'il est toujours au-dessus du seuil. */
export async function unblockStarboardEntry(entryId: string, guildId = authStore.selectedGuildId): Promise<{ entry: StarboardEntryItem } | null> {
  return dashboardRequest(`/starboard/entries/${encodeURIComponent(entryId)}/unblock`, {
    method: 'POST',
    successMessage: m.starboard_unblock_success(),
    guildId,
    errorContext: 'API Error (Unblock Starboard Entry):',
  });
}
