import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { json, verifyAuth } from '../shared.js';
import { cache } from '../../utils/cache.js';
import { resolveRequestIp } from '../../services/system/adminAuditService.js';
import { auditGlobalAdminWrite, evaluateGuildGate } from './dashboard/guildGate.js';

// Sub-routers imports
import { handleGeneralRoutes, handleGuildGeneralRoutes } from './dashboard/general.js';
import { handleAnalyticsRoutes } from './dashboard/analytics.js';
import { handleRecruitmentWebhookRoute, handleRecruitmentRoutes } from './dashboard/recruitment.js';
import { handleBanAppealRoutes } from './dashboard/banAppeals.js';
import { handleMembersRoutes } from './dashboard/members.js';
import { handleLeadershipRoutes, handleGuildLeadershipRoutes } from './dashboard/leadership.js';
import { handleModulesRoutes } from './dashboard/modules.js';
import { handleGeneralistModulesRoutes } from './dashboard/generalistModules.js';
import { handleDoingListRoutes } from './dashboard/doingLists.js';
import { handleAegisRoutes } from './dashboard/aegis.js';
import { handleCustomBotRoutes } from './dashboard/customBot.js';
import { handleHomeWidgetsRoutes } from './dashboard/homeWidgets.js';
import { handleRankedRoutes } from './dashboard/ranked.js';
import { handleRaidProtectionRoutes } from './dashboard/raidProtection.js';
import { handleClansRoutes } from './dashboard/clans.js';
import { getCachedFeatureAccess } from './dashboard/featureGate.js';

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

  // 2. Bypass authentication for recruitment webhook (POST /api/dashboard/guilds/:guildId/recruitment/candidatures)
  if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'recruitment' && parts[5] === 'candidatures' && method === 'POST') {
    if (await handleRecruitmentWebhookRoute(req, res, parts, client)) {
      return true;
    }
  }

  // 3. Enforce authentication for all other dashboard routes
  const user = await verifyAuth(req);
  if (!user) {
    json(res, 401, { error: 'Non authentifié' });
    return true;
  }

  // 3bis. Ecritures d'un admin global : journalisees (voir guildGate.ts).
  await auditGlobalAdminWrite(client, user, parts, method ?? 'GET', resolveRequestIp(req));

  // 4. Try general, non-guild-specific routes first (translate, list guilds, staff profile snapshots)
  if (await handleGeneralRoutes(req, res, parts, url, client, user)) {
    return true;
  }
  if (await handleLeadershipRoutes(req, res, parts, url, client, user)) {
    return true;
  }

  // 5. Check if it's a guild-specific route (/api/dashboard/guilds/:guildId/...)
  if (parts.length >= 4 && parts[2] === 'guilds') {
    const guildId = parts[3];

    const gate = await evaluateGuildGate(client, user, parts, method ?? 'GET');
    if (gate.denied) {
      json(res, gate.denied.status, gate.denied.body);
      return true;
    }
    const { access, effectiveAccess } = gate;

    // Dispatch to guild-specific sub-routers
    if (await handleGuildGeneralRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleAnalyticsRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleRecruitmentRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleBanAppealRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleRaidProtectionRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (['linked-accounts', 'detections', 'members', 'invitations'].includes(parts[4])) {
      // `access` et non `effectiveAccess` : l'elevation ci-dessus vaut pour la
      // seule fonctionnalite visee, alors que cette carte est calculee - et
      // mise en cache - pour toutes. La nourrir de l'accès eleve ferait
      // remonter « peut configurer » sur chaque fonctionnalite sans regle de
      // role, et la lecture suivante relirait ce mensonge dans le cache.
      const featureAccess = await getCachedFeatureAccess(client, guildId, access, user.userId);
      if (await handleMembersRoutes(req, res, parts, url, client, user, guildId, effectiveAccess, featureAccess)) {
        if (method !== 'GET') await cache.invalidateGuild(guildId);
        return true;
      }
    }
    if (await handleGuildLeadershipRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleModulesRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
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
    if (await handleAegisRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleDoingListRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      return true;
    }
    if (await handleCustomBotRoutes(req, res, parts, url, client, user)) {
      return true;
    }
    if (await handleHomeWidgetsRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
      return true;
    }
    if (await handleRankedRoutes(req, res, parts, url, client, user, guildId, effectiveAccess)) {
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
