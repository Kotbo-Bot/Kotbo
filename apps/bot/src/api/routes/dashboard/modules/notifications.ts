/** Routes dashboard du module `notifications`. */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, getOrCreateRuntime, type NotificationSettings, pushAudit } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

export function createNotificationsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/notifications';
  const gate = guildRoute(client);

  router.get(`${base}/features`, ...gate, async (c) => {
    try {
      const { getAvailableFeatureConfigs } = await import('../../../../services/core/dashboardManagementService.js');
      return send(c, { features: await getAvailableFeatureConfigs(c.req.param('guildId')) });
    } catch (err) {
      logger.error('NotificationsAPI', 'Error fetching feature configurations:', err);
      return fail(c, err, 'Erreur lors de la récupération des configurations des modules', 'NotificationsAPI');
    }
  });

  router.patch(`${base}/features/:featureKey`, ...gate, async (c) => {
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions administratives requises.' }, 403);
    }
    const guildId = c.req.param('guildId');
    const featureKey = c.req.param('featureKey');
    try {
      const body = await readBody<{
        channelId?: string | null;
        secondaryChannelId?: string | null;
        requiredRoleId?: string | null;
        notificationRoleId?: string | null;
        notifyViaDiscordChannel?: boolean;
        notifyViaDM?: boolean;
        loggingEnabled?: boolean;
        userActivityTracking?: boolean;
        metadata?: Record<string, unknown>;
      }>(c);
      if (!body) return send(c, { error: 'Payload de configuration invalide' }, 400);

      // Cette route ecrit la ligne de configuration, rien d'autre. Y accepter
      // `enabled` en faisait une seconde porte pour allumer un module : la
      // colonne changeait, mais sans la cascade des dependances, sans le
      // controle de l'offre, sans les tables propres au module et sans purge du
      // cache d'etats - la page disait une chose et le bot en faisait une autre.
      // L'activation passe par PUT /modules/:moduleId, qui fait les cinq.
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        return send(c, {
          error: "L'activation d'un module ne s'ecrit pas ici. Utiliser PUT /modules/:moduleId.",
          code: 'use_module_route',
        }, 400);
      }

      const { updateFeatureConfig } = await import('../../../../services/core/dashboardManagementService.js');
      const updated = await updateFeatureConfig(guildId, featureKey, body);

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Mise à jour module',
        context: getGuildName(client, guildId),
        module: 'Configuration',
        eventType: 'Manuel',
        details: `Configuration du module "${featureKey}" mise à jour.`,
        channelId: null
      });

      return send(c, { ok: true, config: updated });
    } catch (err) {
      logger.error('NotificationsAPI', `Error updating feature configuration for ${featureKey}:`, err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration du module', 'NotificationsAPI');
    }
  });

  router.put(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<NotificationSettings>(c);
      if (!body) return send(c, { error: 'Payload notifications invalide' }, 400);

      const runtime = await getOrCreateRuntime(guildId);
      const statusChannelId = body.discordChannel?.replace(/[^0-9]/g, '') || null;

      await prisma.guild.update({
        where: { id: guildId },
        data: { statusCheckChannelId: statusChannelId }
      });

      await prisma.dashboardSettings.update({
        where: { guildId },
        data: {
          email: body.email ?? '',
          emailEnabled: !!body.emailEnabled,
          cloudBackup: !!body.cloudBackup,
          debugLog: !!body.debugLog,
          killSwitchEnabled: !!body.killSwitchEnabled,
          severityByModule: body.severityByModule ?? runtime.severityByModule
        }
      });

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Sauvegarde notifications',
        context: getGuildName(client, guildId),
        module: 'Notifications',
        eventType: 'Manuel',
        details: 'Paramètres globaux mis à jour.',
        channelId: statusChannelId
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('NotificationsAPI', 'Error updating notifications:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des notifications', 'NotificationsAPI');
    }
  });

  return router;
}
