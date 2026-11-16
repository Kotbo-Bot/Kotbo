/**
 * Contrôle des réponses de l'API Suggestions et ordre de la file d'attente.
 *
 * Le dashboard et le bot ne sont pas toujours déployés en même temps : un bot
 * plus ancien renvoie la liste brute des suggestions, sans réglages ni
 * statistiques. Une telle réponse est refusée, la page affiche alors son état
 * d'erreur ; un champ ajouté plus tard prend sa valeur par défaut.
 */
import type { SuggestionConfig, SuggestionItem, SuggestionsOverview } from './api/suggestionTypes';

export const DEFAULT_SUGGESTION_CONFIG: SuggestionConfig = {
  channelId: null,
  requireComment: true,
  voteWhileApproved: false,
  allowedRoleIds: [],
};

export type SuggestionQueueSort = 'score' | 'oldest' | 'recent';

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export function toSuggestionConfig(raw: unknown): SuggestionConfig | null {
  if (!isObject(raw)) return null;
  return {
    ...DEFAULT_SUGGESTION_CONFIG,
    ...(raw as Partial<SuggestionConfig>),
    allowedRoleIds: Array.isArray(raw.allowedRoleIds) ? (raw.allowedRoleIds as string[]) : [],
  };
}

export function toSuggestionsOverview(raw: unknown): SuggestionsOverview | null {
  if (!isObject(raw) || !isObject(raw.stats)) return null;
  const config = toSuggestionConfig(raw.config);
  if (!config) return null;
  return {
    config,
    stats: raw.stats as unknown as SuggestionsOverview['stats'],
    queue: Array.isArray(raw.queue) ? (raw.queue as SuggestionItem[]) : [],
    queueTruncated: raw.queueTruncated === true,
    messageLabels: isObject(raw.messageLabels) ? (raw.messageLabels as unknown as SuggestionsOverview['messageLabels']) : null,
  };
}

export function suggestionScore(suggestion: Pick<SuggestionItem, 'upvotes' | 'downvotes'>): number {
  return suggestion.upvotes - suggestion.downvotes;
}

const byAge = (a: SuggestionItem, b: SuggestionItem) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

/** Copie triée : à score égal, la plus ancienne passe devant, elle attend depuis plus longtemps. */
export function sortSuggestionQueue(queue: readonly SuggestionItem[], sort: SuggestionQueueSort): SuggestionItem[] {
  const sorted = [...queue];
  if (sort === 'oldest') return sorted.sort(byAge);
  if (sort === 'recent') return sorted.sort((a, b) => byAge(b, a));
  return sorted.sort((a, b) => suggestionScore(b) - suggestionScore(a) || byAge(a, b));
}
