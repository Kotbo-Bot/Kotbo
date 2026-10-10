/** News, journaux d evenements et suivis sociaux. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
export async function fetchNews(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch News):'
  });
}

export async function fetchPublicNews(guildId: string) {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/news`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Impossible de charger les actualités publiques. Réessaie.');
  }

  return response.json();
}

/** Classement RP public : aucune authentification, le lien se partage. */
export async function fetchPublicRanked(guildId: string) {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/ranked`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Impossible de charger le classement de prestige. Réessaie.');
  }

  return response.json();
}

export async function fetchPublicLeveling(guildId: string) {
  const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/leveling`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Impossible de charger le classement de leveling. Réessaie.');
  }

  return response.json();
}

export async function createNews(payload: { title: string; content: string; summary?: string; imageUrl?: string; category?: string; subcategory?: string; published?: boolean; publishMode?: 'summary' | 'full_embed' }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news', {
    method: 'POST',
    successMessage: m.api_ok_create_news(),
    payload,
    guildId,
    errorContext: 'API Error (Create News):'
  });
}

export async function updateNews(articleId: string, payload: { title?: string; content?: string; summary?: string; imageUrl?: string; category?: string; subcategory?: string; published?: boolean; publishMode?: 'summary' | 'full_embed' }, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/news/${articleId}`, {
    method: 'PATCH',
    successMessage: m.api_ok_update_news(),
    payload,
    guildId,
    errorContext: 'API Error (Update News):'
  });
}

export async function deleteNews(articleId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/news/${articleId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete News):'
  });
}

export async function fetchNewsCategoryConfigs(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news/category-configs', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch News Category Configs):'
  });
}

export async function createNewsCategoryConfig(payload: { category: string; subcategory?: string; channelId: string }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/news/category-configs', {
    method: 'POST',
    successMessage: m.api_ok_create_news_category_config(),
    payload,
    guildId,
    errorContext: 'API Error (Create News Category Config):'
  });
}

export async function deleteNewsCategoryConfig(configId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/news/category-configs/${configId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete News Category Config):'
  });
}

export async function fetchLogEventConfigs(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/logs/event-configs', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Log Event Configs):'
  });
}

export async function updateLogEventConfigs(configs: Array<{ eventType: string; enabled: boolean; channelId: string | null }>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/logs/event-configs', {
    method: 'PUT',
    successMessage: m.api_ok_update_log_event_configs(),
    payload: { configs },
    guildId,
    errorContext: 'API Error (Update Log Event Configs):'
  });
}

export async function fetchSocialFollows(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/social-follows', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Social Follows):'
  });
}

export async function addYoutubeFollow(payload: { query?: string; channelId?: string; discordChannelId?: string | null; mention?: string | null; liveMessage?: string | null; videoMessage?: string | null; shortMessage?: string | null }, guildId = authStore.selectedGuildId) {
  // Mise à jour d'un suivi existant : le channelId sert de requête de résolution.
  const body = {
    query: payload.query || payload.channelId || '',
    discordChannelId: payload.discordChannelId,
    mention: payload.mention,
    liveMessage: payload.liveMessage,
    videoMessage: payload.videoMessage,
    shortMessage: payload.shortMessage
  };
  return dashboardRequest('/social-follows/youtube', {
    method: 'POST',
    successMessage: m.api_ok_add_youtube_follow(),
    payload: body,
    guildId,
    errorContext: 'API Error (Add Youtube Follow):'
  });
}

export async function deleteYoutubeFollow(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/social-follows/youtube/${id}`, {
    method: 'DELETE',
    successMessage: m.api_ok_delete_youtube_follow(),
    guildId,
    errorContext: 'API Error (Delete Youtube Follow):'
  });
}

export async function addTwitchFollow(payload: { streamerName: string; discordChannelId?: string | null; mention?: string | null; liveMessage?: string | null }, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/social-follows/twitch', {
    method: 'POST',
    successMessage: m.api_ok_add_twitch_follow(),
    payload,
    guildId,
    errorContext: 'API Error (Add Twitch Follow):'
  });
}

