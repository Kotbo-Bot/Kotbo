import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import { boostBadge, boostGoal, boostMargin, boostTierFor, tierForPerks } from '@kotbo/contracts';

// Le service importe la base et les notifications au chargement : on les neutralise.
for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: {}, prismaRead: {} }));
}
for (const file of ['../../services/notifications/notifyService.ts', '../../services/notifications/notifyService.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ notify: mock(() => Promise.resolve()) }));
}

const { buildBoostPeriods } = await import('../../services/analytics/boostService.js');

const d = (iso: string) => new Date(iso);

describe('paliers de boost', () => {
  test('niveau selon le nombre de boosts', () => {
    expect([0, 1, 2, 6, 7, 13, 14, 30].map(boostTierFor)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  test('boosts et membres Nitro manquants', () => {
    expect(boostGoal(3, 2)).toEqual({ tier: 2, missingBoosts: 4, missingNitroMembers: 2 });
    expect(boostGoal(5, 3)).toEqual({ tier: 3, missingBoosts: 9, missingNitroMembers: 5 });
    expect(boostGoal(20, 3).missingBoosts).toBe(0);
  });

  test('niveau requis pour plusieurs avantages', () => {
    expect(tierForPerks(['emoji_100', 'banner'])).toBe(2);
    expect(tierForPerks(['vanity_url', 'audio_128'])).toBe(3);
    expect(tierForPerks([])).toBe(0);
  });

  test('marge avant de perdre un niveau', () => {
    expect(boostMargin(1)).toBeNull();
    expect(boostMargin(9)).toBe(2);
    expect(boostMargin(14)).toBe(0);
  });

  test("badge d'ancienneté", () => {
    const now = d('2026-11-17T12:00:00Z');
    expect(boostBadge('2026-11-10T00:00:00Z', now)).toEqual({ step: 0, months: 0, nextMonths: 2 });
    expect(boostBadge('2026-08-17T00:00:00Z', now).step).toBe(2); // 3 mois
    expect(boostBadge('2026-05-18T00:00:00Z', now).months).toBe(5); // 6 mois pas encore atteints
    expect(boostBadge('2024-01-01T00:00:00Z', now)).toMatchObject({ step: 8, nextMonths: null });
  });
});

describe('périodes de boost', () => {
  const now = d('2026-11-17T00:00:00Z');

  test('début, arrêt puis reprise', () => {
    const periods = buildBoostPeriods(
      [
        { userId: 'u', type: 'START', boostingSince: d('2026-01-01'), createdAt: d('2026-01-01') },
        { userId: 'u', type: 'STOP', boostingSince: d('2026-01-01'), createdAt: d('2026-03-01') },
        { userId: 'u', type: 'START', boostingSince: d('2026-06-01'), createdAt: d('2026-06-01') },
      ],
      d('2026-06-01'),
      now,
    );
    expect(periods).toEqual([
      { start: d('2026-01-01'), end: d('2026-03-01') },
      { start: d('2026-06-01'), end: null },
    ]);
  });

  test("boost en cours antérieur au suivi, sans aucun événement", () => {
    expect(buildBoostPeriods([], d('2025-05-01'), now)).toEqual([{ start: d('2025-05-01'), end: null }]);
  });

  test('arrêt sans début connu', () => {
    const periods = buildBoostPeriods(
      [{ userId: 'u', type: 'STOP', boostingSince: d('2025-01-01'), createdAt: d('2026-02-01') }],
      null,
      now,
    );
    expect(periods).toEqual([{ start: d('2025-01-01'), end: d('2026-02-01') }]);
  });
});
