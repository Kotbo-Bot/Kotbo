import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Guild } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

interface ConfessionRow { id: string; guildId: string; authorId: string; number: number; content: string; channelId: string; messageId: string | null; createdAt: Date }

let rows: ConfessionRow[] = [];
let nextId = 0;

/** Laisse les autres envois avancer entre deux requêtes, comme le ferait la base. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

function matches(row: ConfessionRow, where: Partial<ConfessionRow>): boolean {
  return Object.entries(where).every(([key, value]) => row[key as keyof ConfessionRow] === value);
}

const confession = {
  findFirst: mock(async ({ where, orderBy }: any) => {
    await tick();
    const [field] = Object.keys(orderBy) as Array<'number' | 'createdAt'>;
    const found = rows.filter((row) => matches(row, where))
      .sort((a, b) => Number(b[field]) - Number(a[field]))[0];
    return found ?? null;
  }),
  create: mock(async ({ data }: any) => {
    await tick();
    if (rows.some((row) => row.guildId === data.guildId && row.number === data.number)) {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
    const row = { id: `c${++nextId}`, messageId: null, createdAt: new Date(), ...data };
    rows.push(row);
    return row;
  }),
  update: mock(async ({ where, data }: any) => {
    const row = rows.find((entry) => entry.id === where.id)!;
    Object.assign(row, data);
    return row;
  }),
  delete: mock(async ({ where }: any) => {
    rows = rows.filter((entry) => entry.id !== where.id);
    return {};
  }),
};

/** Verrous consultatifs : un second preneur de la même clé attend la fin de la transaction du premier. */
const advisoryLocks = new Map<string, Promise<void>>();

const prismaMock = {
  confession,
  $transaction: mock(async (run: (tx: unknown) => Promise<unknown>) => {
    const releases: Array<() => void> = [];
    const tx = {
      confession,
      $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
        const key = values.join(':');
        const previous = advisoryLocks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        advisoryLocks.set(key, previous.then(() => held));
        await previous;
        releases.push(release);
        return [];
      },
    };
    try {
      return await run(tx);
    } finally {
      for (const release of releases) release();
    }
  }),
};

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({
    default: prismaMock,
    prisma: prismaMock,
    prismaRead: prismaMock,
  }));
  mock.module(path.resolve(import.meta.dir, `../../utils/cache.${extension}`), () => completeModuleMock(
    path.resolve(import.meta.dir, '../../utils/cache.ts'),
    { cache: { invalidateGuild: async () => undefined } },
  ));
  mock.module(path.resolve(import.meta.dir, `../../services/moderation/bannedWordsService.${extension}`), () => completeModuleMock(
    path.resolve(import.meta.dir, '../../services/moderation/bannedWordsService.ts'),
    { loadBannedWords: async () => [], containsBannedWord: () => false },
  ));
}

const { submitConfession } = await import('../../services/features/confessionService.js');

function fakeGuild(send: () => Promise<{ id: string }> = async () => ({ id: `m${++nextId}` })) {
  const channel = { send: mock(send) };
  return {
    id: 'guild-1',
    channels: { fetch: mock(async () => channel) },
  } as unknown as Guild;
}

const CONFIG = { channelId: 'confessions', logChannelId: null, cooldownSeconds: 60 };

describe('submitConfession', () => {
  beforeEach(() => {
    rows = [];
    advisoryLocks.clear();
  });

  test('deux envois simultanés du même membre : le délai n’en laisse passer qu’un', async () => {
    const guild = fakeGuild();

    const results = await Promise.all([
      submitConfession(guild, CONFIG, 'membre-1', 'premier'),
      submitConfession(guild, CONFIG, 'membre-1', 'second'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(rows).toHaveLength(1);
  });

  test('deux membres en même temps : chacun publie, avec des numéros distincts', async () => {
    const guild = fakeGuild();

    const results = await Promise.all([
      submitConfession(guild, CONFIG, 'membre-1', 'un'),
      submitConfession(guild, CONFIG, 'membre-2', 'deux'),
    ]);

    expect(results.map((result) => (result.ok ? result.number : null)).sort()).toEqual([1, 2]);
  });

  test('un envoi raté ne compte pas dans le délai', async () => {
    const failing = fakeGuild(async () => { throw new Error('Missing Permissions'); });
    expect(await submitConfession(failing, CONFIG, 'membre-1', 'perdu')).toMatchObject({ ok: false, reason: 'send_failed' });
    expect(rows).toHaveLength(0);

    expect(await submitConfession(fakeGuild(), CONFIG, 'membre-1', 'retente')).toMatchObject({ ok: true, number: 1 });
  });
});
