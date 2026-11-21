/**
 * Remboursement de l'arbre de compétences : jamais deux fois les mêmes points.
 *
 * La fausse base reproduit le verrou de ligne de PostgreSQL : pris par un
 * `SELECT ... FOR UPDATE` ou par une écriture du profil, il est tenu jusqu'à la fin
 * de la transaction, et toute autre transaction qui veut le prendre attend.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { RESPEC_COST, pointsSpent } from '../../services/features/rpg/rpgSkillTree.js';

const GUILD_ID = 'guilde-rpg';
const USER_ID = 'membre-rpg';
const PROFILE_ID = 'profil-rpg';
const START_BALANCE = 3 * RESPEC_COST;

type ProfileRow = { id: string; guildId: string; userId: string; className: string; level: number; balance: number; skillPoints: number };
type UnlockRow = { rpgProfileId: string; nodeId: string; rank: number };

let profile: ProfileRow;
let unlocks: UnlockRow[] = [];

const BOUGHT: UnlockRow[] = [
  { rpgProfileId: PROFILE_ID, nodeId: 'war_bulwark_1', rank: 3 },
  { rpgProfileId: PROFILE_ID, nodeId: 'war_fury_1', rank: 2 },
];
const SPENT = pointsSpent(BOUGHT);

/** Une requête prend un peu de temps : c'est ce qui laisse deux transactions s'entrelacer. */
const latency = () => new Promise((resolve) => setTimeout(resolve, 2));

const nodesOf = (rpgProfileId: string) => unlocks
  .filter((row) => row.rpgProfileId === rpgProfileId)
  .map(({ nodeId, rank }) => ({ nodeId, rank }));

const models = {
  rpgProfile: {
    findUnique: mock(async ({ where, include }: {
      where: { guildId_userId: { guildId: string; userId: string } };
      include?: { skillUnlocks?: unknown };
    }) => {
      const { guildId, userId } = where.guildId_userId;
      const found = profile.guildId === guildId && profile.userId === userId
        ? { ...profile, ...(include?.skillUnlocks ? { skillUnlocks: nodesOf(profile.id) } : {}) }
        : null;
      await latency();
      return found;
    }),
    update: mock(async ({ where, data }: { where: { id: string }; data: { skillPoints?: { increment: number } } }) => {
      await latency();
      if (where.id !== profile.id) throw new Error('profil introuvable');
      profile.skillPoints += data.skillPoints?.increment ?? 0;
      return { ...profile };
    }),
    updateMany: mock(async ({ where, data }: {
      where: { id: string; balance?: { gte: number }; skillPoints?: { gte: number } };
      data: { balance?: { decrement: number }; skillPoints?: { increment?: number; decrement?: number } };
    }) => {
      await latency();
      if (where.id !== profile.id) return { count: 0 };
      if (where.balance && profile.balance < where.balance.gte) return { count: 0 };
      if (where.skillPoints && profile.skillPoints < where.skillPoints.gte) return { count: 0 };
      profile.balance -= data.balance?.decrement ?? 0;
      profile.skillPoints += (data.skillPoints?.increment ?? 0) - (data.skillPoints?.decrement ?? 0);
      return { count: 1 };
    }),
  },
  rpgSkillUnlock: {
    findMany: mock(async ({ where }: { where: { rpgProfileId: string } }) => {
      const found = nodesOf(where.rpgProfileId);
      await latency();
      return found;
    }),
    deleteMany: mock(async ({ where }: { where: { rpgProfileId: string } }) => {
      await latency();
      const before = unlocks.length;
      unlocks = unlocks.filter((row) => row.rpgProfileId !== where.rpgProfileId);
      return { count: before - unlocks.length };
    }),
    upsert: mock(async ({ where, create, update }: {
      where: { rpgProfileId_nodeId: { rpgProfileId: string; nodeId: string } };
      create: UnlockRow;
      update: { rank: number };
    }) => {
      await latency();
      const { rpgProfileId, nodeId } = where.rpgProfileId_nodeId;
      const row = unlocks.find((candidate) => candidate.rpgProfileId === rpgProfileId && candidate.nodeId === nodeId);
      if (row) Object.assign(row, update);
      else unlocks.push({ ...create });
      return { ...(row ?? create) };
    }),
  },
};

