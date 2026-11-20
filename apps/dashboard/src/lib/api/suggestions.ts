/** Suggestions : idées des membres, votes et décisions du staff. */
import type { SuggestionStatus } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import { m } from '../i18n';
import { toSuggestionConfig, toSuggestionsOverview } from '../suggestionData';

export * from './suggestionTypes';
import type { SuggestionConfig, SuggestionItem, SuggestionsOverview, SuggestionPage, SuggestionVoter } from './suggestionTypes';

export async function fetchSuggestionsOverview(guildId = authStore.selectedGuildId): Promise<SuggestionsOverview | null> {
  const raw = await dashboardRequest<unknown>('/suggestions', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Suggestions):',
    silent: true,
  });
  return toSuggestionsOverview(raw);
}

/** Page de l'historique, reprise sous la dernière suggestion affichée. */
export async function fetchSuggestionList(
  filter: { status?: SuggestionStatus; userId?: string; cursor?: string; category?: string | null },
  guildId = authStore.selectedGuildId,
): Promise<SuggestionPage | null> {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
  // `null` : les suggestions sans catégorie.
  if (filter.category !== undefined) query.set('category', filter.category ?? 'none');
  if (filter.userId) query.set('userId', filter.userId);
  if (filter.cursor) query.set('cursor', filter.cursor);
  const suffix = query.size > 0 ? `?${query}` : '';
  return dashboardRequest(`/suggestions/list${suffix}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Suggestion List):',
  });
}

export async function updateSuggestionConfig(
  payload: Partial<SuggestionConfig>,
  guildId = authStore.selectedGuildId,
): Promise<{ config: SuggestionConfig } | null> {
  const raw = await dashboardRequest<{ config?: unknown }>('/suggestions/config', {
    method: 'PATCH',
    successMessage: m.api_ok_update_suggestions_config(),
    payload,
    guildId,
    errorContext: 'API Error (Update Suggestions Config):',
  });
  const config = toSuggestionConfig(raw?.config);
  return config ? { config } : null;
}

/** Pose ou change la décision ; `PENDING` rouvre la suggestion. */
export async function decideSuggestion(
  suggestionId: string,
  payload: { status: SuggestionStatus; responseText: string | null },
  guildId = authStore.selectedGuildId,
): Promise<{ suggestion: SuggestionItem } | null> {
  return dashboardRequest(`/suggestions/${encodeURIComponent(suggestionId)}/resolve`, {
    method: 'POST',
    successMessage: m.api_ok_resolve_suggestion(),
    payload,
    guildId,
    errorContext: 'API Error (Resolve Suggestion):',
  });
}

/** Supprime une suggestion, son message et son fil sur Discord. */
export async function deleteSuggestion(suggestionId: string, guildId = authStore.selectedGuildId): Promise<{ deleted: boolean } | null> {
  return dashboardRequest(`/suggestions/${encodeURIComponent(suggestionId)}`, {
    method: 'DELETE',
    successMessage: m.api_ok_delete_suggestion(),
    guildId,
    errorContext: 'API Error (Delete Suggestion):',
  });
}

/** Repasse les messages déjà publiés au format actuel, en arrière-plan ; rend combien seront repris. */
export async function refreshSuggestionMessages(guildId = authStore.selectedGuildId): Promise<{ total: number } | null> {
  return dashboardRequest('/suggestions/refresh', {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Refresh Suggestion Messages):',
  });
}

/** Votants d'une suggestion, quand le serveur les montre au staff. */
export async function fetchSuggestionVoters(
  suggestionId: string,
  guildId = authStore.selectedGuildId,
): Promise<{ up: SuggestionVoter[]; down: SuggestionVoter[] } | null> {
  return dashboardRequest(`/suggestions/${encodeURIComponent(suggestionId)}/voters`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Suggestion Voters):',
  });
}
