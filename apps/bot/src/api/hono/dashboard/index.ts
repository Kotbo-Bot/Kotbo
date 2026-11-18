/**
 * Routes `/api/dashboard/*` servies par Hono.
 *
 * Ce qui n'est pas encore ici passe par `routes/dashboard.ts` (ancien routeur),
 * atteint quand aucune route Hono ne correspond.
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { Client } from 'discord.js';
import { createImportRouter } from '../../routes/dashboard/modules/import.js';
import { createCommandAccessRouter } from '../../routes/dashboard/modules/command-access.js';
import { createDailyAlgoRunsRouter } from '../../routes/dashboard/modules/daily-algo-runs.js';
import { createTemplateRouter } from '../../routes/dashboard/modules/template.js';
import { createGhostMembersRouter } from '../../routes/dashboard/ghostMembers.js';
import { createChannelHealthRouter } from '../../routes/dashboard/channelHealth.js';
import { createMcpKeysRouter } from '../../routes/dashboard/mcp.js';
import { createWidgetRouter } from '../../routes/dashboard/widget.js';
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
  router.route('/', createWidgetRouter(client));
  router.route('/', createMcpKeysRouter(client));
  router.route('/', createChannelHealthRouter(client));
  router.route('/', createGhostMembersRouter(client));
  router.route('/', createTemplateRouter(client));
  router.route('/', createDailyAlgoRunsRouter(client));
  router.route('/', createCommandAccessRouter(client));
  router.route('/', createImportRouter(client));
  return router;
}
