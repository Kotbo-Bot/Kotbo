import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

let votesCount = 0;
let createError: unknown = null;
let rankAbove = 0n;
let receivedTotal = 0;
let configRow: Record<string, unknown> | null = null;
let voteRows: Array<Record<string, unknown>> = [];
let foundVote: Record<string, unknown> | null = null;
let deletedCount = 0;
let receiverGroups: Array<{ receiverId: string }> = [];

const mockDb = {
  reputationVote: {
    count: mock(async (_args?: unknown) => votesCount),
    create: mock(async (_args?: unknown) => {
      if (createError) throw createError;
      votesCount += 1;
      return { id: 'vote-1' };
    }),
    delete: mock(async (_args?: unknown) => ({})),
    update: mock(async (_args?: unknown) => ({})),
    deleteMany: mock(async (_args?: unknown) => ({ count: deletedCount })),
    aggregate: mock(async (_args?: unknown) => ({ _sum: { value: receivedTotal } })),
    groupBy: mock(async (args?: { by?: string[] }) => (args?.by?.includes('receiverId') ? receiverGroups : [])),
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
  recordVoteGains,
  adjustReputation,
  resetMemberReputation,
  resetGuildReputation,
  getMemberReputationSummary,
} = await import('../../services/community/reputationService.js');

beforeEach(async () => {
  votesCount = 0;
  createError = null;
  rankAbove = 0n;
  receivedTotal = 0;
  configRow = null;
  voteRows = [];
  foundVote = null;
  deletedCount = 0;
  receiverGroups = [];
  for (const fn of [
    mockDb.reputationVote.update,
    mockDb.reputationVote.deleteMany,
    mockDb.reputationVote.findFirst,
    mockDb.reputationVote.groupBy,
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

  test('un vote accepté rend son identifiant, pour y garder les gains', async () => {
    const result = await giveRep('g', 'u1', 'u2');
    expect(result).toMatchObject({ success: true, voteId: 'vote-1' });
  });

  test('l\'attente d\'un jour ne relit pas le dernier vote : l\'index du jour suffit', async () => {
    await giveRep('g', 'u1', 'u2');
    expect(mockDb.reputationVote.findFirst).not.toHaveBeenCalled();
  });

  test('refuse de remercier le même membre avant la fin de l\'attente', async () => {
    configRow = { dailyLimit: 3, sameMemberCooldownDays: 30 };
    foundVote = { day: new Date().toISOString().slice(0, 10) };
    const result = await giveRep('g', 'u1', 'u2');
    expect(result).toEqual({ success: false, code: 'COOLDOWN' });
    expect(mockDb.reputationVote.create).not.toHaveBeenCalled();
    const where = (mockDb.reputationVote.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ guildId: 'g', giverId: 'u1', receiverId: 'u2', kind: 'VOTE' });
  });

  test('accepte une fois l\'attente écoulée', async () => {
    configRow = { dailyLimit: 3, sameMemberCooldownDays: 3 };
    foundVote = { day: '2000-01-01' };
    expect((await giveRep('g', 'u1', 'u2')).success).toBe(true);
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

const DEFAULTS = {
  dailyLimit: 3,
  reactionEnabled: false,
  reactionEmoji: null,
  xpPerRep: 0,
  coinsPerRep: 0,
  announceChannelId: null,
  minAccountAgeDays: 0,
  minMemberDays: 0,
  sameMemberCooldownDays: 1,
  excludedRoleIds: [],
  excludedChannelIds: [],
  tiers: [],
};

describe('réglages', () => {
  test('une ligne d\'avant les garde-fous les rend désactivés', async () => {
    configRow = { dailyLimit: 3, tiers: [] };
    expect(await getReputationConfig('g')).toEqual(DEFAULTS);
  });

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
  const AT = new Date('2026-11-13T10:00:00.000Z');

  function rows(count: number) {
    return Array.from({ length: count }, (_, i) => ({ id: `v${i}`, giverId: 'a', receiverId: 'b', createdAt: AT }));
  }

  function whereOfCall() {
    return (mockDb.reputationVote.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
  }

  test('rend un curseur (date et id du dernier vote) quand une page de plus existe', async () => {
    voteRows = rows(3);
    const page = await listReputationVotes('g', { limit: 2 });
    expect(page.votes).toHaveLength(2);
    expect(page.nextCursor).toBe(`${AT.getTime()}_v1`);
  });

  test('pas de curseur sur la dernière page', async () => {
    voteRows = rows(2);
    const page = await listReputationVotes('g', { limit: 2 });
    expect(page.nextCursor).toBeNull();
  });

  test('reprend sous le curseur par date puis id, sans dépendre d\'une ligne encore présente', async () => {
    await listReputationVotes('g', { cursor: `${AT.getTime()}_v1`, limit: 2 });
    const args = mockDb.reputationVote.findMany.mock.calls[0][0] as Record<string, unknown>;
    // Plus de curseur Prisma : il exige que la ligne existe encore, un vote retiré vidait la page.
    expect(args.cursor).toBeUndefined();
    expect(whereOfCall().AND).toContainEqual({
      OR: [{ createdAt: { lt: AT } }, { createdAt: AT, id: { lt: 'v1' } }],
    });
  });

  test('le filtre membre couvre les votes donnés et reçus', async () => {
    await listReputationVotes('g', { userId: 'u1', limit: 2 });
    expect(whereOfCall().AND).toContainEqual({ OR: [{ giverId: 'u1' }, { receiverId: 'u1' }] });
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

describe('recordVoteGains', () => {
  test('garde les gains versés sur le vote', async () => {
    await recordVoteGains('v1', { xp: 20, coins: 5 });
    expect(mockDb.reputationVote.update.mock.calls[0][0]).toEqual({ where: { id: 'v1' }, data: { xpGranted: 20, coinsGranted: 5 } });
  });

  test('rien de versé : aucune écriture', async () => {
    await recordVoteGains('v1', { xp: 0, coins: 0 });
    expect(mockDb.reputationVote.update).not.toHaveBeenCalled();
  });

  test('un vote retiré entre-temps n\'est pas une erreur', async () => {
    mockDb.reputationVote.update.mockImplementationOnce(async () => { throw Object.assign(new Error('absent'), { code: 'P2025' }); });
    await recordVoteGains('v1', { xp: 20, coins: 0 });
  });
});

describe('adjustReputation', () => {
  test('écrit un ajustement sans jour, au nom du staff, et rend les deux totaux', async () => {
    receivedTotal = 4;
    const result = await adjustReputation('g', 'staff', 'u2', 5, 'aide');
    expect(result).toEqual({ success: true, before: 4, after: 9 });
    const data = (mockDb.reputationVote.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ guildId: 'g', giverId: 'staff', receiverId: 'u2', kind: 'ADJUSTMENT', value: 5, reason: 'aide', day: null });
  });

  test('refuse de descendre sous zéro, sans écrire', async () => {
    receivedTotal = 2;
    expect(await adjustReputation('g', 'staff', 'u2', -3, null)).toEqual({ success: false, code: 'BELOW_ZERO', total: 2 });
    expect(mockDb.reputationVote.create).not.toHaveBeenCalled();
  });

  test('retirer tout ce que le membre a reste permis', async () => {
    receivedTotal = 3;
    expect(await adjustReputation('g', 'staff', 'u2', -3, null)).toEqual({ success: true, before: 3, after: 0 });
  });
});

describe('remises à zéro', () => {
  test('un membre : seulement ce qu\'il a reçu', async () => {
    deletedCount = 4;
    expect(await resetMemberReputation('g', 'u2')).toBe(4);
    expect(mockDb.reputationVote.deleteMany.mock.calls[0][0]).toEqual({ where: { guildId: 'g', receiverId: 'u2' } });
  });

  test('le serveur : tout, et rend les membres qui avaient des points', async () => {
    deletedCount = 9;
    receiverGroups = [{ receiverId: 'u1' }, { receiverId: 'u2' }];
    expect(await resetGuildReputation('g')).toEqual({ count: 9, receiverIds: ['u1', 'u2'] });
    expect(mockDb.reputationVote.deleteMany.mock.calls[0][0]).toEqual({ where: { guildId: 'g' } });
  });
});

describe('getReputationDashboardData, ajustements', () => {
  test('les statistiques ne comptent que les votes', async () => {
    await getReputationDashboardData('g', 'all');
    for (const call of mockDb.reputationVote.count.mock.calls) {
      expect((call[0] as { where: { kind?: string } }).where.kind).toBe('VOTE');
    }
  });
});

describe('getMemberReputationSummary', () => {
  test('total, rang, votes reçus et donnés, derniers mouvements', async () => {
    receivedTotal = 6;
    rankAbove = 1n;
    votesCount = 2;
    voteRows = [{ id: 'v1', kind: 'VOTE', value: 1, giverId: 'a', reason: null, createdAt: new Date() }];
    const summary = await getMemberReputationSummary('g', 'u2');
    expect(summary).toMatchObject({ totalRep: 6, rank: 2, receivedVotes: 2, givenVotes: 2, receivedLast7Days: 2 });
    expect(summary.recent).toHaveLength(1);
  });
});
