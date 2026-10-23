/**
 * Ajouter un membre au staff ne doit pas dependre d'un index unique en base.
 *
 * `prisma.staffMember.upsert` passe par `ON CONFLICT`, qui exige l'index
 * `(guildId, userId)`. La table est nee d'un `db push` et cet index manquait
 * sur une base : chaque ajout depuis le dashboard tombait sur 42P10. Les
 * fonctions de `staffRowUpsert` lisent puis ecrivent, et se rabattent sur une
 * mise a jour quand un ajout simultane a gagne la course (P2002).
 *
 * Prefixe `zz-` : ce fichier pose un `mock.module` sur `utils/db`, que
 * `bun test --isolate` n'isole pas ; il doit charger en dernier.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { completeModuleMock } from '../helpers/moduleMock.js';

let existant: { id: string } | null = null;
let creationEchoue: Error | null = null;
let trouveApresCourse: { id: string } | null = null;

const appels: string[] = [];

const fauxPrisma = {
  staffMember: {
    findFirst: mock(async () => {
      appels.push('findFirst');
      // Apres un P2002, la seconde lecture voit la ligne creee par l'autre ajout.
      return appels.includes('create') ? trouveApresCourse : existant;
    }),
    update: mock(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      appels.push(`update:${where.id}`);
      return { id: where.id, ...data };
    }),
    create: mock(async ({ data }: { data: Record<string, unknown> }) => {
      appels.push('create');
      if (creationEchoue) throw creationEchoue;
      return { id: 'nouveau', ...data };
    }),
  },
  staffMemberHierarchyGrade: {
    findFirst: mock(async () => existant),
    update: mock(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    create: mock(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'grade-nouveau', ...data })),
  },
};

const source = path.resolve(import.meta.dir, '../../utils/db.ts');
for (const suffixe of ['.ts', '.js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db${suffixe}`), () =>
    completeModuleMock(source, { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma }));
}

const { upsertStaffMemberRow, upsertHierarchyGradeRow } = await import('../../services/staff/staffRowUpsert.js');

const donnees = { update: { grade: 'Modérateur' }, create: { grade: 'Modérateur' } };

beforeEach(() => {
  existant = null;
  creationEchoue = null;
  trouveApresCourse = null;
  appels.length = 0;
});

describe('upsertStaffMemberRow', () => {
  test('nouveau membre : il est créé avec son serveur et son identifiant', async () => {
    const ligne = await upsertStaffMemberRow('guilde', 'membre', donnees);

    expect(appels).toEqual(['findFirst', 'create']);
    expect(ligne).toMatchObject({ id: 'nouveau', guildId: 'guilde', userId: 'membre', grade: 'Modérateur' });
  });

  test('membre déjà là : il est mis à jour, sans création', async () => {
    existant = { id: 'deja-la' };

    const ligne = await upsertStaffMemberRow('guilde', 'membre', donnees);

    expect(appels).toEqual(['findFirst', 'update:deja-la']);
    expect(ligne).toMatchObject({ id: 'deja-la', grade: 'Modérateur' });
  });

  test("ajout simultané : le P2002 se rabat sur la ligne créée par l'autre", async () => {
    creationEchoue = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
    trouveApresCourse = { id: 'gagnant' };

    const ligne = await upsertStaffMemberRow('guilde', 'membre', donnees);

    expect(appels).toEqual(['findFirst', 'create', 'findFirst', 'update:gagnant']);
    expect(ligne).toMatchObject({ id: 'gagnant' });
  });

  test("toute autre erreur à la création remonte telle quelle", async () => {
    creationEchoue = new Error('base injoignable');

    await expect(upsertStaffMemberRow('guilde', 'membre', donnees)).rejects.toThrow('base injoignable');
  });
});

describe('upsertHierarchyGradeRow', () => {
  test('crée le grade, ou met à jour celui qui existe', async () => {
    expect(await upsertHierarchyGradeRow('membre', 'pole', 'Helper')).toMatchObject({ id: 'grade-nouveau', grade: 'Helper' });

    existant = { id: 'grade-la' };
    expect(await upsertHierarchyGradeRow('membre', 'pole', 'Admin')).toMatchObject({ id: 'grade-la', grade: 'Admin' });
  });
});
