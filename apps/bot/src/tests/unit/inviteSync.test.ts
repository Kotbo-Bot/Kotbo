import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Guild } from 'discord.js';

type StoredInvite = {
  code: string;
  uses: number;
  maxUses: number | null;
  expiresAt: Date | null;
  inviterId: string | null;
  inviterTag: string | null;
  isTemporary: boolean;
  isDeleted: boolean;
  sourceLabel?: string | null;
};

let storedInvites: StoredInvite[] = [];
const findMany = mock(async (_args: unknown) => storedInvites);
const createMany = mock(async (_args: { data: unknown[] }) => ({ count: 0 }));
const update = mock((args: unknown) => args);
const transaction = mock(async (ops: unknown[]) => ops);
const mockDb = {
  guildInvite: { findMany, createMany, update },
  $transaction: transaction,
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const { syncGuildInvites } = await import('../../services/analytics/inviteService.js');

function discordInvite(code: string, uses: number, inviter: { id: string; username: string; bot?: boolean } = { id: 'u1', username: 'membre' }) {
  return {
    code,
    uses,
    maxUses: 0,
    expiresAt: null,
    inviter: { tag: inviter.username, bot: false, ...inviter },
    temporary: false,
  };
}

const DISBOARD = { id: '302050872383242240', username: 'DISBOARD', bot: true };

function stored(code: string, uses: number): StoredInvite {
  return {
    code,
    uses,
    maxUses: 0,
    expiresAt: null,
    inviterId: 'u1',
    inviterTag: 'membre',
    isTemporary: false,
    isDeleted: false,
  };
}

let fetchCalls = 0;
function fakeGuild(id: string, invites: ReturnType<typeof discordInvite>[]) {
  return {
    id,
    client: { user: { id: 'kotbo' } },
    invites: {
      fetch: async () => {
        fetchCalls += 1;
        return new Map(invites.map((invite) => [invite.code, invite]));
      },
    },
  } as unknown as Guild;
}

describe('syncGuildInvites', () => {
  beforeEach(() => {
    findMany.mockClear();
    createMany.mockClear();
    update.mockClear();
    transaction.mockClear();
    fetchCalls = 0;
  });

  test("n'ecrit rien quand aucune invitation n'a change", async () => {
    storedInvites = [stored('a', 3), stored('b', 0)];
    await syncGuildInvites(fakeGuild('g1', [discordInvite('a', 3), discordInvite('b', 0)]));

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("cree les nouvelles et ne met a jour que celles qui ont bouge", async () => {
    storedInvites = [stored('a', 3), stored('b', 0)];
    await syncGuildInvites(fakeGuild('g2', [
      discordInvite('a', 5),
      discordInvite('b', 0),
      discordInvite('c', 0),
    ]));

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ guildId: 'g2', code: 'c', uses: 0 }),
    ]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toEqual({
      where: { code: 'a' },
      data: expect.objectContaining({ uses: 5 }),
    });
  });

  test('saute la synchronisation si la derniere est assez recente', async () => {
    storedInvites = [];
    const guild = fakeGuild('g3', [discordInvite('a', 0)]);
    await syncGuildInvites(guild, { maxAgeMs: 60_000 });
    await syncGuildInvites(guild, { maxAgeMs: 60_000 });

    expect(fetchCalls).toBe(1);
  });

  test("etiquette les invitations creees par un autre bot, jamais celles de Kotbo", async () => {
    storedInvites = [];
    await syncGuildInvites(fakeGuild('g4', [
      discordInvite('d', 0, DISBOARD),
      discordInvite('k', 0, { id: 'kotbo', username: 'Kotbo', bot: true }),
      discordInvite('m', 0),
    ]));

    const created = createMany.mock.calls[0][0].data as Array<{ code: string; sourceLabel: string | null }>;
    expect(created.map((row) => [row.code, row.sourceLabel])).toEqual([
      ['d', 'Bot-DISBOARD'],
      ['k', null],
      ['m', null],
    ]);
  });

  test("etiquette une invitation de bot deja connue sans provenance, garde une provenance nommee", async () => {
    storedInvites = [
      { ...stored('d', 0), inviterId: DISBOARD.id, inviterTag: 'DISBOARD', sourceLabel: null },
      { ...stored('e', 0), inviterId: DISBOARD.id, inviterTag: 'DISBOARD', sourceLabel: 'Bump' },
    ];
    await syncGuildInvites(fakeGuild('g5', [
      discordInvite('d', 0, DISBOARD),
      discordInvite('e', 0, DISBOARD),
    ]));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toEqual({
      where: { code: 'd' },
      data: expect.objectContaining({ sourceLabel: 'Bot-DISBOARD' }),
    });
  });
});
