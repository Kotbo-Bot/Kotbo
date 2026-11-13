import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

let votesCount = 0;
let createError: unknown = null;
let rankAbove = 0n;
let receivedTotal = 0;

const mockDb = {
  reputationVote: {
    count: mock(async (_args?: unknown) => votesCount),
    create: mock(async (_args?: unknown) => {
      if (createError) throw createError;
      votesCount += 1;
      return { id: 'vote-1' };
    }),
    delete: mock(async (_args?: unknown) => ({})),
    aggregate: mock(async (_args?: unknown) => ({ _sum: { value: receivedTotal } })),
    groupBy: mock(async (_args?: unknown) => []),
    findMany: mock(async (_args?: unknown) => []),
  },
  $queryRaw: mock(async (..._args: unknown[]) => [{ above: rankAbove }]),
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const timezonePath = path.resolve(__dirname, '../../utils/timezone.ts');
for (const suffix of ['../../utils/timezone.ts', '../../utils/timezone.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(timezonePath, {
    DEFAULT_TIMEZONE: 'UTC',
    resolveGuildTimezone: mock(async () => 'UTC'),
  }));
}

const { giveRep, getReputation, getReputationDashboardData } = await import('../../services/community/reputationService.js');

beforeEach(() => {
  votesCount = 0;
  createError = null;
  rankAbove = 0n;
  receivedTotal = 0;
  mockDb.reputationVote.count.mockClear();
  mockDb.reputationVote.create.mockClear();
  mockDb.$queryRaw.mockClear();
});

describe('giveRep', () => {
  test('refuse le vote pour soi-même avec un code, sans écrire', async () => {
    const result = await giveRep('g', 'u1', 'u1');
    expect(result).toEqual({ success: false, code: 'SELF' });
    expect(mockDb.reputationVote.create).not.toHaveBeenCalled();
  });

  test('refuse un bot avec un code', async () => {
    const result = await giveRep('g', 'u1', 'bot', undefined, { receiverIsBot: true });
    expect(result).toEqual({ success: false, code: 'BOT' });
  });

  test('refuse au-delà de la limite du jour', async () => {
    votesCount = 3;
    const result = await giveRep('g', 'u1', 'u2');
    expect(result).toEqual({ success: false, code: 'DAILY_LIMIT' });
    expect(mockDb.reputationVote.create).not.toHaveBeenCalled();
  });

  test('un second vote vers la même personne le même jour renvoie ALREADY_TODAY', async () => {
    createError = Object.assign(new Error('unique'), { code: 'P2002' });
    const result = await giveRep('g', 'u1', 'u2');
    expect(result).toEqual({ success: false, code: 'ALREADY_TODAY' });
  });

  test('un vote accepté renvoie le nouveau total', async () => {
    receivedTotal = 7;
    const result = await giveRep('g', 'u1', 'u2', 'merci');
    expect(result).toEqual({ success: true, newTotal: 7 });
  });

  test('aucun message d\'erreur en dur : les refus ne portent qu\'un code', async () => {
    const result = await giveRep('g', 'u1', 'u1');
    expect('error' in result).toBe(false);
  });
});

describe('getReputation', () => {
  test('le rang vaut le nombre de membres strictement devant, plus un', async () => {
    receivedTotal = 12;
    rankAbove = 4n;
    const profile = await getReputation('g', 'u1');
    expect(profile.totalRep).toBe(12);
    expect(profile.rank).toBe(5);
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('ne charge plus tout le classement pour calculer le rang', async () => {
    mockDb.reputationVote.groupBy.mockClear();
    await getReputation('g', 'u1');
    expect(mockDb.reputationVote.groupBy).not.toHaveBeenCalled();
  });
});

describe('getReputationDashboardData', () => {
  test('compte les votes des 7 derniers jours en base, pas dans la liste récente', async () => {
    votesCount = 42;
    const data = await getReputationDashboardData('g');
    expect(data.votesLast7Days).toBe(42);

    const sinceCall = mockDb.reputationVote.count.mock.calls.find((call) => {
      const where = (call[0] as { where?: { createdAt?: { gte?: Date } } } | undefined)?.where;
      return where?.createdAt?.gte instanceof Date;
    });
    expect(sinceCall).toBeDefined();
    const since = (sinceCall![0] as { where: { createdAt: { gte: Date } } }).where.createdAt.gte;
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });
});
