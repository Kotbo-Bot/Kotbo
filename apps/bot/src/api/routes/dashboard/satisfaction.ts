import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getSatisfactionDashboardData, getStaffSatisfactionReviews } from '../../../services/features/ticketSatisfactionService.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

export function createSatisfactionRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/satisfaction';

  router.get(base, ...guildRoute(client), async (c) => {
    try {
      return send(c, await getSatisfactionDashboardData(c.req.param('guildId'), client));
    } catch (err) {
      logger.error('SatisfactionAPI', 'Error fetching satisfaction data:', err);
      return fail(c, err, 'Erreur lors de la récupération des données', 'SatisfactionAPI');
    }
  });

  router.get(`${base}/staff/:staffId/reviews`, ...guildRoute(client), async (c) => {
    const staffId = c.req.param('staffId');
    if (!/^\d{5,25}$/.test(staffId)) return send(c, { error: 'Identifiant staff invalide' }, 400);
    try {
      const data = await getStaffSatisfactionReviews(
        c.req.param('guildId'),
        staffId,
        {
          limit: Number(c.req.query('limit') ?? 20),
          offset: Number(c.req.query('offset') ?? 0),
          commentsOnly: c.req.query('commentsOnly') === 'true',
        },
        client,
      );
      return send(c, data);
    } catch (err) {
      logger.error('SatisfactionAPI', 'Error fetching staff reviews:', err);
      return fail(c, err, 'Erreur lors de la récupération des avis', 'SatisfactionAPI');
    }
  });

  return router;
}
