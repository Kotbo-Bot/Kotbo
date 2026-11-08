import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Le flush des statistiques membre est passé d'un upsert par ligne à un seul
 * `INSERT ... ON CONFLICT` par lot. Ce qu'on verrouille ici, c'est ce qui
 * rendait l'ancien chemin coûteux : le nombre d'instructions ne doit plus
 * dépendre du nombre de membres, et les incréments d'un même membre doivent
 * être agrégés en mémoire avant d'atteindre Postgres.
 */

const findUnique = mock((_args?: unknown) => Promise.resolve({ id: 'guild-batch', analyticsEnabled: true }));
const upsert = mock((_args?: unknown) => Promise.resolve({ id: 'row' }));
const executeRawUnsafe = mock((_sql?: string, ..._params: unknown[]) => Promise.resolve(0));

const mockDb = {
  guild: { findUnique },
  guildDailyStat: { upsert },
  guildHourlyStat: { upsert },
  channelDailyStat: { upsert },
  memberDailyStat: { upsert },
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

// (guildId, userId, dateKey) puis les cinq compteurs.
const PARAMS_PER_ROW = 8;

beforeEach(async () => {
  executeRawUnsafe.mockClear();
  upsert.mockClear();
  await cache.invalidateGuild('guild-batch');
});

describe('flush des statistiques membre', () => {
  test('écrit un lot de membres en une instruction', async () => {
    for (let i = 0; i < 120; i++) {
      await trackMessage('guild-batch', 'salon-1', `membre-${i}`);
    }

    await flushAllAnalyticsStats();

    expect(memberRawCalls()).toHaveLength(1);
    const [, ...params] = memberRawCalls()[0]!;
    expect(params).toHaveLength(120 * PARAMS_PER_ROW);
  });

  test('découpe au-delà de la taille de lot plutôt que d\'envoyer une requête géante', async () => {
    for (let i = 0; i < 250; i++) {
      await trackMessage('guild-batch', 'salon-1', `membre-${i}`);
    }

    await flushAllAnalyticsStats();

    expect(memberRawCalls()).toHaveLength(2);
  });

  test('agrège les messages d\'un même membre en une seule ligne', async () => {
    for (let i = 0; i < 5; i++) {
      await trackMessage('guild-batch', 'salon-1', 'membre-bavard');
    }

    await flushAllAnalyticsStats();

    const [, ...params] = memberRawCalls()[0]!;
    expect(params).toHaveLength(PARAMS_PER_ROW);
    // messagesCount en tête des compteurs.
    expect(params.slice(0, 2)).toEqual(['guild-batch', 'membre-bavard']);
    expect(params[3]).toBe(5);
  });

  test('ne touche pas la base quand le tampon est vide', async () => {
    await flushAllAnalyticsStats();

    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});
