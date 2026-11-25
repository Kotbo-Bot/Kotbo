// Succès « Aventurier » : une quête d'équipe terminée compte pour chacun de ses
// contributeurs, au même titre qu'une quête personnelle payée.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

type Progress = { id: string; userId: string; questId: string; windowKey: string; teamKey: string; current: number; completions: number };
type Team = { questId: string; teamKey: string; windowKey: string; rewardedAt: Date | null };
let progress: Progress[] = [];
let teams: Team[] = [];

type ProgressWhere = { userId: string; teamKey: string | { not: string }; current?: { gt: number }; id?: { gt: string } };

function matchesProgress(row: Progress, where: ProgressWhere): boolean {
  if (row.userId !== where.userId) return false;
  if (typeof where.teamKey === 'string' ? row.teamKey !== where.teamKey : row.teamKey === where.teamKey.not) return false;
  if (where.current && !(row.current > where.current.gt)) return false;
  if (where.id && !(row.id > where.id.gt)) return false;
  return true;
}

const mockDb = {
  rpgQuestProgress: {
    aggregate: async ({ where }: { where: ProgressWhere }) => {
      const rows = progress.filter((row) => matchesProgress(row, where));
      return { _sum: { completions: rows.length > 0 ? rows.reduce((sum, row) => sum + row.completions, 0) : null } };
    },
    findMany: async ({ where, take }: { where: ProgressWhere; take: number }) =>
      progress
        .filter((row) => matchesProgress(row, where))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, take),
  },
  rpgQuestTeamProgress: {
    count: async ({ where }: { where: { OR: Array<{ questId: string; teamKey: string; windowKey: string }> } }) =>
      teams.filter((team) => team.rewardedAt !== null && where.OR.some((key) =>
        key.questId === team.questId && key.teamKey === team.teamKey && key.windowKey === team.windowKey)).length,
  },
};
const dbSource = path.resolve(import.meta.dir, '../../utils/db.ts');
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () =>
    completeModuleMock(dbSource, { default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { countCompletedQuests } = await import('../../services/features/rpg/rpgQuestStats.js');

function row(overrides: Partial<Progress> & Pick<Progress, 'id'>): Progress {
  return { userId: 'joueur', questId: 'q1', windowKey: '1', teamKey: '', current: 0, completions: 0, ...overrides };
}

describe('quêtes terminées', () => {
  beforeEach(() => {
    progress = [];
    teams = [];
  });

  test('sans aucune quête, zéro', async () => {
    expect(await countCompletedQuests('joueur')).toBe(0);
  });

  test('les quêtes personnelles comptent chaque versement, répétables comprises', async () => {
    progress = [
      row({ id: 'a', completions: 1 }),
      row({ id: 'b', questId: 'q2', completions: 4 }),
      row({ id: 'c', userId: 'autre', completions: 9 }),
    ];
    expect(await countCompletedQuests('joueur')).toBe(5);
  });

  test("une quête d'équipe payée compte pour chaque contributeur, pas une quête en cours", async () => {
    progress = [
      row({ id: 'a', teamKey: 'clan-1', current: 12 }),
      row({ id: 'b', teamKey: 'clan-1', questId: 'q2', current: 3 }),
      row({ id: 'c', userId: 'autre', teamKey: 'clan-1', current: 30 }),
    ];
    teams = [
      { questId: 'q1', teamKey: 'clan-1', windowKey: '1', rewardedAt: new Date() },
      { questId: 'q2', teamKey: 'clan-1', windowKey: '1', rewardedAt: null },
    ];
    expect(await countCompletedQuests('joueur')).toBe(1);
  });

  test("une ligne d'équipe sans contribution ne compte pas", async () => {
    progress = [row({ id: 'a', teamKey: 'clan-1', current: 0 })];
    teams = [{ questId: 'q1', teamKey: 'clan-1', windowKey: '1', rewardedAt: new Date() }];
    expect(await countCompletedQuests('joueur')).toBe(0);
  });

  test('personnelles et équipe s’additionnent, au-delà d’un lot de lecture', async () => {
    progress = [row({ id: 'perso', completions: 2 })];
    for (let index = 0; index < 450; index += 1) {
      const windowKey = String(index).padStart(4, '0');
      progress.push(row({ id: `t${windowKey}`, teamKey: 'clan-1', windowKey, current: 1 }));
      teams.push({ questId: 'q1', teamKey: 'clan-1', windowKey, rewardedAt: new Date() });
    }
    expect(await countCompletedQuests('joueur')).toBe(452);
  });
});
