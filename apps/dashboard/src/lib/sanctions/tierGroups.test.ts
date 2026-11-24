import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TIER_DURATION_SECONDS,
  MAX_TIER_REPEAT,
  actionPatch,
  groupTiers,
  patchGroup,
  removeGroup,
  resizeGroup,
  type TierLike,
} from './tierGroups';

function tier(level: number, action: string, extra: Partial<TierLike> = {}): TierLike {
  return { id: `t${level}`, level, action, durationSeconds: null, weight: 1, customReason: null, ...extra };
}

const reminder = (level: number) => tier(level, 'WARN', { weight: 0, customReason: 'Rappel' });
const timeout = (level: number) => tier(level, 'TIMEOUT', { durationSeconds: 3600 });

describe('groupTiers', () => {
  test('regroupe les paliers identiques qui se suivent', () => {
    const tiers = [reminder(1), reminder(2), reminder(3), timeout(4)];
    expect(groupTiers(tiers).map((g) => [g.start, g.count, g.tier.action])).toEqual([
      [0, 3, 'WARN'],
      [3, 1, 'TIMEOUT'],
    ]);
  });

  test('un rappel et un avertissement ne sont pas le même palier', () => {
    const tiers = [reminder(1), tier(2, 'WARN', { customReason: 'Rappel' })];
    expect(groupTiers(tiers)).toHaveLength(2);
  });

  test('deux durées différentes ne sont pas le même palier', () => {
    const tiers = [timeout(1), tier(2, 'TIMEOUT', { durationSeconds: 7200 })];
    expect(groupTiers(tiers)).toHaveLength(2);
  });

  test('une raison vide équivaut à une raison absente', () => {
    const tiers = [tier(1, 'KICK', { customReason: '' }), tier(2, 'KICK', { customReason: null })];
    expect(groupTiers(tiers)).toHaveLength(1);
  });

  test('le poids est ignoré hors avertissement', () => {
    const tiers = [tier(1, 'KICK', { weight: 0 }), tier(2, 'KICK', { weight: 1 })];
    expect(groupTiers(tiers)).toHaveLength(1);
  });

  test('un tableau vide ne donne aucun groupe', () => {
    expect(groupTiers([])).toEqual([]);
  });
});

describe('resizeGroup', () => {
  test('« rappel × 8 » déplie huit paliers et renumérote la suite', () => {
    const result = resizeGroup([reminder(1), timeout(2)], 0, 1, 8);
    expect(result).toHaveLength(9);
    expect(result.map((t) => t.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.slice(0, 8).every((t) => t.action === 'WARN' && t.weight === 0)).toBe(true);
    expect(result[8].action).toBe('TIMEOUT');
  });

  test('réduire un groupe retire les copies en trop', () => {
    const result = resizeGroup([reminder(1), reminder(2), reminder(3), timeout(4)], 0, 3, 1);
    expect(result.map((t) => [t.level, t.action])).toEqual([[1, 'WARN'], [2, 'TIMEOUT']]);
  });

  test('le nombre est borné entre 1 et le maximum', () => {
    expect(resizeGroup([timeout(1)], 0, 1, 0)).toHaveLength(1);
    expect(resizeGroup([timeout(1)], 0, 1, 999)).toHaveLength(MAX_TIER_REPEAT);
  });

  test('les copies sont des objets distincts', () => {
    const result = resizeGroup([reminder(1)], 0, 1, 2);
    expect(result[0]).not.toBe(result[1]);
  });
});

describe('patchGroup', () => {
  test('modifie tous les paliers du groupe et eux seuls', () => {
    const result = patchGroup([reminder(1), reminder(2), timeout(3)], 0, 2, { weight: 1 });
    expect(result.map((t) => t.weight)).toEqual([1, 1, 1]);
    expect(result[2].durationSeconds).toBe(3600);
  });
});

describe('actionPatch', () => {
  test('passer en timeout sans durée pose la durée par défaut affichée (1 h)', () => {
    expect(actionPatch(reminder(1), 'TIMEOUT')).toEqual({ action: 'TIMEOUT', durationSeconds: DEFAULT_TIER_DURATION_SECONDS });
  });

  test('passer en ban temporaire sans durée pose aussi la durée par défaut', () => {
    expect(actionPatch(tier(1, 'KICK'), 'TEMP_BAN')).toEqual({ action: 'TEMP_BAN', durationSeconds: DEFAULT_TIER_DURATION_SECONDS });
  });

  test('une durée déjà réglée est gardée', () => {
    expect(actionPatch(timeout(1), 'TEMP_BAN')).toEqual({ action: 'TEMP_BAN' });
  });

  test('une action sans durée ne touche pas à la durée', () => {
    expect(actionPatch(reminder(1), 'KICK')).toEqual({ action: 'KICK' });
  });
});

describe('removeGroup', () => {
  test('retire le groupe entier et renumérote', () => {
    const result = removeGroup([reminder(1), reminder(2), timeout(3)], 0, 2);
    expect(result.map((t) => [t.level, t.action])).toEqual([[1, 'TIMEOUT']]);
  });
});
