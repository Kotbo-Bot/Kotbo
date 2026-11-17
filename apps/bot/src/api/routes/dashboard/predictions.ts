import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getPredictionData } from '../../../services/analytics/predictionService.js';
import { getGuildPlan } from '../../../services/system/planService.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

export function createPredictionsRouter(client: Client) {
  const router = new Hono();

  router.get('/api/dashboard/guilds/:guildId/predictions', ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    if ((await getGuildPlan(guildId)) === 'FREE') {
      return send(c, { error: 'plan_required', message: "Les prédictions font partie de l'offre Plus." }, 402);
    }
    try {
      // `getPredictionData` borne déjà la fenêtre à [7, 90] ; on se contente ici
      // de neutraliser une valeur non numérique (`?days=abc` donnait NaN, que
      // `Math.min/max` propageait jusqu'à la requête SQL).
      const raw = Number.parseInt(c.req.query('days') ?? '', 10);
      return send(c, await getPredictionData(guildId, Number.isFinite(raw) ? raw : 30));
    } catch (err) {
      logger.error('PredictionsAPI', 'Error fetching predictions:', err);
      return fail(c, err, 'Erreur lors de la récupération des prédictions', 'PredictionsAPI');
    }
  });

  return router;
}
