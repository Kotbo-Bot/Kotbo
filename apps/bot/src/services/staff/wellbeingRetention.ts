/**
 * Conservation des dossiers de la cellule bien-être.
 *
 * Ces dossiers peuvent contenir des données sensibles (santé, conflits) : on
 * ne les garde pas indéfiniment. Un dossier fermé et inchangé depuis la durée
 * de conservation est supprimé avec ses notes, comme un dossier resté en
 * corbeille au-delà de son délai de restauration.
 */
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { CASE_TRASH_DAYS, CLOSED_CASE_RETENTION_DAYS, closedCaseCutoff, purgeWarnedCutoff, trashCutoff } from './wellbeingPolicy.js';

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
  } catch (error) {
    logger.error('Wellbeing', 'Purge des dossiers fermés en échec :', error);
  }
}
