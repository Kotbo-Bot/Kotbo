import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { DASHBOARD_TELEMETRY_LIMITS, sanitizeTelemetryEntry, type DashboardTelemetryEntry } from '@kotbo/contracts';
import { logger } from '../../../utils/logger.js';
import { checkRateLimit, resolveAdminAccess, resolveDashboardAccess } from '../../shared.js';
import { ensureDashboardTelemetryFlusher, recordTelemetryBatch } from '../../../services/analytics/dashboardTelemetryService.js';
import { dashboardAuth, readBody, send } from '../../hono/dashboard/kit.js';

/** Un onglet envoie un lot toutes les 30 s, plus un au départ : 20/min laisse de la marge à plusieurs onglets. */
const telemetryRateLimiter = new Map<string, number[]>();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

/**
 * POST /api/dashboard/telemetry
 *
 * Reçoit un lot d'événements agrégés par le navigateur. Répond toujours 204
 * quand la requête est bien formée, y compris quand le lot est écarté : la
 * télémétrie ne doit jamais faire apparaître d'erreur dans le dashboard.
 */
export function createTelemetryRouter(client: Client) {
  const router = new Hono();
  const path = '/api/dashboard/telemetry';

  router.post(path, dashboardAuth, async (c) => {
    const user = c.var.dashboardUser;
    if (!checkRateLimit(telemetryRateLimiter, user.userId, RATE_LIMIT, RATE_WINDOW_MS)) {
      return send(c, { error: 'Trop de requêtes' }, 429);
    }

    let body: { entries?: unknown } | null;
    try {
      body = await readBody<{ entries?: unknown }>(c);
    } catch {
      return send(c, { error: 'Corps invalide' }, 400);
    }

    const rawEntries = Array.isArray(body?.entries) ? body.entries : [];
    if (rawEntries.length === 0) {
      return c.body(null, 204);
    }

    // Les admins globaux parcourent tous les serveurs pour le support : les
    // compter fausserait l'usage réel.
    if (await resolveAdminAccess(client, user.userId)) {
      return c.body(null, 204);
    }

    const entries: DashboardTelemetryEntry[] = [];
    for (const raw of rawEntries.slice(0, DASHBOARD_TELEMETRY_LIMITS.maxEntriesPerBatch)) {
      const entry = sanitizeTelemetryEntry(raw);
      if (entry) entries.push(entry);
    }

    // Un compteur n'est rattaché qu'à un serveur dont la personne voit le dashboard.
    const allowedGuilds = new Map<string, boolean>();
    for (const guildId of new Set(entries.map((e) => e.guildId))) {
      if (!guildId) {
        allowedGuilds.set(guildId, true);
        continue;
      }
      try {
        const access = await resolveDashboardAccess(client, guildId, user.userId);
        allowedGuilds.set(guildId, access.canViewDashboard);
      } catch {
        allowedGuilds.set(guildId, false);
      }
    }

    const accepted = entries.filter((e) => allowedGuilds.get(e.guildId));
    try {
      ensureDashboardTelemetryFlusher();
      await recordTelemetryBatch(user.userId, accepted);
    } catch (error) {
      logger.error('DashboardTelemetry', 'Lot de télémétrie non enregistré :', error);
    }

    return c.body(null, 204);
  });

  router.all(path, dashboardAuth, (c) => send(c, { error: 'Méthode non autorisée' }, 405));

  return router;
}
