/**
 * Saisons : référence d'XP à l'ouverture, clôture unique, récompenses.
 *
 * Préfixe `zzz-` : ce fichier remplace `moduleGate`, `economyService`,
 * `cache`, `sharding`, `seasonAnnouncements` et `rankedSeasonService` pour tout le
 * process (`mock.module` est global). Il doit charger après leurs propres tests.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client, Guild } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const ROLE = '123456789012345678';
const TOP_ROLE = '223456789012345678';
const BLACKLIST_ROLE = '323456789012345678';
const CHANNEL = '423456789012345678';
/** Placé au-dessus du rôle le plus haut du bot : Discord refusera de le donner. */
const HIGH_ROLE = '523456789012345678';
const DAY_MS = 86_400_000;

type Season = {
  id: string; guildId: string; number: number; name: string; status: string; startDate: Date; endDate: Date;
  rewards: unknown; topRoleId: string | null; announceChannelId: string | null;
  autoRenew: boolean; remindBeforeEnd: boolean; reminderSentAt: Date | null; grantedRewards: unknown; updatedAt: Date;
};

let seasons: Season[] = [];
let standingsRows: Array<{ userId: string; level: number; seasonXp: number }> = [];
/** Rang d'un membre hors classement affiché (requête à `ROW_NUMBER`). */
let memberRankRows: Array<{ rank: number; seasonXp: number }> = [];
/** Premiers des saisons passées qui portaient le même rôle du premier. */
let previousWinners: Array<{ userId: string }> = [];
/** Rangs de saison d'un membre, saison jointe. */
let historyRows: Array<{ rank: number; xp: number; season: { number: number; name: string; endDate: Date } }> = [];

const executeRaw = mock(async (..._args: unknown[]) => 0);
const queryRaw = mock(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
  const sql = strings.join('?');
  if (sql.includes('COUNT(*)')) return [{ participants: standingsRows.length, totalXp: BigInt(standingsRows.reduce((sum, row) => sum + row.seasonXp, 0)) }];
  if (sql.includes('ROW_NUMBER')) return memberRankRows;
  return standingsRows;
});
const snapshotCreateMany = mock(async (..._args: unknown[]) => ({ count: 0 }));
const baselineDeleteMany = mock(async (..._args: unknown[]) => ({ count: 0 }));
const seasonUpdate = mock(async (..._args: unknown[]) => ({}));
const rpgUpdate = mock(async (..._args: unknown[]) => ({}));

function matches(season: Season, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const field = (season as Record<string, unknown>)[key];
    if (value instanceof Date) return field instanceof Date && field.getTime() === value.getTime();
    if (value && typeof value === 'object') {
      const { not, lte, gt } = value as { not?: unknown; lte?: Date; gt?: Date };
      return (not === undefined || field !== not)
        && (lte === undefined || (field as Date) <= lte)
        && (gt === undefined || (field as Date) > gt);
    }
    return field === value;
  });
}

let createdCount = 0;

const db = {
  levelingSeason: {
    // Une copie, comme Prisma : une lecture ne voit pas les écritures qui la suivent.
    findFirst: mock(async ({ where }: { where: Record<string, unknown> }) => {
      const found = seasons.find((s) => matches(s, where));
      return found ? { ...found } : null;
    }),
    findMany: mock(async ({ where }: { where: Record<string, unknown> }) => seasons.filter((s) => matches(s, where))),
    findUnique: mock(async ({ where }: { where: { id: string } }) => seasons.find((s) => s.id === where.id) ?? null),
    create: mock(async ({ data }: { data: Partial<Season> }) => {
      createdCount += 1;
      const created = { ...season({ id: `créée-${createdCount}`, status: 'UPCOMING' }), ...data } as Season;
      seasons.push(created);
      return created;
    }),
    updateMany: mock(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Season> }) => {
      const hit = seasons.filter((s) => matches(s, where));
      // `@updatedAt` : chaque écriture change la version, comme Prisma.
      for (const s of hit) Object.assign(s, data, { updatedAt: new Date(s.updatedAt.getTime() + 1) });
      return { count: hit.length };
    }),
    update: seasonUpdate,
  },
  seasonSnapshot: {
    createMany: snapshotCreateMany,
    findMany: mock(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.rank === 1) return previousWinners;
      if (where.userId) return historyRows;
      return [];
    }),
  },
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
let blacklist = { progressionBlacklistUserIds: [] as string[], progressionBlacklistRoleIds: [] as string[] };
const closeRanked = mock(async (..._args: unknown[]) => null);
const announceStart = mock(async (..._args: unknown[]) => {});
const announceEnd = mock(async (..._args: unknown[]) => {});
const announceReminder = mock(async (..._args: unknown[]) => {});
mockerModule('../../utils/db', { default: db, prisma: db, prismaRead: db });
mockerModule('../../services/core/moduleGate', {
  isModuleEnabled: mock(async (_guildId: string, key: string) => (key === 'economy' ? economyOn : true)),
});
mockerModule('../../services/features/economyService', {
  getOrCreateRpgProfile: mock(async (_guildId: string, userId: string) => ({ id: `profil-${userId}` })),
});
mockerModule('../../services/progression/ranked/rankedSeasonService', { closeRankedSeasonForLevelingSeason: closeRanked });
mockerModule('../../utils/cache', { getCachedGuild: mock(async () => blacklist) });
mockerModule('../../services/progression/seasonAnnouncements', { announceSeasonStart: announceStart, announceSeasonEnd: announceEnd, announceSeasonReminder: announceReminder });
const broadcast = mock((..._args: unknown[]) => {});
mockerModule('../../api/shared/sharding', { broadcastDashboardStateChange: broadcast });

