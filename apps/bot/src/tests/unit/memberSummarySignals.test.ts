import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: {}, prisma: {}, prismaRead: {}, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { buildSignals } = await import('../../services/moderation/memberSummaryService.js');

const base = {
  accountCreatedAt: new Date('2020-01-01'),
  joinedAt: new Date('2026-01-01'),
  isSuspectedDC: false,
  activeSanctions: 0,
  recentWarns: 0,
  pendingReports: 0,
  linkedAccounts: 0,
  joins: 1,
  invitedLeftWithinWeek: 0,
  invitedTotal: 0,
};

describe('signaux de la fiche membre', () => {
  test('un membre sans histoire ne lève aucun signal', () => {
    expect(buildSignals(base)).toEqual([]);
  });

  test('du plus grave au plus léger', () => {
    const keys = buildSignals({ ...base, activeSanctions: 1, isSuspectedDC: true, pendingReports: 2, linkedAccounts: 1 }).map((s) => s.key);
    expect(keys).toEqual(['active_sanction', 'suspected_alt', 'reports', 'linked']);
  });

  test("l'âge du compte à l'arrivée gradue l'alerte", () => {
    const joined = new Date('2026-01-10');
    expect(buildSignals({ ...base, joinedAt: joined, accountCreatedAt: new Date('2026-01-08') })[0]).toMatchObject({ key: 'young_account', tone: 'warning' });
    expect(buildSignals({ ...base, joinedAt: joined, accountCreatedAt: new Date('2025-12-20') })[0]).toMatchObject({ key: 'young_account', tone: 'info' });
  });

  test('les invités qui repartent vite ne comptent qu’à partir de cinq', () => {
    expect(buildSignals({ ...base, invitedTotal: 4, invitedLeftWithinWeek: 4 })).toEqual([]);
    expect(buildSignals({ ...base, invitedTotal: 6, invitedLeftWithinWeek: 3 })[0].key).toBe('invite_churn');
  });
});
