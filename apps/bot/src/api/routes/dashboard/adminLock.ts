import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { decideAdminLockRequest, isAdminLockBypassed, type AdminLockDecision } from '../../../services/moderation/adminLockService.js';
import { getOrCreateAutoModConfig } from '../../../services/moderation/autoModService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

/**
 * Routes de gestion des demandes Admin Permission Lock.
 * Base: /api/dashboard/guilds/:guildId/admin-lock
 */
export function createAdminLockRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/admin-lock';

  const moderatorOnly = createMiddleware(async (c, next) => {
    if (!c.var.effectiveAccess.canModerateContent) {
      return send(c, { error: 'Accès modérateur requis pour consulter Admin Permission Lock' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), moderatorOnly] as const;

  // Liste (filtre ?status=)
  router.get(base, ...gate, async (c) => {
    try {
      const status = c.req.query('status') || undefined;
      const requests = await prisma.adminPermissionRequest.findMany({
        where: { guildId: c.req.param('guildId'), ...(status ? { status: status as never } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return send(c, { requests });
    } catch (err) {
      logger.error('AdminLockAPI', 'Error listing requests:', err);
      return fail(c, err, 'Erreur lors de la récupération des demandes', 'AdminLockAPI');
    }
  });

  router.get(`${base}/:requestId`, ...gate, async (c) => {
    try {
      const request = await prisma.adminPermissionRequest.findFirst({
        where: { id: c.req.param('requestId'), guildId: c.req.param('guildId') },
      });
      if (!request) return send(c, { error: 'Demande introuvable' }, 404);
      return send(c, { request });
    } catch (err) {
      logger.error('AdminLockAPI', 'Error getting request detail:', err);
      return fail(c, err, 'Erreur lors de la récupération de la demande', 'AdminLockAPI');
    }
  });

  // { decision: APPROVED|REJECTED, reason? }
  router.post(`${base}/:requestId/decide`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      // Un compte admin compromis avec un simple accès dashboard (canManageSettings)
      // ne doit jamais pouvoir approuver sa propre demande : seul le owner ou un
      // membre d'un rôle "sécurité" configuré peut décider, pas l'accès générique.
      const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) return send(c, { error: 'Serveur Discord introuvable' }, 404);
      const config = await getOrCreateAutoModConfig(guildId);
      if (!isAdminLockBypassed(guild, user.userId, config.adminLockSecurityRoleIds)) {
        return send(c, { error: 'Seul le propriétaire du serveur ou un rôle sécurité peut traiter cette demande.' }, 403);
      }

      const body = await readBody<{ decision: AdminLockDecision; reason?: string }>(c);
      if (!body?.decision || !['APPROVED', 'REJECTED'].includes(body.decision)) {
        return send(c, { error: 'Décision invalide' }, 400);
      }

      const result = await decideAdminLockRequest(client, {
        requestId: c.req.param('requestId'),
        guildId,
        decision: body.decision,
        staffUserId: user.userId,
        staffTag: user.username,
        reason: body.reason?.trim() || undefined,
      });

      if (!result.ok) return send(c, { error: result.error }, 409);
      return send(c, { request: result.request });
    } catch (err) {
      logger.error('AdminLockAPI', 'Error deciding request:', err);
      return fail(c, err, 'Erreur lors de la décision', 'AdminLockAPI');
    }
  });

  return router;
}
