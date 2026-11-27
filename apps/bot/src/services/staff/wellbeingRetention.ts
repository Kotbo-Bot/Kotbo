/**
 * Conservation des dossiers de la cellule bien-être.
 *
 * Ces dossiers peuvent contenir des données sensibles (santé, conflits) : on
 * ne les garde pas indéfiniment. Un dossier fermé et inchangé depuis la durée
 * de conservation est supprimé avec ses notes, comme un dossier resté en
 * corbeille au-delà de son délai de restauration. Les signaux de détresse
 * et les empreintes de vote de la météo du staff suivent le même principe.
 *
 * Une note de fiche est effacée à son échéance, une fois annoncée ; une fiche
 * sans note disparaît avec elle.
 */
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { profilePurgeWarnedCutoff } from './wellbeingProfilePolicy.js';
import { CASE_TRASH_DAYS, CLOSED_CASE_RETENTION_DAYS, DISTRESS_SIGNAL_DAYS, closedCaseCutoff, pulseWeekKey, purgeWarnedCutoff, trashCutoff } from './wellbeingPolicy.js';

export async function pruneClosedWellbeingCases(now: Date = new Date()): Promise<void> {
  try {
    // Un dossier n'est effacé qu'une semaine après son annonce (`purgeWarnedAt`, posé par
    // les relances) : un dossier déjà trop ancien au déploiement garde son préavis. L'annonce
    // doit suivre la dernière modification : celle d'avant une réouverture ne vaut plus.
    const { count } = await prisma.wellbeingCase.deleteMany({
      where: {
        status: 'CLOSED',
        deletedAt: null,
        updatedAt: { lt: closedCaseCutoff(now) },
        purgeWarnedAt: { lte: purgeWarnedCutoff(now), gt: prisma.wellbeingCase.fields.updatedAt },
      },
    });
    if (count > 0) {
      logger.info('Wellbeing', `${count} dossier(s) fermé(s) depuis plus de ${CLOSED_CASE_RETENTION_DAYS} jours supprimé(s).`);
    }
    const trash = await prisma.wellbeingCase.deleteMany({ where: { deletedAt: { lt: trashCutoff(now) } } });
    if (trash.count > 0) {
      logger.info('Wellbeing', `${trash.count} dossier(s) en corbeille depuis plus de ${CASE_TRASH_DAYS} jours purgé(s).`);
    }
    // Un signal de détresse n'est qu'un lien vers un message : il ne sert plus après un mois.
    await prisma.wellbeingDistressSignal.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - DISTRESS_SIGNAL_DAYS * 24 * 60 * 60 * 1000) } },
    });
    // Météo du staff : qui a voté n'a plus d'utilité une fois la semaine passée.
    await prisma.wellbeingPulseVoter.deleteMany({ where: { week: { not: pulseWeekKey(now) } } });
    await pruneExpiredProfileNotes(now);
  } catch (error) {
    logger.error('Wellbeing', 'Purge des dossiers fermés en échec :', error);
  }
}

/**
 * Notes de fiche échues et annoncées depuis au moins une semaine. Une fiche
 * restée sans note est effacée à son tour, sauf si elle vient d'être créée :
 * sa première note peut être en cours d'écriture.
 */
export async function pruneExpiredProfileNotes(now: Date = new Date()): Promise<void> {
  const notes = await prisma.wellbeingProfileNote.deleteMany({
    where: { expiresAt: { lte: now }, purgeWarnedAt: { lte: profilePurgeWarnedCutoff(now) } },
  });
  if (notes.count > 0) logger.info('Wellbeing', `${notes.count} note(s) de fiche échue(s) effacée(s).`);
  await prisma.wellbeingProfile.deleteMany({
    where: { notes: { none: {} }, updatedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });
}
