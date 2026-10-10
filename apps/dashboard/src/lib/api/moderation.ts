/** Moderation : pseudos, salons, mots bannis. */
import type { TempVoicePolicy } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, JSON_HEADERS, authorizedFetch, dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
// ==========================================
// MODÉRATION DES PSEUDOS
// ==========================================
export async function fetchNicknameModerationConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/nickname-moderation', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Nickname Moderation Config):',
    silent: true,
  });
}

export async function updateNicknameModerationConfig(
  payload: {
    enabled?: boolean;
    whitelist?: string[];
    bypass?: string[];
    onJoin?: boolean;
    onUpdate?: boolean;
    checkInvisible?: boolean;
    checkGlobal?: boolean;
    checkCustom?: boolean;
    discordAutoModSync?: boolean;
  },
  guildId = authStore.selectedGuildId
) {
  return dashboardMutation('/nickname-moderation', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Nickname Moderation Config):'
  });
}

// ==========================================
// AUTO-THREAD & CHANNELS MANAGEMENT
// ==========================================
export async function fetchAutoThreadConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/auto-thread', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Auto Thread Config):',
    silent: true,
  });
}

export async function updateAutoThreadConfig(
  payload: { enabled: boolean; channels: string[]; botsEnabled?: boolean },
  guildId = authStore.selectedGuildId
) {
  return dashboardMutation('/auto-thread', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Auto Thread Config):'
  });
}

interface TempVoiceGeneratorFields {
  channelId?: string;
  categoryId?: string;
  nameTemplate?: string;
  requiredRoleId?: string | null;
  /**
   * Surcharges de présentation du panneau POUR CE GÉNÉRATEUR : mêmes noms et
   * mêmes unions que les cinq réglages de `tempVoiceModPermissions` plus bas.
   * Absente ou `null` : hérite du réglage serveur. N'a aucun effet tant que
   * `tempVoiceModPermissions.perGeneratorPresentation` est faux (voir sa doc).
   */
  panelMode?: 'CLASSIC' | 'FLAT' | null;
  stateLayout?: 'GRID3' | 'GRID2' | 'TABLE' | 'CARDS' | null;
  stateColors?: 'NEUTRAL' | 'DARK' | 'LIGHT' | null;
  panelComponents?: 'V1' | 'V2' | null;
  reservationFallbackMode?: 'MEMBERS' | 'ANY_ROLE' | 'FORBIDDEN' | null;
}

/**
 * Générateur tel que la page le manipule : sa politique est toujours complète.
 *
 * La page comble les clés manquantes à la lecture, de sorte que l'éditeur n'ait
 * jamais à distinguer « pas configuré » de « configuré à zéro » - une nuance
 * qui, côté bot, ne veut pas dire la même chose.
 */
export type TempVoiceGenerator = TempVoicePolicy & TempVoiceGeneratorFields;

/** Ce que la page envoie : le bot complète et revalide ce qui manque. */
export type TempVoiceGeneratorPayload = Partial<TempVoicePolicy> & TempVoiceGeneratorFields;

export async function fetchChannelsManagementConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Channels Management Config):',
    silent: true,
  });
}

// ── Vue « Par salon » ────────────────────────────────────────────────────────
// Les salons du serveur avec, pour chacun, les fonctionnalites qui y sont
// actives. Complete la vue par fonctionnalite, qui obligeait a parcourir cinq
// onglets pour savoir ce qui touchait un salon donne.

export async function fetchChannelsByChannel(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/by-channel', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Channels By Channel):',
    silent: true,
  });
}

export async function toggleChannelFeature(
  channelId: string,
  feature: string,
  enabled: boolean,
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest(`/channels-management/by-channel/${channelId}`, {
    method: 'PATCH',
    payload: { feature, enabled },
    guildId,
    silent: true,
    errorContext: 'API Error (Toggle Channel Feature):',
  });
}

export async function renameDiscordChannel(
  channelId: string,
  name: string,
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest(`/channels-management/channel/${channelId}`, {
    method: 'PATCH',
    payload: { name },
    guildId,
    silent: true,
    errorContext: 'API Error (Rename Channel):',
  });
}

