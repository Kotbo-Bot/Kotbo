/**
 * Routes `/api/dashboard/*` servies par Hono.
 *
 * Ce qui n'est pas encore ici passe par `routes/dashboard.ts` (ancien routeur),
 * atteint quand aucune route Hono ne correspond.
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { Client } from 'discord.js';
import { createAdminLockRouter } from '../../routes/dashboard/adminLock.js';
import { createAuditEventsRouter } from '../../routes/dashboard/auditEvents.js';
import { createQuestsRouter } from '../../routes/dashboard/quests.js';
import { createEvaluationsRouter } from '../../routes/dashboard/evaluations.js';
import { createPulseRouter } from '../../routes/dashboard/pulse.js';
import { createHomeTasksRouter } from '../../routes/dashboard/homeTasks.js';
import { createPredictionsRouter } from '../../routes/dashboard/predictions.js';
import { createSatisfactionRouter } from '../../routes/dashboard/satisfaction.js';
import { createMarketplaceRouter } from '../../routes/dashboard/marketplace.js';

export function createDashboardRouter(client: Client) {
  const router = new Hono();

  // L'ancien routeur compressait en gzip au-delà de 1 Ko : les listes du
  // dashboard (membres, journaux, analytics) en dépendent.
  router.use('/api/dashboard/*', compress({ threshold: 1024 }));

  router.route('/', createPredictionsRouter(client));
  router.route('/', createSatisfactionRouter(client));
  router.route('/', createMarketplaceRouter(client));

  router.route('/', createHomeTasksRouter(client));
  router.route('/', createPulseRouter(client));
  router.route('/', createEvaluationsRouter(client));
  router.route('/', createQuestsRouter(client));
  router.route('/', createAuditEventsRouter(client));
  router.route('/', createAdminLockRouter(client));
  return router;
}
