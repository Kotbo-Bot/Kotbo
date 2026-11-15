/**
 * Saisons : référence d'XP à l'ouverture, clôture unique, récompenses.
 *
 * Préfixe `zzz-` : ce fichier remplace `moduleGate`, `economyService` et
 * `rankedSeasonService` pour tout le process (`mock.module` est global). Il
 * doit charger après leurs propres tests.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const ROLE = '123456789012345678';
const TOP_ROLE = '223456789012345678';

type Season = { id: string; guildId: string; number: number; status: string; startDate: Date; endDate: Date; rewards: unknown; topRoleId: string | null };

let seasons: Season[] = [];
let standingsRows: Array<{ userId: string; level: number; seasonXp: number }> = [];

const executeRaw = mock(async (..._args: unknown[]) => 0);
const queryRaw = mock(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
  const sql = strings.join('?');
  if (sql.includes('COUNT(*)')) return [{ participants: standingsRows.length, totalXp: BigInt(standingsRows.reduce((sum, row) => sum + row.seasonXp, 0)) }];
  return standingsRows;
});
const snapshotCreateMany = mock(async (..._args: unknown[]) => ({ count: 0 }));
const baselineDeleteMany = mock(async (..._args: unknown[]) => ({ count: 0 }));
const seasonUpdate = mock(async (..._args: unknown[]) => ({}));
const rpgUpdate = mock(async (..._args: unknown[]) => ({}));

function matches(season: Season, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => (season as Record<string, unknown>)[key] === value);
}

const db = {
  levelingSeason: {
    findFirst: mock(async ({ where }: { where: Record<string, unknown> }) => seasons.find((s) => matches(s, where)) ?? null),
    findMany: mock(async ({ where }: { where: Record<string, unknown> }) => {
      const { startDate, endDate, ...rest } = where as { startDate?: { lte: Date }; endDate?: { lte: Date } };
      return seasons.filter((s) => matches(s, rest)
        && (!startDate || s.startDate <= startDate.lte)
        && (!endDate || s.endDate <= endDate.lte));
    }),
    updateMany: mock(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Season> }) => {
      const hit = seasons.filter((s) => matches(s, where));
      for (const s of hit) Object.assign(s, data);
      return { count: hit.length };
    }),
    update: seasonUpdate,
  },
  seasonSnapshot: { createMany: snapshotCreateMany, findMany: mock(async () => []) },
  seasonBaseline: { deleteMany: baselineDeleteMany },
  memberDailyStat: {
    groupBy: mock(async () => [{ userId: 'a', _sum: { messagesCount: 12, voiceMinutes: 30 } }]),
  },
  rpgProfile: { update: rpgUpdate },
  $queryRaw: queryRaw,
  $executeRaw: executeRaw,
  $transaction: mock(async (fn: (tx: unknown) => unknown) => fn(db)),
};

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

let economyOn = true;
const closeRanked = mock(async (..._args: unknown[]) => null);
mockerModule('../../utils/db', { default: db, prisma: db, prismaRead: db });
mockerModule('../../services/core/moduleGate', {
  isModuleEnabled: mock(async (_guildId: string, key: string) => (key === 'economy' ? economyOn : true)),
});
mockerModule('../../services/features/economyService', {
  getOrCreateRpgProfile: mock(async (_guildId: string, userId: string) => ({ id: `profil-${userId}` })),
});
mockerModule('../../services/progression/ranked/rankedSeasonService', { closeRankedSeasonForLevelingSeason: closeRanked });

const { startSeason, endSeason, checkAndProgressSeasons, getSeasonLeaderboard } = await import('../../services/progression/seasonService.js');

/** Serveur factice : `holders` sont les membres qui portent déjà le rôle du premier. */
function fakeClient(holders: string[] = []) {
  const added: Array<[string, string]> = [];
  const removed: Array<[string, string]> = [];
  const member = (id: string) => ({
    id,
    roles: {
      add: mock(async (roleId: string) => { added.push([id, roleId]); }),
      remove: mock(async (roleId: string) => { removed.push([id, roleId]); }),
    },
  });
  const guild = {
    members: { fetch: mock(async (id: string) => member(id)) },
    roles: { cache: new Map([[TOP_ROLE, { id: TOP_ROLE, members: new Map(holders.map((id) => [id, member(id)])) }]]) },
  };
  const client = { guilds: { cache: new Map([['g', guild]]), fetch: mock(async () => guild) } } as unknown as Client;
  return { client, added, removed };
}

function season(overrides: Partial<Season> = {}): Season {
  return {
    id: 's1',
    guildId: 'g',
    number: 1,
    status: 'ACTIVE',
    startDate: new Date('2026-11-01T00:00:00Z'),
    endDate: new Date('2026-12-01T00:00:00Z'),
    rewards: [],
    topRoleId: null,
    ...overrides,
  };
}

beforeEach(() => {
  seasons = [];
  standingsRows = [
    { userId: 'a', level: 5, seasonXp: 900 },
    { userId: 'b', level: 12, seasonXp: 400 },
  ];
  economyOn = true;
  for (const fn of [executeRaw, queryRaw, snapshotCreateMany, baselineDeleteMany, seasonUpdate, rpgUpdate, closeRanked]) fn.mockClear();
});

