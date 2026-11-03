/**
 * Stockage des délais de récupération et des variables.
 *
 * Prefixe `zz-` : ce fichier remplace `utils/db` pour tout le process
 * (`mock.module` est global). Charge en dernier, il ne fausse pas les autres.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

interface CooldownRow { workflowId: string; nodeId: string; subjectKey: string; until: Date }
interface VariableRow { guildId: string; name: string; subjectKey: string; value: number }

let cooldowns: CooldownRow[] = [];
let variables: VariableRow[] = [];

const sameCooldown = (row: CooldownRow, where: Partial<CooldownRow>) => (
  row.workflowId === where.workflowId && row.nodeId === where.nodeId && row.subjectKey === where.subjectKey
);

const mockDb = {
  workflowCooldown: {
    updateMany: mock(async ({ where, data }: any) => {
      const due = cooldowns.filter((row) => sameCooldown(row, where) && row.until.getTime() <= where.until.lte.getTime());
      for (const row of due) row.until = data.until;
      return { count: due.length };
    }),
    create: mock(async ({ data }: any) => {
      if (cooldowns.some((row) => sameCooldown(row, data))) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      cooldowns.push({ ...data });
      return data;
    }),
    deleteMany: mock(async ({ where }: any) => {
      const before = cooldowns.length;
      cooldowns = cooldowns.filter((row) => row.until.getTime() >= where.until.lt.getTime());
      return { count: before - cooldowns.length };
    }),
  },
  workflowVariable: {
    findUnique: mock(async ({ where }: any) => {
      const key = where.guildId_name_subjectKey;
      return variables.find((row) => row.guildId === key.guildId && row.name === key.name && row.subjectKey === key.subjectKey) ?? null;
    }),
    upsert: mock(async ({ where, create, update }: any) => {
      const key = where.guildId_name_subjectKey;
      const row = variables.find((entry) => entry.guildId === key.guildId && entry.name === key.name && entry.subjectKey === key.subjectKey);
      if (!row) {
        variables.push({ ...create });
        return { value: create.value };
      }
      row.value = typeof update.value === 'object' ? row.value + update.value.increment : update.value;
      return { value: row.value };
    }),
  },
};

for (const suffix of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, suffix), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { claimCooldown, getVariable, pruneExpiredCooldowns, updateVariable } =
  await import('../../services/features/workflow/workflowStore.js');

const T0 = new Date('2026-11-03T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

beforeEach(() => {
  cooldowns = [];
  variables = [];
});

describe('claimCooldown', () => {
  test('le premier passage réserve, le suivant attend la fin du délai', async () => {
    expect(await claimCooldown('w1', 'cd', 'member:u1', 60, T0)).toBeTrue();
    expect(await claimCooldown('w1', 'cd', 'member:u1', 60, at(30))).toBeFalse();
    expect(await claimCooldown('w1', 'cd', 'member:u1', 60, at(60))).toBeTrue();
  });

  test('deux passages simultanés : un seul passe', async () => {
    const results = await Promise.all([
      claimCooldown('w1', 'cd', '', 60, T0),
      claimCooldown('w1', 'cd', '', 60, T0),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('chaque titulaire a son propre délai', async () => {
    expect(await claimCooldown('w1', 'cd', 'member:u1', 60, T0)).toBeTrue();
    expect(await claimCooldown('w1', 'cd', 'member:u2', 60, T0)).toBeTrue();
  });

  test('le nettoyage n efface que les délais échus depuis plus d un jour', async () => {
    await claimCooldown('w1', 'cd', 'member:u1', 60, T0);
    await claimCooldown('w1', 'cd', 'member:u2', 3 * 86_400, T0);

    expect(await pruneExpiredCooldowns(at(2 * 86_400))).toBe(1);
    expect(cooldowns.map((row) => row.subjectKey)).toEqual(['member:u2']);
  });
});

describe('variables', () => {
  test('vaut 0 tant qu elle n a jamais été écrite', async () => {
    expect(await getVariable('g1', 'points', 'u1')).toBe(0);
  });

  test('ajoute puis remplace, en rendant la valeur enregistrée', async () => {
    expect(await updateVariable('g1', 'points', 'u1', 'add', 3)).toBe(3);
    expect(await updateVariable('g1', 'points', 'u1', 'add', 2)).toBe(5);
    expect(await updateVariable('g1', 'points', 'u1', 'set', 1)).toBe(1);
    expect(await getVariable('g1', 'points', 'u1')).toBe(1);
  });

  test('la variable du serveur et celle du membre sont distinctes', async () => {
    await updateVariable('g1', 'points', '', 'add', 10);
    await updateVariable('g1', 'points', 'u1', 'add', 1);

    expect(await getVariable('g1', 'points', '')).toBe(10);
    expect(await getVariable('g1', 'points', 'u1')).toBe(1);
  });
});
