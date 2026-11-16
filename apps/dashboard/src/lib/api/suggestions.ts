/** Suggestions : idées des membres, votes et décisions du staff. */
import type { SuggestionStatus } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';
import { m } from '../i18n';
import { toSuggestionConfig, toSuggestionsOverview } from '../suggestionData';

export interface SuggestionConfig {
  /** Salon de publication. `null` = repli sur un salon nommé « suggestions ». */
  channelId: string | null;
  /** Une décision doit porter un commentaire public. */
  requireComment: boolean;
  /** Votes ouverts sur une suggestion approuvée. */
  voteWhileApproved: boolean;
  /** Rôles autorisés à proposer. Vide = tout le monde. */
  allowedRoleIds: string[];
}

export interface SuggestionItem {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  content: string;
  status: SuggestionStatus;
  responseText: string | null;
  respondedById: string | null;
  respondedByName: string | null;
  respondedAt: string | null;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  messageUrl: string | null;
}

export interface SuggestionStats {
  pending: number;
  stalePending: number;
  createdRecent: number;
  resolvedRecent: number;
  /** Entre 0 et 1 ; `null` sans décision sur la fenêtre. */
  acceptanceRate: number | null;
  avgResponseHours: number | null;
  lastCreatedAt: string | null;
}

/** Gabarits du message public dans la langue du serveur ; `votesValue` porte `{up}` et `{down}`. */
export interface SuggestionMessageLabels {
  locale: string;
  title: string;
  statusField: string;
  votesField: string;
  finalVotesField: string;
  votesValue: string;
  responseField: string;
  noResponse: string;
  voteUp: string;
  voteDown: string;
  footer: string;
  status: Record<SuggestionStatus, string>;
}

export interface SuggestionsOverview {
  config: SuggestionConfig;
  stats: SuggestionStats;
  /** En attente, la plus ancienne d'abord. */
  queue: SuggestionItem[];
  /** La file a été coupée : il y en a plus que ce qui est montré. */
  queueTruncated: boolean;
  /** Absent d'un bot plus ancien : l'aperçu du message est alors masqué. */
  messageLabels: SuggestionMessageLabels | null;
}

export interface SuggestionPage {
  suggestions: SuggestionItem[];
  nextCursor: string | null;
}

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
