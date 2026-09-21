import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Verrou de collecte : quand `analyticsEnabled` est à false, aucune écriture ne
 * doit atteindre les tables de statistiques. On vérifie le comportement du
 * verrou lui-même, puis son effet sur les fonctions `track*` - le seul endroit
 * par lequel passent toutes les mesures d'activité.
 */

type GuildRow = { id: string; analyticsEnabled: boolean } | null;

let guildRow: GuildRow = null;
const findUnique = mock((_args?: unknown) => Promise.resolve(guildRow));
const upsert = mock((_args?: unknown) => Promise.resolve({ id: 'row', peakOnline: 0 }));
const createMany = mock((_args?: unknown) => Promise.resolve({ count: 0 }));
const executeRawUnsafe = mock((_sql?: string, ..._params: unknown[]) => Promise.resolve(0));
const mockDb = {
  guild: { findUnique },
  // Les flushes passent tous par createMany + UPDATE brut, pas par upsert.
  guildDailyStat: { upsert, createMany },
  guildHourlyStat: { upsert, createMany },
  channelDailyStat: { upsert, createMany },
  memberDailyStat: { upsert, createMany },
  $executeRawUnsafe: executeRawUnsafe,
  $transaction: mock((ops: unknown[]) => Promise.resolve(ops)),
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { isAnalyticsCollectionEnabled } = await import('../../services/analytics/analyticsConsent');
const { cache } = await import('../../utils/cache');
const {
  trackMessage,
  trackVoiceSession,
  trackMemberJoin,
  trackReaction,
  flushAllAnalyticsStats,
} = await import('../../services/analytics/analyticsService');

beforeEach(async () => {
  guildRow = null;
  findUnique.mockClear();
  upsert.mockClear();
  createMany.mockClear();
  executeRawUnsafe.mockClear();
  // Le verrou lit la configuration via `getCachedGuild` : sans purge, un test
  // hériterait de la décision du précédent.
  await cache.invalidateGuild('guild-analytics');
});

describe('isAnalyticsCollectionEnabled', () => {
  test('autorise la collecte par défaut', async () => {
    guildRow = { id: 'guild-analytics', analyticsEnabled: true };
    expect(await isAnalyticsCollectionEnabled('guild-analytics')).toBe(true);
  });

  test('la refuse quand le serveur a coupé le module', async () => {
    guildRow = { id: 'guild-analytics', analyticsEnabled: false };
    expect(await isAnalyticsCollectionEnabled('guild-analytics')).toBe(false);
  });

  test('la refuse quand la configuration est introuvable', async () => {
    // Se taire plutôt qu'écrire : une lecture en échec ne doit pas rétablir la
    // collecte sur un serveur qui l'a désactivée.
    guildRow = null;
    expect(await isAnalyticsCollectionEnabled('guild-analytics')).toBe(false);
  });
});

describe('collecte désactivée', () => {
  test('aucune statistique n\'est écrite, quel que soit le signal', async () => {
    guildRow = { id: 'guild-analytics', analyticsEnabled: false };

    await trackMessage('guild-analytics', 'salon-1', 'membre-1');
    await trackVoiceSession('guild-analytics', 'membre-1', 42, 'vocal-1');
    await trackMemberJoin('guild-analytics');
    await trackReaction('guild-analytics', 'membre-1');

    // Les `track*` bufferisent puis écrivent au flush : c'est donc après flush
    // que l'absence d'écriture se constate.
    await flushAllAnalyticsStats();

    expect(upsert).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe('collecte activée', () => {
  test('les statistiques repartent normalement', async () => {
    guildRow = { id: 'guild-analytics', analyticsEnabled: true };

    await trackMessage('guild-analytics', 'salon-1', 'membre-1');
    await flushAllAnalyticsStats();

    expect(createMany).toHaveBeenCalled();
    expect(executeRawUnsafe).toHaveBeenCalled();
  });
});
