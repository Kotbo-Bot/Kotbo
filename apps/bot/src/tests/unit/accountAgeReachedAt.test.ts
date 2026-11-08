import { describe, expect, test } from 'bun:test';
import { accountAgeReachedAt } from '../../services/moderation/accountAgeGuardService.js';

describe('accountAgeReachedAt', () => {
  test('en jours : création + N jours', () => {
    const created = Date.UTC(2026, 9, 1, 12);
    expect(accountAgeReachedAt(created, 7, 'DAYS').toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });

  test('en mois : ne déborde pas sur le mois suivant', () => {
    const created = Date.UTC(2026, 0, 31, 8);
    expect(accountAgeReachedAt(created, 1, 'MONTHS').toISOString()).toBe('2026-02-28T08:00:00.000Z');
  });
});
