import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { rankedDayKey } from '@kotbo/shared';

type Ligne = {
  id: string;
  guildId: string;
  rp: number;
  peakRp: number;
  peakTierKey: string | null;
  previousTierKey: string | null;
  streakDays: number;
  lastActiveDate: string | null;
  lastDecayDate: string | null;
};

const membre = {} as Ligne;
const HIER = rankedDayKey(new Date(Date.now() - 86_400_000));

/** Écriture concurrente jouée juste après la prochaine lecture du decay sur la réplique. */
let apresLecture: (() => Promise<unknown>) | null = null;

const rankedMember = {
  // Une lecture rend l'état au moment où elle part : deux mouvements simultanés lisent avant que l'un n'écrive.
  findUnique: async () => {
    const instantane = { ...membre };
    await Bun.sleep(1);
    return instantane;
  },
  // Lot du decay, filtré comme en SQL.
  findMany: async ({ where }: {
    where: { guildId: string; rp: { gt: number }; OR: Array<{ lastActiveDate: null | { lt: string } }>; NOT: { lastDecayDate: string } };
  }) => {
    const inactif = where.OR.some(({ lastActiveDate: filtre }) => (filtre === null
      ? membre.lastActiveDate === null
      : membre.lastActiveDate !== null && membre.lastActiveDate < filtre.lt));
    const lot = membre.guildId === where.guildId && membre.rp > where.rp.gt && inactif && membre.lastDecayDate !== where.NOT.lastDecayDate
      ? [{ ...membre }]
      : [];
    const ecriture = apresLecture;
    apresLecture = null;
    await ecriture?.();
    return lot;
  },
  update: async ({ data }: { data: object }) => Object.assign(membre, data),
  // WHERE respecté : chaque colonne nommée doit encore valoir ce qui est en base.
  updateMany: async ({ where, data }: { where: Partial<Ligne>; data: object }) => {
    const intacte = Object.entries(where).every(([colonne, valeur]) => membre[colonne as keyof Ligne] === valeur);
    if (intacte) Object.assign(membre, data);
    return { count: intacte ? 1 : 0 };
  },
};

// SELECT ... FOR UPDATE : la ligne reste verrouillée jusqu'à la fin de la transaction qui l'a prise.
let verrou = Promise.resolve();
const prismaMock = {
  rankedMember,
  rankedConfig: {
    findUnique: async () => ({
      guildId: 'g1', enabled: true, ladder: null,
      decayEnabled: true, decayGraceDays: 3, decayRpPerDay: 25, decayPercentPerDay: 0, decayFloorTierKey: null,
    }),
  },
  rankedRpLog: { create: async () => ({}) },
  $transaction: async (fn: (tx: object) => Promise<unknown>) => {
    let liberer = () => {};
    const $queryRaw = async () => {
      const precedent = verrou;
      verrou = new Promise((resolve) => { liberer = resolve; });
      await precedent;
    };
    try {
      return await fn({ rankedMember, $queryRaw });
    } finally {
      liberer();
    }
  },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock }));
}

const { applyRpDelta } = await import('../../services/progression/ranked/rankedService.js');
const { runGuildDecay } = await import('../../services/progression/ranked/rankedDecayService.js');

beforeEach(() => {
  Object.assign(membre, {
    id: 'ligne-1', guildId: 'g1', rp: 100, peakRp: 100, peakTierKey: null, previousTierKey: null,
    streakDays: 0, lastActiveDate: null, lastDecayDate: null,
  });
  apresLecture = null;
});

describe('applyRpDelta', () => {
  test('deux gains simultanés s’additionnent au lieu de s’écraser', async () => {
    await Promise.all([applyRpDelta('g1', 'membre', 50, null), applyRpDelta('g1', 'membre', 30, null)]);
    expect(membre.rp).toBe(180);
  });
});

describe('decay', () => {
  test('un gain arrivé entre la lecture et l’écriture du decay n’est pas écrasé', async () => {
    Object.assign(membre, { rp: 1_000, peakRp: 1_000, lastActiveDate: '2026-01-01', lastDecayDate: HIER });
    apresLecture = () => applyRpDelta('g1', 'membre', 50, null);

    await runGuildDecay('g1', null);

    // Le jour non facturé le sera au passage suivant, qui rattrape depuis `lastDecayDate`.
    expect(membre.rp).toBe(1_050);
    expect(membre.lastDecayDate).toBe(HIER);
  });
});
