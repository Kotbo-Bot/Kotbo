// En mode AUTO, l'alerte d'un split ou d'un archivage naît APPLIED : l'analyse
// suivante ne doit ni rejouer l'action ni réarchiver le salon.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import path from 'node:path';
import { ChannelType, Collection, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '987654321098765432';
const GENERAL_CATEGORY_ID = '100000000000000001';
const ARCHIVE_CATEGORY_ID = '100000000000000002';
const DEAD_CHANNEL_ID = '200000000000000001';
const BUSY_CHANNEL_ID = '200000000000000002';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-20T03:00:00.000Z').getTime();

type ConfigRow = Record<string, unknown> & { guildId: string; analysisPeriodDays: number; archiveCategoryId: string | null };
type StatRow = { guildId: string; channelId: string; dateKey: string; messagesCount: number; uniqueAuthors: number };
type AlertRow = Record<string, unknown> & { id: string; createdAt: Date };

let config: ConfigRow;
let stats: StatRow[] = [];
let alerts: AlertRow[] = [];

function compare(field: unknown, op: string, bound: unknown): boolean {
  if (field === null || field === undefined) return false;
  const a = field instanceof Date ? field.getTime() : (field as number | string);
  const b = bound instanceof Date ? bound.getTime() : (bound as number | string);
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b;
}

/** Sous-ensemble du filtre Prisma dont se sert l'analyse. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Record<string, unknown>[]).some((clause) => matches(row, clause));
    const field = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([op, bound]) => {
        if (op === 'in') return (bound as unknown[]).includes(field);
        if (op === 'not') return field !== bound;
        return compare(field, op, bound);
      });
    }
    return field === condition;
  });
}

const prismaMock = {
  channelHealthConfig: {
    findMany: mock(async () => (config.enabled ? [{ guildId: config.guildId }] : [])),
    findUnique: mock(async () => ({ ...config })),
  },
  channelDailyStat: {
    findMany: mock(async ({ where }: { where: Record<string, unknown> }) =>
      stats.filter((row) => matches(row, where)).sort((a, b) => a.dateKey.localeCompare(b.dateKey))),
  },
  guildHourlyStat: { findMany: mock(async () => []) },
  channelHealthAlert: {
    findFirst: mock(async ({ where }: { where: Record<string, unknown> }) =>
      alerts.find((row) => matches(row, where)) ?? null),
    create: mock(async ({ data }: { data: Record<string, unknown> }) => {
      const row: AlertRow = { id: `alerte-${alerts.length + 1}`, createdAt: new Date(), ...data };
      alerts.push(row);
      return row;
    }),
  },
  guild: { findUnique: mock(async () => ({ id: GUILD_ID, timezone: 'UTC' })) },
};

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock });
mockerModule('../../services/core/moduleGate', { isModuleEnabled: mock(async () => true) });

const { analyzeGuildChannelHealth, runChannelHealthAnalysis } = await import('../../services/analytics/channelHealthService.js');

type FakeTextChannel = {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  parent: unknown;
  permissionOverwrites: { cache: Collection<string, unknown>; edit: ReturnType<typeof mock> };
  setParent: ReturnType<typeof mock>;
  send: ReturnType<typeof mock>;
};

let channels: Collection<string, unknown>;
let deadChannel: FakeTextChannel;
let busyChannel: FakeTextChannel;
let createdChannels: Array<Record<string, unknown>> = [];

function textChannel(id: string, name: string, parentId: string): FakeTextChannel {
  const channel: FakeTextChannel = {
    id,
    name,
    type: ChannelType.GuildText,
    parentId,
    parent: null,
    permissionOverwrites: { cache: new Collection(), edit: mock(async () => undefined) },
    setParent: mock(async (categoryId: string) => {
      channel.parentId = categoryId;
      return channel;
    }),
    send: mock(async () => ({})),
  };
  return channel;
}

const guild = {
  id: GUILD_ID,
  roles: { everyone: { id: GUILD_ID } },
  channels: {
    get cache() {
      return channels;
    },
    create: mock(async (options: Record<string, unknown>) => {
      createdChannels.push(options);
      const created = textChannel(`300000000000000${createdChannels.length}`, String(options.name), GENERAL_CATEGORY_ID);
      channels.set(created.id, created);
      return created;
    }),
  },
};

const client = { guilds: { cache: new Collection([[GUILD_ID, guild]]) } } as unknown as Client;

function dateKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Sept jours de statistiques pour un salon, la veille de T0 comprise. */
function week(channelId: string, messagesCount: number, uniqueAuthors: number): StatRow[] {
  return Array.from({ length: 7 }, (_, index) => ({
    guildId: GUILD_ID,
    channelId,
    dateKey: dateKey(T0 - (7 - index) * DAY_MS),
    messagesCount,
    uniqueAuthors,
  }));
}

/** Une ligne de statistiques par jour jusqu'à la veille de T0 : [messages, auteurs uniques]. */
function days(channelId: string, perDay: Array<[number, number]>): StatRow[] {
  return perDay.map(([messagesCount, uniqueAuthors], index) => ({
    guildId: GUILD_ID,
    channelId,
    dateKey: dateKey(T0 - (perDay.length - index) * DAY_MS),
    messagesCount,
    uniqueAuthors,
  }));
}

beforeEach(() => {
  setSystemTime(new Date(T0));
  config = {
    guildId: GUILD_ID,
    enabled: true,
    alertChannelId: null,
    splitMode: 'AUTO',
    archiveMode: 'AUTO',
    analysisPeriodDays: 14,
    overloadMsgPerHour: 120,
    overloadUniqueUsers: 20,
    underusedMsgPerDay: 5,
    underusedUniqueUsers: 3,
    deadMsgPerWeek: 2,
    excludedChannelIds: [],
    archiveCategoryId: ARCHIVE_CATEGORY_ID,
    splitNameTemplate: '{name}-{number}',
  };
  alerts = [];
  createdChannels = [];
  guild.channels.create.mockClear();
  deadChannel = textChannel(DEAD_CHANNEL_ID, 'vieux-salon', GENERAL_CATEGORY_ID);
  busyChannel = textChannel(BUSY_CHANNEL_ID, 'discussion', GENERAL_CATEGORY_ID);
  channels = new Collection<string, unknown>([
    [GENERAL_CATEGORY_ID, { id: GENERAL_CATEGORY_ID, name: 'Général', type: ChannelType.GuildCategory }],
    [ARCHIVE_CATEGORY_ID, { id: ARCHIVE_CATEGORY_ID, name: '📦 Archives', type: ChannelType.GuildCategory }],
    [DEAD_CHANNEL_ID, deadChannel],
    [BUSY_CHANNEL_ID, busyChannel],
  ]);
  stats = [];
});

afterEach(() => {
  setSystemTime();
});

describe('analyse nocturne en mode AUTO : une action par salon, pas une par nuit', () => {
  test('un salon mort archivé une nuit n\'est ni ré-archivé ni ré-annoncé la nuit suivante', async () => {
    stats = week(DEAD_CHANNEL_ID, 0, 0);

    await runChannelHealthAnalysis(client);
    expect(deadChannel.parentId).toBe(ARCHIVE_CATEGORY_ID);
    expect(deadChannel.send).toHaveBeenCalledTimes(1);

    setSystemTime(new Date(T0 + DAY_MS));
    await runChannelHealthAnalysis(client);

    expect(deadChannel.send).toHaveBeenCalledTimes(1);
    expect(alerts.filter((alert) => alert.channelId === DEAD_CHANNEL_ID)).toHaveLength(1);
  });

  test('un salon rangé dans la catégorie d\'archivage n\'est plus analysé', async () => {
    deadChannel.parentId = ARCHIVE_CATEGORY_ID;
    stats = [...week(DEAD_CHANNEL_ID, 0, 0), ...week(BUSY_CHANNEL_ID, 2_400, 30)];

    const summary = await analyzeGuildChannelHealth(client, GUILD_ID);

    expect(summary?.channels.map((report) => report.channelId)).toEqual([BUSY_CHANNEL_ID]);
    expect(summary?.dead).toHaveLength(0);
  });

  test('un salon surchargé splitté une nuit n\'est pas re-splitté la nuit suivante', async () => {
    stats = week(BUSY_CHANNEL_ID, 2_400, 30);

    await runChannelHealthAnalysis(client);
    expect(createdChannels).toHaveLength(1);
    expect(createdChannels[0].name).toBe('discussion-2');

    setSystemTime(new Date(T0 + DAY_MS));
    await runChannelHealthAnalysis(client);

    expect(createdChannels).toHaveLength(1);
    expect(alerts.filter((alert) => alert.channelId === BUSY_CHANNEL_ID)).toHaveLength(1);
  });

  test('passé une période d\'analyse, un split appliqué ne bloque plus un nouveau split', async () => {
    stats = week(BUSY_CHANNEL_ID, 2_400, 30);
    alerts = [{
      id: 'alerte-ancienne',
      guildId: GUILD_ID,
      channelId: BUSY_CHANNEL_ID,
      type: 'SPLIT_AUTO',
      status: 'APPLIED',
      createdAt: new Date(T0 - 15 * DAY_MS),
    }];

    await runChannelHealthAnalysis(client);

    expect(createdChannels).toHaveLength(1);
  });
});

describe('moyenne journalière d\'auteurs uniques', () => {
  test('deux jours au même nombre d\'auteurs comptent chacun dans la moyenne', async () => {
    // 12, 12 puis 6 auteurs, le jour sans message n'étant pas compté : 10 par jour, et non 9
    // sur les seules valeurs distinctes. C'est cette moyenne qui décide d'un split automatique.
    stats = days(BUSY_CHANNEL_ID, [[2_400, 12], [0, 0], [2_400, 12], [2_400, 6]]);
    config.overloadUniqueUsers = 10;

    const summary = await analyzeGuildChannelHealth(client, GUILD_ID);

    expect(summary?.channels[0]).toMatchObject({ uniqueUsersAvg: 10, status: 'OVERLOADED' });
  });
});
