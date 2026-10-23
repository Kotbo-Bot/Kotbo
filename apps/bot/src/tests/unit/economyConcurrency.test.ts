import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import {
  RPG_ADVENTURE_EVENTS,
  RPG_ITEMS,
  RPG_MONSTERS,
} from '../../services/features/rpg/rpgContent.js';

type ProfileState = {
  id: string;
  guildId: string;
  userId: string;
  balance: number;
  level: number;
  xp: number;
  lastDaily: Date | null;
  dailyStreak: number;
  lastWork: Date | null;
  dailyBetCount: number;
  dailyBetWindowStart: Date | null;
  lastEnergyTick: Date;
  updatedAt: Date;
  inventory: unknown[];
};

let profile: ProfileState;

function matchesNullableDate(
  value: Date | null,
  clauses: Array<Record<string, unknown>>,
  field: 'lastDaily' | 'lastWork' | 'dailyBetWindowStart',
): boolean {
  return clauses.some((clause) => {
    const condition = clause[field];
    if (condition === null) return value === null;
    if (!value || typeof condition !== 'object' || condition === null) return false;
    const dateCondition = condition as { lte?: Date; gt?: Date };
    if (dateCondition.lte) return value <= dateCondition.lte;
    if (dateCondition.gt) return value > dateCondition.gt;
    return false;
  });
}

const rpgProfile = {
  findUnique: mock(async () => ({ ...profile, inventory: [] })),
  create: mock(async () => ({ ...profile, inventory: [] })),
  update: mock(async () => ({ ...profile, inventory: [] })),
  updateMany: mock(async ({ where, data }: any) => {
    if (where.id !== profile.id) return { count: 0 };
    if (where.OR) {
      const field = where.OR.some((clause: Record<string, unknown>) => 'lastDaily' in clause)
        ? 'lastDaily'
        : where.OR.some((clause: Record<string, unknown>) => 'lastWork' in clause)
          ? 'lastWork'
          : 'dailyBetWindowStart';
      if (!matchesNullableDate(profile[field], where.OR, field)) return { count: 0 };
    }
    if (where.dailyBetWindowStart?.gt && (
      !profile.dailyBetWindowStart
      || profile.dailyBetWindowStart <= where.dailyBetWindowStart.gt
    )) return { count: 0 };
    if (where.dailyBetCount?.lt !== undefined && profile.dailyBetCount >= where.dailyBetCount.lt) {
      return { count: 0 };
    }

    if (data.balance?.increment) profile.balance += data.balance.increment;
    if (data.xp?.increment) profile.xp += data.xp.increment;
    if (data.lastDaily) profile.lastDaily = data.lastDaily;
    if (typeof data.dailyStreak === 'number') profile.dailyStreak = data.dailyStreak;
    if (data.lastWork) profile.lastWork = data.lastWork;
    if (typeof data.dailyBetCount === 'number') profile.dailyBetCount = data.dailyBetCount;
    if (data.dailyBetCount?.increment) profile.dailyBetCount += data.dailyBetCount.increment;
    if (data.dailyBetWindowStart) profile.dailyBetWindowStart = data.dailyBetWindowStart;
    return { count: 1 };
  }),
};

// `getOrCreateRpgProfile` déclenche le seed du catalogue RPG : on lui présente le contenu
// comme déjà en base pour qu'il n'écrive rien et n'interfère pas avec ces tests.
const alreadySeeded = {
  count: mock(async () => 1),
  createMany: mock(async () => ({ count: 0 })),
  findMany: mock(async () => [] as unknown[]),
};

const mockDb = {
  economyConfig: {
    findUnique: mock(async () => ({
      enabled: true,
      dailyRewardMin: 50,
      dailyRewardMax: 50,
      dailyCooldownHour: 20,
      maxBetAmount: 1_000,
      maxDailyBets: 1,
      currencyEmoji: 'coins',
    })),
  },
  rpgItem: { ...alreadySeeded, findMany: mock(async () => RPG_ITEMS.map((item) => ({ name: item.name }))) },
  rpgMonster: { ...alreadySeeded, findMany: mock(async () => RPG_MONSTERS.map((monster) => ({ name: monster.name }))) },
  rpgAdventureEvent: { ...alreadySeeded, findMany: mock(async () => RPG_ADVENTURE_EVENTS.map((event) => ({ title: event.title }))) },
  rpgRecipe: { ...alreadySeeded },
  rpgProfile,
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));

const { claimDaily, registerGambleAttempt, work } = await import('../../services/features/economyService.js');

beforeEach(() => {
  const now = new Date();
  profile = {
    id: 'profile-1',
    guildId: 'guild-1',
    userId: 'user-1',
    balance: 0,
    level: 1,
    xp: 0,
    lastDaily: null,
    dailyStreak: 0,
    lastWork: null,
    dailyBetCount: 0,
    dailyBetWindowStart: null,
    lastEnergyTick: now,
    updatedAt: now,
    inventory: [],
  };
});

describe('atomic economy cooldowns and quotas', () => {
  test('only one concurrent daily claim receives a reward', async () => {
    const results = await Promise.all([
      claimDaily('guild-1', 'user-1'),
      claimDaily('guild-1', 'user-1'),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    expect(profile.balance).toBe(50);
  });

  test('a daily claimed the next day extends the streak and raises the reward', async () => {
    profile.lastDaily = new Date(Date.now() - 24 * 60 * 60 * 1000);
    profile.dailyStreak = 2;

    const result = await claimDaily('guild-1', 'user-1');

    expect(result.success).toBe(true);
    expect(result.streak).toBe(3);
    expect(result.reward).toBe(60);
    expect(profile.dailyStreak).toBe(3);
    expect(profile.balance).toBe(60);
  });

  test('only one concurrent work action receives salary and XP', async () => {
    const results = await Promise.all([
      work('guild-1', 'user-1'),
      work('guild-1', 'user-1'),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    expect(profile.xp).toBe(15);
    const paidSalary = results
      .map((result) => ('salary' in result ? result.salary : null))
      .find((salary) => salary !== null);
    expect(paidSalary).toBeDefined();
    expect(profile.balance).toBe(paidSalary as number);
  });

  test('the daily gamble quota cannot be exceeded concurrently', async () => {
    const results = await Promise.allSettled([
      registerGambleAttempt('guild-1', 'user-1', 10),
      registerGambleAttempt('guild-1', 'user-1', 10),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(profile.dailyBetCount).toBe(1);
  });
});
