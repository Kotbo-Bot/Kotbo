/**
 * Purge quotidienne des données AegisAI :
 * - l'extrait d'une détection suit la rétention des logs de messages du
 *   serveur (`messageLoggingRetentionDays`) : c'est du contenu de message ;
 * - la détection elle-même, sans contenu, reste un an pour l'historique ;
 * - les agrégats restent 400 jours, de quoi comparer à l'année d'avant.
 */
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';

const DETECTION_DAYS = 365;
const STATS_DAYS = 400;

function dateKeyDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function pruneAegisData(): Promise<void> {
  const excerpts = await prisma.$executeRaw`
    UPDATE "aegis_detections" AS d
    SET "excerpt" = NULL
    FROM "guilds" AS g
    WHERE d."guildId" = g."id"
      AND d."excerpt" IS NOT NULL
      AND d."createdAt" < NOW() - make_interval(days => g."messageLoggingRetentionDays")`;
  const detections = await prisma.aegisDetection.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - DETECTION_DAYS * 86_400_000) } },
  });
  const cutoff = dateKeyDaysAgo(STATS_DAYS);
  const hourly = await prisma.aegisHourlyStat.deleteMany({ where: { dateKey: { lt: cutoff } } });
  const members = await prisma.aegisMemberDailyStat.deleteMany({ where: { dateKey: { lt: cutoff } } });
  if (excerpts + detections.count + hourly.count + members.count > 0) {
    logger.info('AegisAI', `Purge : ${excerpts} extrait(s) effacé(s), ${detections.count} détection(s), ${hourly.count + members.count} agrégat(s).`);
  }
}
