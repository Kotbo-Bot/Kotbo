import { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../../../utils/logger.js';
import { resolveViewTimezone } from '../../../utils/timezone.js';
import { json, type DashboardAccess, type FeatureAccessMap } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import { getMemberSummary } from '../../../services/moderation/memberSummaryService.js';
import { getMemberTimeline, TIMELINE_CATEGORIES, type TimelineCategory } from '../../../services/moderation/memberTimelineService.js';
import { getMemberInsights } from '../../../services/analytics/memberInsightsService.js';
import { getMemberClimate } from '../../../services/moderation/aegis/aegisInsights.js';
import prisma from '../../../utils/db.js';

/**
 * Fiche membre complète :
 *   GET /members/:userId/summary   synthèse, signaux, statistiques d'activité
 *                                  et climat (Kotbo × AegisAI, si le module a servi)
 *   GET /members/:userId/timeline  chronologie, paginée par `before`
 *
 * Même droit que le dossier membre (`GET /members/:userId`) : la section
 * Membres du centre de gestion.
 */
export async function handleMemberProfileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  guildId: string,
  access: DashboardAccess,
  featureAccess: FeatureAccessMap,
): Promise<boolean> {
  if (req.method !== 'GET' || parts.length !== 7 || parts[4] !== 'members') return false;
  if (parts[6] !== 'summary' && parts[6] !== 'timeline') return false;

  const canViewMembers = access.canManageSettings || featureAccess?.members?.canView !== false;
  if (!canViewMembers) {
    json(res, 403, { error: 'Accès refusé. La section Membres ne vous est pas ouverte.', code: 'feature_denied', featureKey: 'members' });
    return true;
  }

  const userId = parts[5].startsWith('!') ? parts[5].slice(1) : parts[5];
  if (!/^\d{17,20}$/.test(userId)) {
    json(res, 400, { error: 'Identifiant de membre invalide.' });
    return true;
  }

  try {
    if (parts[6] === 'summary') {
      const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days')) || 90));
      const timezone = await resolveViewTimezone(url.searchParams.get('tz'), guildId);
      const aegisUsed = await prisma.aegisConfig.count({ where: { guildId } }).catch(() => 0);
      const [summary, insights, climate] = await Promise.all([
        getMemberSummary(guildId, userId),
        getMemberInsights(guildId, userId, days, timezone).catch((err) => {
          logger.warn('MemberProfileAPI', `Statistiques de ${userId} indisponibles :`, err);
          return null;
        }),
        // Les extraits de messages restent au staff de modération.
        aegisUsed
          ? getMemberClimate(guildId, userId, Math.min(days, 30), access.level === 'admin' || access.level === 'moderator').catch((err) => {
            logger.warn('MemberProfileAPI', `Climat de ${userId} indisponible :`, err);
            return null;
          })
          : null,
      ]);
      json(res, 200, { summary, insights, climate });
      return true;
    }

    const beforeParam = url.searchParams.get('before');
    const before = beforeParam ? new Date(beforeParam) : null;
    if (before && Number.isNaN(before.getTime())) {
      json(res, 400, { error: 'Curseur de pagination invalide.' });
      return true;
    }
    const categories = (url.searchParams.get('categories') ?? '')
      .split(',')
      .filter((value): value is TimelineCategory => (TIMELINE_CATEGORIES as string[]).includes(value));
    const limit = Number(url.searchParams.get('limit')) || 40;
    json(res, 200, await getMemberTimeline(guildId, userId, { before, categories, limit }));
  } catch (err) {
    logger.error('MemberProfileAPI', `Fiche de ${userId} :`, err);
    jsonFailure(res, err, 'Erreur lors du chargement de la fiche membre', 'MemberProfileAPI');
  }
  return true;
}
