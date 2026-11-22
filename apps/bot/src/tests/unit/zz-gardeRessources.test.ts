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
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD = 'guild-ressources';

let modulesActifs: Record<string, boolean> = {};

const QUETE = {
  id: 'quete-1', guildId: GUILD, objective: 'SEND_MESSAGES', scope: 'MEMBER', teamMode: 'CLAN', repeatable: false,
  windowHours: 24, target: 1, rewardCoins: 100, rewardXp: 0, rewardClanPoints: 0, name: 'Bavard',
  conditions: null, rewards: null, prerequisiteQuestId: null, activeFrom: null, activeUntil: null,
};

const rpgProfileUpsert = mock(async () => ({}));
const progressUpdateMany = mock(async () => ({ count: 1 }));

const mockDb = {
  guild: { findUnique: mock(async () => ({ id: GUILD, plan: 'CUSTOM' })) },
  dashboardFeatureConfig: {
    findMany: mock(async () => Object.entries(modulesActifs)
      .map(([featureKey, enabled]) => ({ guildId: GUILD, featureKey, enabled }))),
  },
  levelConfig: { findUnique: mock(async () => null) },
  rankedConfig: { findUnique: mock(async () => null) },
  banAppealConfig: { findUnique: mock(async () => null) },
  rpgQuest: { findMany: mock(async () => [QUETE]) },
  rpgQuestProgress: {
    findUnique: mock(async () => null),
    findFirst: mock(async () => null),
    upsert: mock(async () => ({ id: 'progression-1' })),
    updateMany: progressUpdateMany,
  },
  rpgProfile: { upsert: rpgProfileUpsert },
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

// Les montées de niveau et les points d'équipe n'intéressent pas cette garde.
const economyPath = path.resolve(import.meta.dir, '../../services/features/economyService.ts');
for (const suffix of ['../../services/features/economyService.ts', '../../services/features/economyService.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => completeModuleMock(economyPath, {
    checkLevelUp: async () => undefined,
    awardRpgGuildXp: async () => undefined,
  }));
}

const { trackRpgQuest } = await import('../../services/features/rpg/rpgQuestService.js');

const client = { guilds: { cache: new Map() } } as never;

beforeEach(() => {
  modulesActifs = { economy: true };
  rpgProfileUpsert.mockClear();
  progressUpdateMany.mockClear();
});

describe('une quête accomplie ne verse ses pièces que si l\'économie tourne', () => {
  test('économie éteinte : la quête est soldée sans pièces', async () => {
    modulesActifs.economy = false;
    await trackRpgQuest(client, GUILD, 'membre-1', 'SEND_MESSAGES');
    expect(progressUpdateMany).toHaveBeenCalledTimes(1);
    expect(rpgProfileUpsert).not.toHaveBeenCalled();
  });

  test('économie allumée : les pièces sont créditées', async () => {
    await trackRpgQuest(client, GUILD, 'membre-1', 'SEND_MESSAGES');
    expect(rpgProfileUpsert).toHaveBeenCalledTimes(1);
  });
});