export async function deleteTwitchFollow(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/social-follows/twitch/${id}`, {
    method: 'DELETE',
    successMessage: m.api_ok_delete_twitch_follow(),
    guildId,
    errorContext: 'API Error (Delete Twitch Follow):'
  });
}

export type GithubFollowPayload = {
  repo: string;
  branch?: string | null;
  discordChannelId?: string | null;
  mention?: string | null;
  notifyCommits?: boolean;
  notifyReleases?: boolean;
  notifyPullRequests?: boolean;
  notifyIssues?: boolean;
  commitMessage?: string | null;
  releaseMessage?: string | null;
  pullRequestMessage?: string | null;
  issueMessage?: string | null;
};

/** Ajout ou mise à jour : le dépôt sert de clé. */
export async function saveGithubFollow(payload: GithubFollowPayload, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/social-follows/github', {
    method: 'POST',
    successMessage: m.api_ok_save_github_follow(),
    payload,
    guildId,
    errorContext: 'API Error (Save Github Follow):'
  });
}

export async function deleteGithubFollow(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/social-follows/github/${id}`, {
    method: 'DELETE',
    successMessage: m.api_ok_delete_github_follow(),
    guildId,
    errorContext: 'API Error (Delete Github Follow):'
  });
}

export type HuggingFaceKind = 'MODEL' | 'DATASET' | 'SPACE' | 'AUTHOR';

/** Ajout ou mise à jour : le couple type + cible sert de clé. */
export async function saveHuggingFaceFollow(
  payload: { kind: HuggingFaceKind; target: string; discordChannelId?: string | null; mention?: string | null; message?: string | null },
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest('/social-follows/huggingface', {
    method: 'POST',
    successMessage: m.api_ok_save_huggingface_follow(),
    payload,
    guildId,
    errorContext: 'API Error (Save Hugging Face Follow):'
  });
}

export async function deleteHuggingFaceFollow(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/social-follows/huggingface/${id}`, {
    method: 'DELETE',
    successMessage: m.api_ok_delete_huggingface_follow(),
    guildId,
    errorContext: 'API Error (Delete Hugging Face Follow):'
  });
}

/**
 * Starlight : la configuration vit dans sa propre table, la reponse porte donc
 * toujours un objet `config` complet - valeurs par defaut du schema comprises
 * tant que le serveur n'a jamais enregistre.
 */
export interface StarboardConfigPayload {
  enabled: boolean;
  channelId: string | null;
  upvoteEmojis: string[];
  downvoteEmojis: string[];
  threshold: number;
  countEmbedReactions: boolean;
  autoReactEmbed: boolean;
  autoReactChannels: string[];
  watchedChannels: string[];
  ignoredChannels: string[];
  allowBots: boolean;
  embedColor: string;
  removeBelowThreshold: boolean;
}

export async function fetchStarboardConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/starboard', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Starboard Config):',
    silent: true,
  });
}

export async function updateStarboardConfig(
  payload: Partial<StarboardConfigPayload>,
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest('/starboard', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Starboard Config):',
    silent: true,
  });
}

// ── Campagnes marketing ─────────────────────────────────────────────────────

export async function fetchCampaigns(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/campaigns', {
    method: 'GET', guildId, silent: true,
    errorContext: 'API Error (Campaigns):'
  });
}

export async function createCampaign(payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/campaigns', {
    method: 'POST', payload, guildId, silent: true,
    errorContext: 'API Error (Create Campaign):'
  });
}

export async function updateCampaign(id: string, payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}`, {
    method: 'PATCH', payload, guildId, silent: true,
    errorContext: 'API Error (Update Campaign):'
  });
}

export async function deleteCampaign(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}`, {
    method: 'DELETE', guildId, silent: true,
    errorContext: 'API Error (Delete Campaign):'
  });
}

export async function setCampaignStatus(id: string, status: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}/status`, {
    method: 'POST', payload: { status }, guildId, silent: true,
    errorContext: 'API Error (Campaign Status):'
  });
}

export async function fetchCampaignReport(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/campaigns/${id}/report`, {
    method: 'GET', guildId, silent: true,
    errorContext: 'API Error (Campaign Report):'
  });
}

export async function previewCampaignAudience(payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/campaigns/audience-preview', {
    method: 'POST', payload, guildId, silent: true,
    errorContext: 'API Error (Campaign Audience):'
  });
}
