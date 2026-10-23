/**
 * Creer ou mettre a jour un membre du staff, ou son grade dans une hierarchie,
 * sans dependre d'un index unique en base.
 *
 * `staff_members` et `staff_member_hierarchy_grades` sont nees d'un
 * `prisma db push`, avant l'historique des migrations : aucune migration n'a
 * jamais pose leurs index uniques (`guildId, userId` et
 * `staffMemberId, hierarchyId`). Sur une base ou ils manquent, l'`upsert` de
 * Prisma, qui s'appuie sur `ON CONFLICT`, echoue a tous les coups (42P10,
 * « there is no unique or exclusion constraint matching the ON CONFLICT
 * specification ») : ajouter un membre au staff depuis le dashboard etait
 * impossible.
 *
 * La migration `20261114100000_staff_unique_indexes` pose ces index la ou elle
 * peut ; ces fonctions marchent avec ou sans eux. Lire puis ecrire laisse une
 * fenetre a deux ajouts simultanes : quand l'index existe, le second tombe sur
 * P2002 et se rabat sur une mise a jour.
 */
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function upsertStaffMemberRow(
  guildId: string,
  userId: string,
  data: {
    update: Prisma.StaffMemberUncheckedUpdateInput;
    create: Omit<Prisma.StaffMemberUncheckedCreateInput, 'guildId' | 'userId'>;
  },
) {
  const find = () => prisma.staffMember.findFirst({
    where: { guildId, userId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  const existing = await find();
  if (existing) return prisma.staffMember.update({ where: { id: existing.id }, data: data.update });

  try {
    return await prisma.staffMember.create({ data: { ...data.create, guildId, userId } });
  } catch (err) {
    const raced = isUniqueViolation(err) ? await find() : null;
    if (!raced) throw err;
    return prisma.staffMember.update({ where: { id: raced.id }, data: data.update });
  }
}

export async function upsertHierarchyGradeRow<I extends Prisma.StaffMemberHierarchyGradeInclude | undefined = undefined>(
  staffMemberId: string,
  hierarchyId: string,
  grade: string,
  include?: I,
) {
  const find = () => prisma.staffMemberHierarchyGrade.findFirst({
    where: { staffMemberId, hierarchyId },
    select: { id: true },
  });
  const update = (id: string) => prisma.staffMemberHierarchyGrade.update({ where: { id }, data: { grade }, include });

  const existing = await find();
  if (existing) return update(existing.id);

  try {
    return await prisma.staffMemberHierarchyGrade.create({ data: { staffMemberId, hierarchyId, grade }, include });
  } catch (err) {
    const raced = isUniqueViolation(err) ? await find() : null;
    if (!raced) throw err;
    return update(raced.id);
  }
}