describe('startSeason', () => {
  test('ouvre une saison à venir et relève l\'XP de chacun dans la même transaction', async () => {
    seasons = [season({ status: 'UPCOMING' })];
    const before = Date.now();
    expect(await startSeason('g', 's1')).toBe('started');
    expect(seasons[0].status).toBe('ACTIVE');
    expect(seasons[0].startDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect((executeRaw.mock.calls[0][0] as unknown as string[]).join('?')).toContain('season_baselines');
  });

  test('refuse d\'ouvrir une saison pendant qu\'une autre est en cours, sans la clôturer', async () => {
    seasons = [season({ id: 'old' }), season({ id: 's1', number: 2, status: 'UPCOMING' })];
    expect(await startSeason('g', 's1')).toBe('another_active');
    expect(seasons.map((s) => s.status)).toEqual(['ACTIVE', 'UPCOMING']);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  test('ne relève rien pour une saison qui n\'est pas à venir', async () => {
    seasons = [season({ status: 'ENDED' })];
    expect(await startSeason('g', 's1')).toBe('not_found');
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe('endSeason', () => {
  test('fige le classement de saison avec l\'XP gagnée, les messages et la voix', async () => {
    seasons = [season()];
    const { client } = fakeClient();
    expect(await endSeason(client, 'g', 's1')).toBe(true);

    const { data } = snapshotCreateMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> };
    expect(data).toEqual([
      { guildId: 'g', seasonId: 's1', userId: 'a', xp: 900, level: 5, rank: 1, messagesCount: 12, voiceMinutes: 30 },
      { guildId: 'g', seasonId: 's1', userId: 'b', xp: 400, level: 12, rank: 2, messagesCount: 0, voiceMinutes: 0 },
    ]);
    expect(baselineDeleteMany.mock.calls[0][0]).toEqual({ where: { seasonId: 's1' } });
    expect(seasons[0].status).toBe('ENDED');
  });

  test('une saison déjà clôturée ne redonne aucune récompense', async () => {
    seasons = [season({ rewards: [{ rank: 1, coins: 100 }] })];
    const { client } = fakeClient();
    expect(await endSeason(client, 'g', 's1')).toBe(true);
    expect(await endSeason(client, 'g', 's1')).toBe(false);
    expect(rpgUpdate).toHaveBeenCalledTimes(1);
    expect(snapshotCreateMany).toHaveBeenCalledTimes(1);
  });

  test('donne rôles et pièces selon le classement de saison', async () => {
    seasons = [season({ rewards: [{ rank: 1, roleId: ROLE, coins: 100 }, { rank: 2, coins: 50 }] })];
    const { client, added } = fakeClient();
    await endSeason(client, 'g', 's1');
    expect(added).toEqual([['a', ROLE]]);
    expect(rpgUpdate.mock.calls.map((call) => call[0])).toEqual([
      { where: { id: 'profil-a' }, data: { balance: { increment: 100 } } },
      { where: { id: 'profil-b' }, data: { balance: { increment: 50 } } },
    ]);
  });

  test('pas de pièces quand le module Économie est éteint, les rôles restent donnés', async () => {
    economyOn = false;
    seasons = [season({ rewards: [{ rank: 1, roleId: ROLE, coins: 100 }] })];
    const { client, added } = fakeClient();
    await endSeason(client, 'g', 's1');
    expect(rpgUpdate).not.toHaveBeenCalled();
    expect(added).toEqual([['a', ROLE]]);
  });

  test('le rôle du premier passe du gagnant précédent au nouveau', async () => {
    seasons = [season({ topRoleId: TOP_ROLE })];
    const { client, added, removed } = fakeClient(['ancien', 'a']);
    await endSeason(client, 'g', 's1');
    expect(removed).toEqual([['ancien', TOP_ROLE]]);
    expect(added).toEqual([['a', TOP_ROLE]]);
  });

  test('passe les récompenses à la clôture du classement RP', async () => {
    seasons = [season({ rewards: [{ rank: 1, roleId: ROLE, coins: 0 }, { rank: 2, coins: 10 }] })];
    await endSeason(fakeClient().client, 'g', 's1');
    expect(closeRanked.mock.calls[0][3]).toEqual([{ rank: 1, roleId: ROLE, coins: 0 }, { rank: 2, roleId: undefined, coins: 10 }]);
  });
});

describe('checkAndProgressSeasons', () => {
  test('clôture la saison échue avant d\'ouvrir la suivante', async () => {
    seasons = [
      season({ id: 'old', endDate: new Date(Date.now() - 1000) }),
      season({ id: 'next', number: 2, status: 'UPCOMING', startDate: new Date(Date.now() - 1000), endDate: new Date(Date.now() + 86_400_000) }),
    ];
    await checkAndProgressSeasons(fakeClient().client);
    expect(seasons.map((s) => [s.id, s.status])).toEqual([['old', 'ENDED'], ['next', 'ACTIVE']]);
  });
});

describe('getSeasonLeaderboard', () => {
  test('saison en cours : classement calculé sur l\'XP gagnée depuis l\'ouverture', async () => {
    seasons = [season()];
    const board = await getSeasonLeaderboard('g', 's1', 10);
    expect(board.map((row) => [row.rank, row.userId, row.xp])).toEqual([[1, 'a', 900], [2, 'b', 400]]);
  });

  test('saison inconnue : classement vide', async () => {
    expect(await getSeasonLeaderboard('g', 'nope', 10)).toEqual([]);
  });
});
