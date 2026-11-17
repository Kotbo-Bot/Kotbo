import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import {
  getPulseDashboardDataWithToday,
  backfillPulseHistory,
} from '../../../services/analytics/pulseService.js';
import { invalidatePredictionCache } from '../../../services/analytics/predictionService.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

/** Nombre de jours reconsolidés par un « Recalculer ». */
const REFRESH_BACKFILL_DAYS = 7;

/**
 * Un recalcul rejoue plusieurs jours et coûte donc bien plus qu'une lecture :
 * on évite qu'un double-clic (ou plusieurs onglets ouverts) le déclenche en
 * rafale sur la même guilde.
 */
const REFRESH_COOLDOWN_MS = 30_000;
const lastRefreshAt = new Map<string, number>();

export function createPulseRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/pulse';

  router.get(base, ...guildRoute(client), async (c) => {
    try {
      return send(c, await getPulseDashboardDataWithToday(client, c.req.param('guildId')));
    } catch (err) {
      logger.error('PulseAPI', 'Error fetching pulse data:', err);
      return fail(c, err, 'Erreur lors de la récupération des données Pulse', 'PulseAPI');
    }
  });

  router.post(`${base}/refresh`, ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    const now = Date.now();
    const previous = lastRefreshAt.get(guildId) ?? 0;
    if (now - previous < REFRESH_COOLDOWN_MS) {
      return send(c, {
        error: 'Recalcul déjà en cours, réessayez dans quelques secondes.',
        retryAfterMs: REFRESH_COOLDOWN_MS - (now - previous),
      }, 429);
    }
    lastRefreshAt.set(guildId, now);

    try {
      const written = await backfillPulseHistory(client, guildId, REFRESH_BACKFILL_DAYS);
      invalidatePredictionCache(guildId);
      const data = await getPulseDashboardDataWithToday(client, guildId);
      return send(c, { ...data, recomputedDays: written });
    } catch (err) {
      lastRefreshAt.delete(guildId);
      logger.error('PulseAPI', 'Error refreshing pulse:', err);
      return fail(c, err, 'Erreur lors du rafraîchissement', 'PulseAPI');
    }
  });

  return router;
}
