import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Les flushes serveur/salon écrivaient un `upsert` par ligne dans une seule
 * transaction, et les quatre tables partaient en parallèle : sur un serveur
 * actif, Postgres refusait d'ouvrir la transaction (`P2028`) et le bot
 * tombait. On verrouille ici le chemin qui a remplacé ça : deux instructions
 * par table, des flushes qui s'enchaînent, et un flush en vol qui n'est jamais
 * doublé par le minuteur.
 */

const findUnique = mock((_args?: unknown) => Promise.resolve({ id: 'guild-flush', analyticsEnabled: true }));
const upsert = mock((_args?: unknown) => Promise.resolve({ id: 'row' }));
const createMany = mock((_args?: unknown) => Promise.resolve({ count: 0 }));
const executeRawUnsafe = mock((_sql?: string, ..._params: unknown[]) => Promise.resolve(0));
const transaction = mock((ops: unknown[], _options?: unknown) =>
  Promise.all(ops as Promise<unknown>[]).then(() => undefined),
);

const mockDb = {
  guild: { findUnique },
  guildDailyStat: { upsert, createMany },
  guildHourlyStat: { upsert, createMany },
  channelDailyStat: { upsert, createMany },
  memberDailyStat: { upsert, createMany },
  $executeRawUnsafe: executeRawUnsafe,
  $transaction: transaction,
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { cache } = await import('../../utils/cache');
const { trackMessage, flushAllAnalyticsStats } = await import('../../services/analytics/analyticsService');

const rawCallsFor = (table: string) =>
  executeRawUnsafe.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].includes(table),
  ) as Array<[string, ...unknown[]]>;

beforeEach(async () => {
  upsert.mockClear();
  createMany.mockClear();
  executeRawUnsafe.mockClear();
  transaction.mockClear();
  await cache.invalidateGuild('guild-flush');
});

describe('flush des statistiques serveur et salon', () => {
  test('écrit chaque table en deux instructions, sans upsert unitaire', async () => {
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

  test('laisse au pool le temps de fournir une connexion', async () => {
    await trackMessage('guild-flush', 'salon-1', 'membre-1');
    await flushAllAnalyticsStats();

    // `maxWait` par défaut vaut 2 s : c'est ce délai trop court qui perdait
    // les lots sous charge.
    const options = transaction.mock.calls[0]?.[1] as { maxWait: number; timeout: number };
    expect(options.maxWait).toBeGreaterThanOrEqual(10_000);
    expect(options.timeout).toBeGreaterThan(options.maxWait);
  });

  test('compte les auteurs uniques du salon sans les incrémenter', async () => {
    await trackMessage('guild-flush', 'salon-1', 'membre-1');
    await trackMessage('guild-flush', 'salon-1', 'membre-2');
    await trackMessage('guild-flush', 'salon-1', 'membre-1');

    await flushAllAnalyticsStats();

    const [sql, ...params] = rawCallsFor('channel_daily_stats')[0]!;
    expect(sql).toContain('"messagesCount" = m."messagesCount" + v."messagesCount"');
    expect(sql).toContain('"uniqueAuthors" = v."uniqueAuthors"');
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
    transaction.mockImplementationOnce(() => Promise.reject(new Error('P2028')));

    await trackMessage('guild-flush', 'salon-1', 'membre-1');

    await expect(flushAllAnalyticsStats()).resolves.toBeUndefined();
    expect(rawCallsFor('member_daily_stats')).toHaveLength(1);
  });
});
