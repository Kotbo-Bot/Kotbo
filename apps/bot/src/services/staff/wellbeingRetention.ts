/**
 * Conservation des dossiers de la cellule bien-être.
 *
 * Ces dossiers peuvent contenir des données sensibles (santé, conflits) : on
 * ne les garde pas indéfiniment. Un dossier fermé et inchangé depuis la durée
 * de conservation est supprimé avec ses notes.
 */
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { CLOSED_CASE_RETENTION_DAYS, closedCaseCutoff } from './wellbeingPolicy.js';

export async function pruneClosedWellbeingCases(now: Date = new Date()): Promise<void> {
  try {
    const { count } = await prisma.wellbeingCase.deleteMany({
      where: { status: 'CLOSED', updatedAt: { lt: closedCaseCutoff(now) } },
    });
    if (count > 0) {
      logger.info('Wellbeing', `${count} dossier(s) fermé(s) depuis plus de ${CLOSED_CASE_RETENTION_DAYS} jours supprimé(s).`);
    }
  } catch (error) {
    logger.error('Wellbeing', 'Purge des dossiers fermés en échec :', error);
  }
}
