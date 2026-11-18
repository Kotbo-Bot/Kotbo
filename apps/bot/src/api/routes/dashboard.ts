import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { json, verifyAuth } from '../shared.js';
import { cache } from '../../utils/cache.js';
import { resolveRequestIp } from '../../services/system/adminAuditService.js';
import { auditGlobalAdminWrite, evaluateGuildGate } from './dashboard/guildGate.js';

// Sub-routers imports
import { handleAnalyticsRoutes } from './dashboard/analytics.js';
import { handleGeneralistModulesRoutes } from './dashboard/generalistModules.js';
import { handleClansRoutes } from './dashboard/clans.js';

export async function handleDashboardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client
): Promise<boolean> {
  const method = req.method;

  // 1. Check if the path belongs to api/dashboard
  if (parts[0] !== 'api' || parts[1] !== 'dashboard') {
    return false;
  }

  // 3. Enforce authentication for all other dashboard routes
  const user = await verifyAuth(req);
  if (!user) {
    json(res, 401, { error: 'Non authentifié' });
    return true;
  }

  // 3bis. Ecritures d'un admin global : journalisees (voir guildGate.ts).
  await auditGlobalAdminWrite(client, user, parts, method ?? 'GET', resolveRequestIp(req));


  // 5. Check if it's a guild-specific route (/api/dashboard/guilds/:guildId/...)
  if (parts.length >= 4 && parts[2] === 'guilds') {
    const guildId = parts[3];

    const gate = await evaluateGuildGate(client, user, parts, method ?? 'GET');
    if (gate.denied) {
      json(res, gate.denied.status, gate.denied.body);
      return true;
    }
    const { effectiveAccess } = gate;

    // Dispatch to guild-specific sub-routers
    if (await handleAnalyticsRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    // Avant les modules généralistes, qui portent le reste du segment `automod`.
    // `access` et non `effectiveAccess` : la route doit savoir si le droit de
    // configurer vient d'un administrateur ou de la seule case « Configurer ».
    // Pas d'invalidation du cache derrière : une simulation n'écrit rien.
    if (await handleGeneralistModulesRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (parts[4] === 'clans') {
      if (await handleClansRoutes(req, res, parts, client, user, guildId, effectiveAccess)) {
        if (method !== 'GET') await cache.invalidateGuild(guildId);
        return true;
      }
    }
  }

  return false;
}
