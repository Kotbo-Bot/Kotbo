import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { resolveViewTimezone } from '../../../utils/timezone.js';
import { getMemberSummary } from '../../../services/moderation/memberSummaryService.js';
import { getMemberTimeline, TIMELINE_CATEGORIES, type TimelineCategory } from '../../../services/moderation/memberTimelineService.js';
import { getMemberInsights } from '../../../services/analytics/memberInsightsService.js';
import { getMemberClimate } from '../../../services/moderation/aegis/aegisInsights.js';
import prisma from '../../../utils/db.js';
import { getCachedFeatureAccess } from './featureGate.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

/**
 * Fiche membre complète :
 *   GET /members/:userId/summary   synthèse, signaux, statistiques d'activité
 *                                  et climat (Kotbo × AegisAI, si le module a servi)
 *   GET /members/:userId/timeline  chronologie, paginée par `before`
 *
 * Même droit que le dossier membre (`GET /members/:userId`) : la section
 * Membres du centre de gestion.
 */
export function createMemberProfileRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/members/:userId';
  const gate = guildRoute(client, { invalidateCache: false });

  /** Droit de lecture et identifiant du membre, ou la réponse de refus. */
  async function resolveMember(c: Context): Promise<{ userId: string } | Response> {
    const guildId = c.req.param('guildId')!;
    // `access` et non `effectiveAccess` : la carte des droits est mise en cache
    // pour toutes les fonctionnalités (voir routes/dashboard.ts).
    const featureAccess = await getCachedFeatureAccess(client, guildId, c.var.access, c.var.dashboardUser.userId);
    const canViewMembers = c.var.effectiveAccess.canManageSettings || featureAccess?.members?.canView !== false;
    if (!canViewMembers) {
      return send(c, { error: 'Accès refusé. La section Membres ne vous est pas ouverte.', code: 'feature_denied', featureKey: 'members' }, 403);
    }
    const raw = c.req.param('userId')!;
    const userId = raw.startsWith('!') ? raw.slice(1) : raw;
    if (!/^\d{17,20}$/.test(userId)) return send(c, { error: 'Identifiant de membre invalide.' }, 400);
    return { userId };
  }

  router.get(`${base}/summary`, ...gate, async (c) => {
    const member = await resolveMember(c);
    if (member instanceof Response) return member;
    const { userId } = member;
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    try {
      const days = Math.min(90, Math.max(7, Number(c.req.query('days')) || 90));
      const timezone = await resolveViewTimezone(c.req.query('tz') ?? null, guildId);
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
      return send(c, { summary, insights, climate });
    } catch (err) {
      logger.error('MemberProfileAPI', `Fiche de ${userId} :`, err);
      return fail(c, err, 'Erreur lors du chargement de la fiche membre', 'MemberProfileAPI');
    }
  });

  router.get(`${base}/timeline`, ...gate, async (c) => {
    const member = await resolveMember(c);
    if (member instanceof Response) return member;
    const { userId } = member;
    try {
      const beforeParam = c.req.query('before');
      const before = beforeParam ? new Date(beforeParam) : null;
      if (before && Number.isNaN(before.getTime())) return send(c, { error: 'Curseur de pagination invalide.' }, 400);
      const categories = (c.req.query('categories') ?? '')
        .split(',')
        .filter((value): value is TimelineCategory => (TIMELINE_CATEGORIES as string[]).includes(value));
      const limit = Number(c.req.query('limit')) || 40;
      return send(c, await getMemberTimeline(c.req.param('guildId'), userId, { before, categories, limit }));
    } catch (err) {
      logger.error('MemberProfileAPI', `Fiche de ${userId} :`, err);
      return fail(c, err, 'Erreur lors du chargement de la fiche membre', 'MemberProfileAPI');
    }
  });

  return router;
}
