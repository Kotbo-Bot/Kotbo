import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

type Profile = { id: string; guildId: string; userId: string; balance: number; rpgGuildId: string | null };

let profile: Profile;
let treasury: number;
let queue = Promise.resolve();

function matchesBalance(where: any): boolean {
  if (where.id !== profile.id) return false;
  if (where.balance?.gte !== undefined && profile.balance < where.balance.gte) return false;
  if (where.balance?.lt !== undefined && profile.balance >= where.balance.lt) return false;
  if ('rpgGuildId' in where && where.rpgGuildId !== profile.rpgGuildId) return false;
  return true;
}

function applyData(data: any): void {
  if (data.balance?.decrement !== undefined) profile.balance -= data.balance.decrement;
  if (data.balance?.increment !== undefined) profile.balance += data.balance.increment;
  if (typeof data.balance === 'number') profile.balance = data.balance;
}

const rpgProfile = {
  findUnique: mock(async () => ({ ...profile, lastEnergyTick: new Date(), inventory: [] })),
  create: mock(async () => ({ ...profile })),
  update: mock(async ({ data }: any) => { applyData(data); return { ...profile }; }),
  updateMany: mock(async ({ where, data }: any) => {
    // Chaque écriture conditionnelle est atomique, comme en base.
    await Promise.resolve();
    if (!matchesBalance(where)) return { count: 0 };
    applyData(data);
    return { count: 1 };
  }),
};

const tx = {
  rpgProfile,
  rpgGuild: {
    update: mock(async ({ data }: any) => { treasury += data.treasury.increment; return { level: 1, xp: treasury }; }),
  },
};

const alreadySeeded = { count: mock(async () => 1), createMany: mock(async () => ({ count: 0 })), findMany: mock(async () => []) };

const mockDb = {
  ...tx,
  economyConfig: { findUnique: mock(async () => ({ enabled: true, guildsEnabled: true })) },
  rpgGuild: {
    ...tx.rpgGuild,
    findUnique: mock(async () => ({ id: 'rpg-guild', level: 1, xp: 0, treasury })),
  },
  rpgItem: alreadySeeded,
  rpgMonster: alreadySeeded,
  rpgAdventureEvent: alreadySeeded,
  rpgRecipe: alreadySeeded,
  $transaction: mock(<T>(callback: (client: typeof tx) => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const snapshot = { ...profile };
      const treasurySnapshot = treasury;
      try {
        return await callback(tx);
      } catch (error) {
        profile = snapshot;
        treasury = treasurySnapshot;
        throw error;
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }),
};

for (const file of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, file), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { takeBet, creditBalance, removeBalanceFloored, depositToRpgGuildTreasury } = await import('../../services/features/economyService.js');

beforeEach(() => {
  profile = { id: 'p1', guildId: 'g1', userId: 'u1', balance: 100, rpgGuildId: 'rpg-guild' };
  treasury = 0;
  queue = Promise.resolve();
});

describe('mises des jeux d\'argent', () => {
  test('deux mises simultanées ne passent que si le solde couvre les deux', async () => {
    const results = await Promise.all([takeBet('p1', 80), takeBet('p1', 80)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(profile.balance).toBe(20);
  });

  test('le gain s\'ajoute au solde courant, sans effacer ce qui a bougé entre-temps', async () => {
    await takeBet('p1', 50);
    // Un transfert sortant pendant la partie :
    profile.balance -= 30;
    expect(await creditBalance('p1', 100)).toBe(120);
  });
});

describe('retrait borné à zéro', () => {
  test('retire le montant quand le solde le couvre', async () => {
    expect(await removeBalanceFloored('p1', 40)).toBe(60);
  });

  test('ramène à zéro un solde trop court, jamais en négatif', async () => {
    expect(await removeBalanceFloored('p1', 500)).toBe(0);
  });
});

describe('don au trésor de guilde', () => {
  test('deux dons simultanés ne dépassent jamais le solde', async () => {
    const results = await Promise.allSettled([
      depositToRpgGuildTreasury('g1', 'u1', 80),
      depositToRpgGuildTreasury('g1', 'u1', 80),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(profile.balance).toBe(20);
    expect(treasury).toBe(80);
  });
});
