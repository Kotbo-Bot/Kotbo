import { describe, expect, test } from 'bun:test';
import {
  SUGGESTION_CATEGORIES_MAX,
  SUGGESTION_CATEGORY_NAME_MAX,
  SUGGESTION_STALE_DAYS,
  crossedSuggestionThreshold,
  isSuggestionAccepted,
  matchSuggestionCategory,
  normalizeSuggestionCategories,
  suggestionRewardMove,
  summarizeSuggestionCategories,
  decodeTimeCursor,
  encodeTimeCursor,
  isSuggestionStale,
  isSuggestionStatus,
  isSuggestionVotingOpen,
  suggestionNeedsComment,
  suggestionSubmitBlocker,
  suggestionThreadName,
  summarizeSuggestionResolutions,
} from '@kotbo/shared';

const DAY_MS = 86_400_000;

describe('statuts des suggestions', () => {
  test('reconnaît les cinq statuts et rien d\'autre', () => {
    for (const status of ['PENDING', 'APPROVED', 'IN_PROGRESS', 'REJECTED', 'IMPLEMENTED']) expect(isSuggestionStatus(status)).toBe(true);
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

  test('restent ouverts sur une approuvée ou en cours quand le serveur le veut', () => {
    expect(isSuggestionVotingOpen('APPROVED', true)).toBe(true);
    expect(isSuggestionVotingOpen('IN_PROGRESS', true)).toBe(true);
    expect(isSuggestionVotingOpen('IN_PROGRESS', false)).toBe(false);
    expect(isSuggestionVotingOpen('REJECTED', true)).toBe(false);
    expect(isSuggestionVotingOpen('IMPLEMENTED', true)).toBe(false);
  });
});

describe('droit de proposer', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const OPEN = { allowedRoleIds: [] as string[], cooldownMinutes: 0, minAccountAgeDays: 0, minMemberDays: 0 };
  const member = (over: Partial<{ roleIds: string[]; canManageGuild: boolean; accountCreatedAt: Date; joinedAt: Date | null }> = {}) => ({
    roleIds: [] as string[],
    canManageGuild: false,
    accountCreatedAt: new Date(now.getTime() - 400 * DAY_MS),
    joinedAt: new Date(now.getTime() - 100 * DAY_MS),
    ...over,
  });

  test('sans règle : tout le monde, même un membre introuvable', () => {
    expect(suggestionSubmitBlocker(OPEN, member(), null, now)).toBeNull();
    expect(suggestionSubmitBlocker(OPEN, null, null, now)).toBeNull();
  });

  test('rôles posés : il faut un des rôles', () => {
    const rules = { ...OPEN, allowedRoleIds: ['r1', 'r2'] };
    expect(suggestionSubmitBlocker(rules, member({ roleIds: ['r2'] }), null, now)).toBeNull();
    expect(suggestionSubmitBlocker(rules, member({ roleIds: ['r3'] }), null, now)).toEqual({ code: 'ROLE' });
    expect(suggestionSubmitBlocker(rules, null, null, now)).toEqual({ code: 'ROLE' });
  });

  test('compte trop récent', () => {
    const rules = { ...OPEN, minAccountAgeDays: 30 };
    expect(suggestionSubmitBlocker(rules, member({ accountCreatedAt: new Date(now.getTime() - 10 * DAY_MS) }), null, now)).toEqual({ code: 'ACCOUNT_TOO_NEW' });
    expect(suggestionSubmitBlocker(rules, member(), null, now)).toBeNull();
  });

  test('arrivé trop récemment sur le serveur, ou date d\'arrivée inconnue', () => {
    const rules = { ...OPEN, minMemberDays: 7 };
    expect(suggestionSubmitBlocker(rules, member({ joinedAt: new Date(now.getTime() - 2 * DAY_MS) }), null, now)).toEqual({ code: 'MEMBER_TOO_NEW' });
    expect(suggestionSubmitBlocker(rules, member({ joinedAt: null }), null, now)).toEqual({ code: 'MEMBER_TOO_NEW' });
  });

  test('délai entre deux suggestions : rend l\'heure de reprise', () => {
    const rules = { ...OPEN, cooldownMinutes: 60 };
    const last = new Date(now.getTime() - 20 * 60_000);
    expect(suggestionSubmitBlocker(rules, member(), last, now)).toEqual({ code: 'COOLDOWN', retryAt: new Date(last.getTime() + 60 * 60_000) });
    expect(suggestionSubmitBlocker(rules, member(), new Date(now.getTime() - 61 * 60_000), now)).toBeNull();
  });

  test('le délai s\'applique même sans membre retrouvé', () => {
    const rules = { ...OPEN, cooldownMinutes: 60 };
    expect(suggestionSubmitBlocker(rules, null, new Date(now.getTime() - 60_000), now)?.code).toBe('COOLDOWN');
  });

  test('un gestionnaire du serveur passe toutes les règles', () => {
    const rules = { allowedRoleIds: ['r1'], cooldownMinutes: 60, minAccountAgeDays: 30, minMemberDays: 30 };
    const manager = member({ canManageGuild: true, accountCreatedAt: now, joinedAt: now });
    expect(suggestionSubmitBlocker(rules, manager, new Date(now.getTime() - 60_000), now)).toBeNull();
  });
});

describe('seuil de votes', () => {
  test('franchi au vote qui l\'atteint', () => {
    expect(crossedSuggestionThreshold(10, 9, 10)).toBe(true);
  });

  test('pas déjà au-dessus, pas en dessous, pas sans seuil', () => {
    expect(crossedSuggestionThreshold(10, 10, 11)).toBe(false);
    expect(crossedSuggestionThreshold(10, 8, 9)).toBe(false);
    expect(crossedSuggestionThreshold(null, 9, 10)).toBe(false);
  });
});

describe('nom du fil d\'une suggestion', () => {
  test('le titre quand il y en a un', () => {
    expect(suggestionThreadName('Soirée jeux', 'Un long texte')).toBe('Soirée jeux');
  });

  test('sinon le début du texte, sur une ligne, coupé à 100 caractères', () => {
    const name = suggestionThreadName(null, `Première ligne\n${'x'.repeat(200)}`);
    expect(name.length).toBe(100);
    expect(name.startsWith('Première ligne x')).toBe(true);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('décision favorable et gains', () => {
  test('approuvée, en cours et mise en place sont favorables', () => {
    expect(isSuggestionAccepted('APPROVED')).toBe(true);
    expect(isSuggestionAccepted('IN_PROGRESS')).toBe(true);
    expect(isSuggestionAccepted('IMPLEMENTED')).toBe(true);
    expect(isSuggestionAccepted('REJECTED')).toBe(false);
    expect(isSuggestionAccepted('PENDING')).toBe(false);
  });

  test('gains versés en entrant dans une décision favorable', () => {
    expect(suggestionRewardMove('PENDING', 'APPROVED')).toBe('grant');
    expect(suggestionRewardMove('REJECTED', 'IMPLEMENTED')).toBe('grant');
  });

  test('gains repris en en sortant', () => {
    expect(suggestionRewardMove('APPROVED', 'REJECTED')).toBe('reclaim');
    expect(suggestionRewardMove('IMPLEMENTED', 'PENDING')).toBe('reclaim');
  });

  test('rien entre deux décisions favorables ou deux défavorables', () => {
    expect(suggestionRewardMove('APPROVED', 'IN_PROGRESS')).toBeNull();
    expect(suggestionRewardMove('IN_PROGRESS', 'IMPLEMENTED')).toBeNull();
    expect(suggestionRewardMove('PENDING', 'REJECTED')).toBeNull();
  });
});

describe('catégories', () => {
  test('nettoyées : espaces, doublons sans tenir compte de la casse, vides retirées', () => {
    expect(normalizeSuggestionCategories(['  Événements ', 'salons', 'Salons', '', 'Bot'])).toEqual({ categories: ['Événements', 'salons', 'Bot'] });
  });

  test('refusées au-delà du nombre ou de la longueur permis', () => {
    expect(normalizeSuggestionCategories(Array.from({ length: SUGGESTION_CATEGORIES_MAX + 1 }, (_, i) => `c${i}`))).toEqual({ error: 'TOO_MANY' });
    expect(normalizeSuggestionCategories(['x'.repeat(SUGGESTION_CATEGORY_NAME_MAX + 1)])).toEqual({ error: 'TOO_LONG' });
    expect(normalizeSuggestionCategories('Bot')).toEqual({ error: 'NOT_ARRAY' });
  });

  test('une catégorie choisie doit exister, à la casse près', () => {
    expect(matchSuggestionCategory(['Événements', 'Bot'], 'bot')).toBe('Bot');
    expect(matchSuggestionCategory(['Bot'], 'Salons')).toBeNull();
    expect(matchSuggestionCategory(['Bot'], null)).toBeNull();
  });
});

describe('bilan par catégorie', () => {
  test('totaux, en attente et acceptées par catégorie, la plus fournie d\'abord', () => {
    expect(summarizeSuggestionCategories([
      { category: 'Bot', status: 'PENDING', count: 2 },
      { category: 'Salons', status: 'APPROVED', count: 1 },
      { category: 'Bot', status: 'IMPLEMENTED', count: 3 },
      { category: null, status: 'REJECTED', count: 4 },
      { category: 'Salons', status: 'IN_PROGRESS', count: 1 },
    ])).toEqual([
      { category: 'Bot', total: 5, pending: 2, accepted: 3 },
      { category: null, total: 4, pending: 0, accepted: 0 },
      { category: 'Salons', total: 2, pending: 0, accepted: 2 },
    ]);
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

  test('une suggestion en cours compte comme acceptée', () => {
    const summary = summarizeSuggestionResolutions([
      { status: 'IN_PROGRESS', count: 1, avgSeconds: 3_600 },
      { status: 'REJECTED', count: 1, avgSeconds: 3_600 },
    ]);
    expect(summary.acceptanceRate).toBe(0.5);
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
