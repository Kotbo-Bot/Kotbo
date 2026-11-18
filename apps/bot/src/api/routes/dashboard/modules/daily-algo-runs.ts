/** Routes dashboard du module `daily-algo-runs`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../../utils/logger.js';
import { broadcastDashboardStateChange } from '../../../shared.js';
import { ensureDailyAlgoScheduleRuns, getDailyAlgoScheduleRuns } from './_shared.js';
import { fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

export function createDailyAlgoRunsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/daily-algo-runs/schedule';

  router.get(base, ...guildRoute(client), async (c) => {
    try {
      const daysBack = Number(c.req.query('daysBack') ?? '7');
      const daysForward = Number(c.req.query('daysForward') ?? '21');
      const runs = await getDailyAlgoScheduleRuns(c.req.param('guildId'), daysBack, daysForward);
      return send(c, { runs });
    } catch (err) {
      logger.error('DailyAlgoAPI', 'Erreur lors de la récupération du planning Daily Algo:', err);
      return fail(c, err, 'Erreur lors de la récupération du planning Daily Algo', 'DailyAlgoAPI');
    }
  });

  router.post(`${base}/ensure`, ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{ daysForward?: unknown }>(c);
      const parsedDaysForward = Number(body?.daysForward ?? c.req.query('daysForward') ?? '21');
      const daysForward = Number.isFinite(parsedDaysForward) ? parsedDaysForward : 21;
      const result = await ensureDailyAlgoScheduleRuns(guildId, daysForward);
      // Uniquement si le planning a reellement bouge : cette route est appelee
      // automatiquement a l'ouverture de la page, et prevenir les clients d'un
      // appel qui n'a rien cree ne ferait que les faire rappeler cette route.
      if (result.createdCount > 0) {
        broadcastDashboardStateChange(guildId, 'daily_algo_schedule_updated');
      }
      return send(c, { ok: true, ...result });
    } catch (err) {
      logger.error('DailyAlgoAPI', 'Erreur lors de la génération du planning Daily Algo:', err);
      return fail(c, err, 'Erreur lors de la génération du planning Daily Algo', 'DailyAlgoAPI');
    }
  });

  return router;
}
