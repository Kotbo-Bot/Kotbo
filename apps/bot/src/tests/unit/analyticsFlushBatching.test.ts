import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Les flushes serveur/salon écrivaient un `upsert` par ligne dans une seule
 * transaction, et les quatre tables partaient en parallèle : sur un serveur
 * actif, Postgres refusait d'ouvrir la transaction (`P2028`) et le bot
 * tombait. On verrouille ici le chemin qui a remplacé ça : une instruction
 * `INSERT ... ON CONFLICT` par table et par lot, des flushes qui
 * s'enchaînent, et un flush en vol qui n'est jamais doublé par le minuteur.
 */

const findUnique = mock((_args?: unknown) => Promise.resolve({ id: 'guild-flush', analyticsEnabled: true }));
const upsert = mock((_args?: unknown) => Promise.resolve({ id: 'row' }));
const executeRawUnsafe = mock((_sql?: string, ..._params: unknown[]) => Promise.resolve(0));
const transaction = mock((ops: unknown[], _options?: unknown) =>
  Promise.all(ops as Promise<unknown>[]).then(() => undefined),
);

const mockDb = {
  guild: { findUnique },
  guildDailyStat: { upsert },
  guildHourlyStat: { upsert },
  channelDailyStat: { upsert },
  memberDailyStat: { upsert },
  $executeRawUnsafe: executeRawUnsafe,
  $transaction: transaction,
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { cache } = await import('../../utils/cache');
const { trackMessage, flushAllAnalyticsStats } = await import('../../services/analytics/analyticsService');
const { flushBulk } = await import('../../services/analytics/analyticsBulkFlush');

const rawCallsFor = (table: string) =>
  executeRawUnsafe.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].includes(table),
  ) as Array<[string, ...unknown[]]>;

beforeEach(async () => {
  upsert.mockClear();
  executeRawUnsafe.mockClear();
  transaction.mockClear();
  await cache.invalidateGuild('guild-flush');
});

describe('flush des statistiques serveur et salon', () => {
  test('écrit chaque table en une instruction, sans upsert unitaire', async () => {
    for (let i = 0; i < 40; i++) {
      await trackMessage('guild-flush', `salon-${i}`, `membre-${i}`);
    }

    await flushAllAnalyticsStats();

    expect(upsert).not.toHaveBeenCalled();
    expect(rawCallsFor('guild_daily_stats')).toHaveLength(1);
    expect(rawCallsFor('guild_hourly_stats')).toHaveLength(1);
    expect(rawCallsFor('channel_daily_stats')).toHaveLength(1);
    expect(rawCallsFor('member_daily_stats')).toHaveLength(1);
  });

  test('insère ou incrémente sur la clé primaire, sans transaction', async () => {
    await trackMessage('guild-flush', 'salon-1', 'membre-1');
    await flushAllAnalyticsStats();

    const [sql] = rawCallsFor('member_daily_stats')[0]!;
    expect(sql).toContain('INSERT INTO member_daily_stats AS m');
    expect(sql).toContain('ON CONFLICT ON CONSTRAINT "member_daily_stats_pkey" DO UPDATE');
    expect(sql).toContain('"updatedAt" = NOW()');
    // Une seule instruction par lot : plus rien à attendre du pool en transaction.
    expect(transaction).not.toHaveBeenCalled();
  });

  test('compte les auteurs uniques du salon sans les incrémenter', async () => {
    await trackMessage('guild-flush', 'salon-1', 'membre-1');
    await trackMessage('guild-flush', 'salon-1', 'membre-2');
    await trackMessage('guild-flush', 'salon-1', 'membre-1');

    await flushAllAnalyticsStats();

    const [sql, ...params] = rawCallsFor('channel_daily_stats')[0]!;
    expect(sql).toContain('"messagesCount" = m."messagesCount" + EXCLUDED."messagesCount"');
    expect(sql).toContain('"uniqueAuthors" = EXCLUDED."uniqueAuthors"');
    // (guildId, channelId, dateKey), puis messagesCount, voiceMinutes, uniqueAuthors.
    expect(params[3]).toBe(3);
    expect(params[5]).toBe(2);
  });

  test('un flush déjà en vol est rejoint, pas doublé', async () => {
    await trackMessage('guild-flush', 'salon-1', 'membre-1');

    await Promise.all([flushAllAnalyticsStats(), flushAllAnalyticsStats()]);

    expect(rawCallsFor('member_daily_stats')).toHaveLength(1);
  });

  test('une écriture en échec n\'arrête pas le bot ni les tables suivantes', async () => {
    executeRawUnsafe.mockImplementationOnce(() => Promise.reject(new Error('P2028')));

    await trackMessage('guild-flush', 'salon-1', 'membre-1');

    await expect(flushAllAnalyticsStats()).resolves.toBeUndefined();
    expect(rawCallsFor('member_daily_stats')).toHaveLength(1);
  });
});

describe('flushBulk', () => {
  const target = {
    label: 'Test',
    table: 'test_stats',
    keys: [
      { name: 'guildId', type: 'text' as const },
      { name: 'dateKey', type: 'text' as const },
    ],
    counterColumns: ['n'],
  };

  test('fusionne deux lignes de même clé : Postgres rejetterait tout le lot', async () => {
    await flushBulk(target, [
      { keys: ['g', '2026-11-01'], counters: { n: 2 } },
      { keys: ['g', '2026-11-01'], counters: { n: 3 } },
    ]);

    const [, ...params] = rawCallsFor('test_stats')[0]!;
    expect(params).toEqual(['g', '2026-11-01', 5]);
  });

  test('écarte une clé coupée en trop de morceaux plutôt que de décaler le lot', async () => {
    await flushBulk(target, [
      { keys: ['g', '2026-11-01', 'reste'], counters: { n: 1 } },
      { keys: ['g', '2026-11-02'], counters: { n: 4 } },
    ]);

    const [, ...params] = rawCallsFor('test_stats')[0]!;
    expect(params).toEqual(['g', '2026-11-02', 4]);
  });

  test('sans horodatage, n\'écrit ni createdAt ni updatedAt', async () => {
    await flushBulk({ ...target, timestamps: false }, [{ keys: ['g', '2026-11-01'], counters: { n: 1 } }]);

    const [sql] = rawCallsFor('test_stats')[0]!;
    expect(sql).not.toContain('updatedAt');
    expect(sql).not.toContain('createdAt');
  });
});
