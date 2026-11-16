/** Suggestions : idées des membres, votes et décisions du staff. */
import type { SuggestionStatus } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import { m } from '../i18n';
import { toSuggestionConfig, toSuggestionsOverview } from '../suggestionData';

export * from './suggestionTypes';
import type { SuggestionConfig, SuggestionItem, SuggestionsOverview, SuggestionPage } from './suggestionTypes';

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
  filter: { status?: SuggestionStatus; userId?: string; cursor?: string },
  guildId = authStore.selectedGuildId,
): Promise<SuggestionPage | null> {
  const query = new URLSearchParams();
  if (filter.status) query.set('status', filter.status);
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