const {
  startSeason,
  endSeason,
  updateSeason,
  checkAndProgressSeasons,
  getSeasonLeaderboard,
  getSeasonsDashboardData,
  retrySeasonRewards,
  getSeasonMemberStanding,
  getMemberSeasonHistory,
} = await import('../../services/progression/seasonService.js');

/** Liste d'exclusion passée à la requête de classement (ou des totaux) : son seul paramètre tableau. */
function excludedInQuery(totals = false): unknown {
  const call = queryRaw.mock.calls.find((args) => (args[0] as unknown as string[]).join('?').includes('COUNT(*)') === totals);
  return call?.slice(1).find(Array.isArray);
}

/**
 * Serveur factice : `holders` portent déjà le rôle du premier (en cache),
 * `blacklisted` le rôle de la liste noire, `lateBlacklisted` aussi mais hors
 * cache jusqu'au chargement de tous les membres, `gone` ont quitté le serveur.
 */
function fakeClient(holders: string[] = [], blacklisted: string[] = [], options: { lateBlacklisted?: string[]; gone?: string[] } = {}) {
  const added: Array<[string, string]> = [];
  const removed: Array<[string, string]> = [];
  const member = (id: string) => ({
    id,
    roles: {
      cache: { has: () => true },
      add: mock(async (roleId: string) => { added.push([id, roleId]); }),
      remove: mock(async (roleId: string) => { removed.push([id, roleId]); }),
    },
  });
  const role = (id: string, position: number, members: string[] = []) => ({ id, position, managed: false, members: new Map(members.map((memberId) => [memberId, member(memberId)])) });
  const blacklistRole = role(BLACKLIST_ROLE, 3, blacklisted);
  const guild = {
    id: 'g',
    members: {
      me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } },
      fetch: mock(async (id?: string) => {
        if (id === undefined) {
          for (const late of options.lateBlacklisted ?? []) blacklistRole.members.set(late, member(late));
          return new Map();
        }
        if (options.gone?.includes(id)) throw new Error('Unknown Member');
        return member(id);
      }),
    },
    roles: {
      cache: new Map([
        [ROLE, role(ROLE, 1)],
        [TOP_ROLE, role(TOP_ROLE, 2, holders)],
        [BLACKLIST_ROLE, blacklistRole],
        [HIGH_ROLE, role(HIGH_ROLE, 20)],
      ]),
    },
  };
  const client = { guilds: { cache: new Map([['g', guild]]), fetch: mock(async () => guild) } } as unknown as Client;
  return { client, added, removed };
}

/** Serveur seul, tel que le reçoivent les lectures du classement en cours. */
function fakeGuild(blacklisted: string[] = []): Guild {
  return fakeClient([], blacklisted).client.guilds.cache.get('g') as unknown as Guild;
}

