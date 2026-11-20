/**
 * GET /api/dashboard/guilds/:guildId/home-tasks
 *
 * Liste « a traiter » de l'accueil. Le calcul et le filtrage par droit vivent
 * dans `services/core/homeTasksService.ts` ; la route ne fait que resoudre le
 * lecteur.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { buildHomeTasks } from '../../../services/core/homeTasksService.js';
import { getCachedFeatureAccess } from './featureGate.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

export function createHomeTasksRouter(client: Client) {
  const router = new Hono();

  router.get('/api/dashboard/guilds/:guildId/home-tasks', ...guildRoute(client, { invalidateCache: false }), async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const userId = c.var.dashboardUser.userId;
    try {
      const featureAccess = await getCachedFeatureAccess(client, guildId, access, userId);
      return send(c, await buildHomeTasks(client, guildId, {
        userId,
        canManageSettings: access.canManageSettings,
        canView: (featureKey) => featureAccess[featureKey]?.canView !== false,
      }));
    } catch (err) {
      logger.error('HomeTasksAPI', 'Error building home tasks:', err);
      return fail(c, err, 'Erreur lors du calcul des sujets à traiter', 'HomeTasksAPI');
    }
  });

  return router;
}
