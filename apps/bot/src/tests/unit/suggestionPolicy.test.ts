import { describe, expect, test } from 'bun:test';
import {
  SUGGESTION_STALE_DAYS,
  canSubmitSuggestion,
  decodeTimeCursor,
  encodeTimeCursor,
  isSuggestionStale,
  isSuggestionStatus,
  isSuggestionVotingOpen,
  suggestionNeedsComment,
  summarizeSuggestionResolutions,
} from '@kotbo/shared';

const DAY_MS = 86_400_000;

describe('statuts des suggestions', () => {
  test('reconnaît les quatre statuts et rien d\'autre', () => {
    for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'IMPLEMENTED']) expect(isSuggestionStatus(status)).toBe(true);
    expect(isSuggestionStatus('CLOSED')).toBe(false);
    expect(isSuggestionStatus(undefined)).toBe(false);
  });
});

describe('commentaire de décision', () => {
  test('exigé pour une décision quand le serveur le demande', () => {
    expect(suggestionNeedsComment('APPROVED', true)).toBe(true);
    expect(suggestionNeedsComment('REJECTED', true)).toBe(true);
    expect(suggestionNeedsComment('IMPLEMENTED', true)).toBe(true);
  });

  test('jamais pour remettre en attente', () => {
    expect(suggestionNeedsComment('PENDING', true)).toBe(false);
  });

  test('facultatif quand le serveur ne le demande pas', () => {
    expect(suggestionNeedsComment('REJECTED', false)).toBe(false);
  });
});

describe('ouverture des votes', () => {
  test('ouverts en attente', () => {
    expect(isSuggestionVotingOpen('PENDING', false)).toBe(true);
  });

  test('fermés après une décision, par défaut', () => {
    expect(isSuggestionVotingOpen('APPROVED', false)).toBe(false);
    expect(isSuggestionVotingOpen('REJECTED', false)).toBe(false);
    expect(isSuggestionVotingOpen('IMPLEMENTED', false)).toBe(false);
  });

  test('restent ouverts sur une approuvée quand le serveur le veut', () => {
    expect(isSuggestionVotingOpen('APPROVED', true)).toBe(true);
    expect(isSuggestionVotingOpen('REJECTED', true)).toBe(false);
    expect(isSuggestionVotingOpen('IMPLEMENTED', true)).toBe(false);
  });
});

describe('droit de proposer', () => {
  const member = (roleIds: string[], canManageGuild = false) => ({ roleIds, canManageGuild });

  test('liste vide : tout le monde, même un membre introuvable', () => {
    expect(canSubmitSuggestion([], member([]))).toBe(true);
    expect(canSubmitSuggestion([], null)).toBe(true);
  });

  test('liste posée : il faut un des rôles', () => {
    expect(canSubmitSuggestion(['r1', 'r2'], member(['r2']))).toBe(true);
    expect(canSubmitSuggestion(['r1'], member(['r3']))).toBe(false);
  });

  test('un gestionnaire du serveur passe toujours', () => {
    expect(canSubmitSuggestion(['r1'], member([], true))).toBe(true);
  });

  test('liste posée et membre introuvable : refusé', () => {
    expect(canSubmitSuggestion(['r1'], null)).toBe(false);
  });
});

describe('suggestion en souffrance', () => {
  const now = new Date('2026-11-16T12:00:00Z');

  test('au-delà du délai, en attente', () => {
    expect(isSuggestionStale(new Date(now.getTime() - (SUGGESTION_STALE_DAYS + 1) * DAY_MS), now)).toBe(true);
  });

  test('pas avant le délai', () => {
    expect(isSuggestionStale(new Date(now.getTime() - (SUGGESTION_STALE_DAYS - 1) * DAY_MS), now)).toBe(false);
  });

  test('accepte une date sérialisée', () => {
    expect(isSuggestionStale(new Date(now.getTime() - 30 * DAY_MS).toISOString(), now)).toBe(true);
  });
});

describe('bilan des décisions', () => {
  test('taux d\'acceptation et délai moyen pondérés par statut', () => {
    const summary = summarizeSuggestionResolutions([
      { status: 'APPROVED', count: 2, avgSeconds: 3_600 },
      { status: 'IMPLEMENTED', count: 1, avgSeconds: 7_200 },
      { status: 'REJECTED', count: 1, avgSeconds: 0 },
    ]);
    expect(summary.resolved).toBe(4);
    expect(summary.acceptanceRate).toBe(0.75);
    // (2 × 1 h + 1 × 2 h + 0) / 4
    expect(summary.avgResponseHours).toBe(1);
  });

  test('rien de tranché : ni taux ni délai', () => {
    expect(summarizeSuggestionResolutions([])).toEqual({ resolved: 0, acceptanceRate: null, avgResponseHours: null });
  });

  test('ignore une ligne en attente glissée dans le relevé', () => {
    const summary = summarizeSuggestionResolutions([
      { status: 'PENDING', count: 5, avgSeconds: null },
      { status: 'REJECTED', count: 1, avgSeconds: 1_800 },
    ]);
    expect(summary.resolved).toBe(1);
    expect(summary.acceptanceRate).toBe(0);
    expect(summary.avgResponseHours).toBe(0.5);
  });
});

describe('curseur date + id', () => {
  test('aller-retour', () => {
    const createdAt = new Date('2026-11-16T10:00:00.123Z');
    expect(decodeTimeCursor(encodeTimeCursor(createdAt, 'cmabc123'))).toEqual({ createdAt, id: 'cmabc123' });
  });

  test('refuse un curseur mal formé', () => {
    expect(decodeTimeCursor('abc')).toBeNull();
    expect(decodeTimeCursor('123_')).toBeNull();
    expect(decodeTimeCursor('123_a;b')).toBeNull();
  });
});