/** Seule ligne verrouillée du test : le profil, avec la transaction qui le tient. */
let verrou: { tx: object; libere: Promise<void>; liberer: () => void } | null = null;

async function verrouiller(tx: object): Promise<void> {
  while (verrou && verrou.tx !== tx) await verrou.libere;
  if (verrou) return;
  let liberer = () => {};
  const libere = new Promise<void>((resolve) => { liberer = resolve; });
  verrou = { tx, libere, liberer };
}

const prismaMock = {
  ...models,
  $transaction: mock(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    const tx: Record<string, unknown> = {};
    const ecrire = <A extends unknown[], R>(ecriture: (...args: A) => Promise<R>) => async (...args: A) => {
      await verrouiller(tx);
      return ecriture(...args);
    };
    Object.assign(tx, {
      ...models,
      rpgProfile: { ...models.rpgProfile, update: ecrire(models.rpgProfile.update), updateMany: ecrire(models.rpgProfile.updateMany) },
      $queryRaw: () => verrouiller(tx),
    });
    try {
      return await (arg as (tx: object) => Promise<unknown>)(tx);
    } finally {
      if (verrou?.tx === tx) {
        verrou.liberer();
        verrou = null;
      }
    }
  }),
};

const dbSource = path.resolve(import.meta.dir, '../../utils/db.ts');
for (const suffixe of ['.ts', '.js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db${suffixe}`), () =>
    completeModuleMock(dbSource, { default: prismaMock, prisma: prismaMock, prismaRead: prismaMock }));
}

const { respecSkillTree, resetSkillTreeForClassChange, unlockSkillNode } = await import('../../services/features/rpg/rpgSkillTreeService.js');

beforeEach(() => {
  profile = { id: PROFILE_ID, guildId: GUILD_ID, userId: USER_ID, className: 'WARRIOR', level: 30, balance: START_BALANCE, skillPoints: 0 };
  unlocks = BOUGHT.map((row) => ({ ...row }));
  verrou = null;
});

describe('remboursement concurrent de l\'arbre de compétences', () => {
  test('deux remises à zéro simultanées ne rendent les points et ne prélèvent le coût qu\'une fois', async () => {
    expect(SPENT).toBeGreaterThan(0);

    const outcomes = await Promise.allSettled([
      respecSkillTree(GUILD_ID, USER_ID),
      respecSkillTree(GUILD_ID, USER_ID),
    ]);

    expect(profile.skillPoints).toBe(SPENT);
    expect(profile.balance).toBe(START_BALANCE - RESPEC_COST);
    expect(unlocks).toHaveLength(0);

    const done = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(done).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String(refused[0].reason?.message)).toContain('déjà vierge');
  });

  test('deux changements de classe simultanés ne rendent les points qu\'une fois', async () => {
    const refunds = await Promise.all([
      resetSkillTreeForClassChange(PROFILE_ID),
      resetSkillTreeForClassChange(PROFILE_ID),
    ]);

    expect(profile.skillPoints).toBe(SPENT);
    expect([...refunds].sort((a, b) => a - b)).toEqual([0, SPENT]);
    expect(unlocks).toHaveLength(0);
  });

  test('une remise à zéro seule rend tous les points investis', async () => {
    const result = await respecSkillTree(GUILD_ID, USER_ID);

    expect(result).toEqual({ refunded: SPENT, cost: RESPEC_COST, newBalance: START_BALANCE - RESPEC_COST });
    expect(profile.skillPoints).toBe(SPENT);
    expect(unlocks).toHaveLength(0);
  });
});

describe('déblocage pendant une remise à zéro', () => {
  test('le rang acheté part de l\'arbre remboursé : aucun point n\'est à la fois rendu et investi', async () => {
    profile.skillPoints = 1;

    // Lancés ensemble, le respec prend le verrou le premier.
    await Promise.all([
      respecSkillTree(GUILD_ID, USER_ID),
      unlockSkillNode(GUILD_ID, USER_ID, 'war_fury_1'),
    ]);

    expect(unlocks).toEqual([{ rpgProfileId: PROFILE_ID, nodeId: 'war_fury_1', rank: 1 }]);
    expect(profile.skillPoints + pointsSpent(unlocks)).toBe(1 + SPENT);
  });
});
