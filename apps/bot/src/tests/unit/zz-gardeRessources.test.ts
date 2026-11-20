/**
 * Une ressource tenue par un module n'est plus versée quand ce module est
 * éteint, même si c'est un autre module qui la verse : les quêtes créditaient
 * des pièces sans regarder l'économie.
 *
 * `addXp` porte la même garde pour le leveling, mais ne se teste pas ici :
 * `widgetService.test.ts`, chargé avant, remplace `levelingService` par un
 * double strict pour tout le process.
 *
 * La garde est la vraie (`moduleGate`), alimentée par une base factice : la
 * remplacer par un double fausserait `zz-moduleGate`, chargé juste après et
 * qui teste précisément cette garde.
 *
 * Préfixe `zz-` : ce fichier remplace `utils/db`, `utils/cache` et
 * `utils/logger` pour tout le process (`mock.module` est global).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const GUILD = 'guild-ressources';

let modulesActifs: Record<string, boolean> = {};

const QUETE = {
  id: 'quete-1', guildId: GUILD, type: 'MESSAGE', frequency: 'DAILY', target: 1, rewardCoins: 100, rewardXp: 0,
};

const rpgProfileUpsert = mock(async () => ({}));
const tx = {
  questProgress: { updateMany: mock(async () => ({ count: 1 })) },
  rpgProfile: { upsert: rpgProfileUpsert },
};

const mockDb = {
  guild: { findUnique: mock(async () => ({ id: GUILD, plan: 'CUSTOM' })) },
  dashboardFeatureConfig: {
    findMany: mock(async () => Object.entries(modulesActifs)
      .map(([featureKey, enabled]) => ({ guildId: GUILD, featureKey, enabled }))),
  },
  levelConfig: { findUnique: mock(async () => null) },
  rankedConfig: { findUnique: mock(async () => null) },
  banAppealConfig: { findUnique: mock(async () => null) },
  questDefinition: { findMany: mock(async () => [QUETE]) },
  questProgress: {
    findUnique: mock(async () => null),
    create: mock(async () => ({ id: 'progression-1' })),
  },
  $transaction: mock(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
};

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {},
};

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => ({
    default: mockDb, prisma: mockDb, prismaRead: mockDb,
    upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert(),
  }));
}
for (const suffix of ['../../utils/logger.ts', '../../utils/logger.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => ({ logger: silentLogger, default: silentLogger }));
}
// Cache toujours vide : chaque appel relit l'état des modules.
for (const suffix of ['../../utils/cache.ts', '../../utils/cache.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => ({
    cache: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      invalidateGuild: async () => undefined,
      wrap: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
    },
    getCachedGuild: async () => null,
    getCachedDashboardSettings: async () => null,
  }));
}

const { incrementQuestProgress } = await import('../../services/community/questService.js');

const client = { guilds: { cache: new Map() } } as never;

beforeEach(() => {
  modulesActifs = { economy: true };
  rpgProfileUpsert.mockClear();
  tx.questProgress.updateMany.mockClear();
});

describe('une quête accomplie ne verse ses pièces que si l\'économie tourne', () => {
  test('économie éteinte : la quête est soldée sans pièces', async () => {
    modulesActifs.economy = false;
    await incrementQuestProgress(client, GUILD, 'membre-1', 'MESSAGE');
    expect(tx.questProgress.updateMany).toHaveBeenCalledTimes(1);
    expect(rpgProfileUpsert).not.toHaveBeenCalled();
  });

  test('économie allumée : les pièces sont créditées', async () => {
    await incrementQuestProgress(client, GUILD, 'membre-1', 'MESSAGE');
    expect(rpgProfileUpsert).toHaveBeenCalledTimes(1);
  });
});