export async function deleteDiscordChannel(channelId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/channel/${channelId}`, {
    method: 'DELETE',
    guildId,
    silent: true,
    errorContext: 'API Error (Delete Channel):',
  });
}

export async function updateChannelsManagementConfig(
  payload: {
    autoThreadEnabled?: boolean;
    autoThreadChannels?: string[];
    autoThreadBotsEnabled?: boolean;
    statsEnabled?: boolean;
    statsConfig?: unknown;
    tempVoiceEnabled?: boolean;
    tempVoiceChannelId?: string | null;
    tempVoiceCategoryId?: string | null;
    tempVoiceNameTemplate?: string;
    tempVoiceRequiredRoleId?: string | null;
    tempVoiceDefaults?: TempVoicePolicy;
    tempVoiceGenerators?: Array<TempVoiceGeneratorPayload>;
    // Demandes d'accès à un salon verrouillé/réservé, et permissions du staff
    // sur les salons temporaires. Formes calquées sur les modèles Prisma
    // `TempVoiceAccessRequestConfig` / `TempVoiceModPermissionsConfig`
    // (packages/database/prisma/temp-voice-access.prisma), servies par
    // `GET`/`PATCH /channels-management` côté bot.
    tempVoiceAccessRequest?: {
      enabled: boolean;
      responders: 'OWNER' | 'OWNER_AND_STAFF';
      notifyVia: 'VOICE' | 'DM' | 'CHANNEL';
      notifyChannelId: string | null;
      requestExpiresMinutes: number;
      denyCooldownMinutes: number;
    };
    tempVoiceModPermissions?: {
      canRename: boolean;
      canChangeLimit: boolean;
      canLock: boolean;
      canChangeWriteMode: boolean;
      canKickOrBan: boolean;
      canReserve: boolean;
      canTransfer: boolean;
      /** Pas une permission : un choix de présentation. Défaut `false`. */
      panelCompactMode: boolean;
      /** Rôles proposés dans le menu « Réserver le salon ». Vide = tous. */
      reservableRoleIds: string[];
      /** Sort des personnes déjà présentes sans le rôle au moment de la réservation. */
      reservationOverflow: 'ASK' | 'NOTHING' | 'MOVE' | 'DISCONNECT';
      /** Salon vers lequel déplacer quand la décision est `MOVE`. */
      reservationFallbackChannelId: string | null;
      /**
       * Cinq réglages de présentation du panneau, décrits ici parce que ce type
       * est le seul garde-fou entre la page et la route du bot : un champ absent
       * de cette liste part quand même (le corps est sérialisé tel quel), mais
       * une faute de frappe d'un côté ou de l'autre passerait alors le typecheck
       * en silence et le réglage deviendrait fantôme.
       */
      panelMode: 'CLASSIC' | 'FLAT';
      stateLayout: 'GRID3' | 'GRID2' | 'TABLE' | 'CARDS';
      stateColors: 'NEUTRAL' | 'DARK' | 'LIGHT';
      panelComponents: 'V1' | 'V2';
      /** Nommé comme la colonne Prisma `reservationFallbackMode`. */
      reservationFallbackMode: 'MEMBERS' | 'ANY_ROLE' | 'FORBIDDEN';
      /**
       * L'interrupteur de secours de la personnalisation par générateur.
       * Défaut `false` : au déploiement, aucun serveur existant ne change de
       * comportement. Le couper IGNORE les surcharges des générateurs, il ne
       * les EFFACE PAS : elles restent dans `tempVoiceGenerators` et reviennent
       * telles quelles au rallumage.
       */
      perGeneratorPresentation: boolean;
    };
    honeypotEnabled?: boolean;
    honeypotChannelId?: string | null;
    honeypotSanction?: string;
    honeypotReinvite?: boolean;
    createHoneypotChannel?: boolean;
    wordStatsEnabled?: boolean;
  },
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/channels-management', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Channels Management Config):'
  });
}

export type VerificationConfigPayload = {
  verificationEnabled?: boolean;
  verificationMode?: string;
  verificationAction?: string;
  verificationChannelId?: string | null;
  verificationFallbackChannelId?: string | null;
  verificationRoleId?: string | null;
  verificationLogChannelId?: string | null;
  verificationEmbedTitle?: string;
  verificationEmbedDesc?: string;
  verificationEmbedColor?: string;
  verificationOnJoin?: boolean;
  verificationSaveIp?: boolean;
  verificationSaveDevice?: boolean;
  verificationLevelCommand?: string;
  verificationLevelJoin?: string;
  verificationWarnThreshold?: number | null;
  verificationWarnAutoMode?: string;
  verificationWarnReason?: string;
  warnWeightingEnabled?: boolean;
  warnDecayDays?: number | null;
  countArchivedInWarnScore?: boolean;
  warnAutoArchiveDays?: number | null;
  wordStatsEnabled?: boolean;
  banHygieneEnabled?: boolean;
};

export async function fetchVerificationConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/verification', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Verification Config):',
    silent: true,
  });
}

export async function updateVerificationConfig(
  payload: VerificationConfigPayload,
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/verification', {
    method: 'PATCH',
    successMessage: m.api_ok_update_verification_config(),
    payload,
    guildId,
    errorContext: 'API Error (Update Verification Config):'
  });
}

export async function fetchStickyMessages(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/sticky', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Sticky Messages):',
    silent: true,
  });
}

export async function saveStickyMessage(
  payload: {
    channelId: string;
    enabled?: boolean;
    content: string;
    embedEnabled?: boolean;
    embedTitle?: string | null;
    embedColor?: string;
    messageThreshold?: number;
    cooldownSeconds?: number;
  },
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/channels-management/sticky', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Save Sticky Message):',
    silent: true,
  });
}

export async function deleteStickyMessage(channelId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/sticky/${channelId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Sticky Message):',
    silent: true,
  });
}

export async function repostStickyMessage(channelId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/sticky/${channelId}/repost`, {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Repost Sticky Message):',
    silent: true,
  });
}

