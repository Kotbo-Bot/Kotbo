import { describe, expect, test } from 'bun:test';
import {
  REPUTATION_TIERS_MAX,
  REPUTATION_TIER_THRESHOLD,
  crossedTiers,
  tiersAbove,
  validateReputationTiers,
} from '@kotbo/shared';

const TIERS = [
  { threshold: 50, roleId: 'r50' },
  { threshold: 10, roleId: 'r10' },
  { threshold: 100, roleId: 'r100' },
];

describe('crossedTiers', () => {
  test('rend le palier atteint par le gain', () => {
    expect(crossedTiers(9, 10, TIERS)).toEqual([{ threshold: 10, roleId: 'r10' }]);
  });

  test('rien quand le total reste entre deux paliers', () => {
    expect(crossedTiers(10, 11, TIERS)).toEqual([]);
  });

  test('plusieurs paliers franchis d\'un coup, du plus bas au plus haut', () => {
    expect(crossedTiers(0, 60, TIERS).map((tier) => tier.threshold)).toEqual([10, 50]);
  });

  test('une baisse ne franchit rien', () => {
    expect(crossedTiers(60, 40, TIERS)).toEqual([]);
  });
});

describe('tiersAbove', () => {
  test('rend les paliers que le total n\'atteint plus', () => {
    expect(tiersAbove(49, TIERS).map((tier) => tier.threshold)).toEqual([50, 100]);
  });

  test('un total pile sur le seuil garde le palier', () => {
    expect(tiersAbove(50, TIERS).map((tier) => tier.threshold)).toEqual([100]);
  });
});

describe('validateReputationTiers', () => {
  const role = (n: number) => String(100000000000000000n + BigInt(n));

  test('accepte une liste valide et la trie par seuil', () => {
    const result = validateReputationTiers([
      { threshold: 50, roleId: role(2) },
      { threshold: 10, roleId: role(1) },
    ]);
    expect(result).toEqual({ tiers: [{ threshold: 10, roleId: role(1) }, { threshold: 50, roleId: role(2) }] });
  });

  test('refuse autre chose qu\'un tableau', () => {
    expect(validateReputationTiers('x')).toEqual({ error: 'NOT_ARRAY' });
  });

  test('refuse plus de paliers que la limite', () => {
    const many = Array.from({ length: REPUTATION_TIERS_MAX + 1 }, (_, i) => ({ threshold: i + 1, roleId: role(i) }));
    expect(validateReputationTiers(many)).toEqual({ error: 'TOO_MANY' });
  });

  test('refuse un seuil hors bornes ou non entier', () => {
    for (const threshold of [0, REPUTATION_TIER_THRESHOLD.max + 1, 2.5, '10']) {
      expect(validateReputationTiers([{ threshold, roleId: role(1) }])).toEqual({ error: 'BAD_THRESHOLD' });
    }
  });

  test('refuse un rôle mal formé', () => {
    expect(validateReputationTiers([{ threshold: 5, roleId: 'abc' }])).toEqual({ error: 'BAD_ROLE' });
  });

  test('refuse deux paliers au même seuil', () => {
    expect(validateReputationTiers([
      { threshold: 5, roleId: role(1) },
      { threshold: 5, roleId: role(2) },
    ])).toEqual({ error: 'DUPLICATE_THRESHOLD' });
  });

  test('refuse le même rôle sur deux paliers', () => {
    expect(validateReputationTiers([
      { threshold: 5, roleId: role(1) },
      { threshold: 10, roleId: role(1) },
    ])).toEqual({ error: 'DUPLICATE_ROLE' });
  });
});
