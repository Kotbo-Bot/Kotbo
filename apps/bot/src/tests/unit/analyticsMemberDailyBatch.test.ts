import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Le flush des statistiques membre est passé d'un upsert par ligne à un
 * `createMany` suivi d'un `UPDATE ... FROM (VALUES ...)`. Ce qu'on verrouille
 * ici, c'est ce qui rendait l'ancien chemin coûteux : le nombre d'instructions
 * ne doit plus dépendre du nombre de membres, et les incréments d'un même
 * membre doivent être agrégés en mémoire avant d'atteindre Postgres.
 */

const findUnique = mock((_args?: unknown) => Promise.resolve({ id: 'guild-batch', analyticsEnabled: true }));
const upsert = mock((_args?: unknown) => Promise.resolve({ id: 'row' }));
const createMany = mock((_args?: unknown) => Promise.resolve({ count: 0 }));
const otherCreateMany = mock((_args?: unknown) => Promise.resolve({ count: 0 }));
const executeRawUnsafe = mock((_sql?: string, ..._params: unknown[]) => Promise.resolve(0));

const mockDb = {
  guild: { findUnique },
  guildDailyStat: { upsert, createMany: otherCreateMany },
  guildHourlyStat: { upsert, createMany: otherCreateMany },
  channelDailyStat: { upsert, createMany: otherCreateMany },
  memberDailyStat: { upsert, createMany },
  $executeRawUnsafe: executeRawUnsafe,
  $transaction: mock((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
};

/** Les quatre tables passent par le même chemin brut : on isole celle du test. */
const memberRawCalls = () =>
  executeRawUnsafe.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].includes('member_daily_stats'),
  ) as Array<[string, ...unknown[]]>;

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { cache } = await import('../../utils/cache');
const { trackMessage, flushAllAnalyticsStats } = await import('../../services/analytics/analyticsService');

type CreateManyArgs = { data: Array<{ guildId: string; userId: string; dateKey: string }>; skipDuplicates?: boolean };

beforeEach(async () => {
  createMany.mockClear();
  otherCreateMany.mockClear();
  executeRawUnsafe.mockClear();
  upsert.mockClear();
  await cache.invalidateGuild('guild-batch');
});

describe('flush des statistiques membre', () => {
  test('écrit un lot de membres en deux instructions', async () => {
    for (let i = 0; i < 120; i++) {
      await trackMessage('guild-batch', 'salon-1', `membre-${i}`);
    }

    await flushAllAnalyticsStats();

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(memberRawCalls()).toHaveLength(1);

    const args = createMany.mock.calls[0]?.[0] as CreateManyArgs;
    expect(args.data).toHaveLength(120);
    // Sans `skipDuplicates`, la pré-insertion casserait sur la contrainte
    // unique dès le deuxième flush de la journée.
    expect(args.skipDuplicates).toBe(true);
  });

  test('découpe au-delà de la taille de lot plutôt que d\'envoyer une requête géante', async () => {
    for (let i = 0; i < 250; i++) {
      await trackMessage('guild-batch', 'salon-1', `membre-${i}`);
    }

    await flushAllAnalyticsStats();

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(memberRawCalls()).toHaveLength(2);
  });

  test('agrège les messages d\'un même membre en une seule ligne', async () => {
    for (let i = 0; i < 5; i++) {
      await trackMessage('guild-batch', 'salon-1', 'membre-bavard');
    }

    await flushAllAnalyticsStats();

    const args = createMany.mock.calls[0]?.[0] as CreateManyArgs;
    expect(args.data).toHaveLength(1);

    const [, ...params] = memberRawCalls()[0]!;
    // (guildId, userId, dateKey) puis les cinq compteurs, messagesCount en tête.
    expect(params.slice(0, 2)).toEqual(['guild-batch', 'membre-bavard']);
    expect(params[3]).toBe(5);
  });

  test('ne touche pas la base quand le tampon est vide', async () => {
    await flushAllAnalyticsStats();

    expect(createMany).not.toHaveBeenCalled();
    expect(otherCreateMany).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});
