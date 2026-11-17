/**
 * Routes `/api/dashboard/*` servies par Hono.
 *
 * Ce qui n'est pas encore ici passe par `routes/dashboard.ts` (ancien routeur),
 * atteint quand aucune route Hono ne correspond.
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { Client } from 'discord.js';

export function createDashboardRouter(client: Client) {
  const router = new Hono();

  // L'ancien routeur compressait en gzip au-delà de 1 Ko : les listes du
  // dashboard (membres, journaux, analytics) en dépendent.
  router.use('/api/dashboard/*', compress({ threshold: 1024 }));

  return router;
}
