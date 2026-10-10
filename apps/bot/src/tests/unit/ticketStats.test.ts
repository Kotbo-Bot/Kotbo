import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);

const mockDb = {
  guild: { findUnique: async () => ({ ticketSlaFirstResponseMinutes: 60, ticketSlaResolutionHours: null }) },
  ticket: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      if ('closedAt' in where) return [{ createdAt: ago(300), closedAt: ago(100) }];
      if ('createdAt' in where) {
        return [
          // Répondu en 30 min par alice, fermé.
          { status: 'CLOSED', createdAt: ago(300), firstResponseAt: ago(270), firstResponderId: 'a', closedAt: ago(100), claimedById: 'a', claimedByName: 'alice', ticketTypeLabel: 'Support', tags: ['bug'], lastMemberMessageAt: ago(280), lastStaffMessageAt: ago(270) },
          // Répondu en 120 min par bob : objectif manqué.
          { status: 'CLAIMED', createdAt: ago(200), firstResponseAt: ago(80), firstResponderId: 'b', closedAt: null, claimedById: 'b', claimedByName: 'bob', ticketTypeLabel: null, tags: ['bug', 'paiement'], lastMemberMessageAt: ago(10), lastStaffMessageAt: ago(80) },
        ];
      }
      // File active.
      return [
        { status: 'CLAIMED', createdAt: ago(200), firstResponseAt: ago(80), closedAt: null, claimedById: 'b', lastMemberMessageAt: ago(10), lastStaffMessageAt: ago(80) },
        { status: 'OPEN', createdAt: ago(90), firstResponseAt: null, closedAt: null, claimedById: null, lastMemberMessageAt: ago(90), lastStaffMessageAt: null },
      ];
    },
  },
  ticketSatisfaction: { findMany: async () => [{ rating: 5, staffId: 'a', createdAt: ago(60) }, { rating: 3, staffId: 'b', createdAt: ago(30) }, { rating: 1, staffId: 'a', createdAt: ago(40 * 24 * 60) }] },
};
for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { getTicketStats, quantile } = await import('../../services/features/ticketStatsService.js');

describe('quantiles', () => {
  test('médiane et P90 interpolés', () => {
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9.1);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('performance du support', () => {
  test('délais, objectifs, satisfaction, file et agents', async () => {
    const stats = await getTicketStats('g', 30, 'Europe/Paris');
    expect(stats.volume.created).toBe(2);
    expect(stats.firstResponse).toEqual({ count: 2, median: 75, p90: 111 });
    expect(stats.sla.firstResponseMet).toBe(50);
    expect(stats.sla.resolutionMet).toBeNull();
    expect(stats.satisfaction).toMatchObject({ average: 4, count: 2, distribution: [0, 0, 1, 0, 1] });
    expect(stats.backlog).toMatchObject({ active: 2, unassigned: 1, waitingStaff: 2, breached: 1 });
    expect(stats.agents.map((a) => [a.name, a.handled, a.rating, a.openNow])).toEqual([['alice', 1, 5, 0], ['bob', 1, 3, 1]]);
    expect(stats.byTag).toEqual([{ tag: 'bug', count: 2 }, { tag: 'paiement', count: 1 }]);
    expect(stats.byType.map((t) => t.label)).toEqual(['Support', 'Sans type']);
    // Séries pour la courbe : une case par jour, la période d'avant alignée.
    expect(stats.daily.dates).toHaveLength(30);
    expect(stats.daily.previous.created).toHaveLength(30);
    expect(stats.daily.current.created.reduce((a, b) => a + b, 0)).toBe(2);
    // La note d'il y a 40 jours tombe dans la période d'avant.
    expect(stats.previous.satisfaction).toBe(1);
  });
});
