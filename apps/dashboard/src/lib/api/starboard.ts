/** Starlight : messages mis à la une par les réactions des membres. */
import type { StarboardPeriod, StarboardSettings, StarboardSort } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import { m } from '../i18n';
import { toStarboardConfig, toStarboardOverview } from '../starboardData';

export interface StarboardEntryItem {
  id: string;
  /** Salon (ou fil) du message d'origine. */
  channelId: string;
  authorId: string;
  /** Pseudo actuel ; `null` pour un membre parti. */
  authorName: string | null;
  avatarUrl: string | null;
  excerpt: string | null;
  /** Lien d'image Discord, qui peut avoir expiré. */
  imageUrl: string | null;
  upvotes: number;
  downvotes: number;
  score: number;
  /** Meilleur score atteint, gardé même si le score est retombé. */
  peakScore: number;
  /** La republication est affichée dans le salon des messages à la une. */
  onBoard: boolean;
  /** Retiré par le staff : n'y revient plus, quels que soient ses votes. Absent d'un bot plus ancien. */
  blocked?: boolean;
  /** Passage à la une. */
  createdAt: string;
  postedAt: string | null;
  messageUrl: string;
  starUrl: string | null;
}

export interface StarboardStats {
  postedRecent: number;
  avgPeakRecent: number | null;
  bestPeakRecent: number | null;
  onBoard: number;
  lastPostedAt: string | null;
}

/** Textes du message publié dans la langue du serveur ; `footerVotes` porte `{up}` et `{down}`. */
export interface StarboardMessageLabels {
  locale: string;
  jumpButton: string;
  footerVotes: string;
  attachmentsField: string;
}

export interface StarboardOverview {
  config: StarboardSettings;
  stats: StarboardStats;
  /** Meilleurs messages de la fenêtre des statistiques. */
  topEntries: StarboardEntryItem[];
  channelStats: Array<{ channelId: string; count: number }>;
  health: { channelFound: boolean | null; missingPermissions: string[] };
  /** Absent d'un bot plus ancien : l'aperçu du message est alors masqué. */
  messageLabels: StarboardMessageLabels | null;
  /** Membres exclus, avec leur identité actuelle. */
  blockedMembers: Array<{ userId: string; name: string | null; avatarUrl: string | null }>;
}

export interface StarboardEntryPage {
  entries: StarboardEntryItem[];
  nextCursor: string | null;
}

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
