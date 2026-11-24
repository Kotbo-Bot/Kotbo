/** Routes dashboard du module `management`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { cache } from '../../../../utils/cache.js';
import { logger } from '../../../../utils/logger.js';
import { broadcastDashboardStateChange, getGuildName, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { withoutManagedRoles } from '../../../../services/core/dashboardAccessRoles.js';
import { isRestrictedModule } from '@kotbo/contracts';

/** Un module confidentiel (cellule bien-être) décide seul de son accès : aucune règle ne s'y écrit. */
const RESTRICTED_ERROR = "Ce module gère son accès dans sa propre configuration : le Centre de gestion n'y donne aucun droit.";

export function createManagementRouter(client: Client) {
  const router = new Hono();

  router.put('/api/dashboard/guilds/:guildId/management/features/:featureKey/role-access', ...guildRoute(client), async (c) => {
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions administratives requises.' }, 403);
    }
    const guildId = c.req.param('guildId');
    const featureKey = c.req.param('featureKey');
    if (isRestrictedModule(featureKey)) return send(c, { error: RESTRICTED_ERROR }, 403);
    try {
      const body = await readBody<{
        roleAccessConfigs: Array<{
          roleId: string;
          canView?: boolean;
          canModerate?: boolean;
          canConfigure?: boolean;
          canDelete?: boolean;
        }>;
      }>(c);
      if (!body || !Array.isArray(body.roleAccessConfigs)) {
        return send(c, { error: "Payload d'accès de rôle invalide" }, 400);
      }

      const featureConfig = await prisma.dashboardFeatureConfig.findUnique({
        where: { guildId_featureKey: { guildId, featureKey } }
      });
      if (!featureConfig) return send(c, { error: 'Configuration du module introuvable' }, 404);

      const { updateRoleAccess } = await import('../../../../services/core/dashboardManagementService.js');
      // Enregistrer la matrice purge aussi les règles héritées sur des rôles de bots.
      const roleAccessConfigs = withoutManagedRoles(client.guilds.cache.get(guildId), body.roleAccessConfigs);
      const updated = await updateRoleAccess(guildId, featureConfig.id, roleAccessConfigs);

      // Les droits de dashboard sont mis en cache sous le prefixe `guild:`.
      // Sans purge, un membre garde ses anciens acces jusqu'a une minute.
      await cache.invalidateGuild(guildId);
      broadcastDashboardStateChange(guildId, 'role_access_updated');

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Mise à jour accès rôle',
        context: getGuildName(client, guildId),
        module: 'Configuration',
        eventType: 'Manuel',
        details: `Accès rôles pour le module "${featureKey}" mis à jour (${body.roleAccessConfigs.length} rôles).`,
        channelId: null
      });

      return send(c, { ok: true, config: updated });
    } catch (err) {
      logger.error('ManagementAPI', `Error updating role access for ${featureKey}:`, err);
      return fail(c, err, 'Erreur lors de la mise à jour des permissions du module', 'ManagementAPI');
    }
  });

  // Droits des cles MCP sur un module : meme matrice, meme endroit que les roles.
  router.put('/api/dashboard/guilds/:guildId/management/features/:featureKey/key-access', ...guildRoute(client), async (c) => {
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions administratives requises.' }, 403);
    }
    const guildId = c.req.param('guildId');
    const featureKey = c.req.param('featureKey');
    if (isRestrictedModule(featureKey)) return send(c, { error: RESTRICTED_ERROR }, 403);
    try {
      const body = await readBody<{
        keyAccessConfigs: Array<{
          keyId: string;
          canView?: boolean;
          canModerate?: boolean;
          canConfigure?: boolean;
          canDelete?: boolean;
        }>;
      }>(c);
      if (!body || !Array.isArray(body.keyAccessConfigs) || body.keyAccessConfigs.some((k) => typeof k?.keyId !== 'string')) {
        return send(c, { error: "Payload d'accès de clé invalide" }, 400);
      }

      const featureConfig = await prisma.dashboardFeatureConfig.findUnique({
        where: { guildId_featureKey: { guildId, featureKey } },
        select: { id: true },
      });
      if (!featureConfig) return send(c, { error: 'Configuration du module introuvable' }, 404);

      const { updateKeyAccess } = await import('../../../../services/core/dashboardManagementService.js');
      await updateKeyAccess(guildId, featureKey, body.keyAccessConfigs);
      await cache.invalidateGuild(guildId);

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Mise à jour accès clés MCP',
        context: getGuildName(client, guildId),
        module: 'Configuration',
        eventType: 'Manuel',
        details: `Accès des clés MCP pour le module "${featureKey}" mis à jour (${body.keyAccessConfigs.length} clés).`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('ManagementAPI', `Error updating key access for ${featureKey}:`, err);
      return fail(c, err, 'Erreur lors de la mise à jour des droits des clés du module', 'ManagementAPI');
    }
  });

  return router;
}
