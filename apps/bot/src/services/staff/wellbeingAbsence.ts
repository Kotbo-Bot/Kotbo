/**
 * Absence en cours d'un membre du staff, lue pour la cellule de suivi : la
 * fiche d'un dossier signale un référent absent, et ses relances vont au
 * suppléant de la cellule.
 */
import prisma from '../../utils/db.js';
import { absenceActive } from './wellbeingWorkloadPolicy.js';

export async function currentAbsence(guildId: string, userId: string, now: Date = new Date()) {
  const absences = await prisma.staffAbsence.findMany({
    where: { guildId, staffUserId: userId, status: { in: ['APPROVED', 'ACKNOWLEDGED'] }, isVoid: false, endedAt: null },
    select: { status: true, isVoid: true, endedAt: true, startDate: true, endDate: true, isIndefinite: true },
  });
  return absences.find((absence) => absenceActive(absence, now)) ?? null;
}
