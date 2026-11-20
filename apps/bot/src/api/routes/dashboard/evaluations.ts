import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import {
  getEvaluationsDashboardData,
  generateStaffEvaluation,
  generateAllStaffEvaluations,
  updateEvaluationNote,
} from '../../../services/staff/staffEvaluationService.js';
import { fail, guildRoute, readLenientBody, send } from '../../hono/dashboard/kit.js';

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
      const body = await readLenientBody<{ staffUserId?: string; periodDays?: number }>(c);
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
      const body = await readLenientBody<{ managerNote?: string }>(c);
      if (body.managerNote === undefined) return send(c, { error: 'managerNote requis' }, 400);
      return send(c, await updateEvaluationNote(c.req.param('guildId')!, c.req.param('evaluationId'), body.managerNote));
    } catch (err) {
      logger.error('EvaluationsAPI', 'Error updating evaluation:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'EvaluationsAPI');
    }
  });

  return router;
}
