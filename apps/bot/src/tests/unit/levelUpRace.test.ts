import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '987654321098765432';
const USER_ID = '123456789012345678';

/** Membre à 20 XP du niveau 2. */
const row = { guildId: GUILD_ID, userId: USER_ID, level: 1, xp: 280 };

const tx = {
  guild: { findUnique: mock(async () => null) },
  levelConfig: {
    findUnique: mock(async () => ({ guildId: GUILD_ID, curveBaseXp: 100, curveLinearXp: 200, curveExponent: 2, maxLevel: 0 })),
  },
  memberLevel: {
    // L'incrément est atomique, mais chaque gain relit le niveau d'avant les deux montées.
    upsert: mock(async ({ update }: { update: { xp: { increment: number } } }) => {
      row.xp += update.xp.increment;
      const snapshot = { ...row };
      await Bun.sleep(5);
      return snapshot;
    }),
    // Écriture sans condition, comme en SQL : la dernière arrivée l'emporte.
    update: mock(async ({ data }: { data: { level?: number; xp?: number } }) => ({ ...Object.assign(row, data) })),
    // WHERE respecté : la ligne n'est écrite que si chaque colonne nommée vaut encore la valeur attendue.
    updateMany: mock(async ({ where, data }: { where: Partial<typeof row>; data: { level: number } }) => {
      if (!Object.entries(where).every(([colonne, valeur]) => row[colonne as keyof typeof row] === valeur)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  },
};
const prismaMock = { ...tx, $transaction: mock(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock });
mockerModule('../../services/core/moduleGate', {
  isModuleEnabled: async (_guildId: string, module: string) => module === 'leveling',
});

const { addXp } = await import('../../services/progression/levelingService.js');

describe('montée de niveau', () => {
  test('deux gains d\'XP simultanés n\'annoncent qu\'une montée de niveau', async () => {
    const annonces: number[] = [];
    kotboEventBus.subscribe('level:up', ({ level }) => { annonces.push(level); });
    const client = { guilds: { cache: new Map(), fetch: async () => null } } as unknown as Client;

    await Promise.all([addXp(GUILD_ID, USER_ID, 20, client), addXp(GUILD_ID, USER_ID, 20, client)]);

    expect(annonces).toEqual([2]);
  });
});
