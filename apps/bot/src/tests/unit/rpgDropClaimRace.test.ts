import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client, Interaction } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '987654321098765432';
const DROP_ID = 'drop-rpg-1';
const AMOUNT = 250;

type DropRow = { id: string; guildId: string; type: string; amount: number; claimed: boolean; claimedBy: string | null };
type ProfileRow = { id: string; guildId: string; userId: string; balance: number; xp: number };

let drop: DropRow;
let profiles: ProfileRow[] = [];

const tx = {
  rpgDrop: {
    // La lecture voit l'état au moment où elle est lancée, et les deux clics lisent avant d'écrire.
    findUnique: mock(async ({ where }: { where: { id: string } }) => {
      const snapshot = where.id === drop.id ? { ...drop } : null;
      await Bun.sleep(5);
      return snapshot;
    }),
    updateMany: mock(async ({ where, data }: { where: { id: string; claimed?: boolean }; data: Partial<DropRow> }) => {
      if (where.id !== drop.id) return { count: 0 };
      if (where.claimed !== undefined && drop.claimed !== where.claimed) return { count: 0 };
      Object.assign(drop, data);
      return { count: 1 };
    }),
  },
  rpgProfile: {
    findUnique: mock(async ({ where }: { where: { guildId_userId: { guildId: string; userId: string } } }) => {
      const { guildId, userId } = where.guildId_userId;
      const found = profiles.find((row) => row.guildId === guildId && row.userId === userId);
      return found ? { ...found } : null;
    }),
    create: mock(async ({ data }: { data: { guildId: string; userId: string } }) => {
      const row: ProfileRow = { id: `profil-${data.userId}`, balance: 0, xp: 0, ...data };
      profiles.push(row);
      return { ...row };
    }),
    update: mock(async ({ where, data }: {
      where: { id: string };
      data: { balance?: { increment: number }; xp?: { increment: number } };
    }) => {
      const row = profiles.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('profil introuvable');
      row.balance += data.balance?.increment ?? 0;
      row.xp += data.xp?.increment ?? 0;
      return { ...row };
    }),
  },
};

const prismaMock = {
  ...tx,
  $transaction: mock(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
};

const dbSource = path.resolve(import.meta.dir, '../../utils/db.ts');
for (const suffixe of ['.ts', '.js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db${suffixe}`), () =>
    completeModuleMock(dbSource, { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock }));
}

const { handleButton } = await import('../../handlers/interactionHandler.js');

function click(userId: string) {
  return {
    isButton: () => true,
    customId: `rpg_drop_claim:${DROP_ID}`,
    guildId: GUILD_ID,
    user: { id: userId },
    deferUpdate: mock(async () => undefined),
    followUp: mock(async (_payload: { content: string }) => undefined),
    message: { edit: mock(async (_payload: unknown) => undefined) },
  };
}

const client = {} as Client;

beforeEach(() => {
  drop = { id: DROP_ID, guildId: GUILD_ID, type: 'COINS', amount: AMOUNT, claimed: false, claimedBy: null };
  profiles = [
    { id: 'profil-a', guildId: GUILD_ID, userId: 'membre-a', balance: 0, xp: 0 },
    { id: 'profil-b', guildId: GUILD_ID, userId: 'membre-b', balance: 0, xp: 0 },
  ];
});

describe('ramassage concurrent d\'un drop RPG', () => {
  test('deux clics simultanés : un seul membre est crédité, l\'autre apprend que le drop est pris', async () => {
    const first = click('membre-a');
    const second = click('membre-b');

    await Promise.all([
      handleButton(first as unknown as Interaction, client),
      handleButton(second as unknown as Interaction, client),
    ]);

    // Le drop n'est versé qu'une fois, en tout et pour tout.
    const totalCredited = profiles.reduce((sum, row) => sum + row.balance, 0);
    expect(totalCredited).toBe(AMOUNT);

    const winner = profiles.find((row) => row.balance === AMOUNT);
    expect(drop.claimed).toBe(true);
    expect(drop.claimedBy).toBe(winner?.userId ?? 'aucun gagnant');

    // Le perdant reçoit le refus, et lui seul ; le message n'est édité qu'une fois.
    const loser = winner?.userId === 'membre-a' ? second : first;
    const winnerClick = loser === first ? second : first;
    expect(loser.followUp).toHaveBeenCalledTimes(1);
    expect(loser.followUp.mock.calls[0][0].content).toContain('déjà été réclamé');
    expect(winnerClick.followUp).not.toHaveBeenCalled();
    expect(first.message.edit.mock.calls.length + second.message.edit.mock.calls.length).toBe(1);
  });
});
