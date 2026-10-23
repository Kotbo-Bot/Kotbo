/** Routes dashboard du module `daily-algo-runs`. */
import { logger } from '../../../../utils/logger.js';
import { broadcastDashboardStateChange, json, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext, ensureDailyAlgoScheduleRuns, getDailyAlgoScheduleRuns } from './_shared.js';

import { jsonFailure } from '../../../shared/failure.js';
export async function handleDailyAlgoRunsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, url, guildId, method, moduleKey } = ctx;

  // Daily-algo runs routes
  if (moduleKey === 'daily-algo-runs') {
    // GET /api/dashboard/guilds/:guildId/daily-algo-runs/schedule
    if (parts.length === 6 && parts[5] === 'schedule' && method === 'GET') {
      try {
        const daysBack = Number(url.searchParams.get('daysBack') ?? '7');
        const daysForward = Number(url.searchParams.get('daysForward') ?? '21');
        const runs = await getDailyAlgoScheduleRuns(guildId, daysBack, daysForward);
        json(res, 200, { runs });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la récupération du planning Daily Algo:', err);
        jsonFailure(res, err, 'Erreur lors de la récupération du planning Daily Algo', 'DailyAlgoAPI');
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/daily-algo-runs/schedule/ensure
    if (parts.length === 7 && parts[5] === 'schedule' && parts[6] === 'ensure' && method === 'POST') {
      try {
        const body = await readJsonBody<{ daysForward?: unknown }>(req);
        const parsedDaysForward = Number(body?.daysForward ?? url.searchParams.get('daysForward') ?? '21');
        const daysForward = Number.isFinite(parsedDaysForward) ? parsedDaysForward : 21;
        const result = await ensureDailyAlgoScheduleRuns(guildId, daysForward);
        // Uniquement si le planning a reellement bouge : cette route est appelee
        // automatiquement a l'ouverture de la page, et prevenir les clients d'un
        // appel qui n'a rien cree ne ferait que les faire rappeler cette route.
        if (result.createdCount > 0) {
          broadcastDashboardStateChange(guildId, 'daily_algo_schedule_updated');
        }
        json(res, 200, { ok: true, ...result });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la génération du planning Daily Algo:', err);
        jsonFailure(res, err, 'Erreur lors de la génération du planning Daily Algo', 'DailyAlgoAPI');
      }
      return true;
    }
  }

  return false;
}
