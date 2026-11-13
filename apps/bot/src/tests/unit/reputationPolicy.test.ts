import { describe, expect, test } from 'bun:test';
import {
  REPUTATION_DAILY_LIMIT,
  isReputationPeriod,
  reputationPeriodStart,
} from '@kotbo/shared';

const DAY_MS = 86_400_000;

describe('périodes de la réputation', () => {
  test('reconnaît les trois périodes et rien d\'autre', () => {
    expect(isReputationPeriod('week')).toBe(true);
    expect(isReputationPeriod('month')).toBe(true);
    expect(isReputationPeriod('all')).toBe(true);
    expect(isReputationPeriod('year')).toBe(false);
    expect(isReputationPeriod(undefined)).toBe(false);
  });

  test('la semaine est une fenêtre glissante de 7 jours', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    expect(now.getTime() - reputationPeriodStart('week', now)!.getTime()).toBe(7 * DAY_MS);
  });

  test('le mois est une fenêtre glissante de 30 jours', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    expect(now.getTime() - reputationPeriodStart('month', now)!.getTime()).toBe(30 * DAY_MS);
  });

  test('« tout » n\'a pas de début', () => {
    expect(reputationPeriodStart('all')).toBeNull();
  });
});

describe('bornes de la limite par jour', () => {
  test('le défaut reste dans les bornes', () => {
    expect(REPUTATION_DAILY_LIMIT.default).toBeGreaterThanOrEqual(REPUTATION_DAILY_LIMIT.min);
    expect(REPUTATION_DAILY_LIMIT.default).toBeLessThanOrEqual(REPUTATION_DAILY_LIMIT.max);
  });
});
