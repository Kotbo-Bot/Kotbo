import { Hono } from 'hono';
import crypto from 'node:crypto';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import prisma from '../../../utils/db.js';
import {
  pushWidgetForUser,
  clearWidgetForUser,
  refreshAllStaffWidgets,
} from '../../../services/integrations/widgetService.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

/** Token secret utilisé par les widgets externes (Scriptable, KWGT, widget Edge). */
function generateWidgetToken(): string {
  return `wgt_${crypto.randomBytes(24).toString('hex')}`;
}

export function createWidgetRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/widget';
  const gate = guildRoute(client);

  // Liste des subscriptions
  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.var.dashboardUser.userId;
    try {
      const subscriptions = await prisma.widgetSubscription.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });

      let mySubscription = subscriptions.find((s) => s.userId === userId) ?? null;

      // Génération paresseuse du token pour les subscriptions créées avant son introduction
      if (mySubscription && !mySubscription.token) {
        mySubscription = await prisma.widgetSubscription.update({
          where: { id: mySubscription.id },
          data: { token: generateWidgetToken() },
        });
      }

      return send(c, {
        // Le token est secret : on ne l'expose jamais pour les autres membres
        subscriptions: subscriptions.map(({ token: _token, ...rest }) => rest),
        mySubscription,
      });
    } catch (err) {
      logger.error('WidgetAPI', 'Error fetching widget data:', err);
      return fail(c, err, 'Erreur lors de la récupération des données widget', 'WidgetAPI');
    }
  });

  router.post(`${base}/rotate-token`, ...gate, async (c) => {
    try {
      const subscription = await prisma.widgetSubscription.update({
        where: { guildId_userId: { guildId: c.req.param('guildId'), userId: c.var.dashboardUser.userId } },
        data: { token: generateWidgetToken() },
      });
      return send(c, { success: true, token: subscription.token });
    } catch (err) {
      logger.error('WidgetAPI', 'Error rotating widget token:', err);
      return fail(c, err, 'Erreur lors de la régénération du token', 'WidgetAPI');
    }
  });

  // Activer le widget pour l'utilisateur connecté
  router.post(`${base}/activate`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.var.dashboardUser.userId;
    try {
      await prisma.widgetSubscription.upsert({
        where: { guildId_userId: { guildId, userId } },
        update: { enabled: true },
        create: { guildId, userId, enabled: true, token: generateWidgetToken() },
      });
      const result = await pushWidgetForUser(guildId, userId);
      return send(c, { success: result.ok, pushResult: result });
    } catch (err) {
      logger.error('WidgetAPI', 'Error activating widget:', err);
      return fail(c, err, 'Erreur lors de l\'activation du widget', 'WidgetAPI');
    }
  });

  router.post(`${base}/deactivate`, ...gate, async (c) => {
    const userId = c.var.dashboardUser.userId;
    try {
      await prisma.widgetSubscription.updateMany({
        where: { guildId: c.req.param('guildId'), userId },
        data: { enabled: false },
      });
      const result = await clearWidgetForUser(userId);
      return send(c, { success: true, clearResult: result });
    } catch (err) {
      logger.error('WidgetAPI', 'Error deactivating widget:', err);
      return fail(c, err, 'Erreur lors de la désactivation du widget', 'WidgetAPI');
    }
  });

  router.post(`${base}/refresh`, ...gate, async (c) => {
    try {
      const result = await pushWidgetForUser(c.req.param('guildId'), c.var.dashboardUser.userId);
      return send(c, { success: true, pushResult: result });
    } catch (err) {
      logger.error('WidgetAPI', 'Error refreshing widget:', err);
      return fail(c, err, 'Erreur lors du rafraîchissement du widget', 'WidgetAPI');
    }
  });

  // Rafraîchir tous les widgets (admin)
  router.post(`${base}/refresh-all`, ...gate, async (c) => {
    try {
      return send(c, await refreshAllStaffWidgets(c.req.param('guildId')));
    } catch (err) {
      logger.error('WidgetAPI', 'Error refreshing all widgets:', err);
      return fail(c, err, 'Erreur lors du rafraîchissement global', 'WidgetAPI');
    }
  });

  return router;
}
