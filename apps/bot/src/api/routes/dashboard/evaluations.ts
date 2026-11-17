import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import {
  getEvaluationsDashboardData,
  generateStaffEvaluation,
  generateAllStaffEvaluations,
  updateEvaluationNote,
} from '../../../services/staff/staffEvaluationService.js';
import { fail, guildRoute, send } from '../../hono/dashboard/kit.js';

/** Corps tolérant (sans Content-Type exigé, `{}` si vide), comme l'ancienne route. */
async function parseBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return JSON.parse((await c.req.text()) || '{}');
  } catch {
    throw new Error('Invalid JSON');
  }
}

export function createEvaluationsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/evaluations';

  router.get(base, ...guildRoute(client), async (c) => {
    try {
      return send(c, await getEvaluationsDashboardData(c.req.param('guildId')));
    } catch (err) {
      logger.error('EvaluationsAPI', 'Error fetching evaluations:', err);
      return fail(c, err, 'Erreur lors de la récupération des évaluations', 'EvaluationsAPI');
    }
  });

  router.post(`${base}/generate`, ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await parseBody(c) as { staffUserId?: string; periodDays?: number };
      if (body.staffUserId) {
        return send(c, await generateStaffEvaluation(guildId, body.staffUserId, body.periodDays ?? 30));
      }
      const evaluations = await generateAllStaffEvaluations(guildId, body.periodDays ?? 30);
      return send(c, { evaluations, count: evaluations.length });
    } catch (err) {
      logger.error('EvaluationsAPI', 'Error generating evaluation:', err);
      return fail(c, err, 'Erreur lors de la génération', 'EvaluationsAPI');
    }
  });

  router.patch(`${base}/:evaluationId`, ...guildRoute(client), async (c) => {
    try {
      const body = await parseBody(c) as { managerNote?: string };
      if (body.managerNote === undefined) return send(c, { error: 'managerNote requis' }, 400);
      return send(c, await updateEvaluationNote(c.req.param('evaluationId'), body.managerNote));
    } catch (err) {
      logger.error('EvaluationsAPI', 'Error updating evaluation:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'EvaluationsAPI');
    }
  });

  return router;
}
