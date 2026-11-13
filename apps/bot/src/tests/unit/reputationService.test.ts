import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

let votesCount = 0;
let createError: unknown = null;
let rankAbove = 0n;
let receivedTotal = 0;
let configRow: Record<string, unknown> | null = null;
let voteRows: Array<Record<string, unknown>> = [];
let foundVote: Record<string, unknown> | null = null;

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
    findMany: mock(async (_args?: unknown) => voteRows),
    findFirst: mock(async (_args?: unknown) => foundVote),
  },
  reputationConfig: {
    findUnique: mock(async (_args?: unknown) => configRow),
    upsert: mock(async (args: { create: Record<string, unknown> }) => args.create),
  },
  reputationTier: {
    deleteMany: mock(async (_args?: unknown) => ({ count: 0 })),
    createMany: mock(async (_args?: unknown) => ({ count: 0 })),
  },
  $transaction: mock(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
  $queryRaw: mock(async (..._args: unknown[]) => [{ above: rankAbove }]),
  // Lu par le vrai `resolveGuildTimezone` : sans serveur, le fuseau par défaut.
  guild: { findUnique: mock(async (_args?: unknown) => null) },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const {
  giveRep,
  getReputation,
  getReputationConfig,
  getReputationDashboardData,
  invalidateReputationConfigCache,
  listReputationVotes,
  deleteReputationVote,
  saveReputationConfig,
} = await import('../../services/community/reputationService.js');

beforeEach(async () => {
  votesCount = 0;
  createError = null;
  rankAbove = 0n;
  receivedTotal = 0;
  configRow = null;
  voteRows = [];
  foundVote = null;
  for (const fn of [
    mockDb.reputationVote.count,
    mockDb.reputationVote.create,
    mockDb.reputationVote.findMany,
    mockDb.reputationVote.delete,
    mockDb.reputationConfig.upsert,
    mockDb.reputationTier.deleteMany,
    mockDb.reputationTier.createMany,
    mockDb.$queryRaw,
  ]) fn.mockClear();
  await invalidateReputationConfigCache('g');
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

  test('refuse au-delà de la limite par défaut', async () => {
    votesCount = 3;
    const result = await giveRep('g', 'u1', 'u2');
    expect(result).toEqual({ success: false, code: 'DAILY_LIMIT' });
    expect(mockDb.reputationVote.create).not.toHaveBeenCalled();
  });

  test('la limite du jour vient des réglages du serveur', async () => {
    configRow = { dailyLimit: 5 };
    votesCount = 4;
    const result = await giveRep('g', 'u1', 'u2');
    expect(result.success).toBe(true);
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

  test('le message remercié est enregistré avec le vote', async () => {
    await giveRep('g', 'u1', 'u2', undefined, { channelId: 'c1', messageId: 'm1' });
    const data = (mockDb.reputationVote.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.channelId).toBe('c1');
    expect(data.messageId).toBe('m1');
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

  test('les votes restants suivent la limite du serveur', async () => {
    configRow = { dailyLimit: 2 };
    votesCount = 2;
    const profile = await getReputation('g', 'u1');
    expect(profile.dailyLimit).toBe(2);
    expect(profile.canVote).toBe(false);
  });
});

const DEFAULTS = { dailyLimit: 3, reactionEnabled: false, reactionEmoji: null, xpPerRep: 0, coinsPerRep: 0, announceChannelId: null, tiers: [] };

describe('réglages', () => {
  test('sans ligne, les valeurs par défaut', async () => {
    expect(await getReputationConfig('g')).toEqual(DEFAULTS);
  });

  test('les paliers sont rendus avec les réglages', async () => {
    configRow = { ...DEFAULTS, announceChannelId: '1', tiers: [{ threshold: 10, roleId: 'r' }] };
    expect(await getReputationConfig('g')).toEqual({ ...DEFAULTS, announceChannelId: '1', tiers: [{ threshold: 10, roleId: 'r' }] });
  });

  test('la sauvegarde écrit la ligne et invalide le cache', async () => {
    expect(await getReputationConfig('g')).toEqual(DEFAULTS);
    configRow = { ...DEFAULTS, dailyLimit: 8 };
    await saveReputationConfig('g', { dailyLimit: 8 });
    expect(mockDb.reputationConfig.upsert).toHaveBeenCalledTimes(1);
    expect(mockDb.reputationTier.deleteMany).not.toHaveBeenCalled();
    expect(await getReputationConfig('g')).toEqual({ ...DEFAULTS, dailyLimit: 8 });
  });

  test('des paliers envoyés remplacent ceux en place', async () => {
    const tiers = [{ threshold: 10, roleId: 'r1' }, { threshold: 20, roleId: 'r2' }];
    await saveReputationConfig('g', { tiers });
    expect(mockDb.reputationTier.deleteMany).toHaveBeenCalledTimes(1);
    const created = (mockDb.reputationTier.createMany.mock.calls[0][0] as { data: unknown[] }).data;
    expect(created).toEqual(tiers.map((tier) => ({ guildId: 'g', ...tier })));
  });
});

describe('getReputationDashboardData', () => {
  test('compte les votes des 7 derniers jours en base, pas dans la liste récente', async () => {
    votesCount = 42;
    const data = await getReputationDashboardData('g', 'all');
    expect(data.stats.votesLast7Days).toBe(42);

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

  test('le classement de la semaine filtre sur la date', async () => {
    await getReputationDashboardData('g', 'week');
    const leaderboardCall = mockDb.reputationVote.groupBy.mock.calls.find((call) =>
      (call[0] as { by: string[] }).by.includes('receiverId'));
    const where = (leaderboardCall![0] as { where: { createdAt?: { gte: Date } } }).where;
    expect(where.createdAt?.gte).toBeInstanceOf(Date);
  });
});

describe('listReputationVotes', () => {
  function rows(count: number) {
    return Array.from({ length: count }, (_, i) => ({ id: `v${i}`, giverId: 'a', receiverId: 'b', createdAt: new Date() }));
  }

  test('rend un curseur quand une page de plus existe', async () => {
    voteRows = rows(3);
    const page = await listReputationVotes('g', { limit: 2 });
    expect(page.votes).toHaveLength(2);
    expect(page.nextCursor).toBe('v1');
  });

  test('pas de curseur sur la dernière page', async () => {
    voteRows = rows(2);
    const page = await listReputationVotes('g', { limit: 2 });
    expect(page.nextCursor).toBeNull();
  });

  test('le filtre membre couvre les votes donnés et reçus', async () => {
    await listReputationVotes('g', { userId: 'u1', limit: 2 });
    const where = (mockDb.reputationVote.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } }).where;
    expect(where.OR).toEqual([{ giverId: 'u1' }, { receiverId: 'u1' }]);
  });
});

describe('deleteReputationVote', () => {
  test('ne supprime pas le vote d\'un autre serveur', async () => {
    foundVote = null;
    expect(await deleteReputationVote('g', 'v1')).toBeNull();
    expect(mockDb.reputationVote.delete).not.toHaveBeenCalled();
  });

  test('supprime et rend le vote trouvé', async () => {
    foundVote = { id: 'v1', guildId: 'g', receiverId: 'u2', giverId: 'u1' };
    expect(await deleteReputationVote('g', 'v1')).toEqual(foundVote);
    expect(mockDb.reputationVote.delete).toHaveBeenCalledTimes(1);
  });
});
