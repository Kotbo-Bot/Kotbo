import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_SUGGESTION_CONFIG,
  sortSuggestionQueue,
  suggestionScore,
  toSuggestionConfig,
  toSuggestionsOverview,
} from './suggestionData';
import type { SuggestionItem } from './api/suggestionTypes';

const STATS = { pending: 0, stalePending: 0, createdRecent: 0, resolvedRecent: 0, acceptanceRate: null, avgResponseHours: null, lastCreatedAt: null };

function item(id: string, upvotes: number, downvotes: number, createdAt: string): SuggestionItem {
  return {
    id,
    userId: '1',
    username: 'Alice',
    avatarUrl: null,
    content: 'Idée',
    status: 'PENDING',
    responseText: null,
    respondedById: null,
    respondedByName: null,
    respondedAt: null,
    upvotes,
    downvotes,
    createdAt,
    messageUrl: null,
  };
}

describe('toSuggestionsOverview', () => {
  test('l\'ancienne réponse (liste brute) est refusée au lieu de faire planter la page', () => {
    expect(toSuggestionsOverview({ suggestions: [] })).toBeNull();
    expect(toSuggestionsOverview(null)).toBeNull();
  });

  test('les champs absents d\'un bot un peu plus ancien prennent leurs valeurs par défaut', () => {
    const data = toSuggestionsOverview({ config: { channelId: '9' }, stats: STATS });
    expect(data?.config).toEqual({ ...DEFAULT_SUGGESTION_CONFIG, channelId: '9' });
    expect(data?.queue).toEqual([]);
    expect(data?.queueTruncated).toBe(false);
    expect(data?.messageLabels).toBeNull();
  });

  test('une réponse complète passe telle quelle', () => {
    const raw = {
      config: { ...DEFAULT_SUGGESTION_CONFIG, allowedRoleIds: ['5'] },
      stats: STATS,
      queue: [item('a', 1, 0, '2026-11-10T00:00:00Z')],
      queueTruncated: true,
      messageLabels: { locale: 'fr', title: 'T' },
    };
    expect(toSuggestionsOverview(raw)).toEqual(raw as never);
  });
});

describe('toSuggestionConfig', () => {
  test('une liste de rôles invalide redevient vide', () => {
    expect(toSuggestionConfig({ allowedRoleIds: 'x' })?.allowedRoleIds).toEqual([]);
  });
});

describe('file d\'attente', () => {
  const oldPopular = item('old', 5, 1, '2026-11-01T00:00:00Z');
  const recentTop = item('recent', 9, 0, '2026-11-12T00:00:00Z');
  const middle = item('middle', 0, 2, '2026-11-05T00:00:00Z');
  const queue = [middle, recentTop, oldPopular];

  test('le score est la différence des votes', () => {
    expect(suggestionScore(oldPopular)).toBe(4);
    expect(suggestionScore(middle)).toBe(-2);
  });

  test('par score, puis la plus ancienne', () => {
    expect(sortSuggestionQueue(queue, 'score').map((s) => s.id)).toEqual(['recent', 'old', 'middle']);
    const tie = [item('b', 1, 0, '2026-11-05T00:00:00Z'), item('a', 1, 0, '2026-11-01T00:00:00Z')];
    expect(sortSuggestionQueue(tie, 'score').map((s) => s.id)).toEqual(['a', 'b']);
  });

  test('par ancienneté', () => {
    expect(sortSuggestionQueue(queue, 'oldest').map((s) => s.id)).toEqual(['old', 'middle', 'recent']);
  });

  test('par nouveauté', () => {
    expect(sortSuggestionQueue(queue, 'recent').map((s) => s.id)).toEqual(['recent', 'middle', 'old']);
  });

  test('ne modifie pas la liste reçue', () => {
    sortSuggestionQueue(queue, 'score');
    expect(queue.map((s) => s.id)).toEqual(['middle', 'recent', 'old']);
  });
});