function season(overrides: Partial<Season> = {}): Season {
  return {
    id: 's1',
    guildId: 'g',
    number: 1,
    name: 'Hiver',
    status: 'ACTIVE',
    startDate: new Date('2026-11-01T00:00:00Z'),
    endDate: new Date('2026-12-01T00:00:00Z'),
    rewards: [],
    topRoleId: null,
    announceChannelId: null,
    autoRenew: false,
    remindBeforeEnd: false,
    reminderSentAt: null,
    grantedRewards: null,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  seasons = [];
  standingsRows = [
    { userId: 'a', level: 5, seasonXp: 900 },
    { userId: 'b', level: 12, seasonXp: 400 },
  ];
  memberRankRows = [];
  previousWinners = [];
  historyRows = [];
  economyOn = true;
  blacklist = { progressionBlacklistUserIds: [], progressionBlacklistRoleIds: [] };
  for (const fn of [executeRaw, queryRaw, snapshotCreateMany, baselineDeleteMany, seasonUpdate, rpgUpdate, closeRanked, announceStart, announceEnd, announceReminder, broadcast]) fn.mockClear();
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

  test('annonce l\'ouverture avec les récompenses quand un client est fourni', async () => {
    seasons = [season({ status: 'UPCOMING', announceChannelId: CHANNEL, rewards: [{ rank: 1, coins: 10 }], topRoleId: TOP_ROLE })];
    const { client } = fakeClient();
    await startSeason('g', 's1', client);
    expect(announceStart).toHaveBeenCalledTimes(1);
    expect(announceStart.mock.calls[0].slice(2)).toEqual([[{ rank: 1, roleId: null, coins: 10 }], TOP_ROLE]);
  });

  test('prévient la page Saisons en direct', async () => {
    seasons = [season({ status: 'UPCOMING' })];
    await startSeason('g', 's1');
    expect(broadcast.mock.calls).toEqual([['g', 'seasons_updated']]);
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

  test('ne prévient la page qu\'une fois, à la vraie clôture', async () => {
    seasons = [season()];
    const { client } = fakeClient();
    await endSeason(client, 'g', 's1');
    await endSeason(client, 'g', 's1');
    expect(broadcast).toHaveBeenCalledTimes(1);
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

  test('clôt le classement RP sans lui redonner les récompenses de la saison', async () => {
    seasons = [season({ rewards: [{ rank: 1, roleId: ROLE, coins: 0 }] })];
    await endSeason(fakeClient().client, 'g', 's1');
    expect(closeRanked).toHaveBeenCalledTimes(1);
    expect(closeRanked.mock.calls[0][3]).toBeUndefined();
  });

  test('écarte du classement les membres et les porteurs de rôle de la liste noire', async () => {
    blacklist = { progressionBlacklistUserIds: ['listé'], progressionBlacklistRoleIds: [BLACKLIST_ROLE] };
    seasons = [season()];
    await endSeason(fakeClient([], ['porteur']).client, 'g', 's1');
    expect(excludedInQuery()).toEqual(['listé', 'porteur']);
  });

  test('annonce la clôture avec le classement et les récompenses données', async () => {
    seasons = [season({ announceChannelId: CHANNEL, rewards: [{ rank: 1, coins: 100 }] })];
    await endSeason(fakeClient().client, 'g', 's1');
    const [, announced, standings, plan] = announceEnd.mock.calls[0] as [unknown, Season, Array<{ userId: string }>, unknown];
    expect(announced.id).toBe('s1');
    expect(standings.map((entry) => entry.userId)).toEqual(['a', 'b']);
    expect(plan).toEqual([{ userId: 'a', rank: 1, roleId: null, coins: 100 }]);
  });
});

/** Trace des récompenses enregistrée après la clôture. */
function recordedOutcomes(): unknown {
  const call = seasonUpdate.mock.calls.find((args) => (args[0] as { data: Record<string, unknown> }).data.grantedRewards !== undefined);
  return (call?.[0] as { data: { grantedRewards: unknown } } | undefined)?.data.grantedRewards;
}

describe('endSeason : trace des récompenses', () => {
  test('enregistre ce que chacun a réellement reçu', async () => {
    seasons = [season({ rewards: [{ rank: 1, roleId: ROLE, coins: 100 }, { rank: 2, coins: 50 }] })];
    await endSeason(fakeClient().client, 'g', 's1');
    expect(recordedOutcomes()).toEqual([
      { userId: 'a', rank: 1, roleId: ROLE, coins: 100, roleStatus: 'given', coinsStatus: 'given' },
      { userId: 'b', rank: 2, roleId: null, coins: 50, roleStatus: null, coinsStatus: 'given' },
    ]);
  });

  test('un rôle au-dessus du bot n\'est pas tenté et reste à reprendre', async () => {
    seasons = [season({ rewards: [{ rank: 1, roleId: HIGH_ROLE, coins: 0 }] })];
    const { client, added } = fakeClient();
    await endSeason(client, 'g', 's1');
    expect(added).toEqual([]);
    expect(recordedOutcomes()).toEqual([{ userId: 'a', rank: 1, roleId: HIGH_ROLE, coins: 0, roleStatus: 'blocked', coinsStatus: null }]);
  });

  test('membre parti et Économie éteinte sont distingués', async () => {
    economyOn = false;
    seasons = [season({ rewards: [{ rank: 1, roleId: ROLE, coins: 100 }] })];
    await endSeason(fakeClient([], [], { gone: ['a'] }).client, 'g', 's1');
    expect(recordedOutcomes()).toEqual([{ userId: 'a', rank: 1, roleId: ROLE, coins: 100, roleStatus: 'member_left', coinsStatus: 'economy_off' }]);
  });

  test('le rôle du premier est repris aux gagnants passés, même hors cache', async () => {
    previousWinners = [{ userId: 'ancien' }, { userId: 'a' }];
    seasons = [season({ topRoleId: TOP_ROLE })];
    const { client, removed } = fakeClient();
    await endSeason(client, 'g', 's1');
    expect(removed).toEqual([['ancien', TOP_ROLE]]);
  });

  test('charge tous les membres pour écarter les porteurs de rôle de la liste noire hors cache', async () => {
    blacklist = { progressionBlacklistUserIds: [], progressionBlacklistRoleIds: [BLACKLIST_ROLE] };
    seasons = [season()];
    await endSeason(fakeClient([], ['porteur'], { lateBlacklisted: ['tardif'] }).client, 'g', 's1');
    expect(excludedInQuery()).toEqual(['porteur', 'tardif']);
  });
});

describe('endSeason : enchaînement', () => {
  test('ouvre une saison de même durée prévue, mêmes réglages', async () => {
    const start = new Date(Date.now() - 10 * DAY_MS);
    seasons = [season({ autoRenew: true, remindBeforeEnd: true, announceChannelId: CHANNEL, topRoleId: TOP_ROLE, startDate: start, endDate: new Date(start.getTime() + 30 * DAY_MS), rewards: [{ rank: 1, coins: 5 }] })];
    await endSeason(fakeClient().client, 'g', 's1');

    const next = seasons.find((s) => s.id !== 's1');
    expect(next).toMatchObject({ number: 2, name: 'Hiver', status: 'ACTIVE', autoRenew: true, remindBeforeEnd: true, announceChannelId: CHANNEL, topRoleId: TOP_ROLE, rewards: [{ rank: 1, roleId: null, coins: 5 }] });
    expect(Math.round((next!.endDate.getTime() - next!.startDate.getTime()) / DAY_MS)).toBe(30);
  });

  test('rien quand une saison est déjà prévue : elle prend la suite', async () => {
    seasons = [season({ autoRenew: true }), season({ id: 'prévue', number: 2, status: 'UPCOMING', startDate: new Date(Date.now() + DAY_MS) })];
    await endSeason(fakeClient().client, 'g', 's1');
    expect(seasons.map((s) => s.id)).toEqual(['s1', 'prévue']);
  });

  test('rien sans enchaînement demandé', async () => {
    seasons = [season()];
    await endSeason(fakeClient().client, 'g', 's1');
    expect(seasons).toHaveLength(1);
  });
});

describe('retrySeasonRewards', () => {
  const blocked = { userId: 'a', rank: 1, roleId: ROLE, coins: 0, roleStatus: 'blocked', coinsStatus: null };
  const noCoins = { userId: 'b', rank: 2, roleId: null, coins: 50, roleStatus: null, coinsStatus: 'economy_off' };
  const done = { userId: 'c', rank: 3, roleId: null, coins: 10, roleStatus: null, coinsStatus: 'given' };

  test('reprend seulement ce qui manque et met la trace à jour', async () => {
    seasons = [season({ status: 'ENDED', grantedRewards: [blocked, noCoins, done] })];
    const { client, added } = fakeClient();
    expect(await retrySeasonRewards(client, 'g', 's1')).toEqual({ retried: 2, remaining: 0 });
    expect(added).toEqual([['a', ROLE]]);
    expect(rpgUpdate.mock.calls.map((call) => call[0])).toEqual([{ where: { id: 'profil-b' }, data: { balance: { increment: 50 } } }]);
    expect(recordedOutcomes()).toEqual([{ ...blocked, roleStatus: 'given' }, { ...noCoins, coinsStatus: 'given' }, done]);
  });

  test('ce qui échoue encore reste à reprendre', async () => {
    economyOn = false;
    seasons = [season({ status: 'ENDED', grantedRewards: [noCoins] })];
    expect(await retrySeasonRewards(fakeClient().client, 'g', 's1')).toEqual({ retried: 1, remaining: 1 });
  });

  test('saison en cours ou inconnue : rien', async () => {
    seasons = [season({ grantedRewards: [blocked] })];
    expect(await retrySeasonRewards(fakeClient().client, 'g', 's1')).toBe('not_found');
  });

  test('deux reprises simultanées ne donnent qu\'une fois', async () => {
    seasons = [season({ status: 'ENDED', grantedRewards: [noCoins] })];
    const { client } = fakeClient();
    const results = await Promise.all([retrySeasonRewards(client, 'g', 's1'), retrySeasonRewards(client, 'g', 's1')]);
    expect(results).toContain('busy');
    expect(rpgUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('rappel avant la fin', () => {
  test('part une seule fois dans les dernières 24 h', async () => {
    seasons = [season({ remindBeforeEnd: true, announceChannelId: CHANNEL, startDate: new Date(Date.now() - 10 * DAY_MS), endDate: new Date(Date.now() + DAY_MS / 2) })];
    const { client } = fakeClient();
    await checkAndProgressSeasons(client);
    await checkAndProgressSeasons(client);
    expect(announceReminder).toHaveBeenCalledTimes(1);
    const [, announced, standings] = announceReminder.mock.calls[0] as [unknown, Season, Array<{ userId: string }>];
    expect(announced.id).toBe('s1');
    expect(standings.map((entry) => entry.userId)).toEqual(['a', 'b']);
  });

  test('pas avant les dernières 24 h, ni sans rappel demandé', async () => {
    seasons = [
      season({ id: 'tôt', remindBeforeEnd: true, startDate: new Date(Date.now() - 10 * DAY_MS), endDate: new Date(Date.now() + 3 * DAY_MS) }),
      season({ id: 'sans', guildId: 'h', startDate: new Date(Date.now() - 10 * DAY_MS), endDate: new Date(Date.now() + DAY_MS / 2) }),
    ];
    await checkAndProgressSeasons(fakeClient().client);
    expect(announceReminder).not.toHaveBeenCalled();
  });
});

describe('getSeasonMemberStanding', () => {
  test('saison en cours : rang et XP gagnée du membre', async () => {
    seasons = [season()];
    memberRankRows = [{ rank: 14, seasonXp: 120 }];
    expect(await getSeasonMemberStanding('g', 's1', 'z', null)).toEqual({ rank: 14, xp: 120 });
  });

  test('membre sans XP de saison : pas classé', async () => {
    seasons = [season()];
    expect(await getSeasonMemberStanding('g', 's1', 'z', null)).toBeNull();
  });

  test('membre de la liste noire : pas classé', async () => {
    blacklist = { progressionBlacklistUserIds: ['z'], progressionBlacklistRoleIds: [] };
    seasons = [season()];
    memberRankRows = [{ rank: 14, seasonXp: 120 }];
    expect(await getSeasonMemberStanding('g', 's1', 'z', null)).toBeNull();
  });
});

describe('getMemberSeasonHistory', () => {
  test('rend les saisons classées du membre, de la plus récente à la plus ancienne', async () => {
    const endDate = new Date('2026-10-01T00:00:00Z');
    historyRows = [{ rank: 2, xp: 900, season: { number: 3, name: 'Automne', endDate } }];
    expect(await getMemberSeasonHistory('g', 'a')).toEqual([{ number: 3, name: 'Automne', endDate, rank: 2, xp: 900 }]);
  });
});

describe('updateSeason', () => {
  test('un champ absent garde sa valeur', async () => {
    seasons = [season({ status: 'UPCOMING', startDate: new Date(Date.now() + 86_400_000), endDate: new Date(Date.now() + 10 * 86_400_000), topRoleId: TOP_ROLE, announceChannelId: CHANNEL, rewards: [{ rank: 1, coins: 5 }] })];
    expect(await updateSeason('g', 's1', { name: 'Printemps' }, null)).toBe('updated');
    expect(seasons[0]).toMatchObject({ name: 'Printemps', topRoleId: TOP_ROLE, announceChannelId: CHANNEL, rewards: [{ rank: 1, roleId: null, coins: 5 }] });
  });

  test('null retire le salon d\'annonce', async () => {
    seasons = [season({ announceChannelId: CHANNEL, startDate: new Date(Date.now() - 86_400_000), endDate: new Date(Date.now() + 86_400_000) })];
    expect(await updateSeason('g', 's1', { announceChannelId: null }, null)).toBe('updated');
    expect(seasons[0].announceChannelId).toBeNull();
  });

  test('une nouvelle date de fin réarme le rappel', async () => {
    const end = new Date(Date.now() + 5 * DAY_MS);
    seasons = [season({ startDate: new Date(Date.now() - DAY_MS), endDate: end, reminderSentAt: new Date() })];
    expect(await updateSeason('g', 's1', { endDate: new Date(end.getTime() + DAY_MS).toISOString() }, null)).toBe('updated');
    expect(seasons[0].reminderSentAt).toBeNull();
  });

  test('la même date de fin garde le rappel envoyé', async () => {
    const sent = new Date();
    seasons = [season({ startDate: new Date(Date.now() - DAY_MS), endDate: new Date(Date.now() + 5 * DAY_MS), reminderSentAt: sent })];
    expect(await updateSeason('g', 's1', { name: 'Printemps' }, null)).toBe('updated');
    expect(seasons[0].reminderSentAt).toBe(sent);
  });

  test('enchaînement et rappel se règlent', async () => {
    seasons = [season({ startDate: new Date(Date.now() - DAY_MS), endDate: new Date(Date.now() + 5 * DAY_MS) })];
    expect(await updateSeason('g', 's1', { autoRenew: true, remindBeforeEnd: true }, null)).toBe('updated');
    expect(seasons[0]).toMatchObject({ autoRenew: true, remindBeforeEnd: true });
  });

  test('refuse une saison terminée', async () => {
    seasons = [season({ status: 'ENDED' })];
    expect(await updateSeason('g', 's1', { name: 'Printemps' }, null)).toBe('not_found');
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
  test('saison en cours sans serveur sous la main : seuls les membres listés un à un sont écartés', async () => {
    blacklist = { progressionBlacklistUserIds: ['listé'], progressionBlacklistRoleIds: [BLACKLIST_ROLE] };
    seasons = [season()];
    await getSeasonLeaderboard('g', 's1', 10, null);
    expect(excludedInQuery()).toEqual(['listé']);
  });

  test('saison en cours : les porteurs de rôle de la liste noire sont écartés, comme à la clôture', async () => {
    blacklist = { progressionBlacklistUserIds: ['listé'], progressionBlacklistRoleIds: [BLACKLIST_ROLE] };
    seasons = [season()];
    await getSeasonLeaderboard('g', 's1', 10, fakeGuild(['porteur']));
    expect(excludedInQuery()).toEqual(['listé', 'porteur']);
  });

  test('saison en cours : classement calculé sur l\'XP gagnée depuis l\'ouverture', async () => {
    seasons = [season()];
    const board = await getSeasonLeaderboard('g', 's1', 10, null);
    expect(board.map((row) => [row.rank, row.userId, row.xp])).toEqual([[1, 'a', 900], [2, 'b', 400]]);
  });

  test('saison inconnue : classement vide', async () => {
    expect(await getSeasonLeaderboard('g', 'nope', 10, null)).toEqual([]);
  });
});

describe('getSeasonsDashboardData', () => {
  test('classement et totaux écartent les porteurs de rôle de la liste noire', async () => {
    blacklist = { progressionBlacklistUserIds: [], progressionBlacklistRoleIds: [BLACKLIST_ROLE] };
    seasons = [season()];
    await getSeasonsDashboardData('g', fakeGuild(['porteur']));
    expect(excludedInQuery()).toEqual(['porteur']);
    expect(excludedInQuery(true)).toEqual(['porteur']);
  });
});