export async function rescanChannelsManagementStats(payload: { force: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/rescan-stats', {
    method: 'POST',
    successMessage: m.api_ok_rescan_channels_management_stats(),
    payload,
    guildId,
    errorContext: 'API Error (Rescan Stats):'
  });
}

export async function rescanMemberStats(payload: { force: boolean }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/analytics/rescan-members', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Rescan Members):'
  });
}

export async function fetchTempVoiceChannels(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/channels-management/temp-voice/channels', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Temp Voice Channels):',
    silent: true
  });
}

export async function updateTempVoiceChannel(channelId: string, data: { name?: string; roleId?: string | null; action?: 'DELETE' }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/channels-management/temp-voice/channels/${channelId}`, {
    method: 'PATCH',
    payload: data,
    guildId,
    errorContext: 'API Error (Update Temp Voice Channel):'
  });
}

// ==========================================
// MOTS BANNIS (service générique partagé)
// ==========================================

/** Retourne { global: BannedWord[], custom: BannedWord[] } */
export async function fetchBannedWords(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/banned-words', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Banned Words):',
    silent: true,
  });
}

/** Ajoute un mot personnalisé pour le serveur */
export async function addBannedWord(
  word: string,
  category = 'custom',
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/banned-words', {
    method: 'POST',
    payload: { word, category },
    guildId,
    errorContext: 'API Error (Add Banned Word):'
  });
}

/** Active ou désactive un mot personnalisé */
export async function toggleBannedWord(
  id: string,
  enabled: boolean,
  guildId = authStore.selectedGuildId
) {
  return dashboardMutation(`/banned-words/${id}`, {
    method: 'PATCH',
    payload: { enabled },
    guildId,
    errorContext: 'API Error (Toggle Banned Word):'
  });
}

/** Supprime un mot personnalisé */
export async function deleteBannedWord(id: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/banned-words/${id}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Banned Word):'
  });
}

// ==========================================
// MOTS BANNIS GLOBAUX (admin bot)
// ==========================================

export async function fetchGlobalBannedWords() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words`, { method: 'GET' });
  if (!response.ok) throw new Error('Impossible de charger les mots globaux. Réessaie.');
  return response.json();
}

export async function saveGlobalBannedWords(
  words: Array<{ word: string; category?: string; enabled?: boolean }>
) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ words })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur lors de l'enregistrement des mots globaux");
  }

  return response.json();
}

export async function cleanupGlobalBannedWords() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words/cleanup`, {
    method: 'POST',
    headers: JSON_HEADERS,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors du nettoyage des mots globaux');
  }

  return response.json();
}

export async function updateGlobalBannedWord(
  id: string,
  payload: { word?: string; category?: string; enabled?: boolean }
) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Impossible de mettre à jour le mot global. Réessaie.');
  }

  return response.json();
}

export async function toggleGlobalBannedWord(id: string, enabled: boolean) {
  return updateGlobalBannedWord(id, { enabled });
}

export async function deleteGlobalBannedWord(id: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/banned-words/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Impossible de supprimer le mot global. Réessaie.');
  return response.json();
}
