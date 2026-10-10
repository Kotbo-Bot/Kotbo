import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: {}, prisma: {}, prismaRead: {}, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { activatedWithin, retainedAfter, summarize } = await import('../../services/features/welcomeExperimentService.js');
const { parseVariants } = await import('../../services/features/welcomeExperimentMath.js');

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY);

function outcome(variantKey: string, joinedDaysAgo: number, leftAfterDays: number | null, messagesDay0 = 0) {
  return {
    userId: `${variantKey}-${Math.random()}`,
    variantKey,
    assignedAt: daysAgo(joinedDaysAgo),
    leftAt: leftAfterDays === null ? null : new Date(daysAgo(joinedDaysAgo).getTime() + leftAfterDays * DAY),
    messagesByDay: new Map(messagesDay0 ? [[0, messagesDay0]] : []),
  };
}

describe('mesures par arrivant', () => {
  test('rétention : inconnue tant que le délai n’est pas écoulé', () => {
    expect(retainedAfter(outcome('A', 3, null), 7, NOW)).toBeNull();
    expect(retainedAfter(outcome('A', 10, null), 7, NOW)).toBe(true);
    expect(retainedAfter(outcome('A', 10, 2), 7, NOW)).toBe(false);
    expect(retainedAfter(outcome('A', 10, 8), 7, NOW)).toBe(true);
  });

  test('activation : un message dans la première semaine', () => {
    expect(activatedWithin(outcome('A', 10, null, 3), 7, NOW)).toBe(true);
    expect(activatedWithin(outcome('A', 10, null), 7, NOW)).toBe(false);
    expect(activatedWithin(outcome('A', 2, null, 3), 7, NOW)).toBeNull();
  });
});

describe('résultats du test', () => {
  const variants = parseVariants([{ name: 'Contrôle' }, { name: 'Chaleureux' }]);

  test('en collecte tant qu’il manque des arrivants mesurables', () => {
    const results = summarize(variants, [outcome('A', 10, null), outcome('B', 10, 1)], 'retained_d7', NOW);
    expect(results.recommendation.status).toBe('collecting');
    expect(results.variants[0].metrics.retained_d7).toMatchObject({ eligible: 1, success: 1, rate: 1, vsControl: null });
    expect(results.variants[1].metrics.retained_d7.rate).toBe(0);
  });

  test('désigne une gagnante nette', () => {
    const list = [
      ...Array.from({ length: 200 }, (_, i) => outcome('A', 20, i < 120 ? 2 : null)), // 40 % restent
      ...Array.from({ length: 200 }, (_, i) => outcome('B', 20, i < 60 ? 2 : null)), // 70 % restent
    ];
    const results = summarize(variants, list, 'retained_d7', NOW);
    expect(results.recommendation).toMatchObject({ status: 'winner', winnerKey: 'B' });
    expect(results.variants[1].metrics.retained_d7.vsControl?.uplift).toBeCloseTo(0.75, 2);
  });

  test('le contrôle peut l’emporter', () => {
    const list = [
      ...Array.from({ length: 200 }, (_, i) => outcome('A', 20, i < 60 ? 2 : null)),
      ...Array.from({ length: 200 }, (_, i) => outcome('B', 20, i < 120 ? 2 : null)),
    ];
    expect(summarize(variants, list, 'retained_d7', NOW).recommendation).toMatchObject({ status: 'control_wins', winnerKey: 'A' });
  });
});
