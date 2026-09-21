/** Routes dashboard du module `logs`. */
import prisma from '../../../../utils/db.js';
import { cache } from '../../../../utils/cache.js';
import { enregistrerConfigsEvenements } from '../../../../utils/logEventConfig.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, pushAudit, readJsonBody, resolveFeatureAccessMap } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

import { jsonFailure } from '../../../shared/failure.js';
export async function handleLogsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, user, guildId, access, method, auditUser, moduleKey } = ctx;

  // Logs event configurations
  if (moduleKey === 'logs') {
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
    const roleIds = member
      ? member.roles.cache
          .map((role) => role?.id)
          .filter((roleId): roleId is string => !!roleId)
      : [];
    const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

    const isGetMethod = method === 'GET';
    if (!isGetMethod && !access.canManageSettings && !featureAccess.logs?.canConfigure) {
      json(res, 403, { error: 'Accès refusé. Seuls les administrateurs peuvent modifier les logs.' });
      return true;
    }

    if (isGetMethod && !access.canViewDashboard) {
      json(res, 403, { error: "Accès refusé. Vous n'avez pas accès au dashboard." });
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/logs/event-configs
    if (parts.length === 6 && parts[5] === 'event-configs' && method === 'GET') {
      try {
        const LOG_EVENT_TYPES = [
          'message_delete', 'message_edit', 'message_bulk_delete',
          'member_join', 'member_leave', 'member_roles_update', 'member_timeout',
          'moderation_kick', 'moderation_ban', 'moderation_unban',
          'voice_join', 'voice_leave', 'voice_move',
          'channel_lifecycle', 'role_lifecycle'
        ];

        const existingConfigs = await prisma.guildLogEventConfig.findMany({
          where: { guildId }
        });

        const existingMap = new Map(existingConfigs.map(c => [c.eventType, c]));
        const missingTypes = LOG_EVENT_TYPES.filter(t => !existingMap.has(t));

        if (missingTypes.length > 0) {
          await prisma.$transaction(
            missingTypes.map(t => prisma.guildLogEventConfig.create({
              data: {
                guildId,
                eventType: t,
                enabled: true,
                channelId: null
              }
            }))
          );
        }

        const allConfigs = await prisma.guildLogEventConfig.findMany({
          where: { guildId },
          orderBy: { eventType: 'asc' }
        });

        json(res, 200, { configs: allConfigs });
      } catch (err) {
        logger.error('LogsConfigAPI', 'Error fetching logs event configs:', err);
        jsonFailure(res, err, 'Erreur lors de la récupération de la configuration des événements', 'LogsConfigAPI');
      }
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/logs/event-configs
    if (parts.length === 6 && parts[5] === 'event-configs' && method === 'PUT') {
      try {
        const body = await readJsonBody<{
          configs: Array<{
            eventType: string;
            enabled: boolean;
            channelId: string | null;
          }>;
        }>(req);

        if (!body?.configs || !Array.isArray(body.configs)) {
          json(res, 400, { error: 'Format invalide. Liste de configurations attendue.' });
          return true;
        }

        // L'enregistrement et l'invalidation sont soudés dans la même
        // fonction : jusqu'ici cette route écrivait en base sans jamais
        // toucher au cache, et la configuration restait périmée jusqu'à
        // soixante secondes après une sauvegarde.
        await enregistrerConfigsEvenements(
          {
            enregistrer: async (configs) => {
              await prisma.$transaction(
                configs.map(c => prisma.guildLogEventConfig.upsert({
                  where: {
                    guildId_eventType: { guildId, eventType: c.eventType }
                  },
                  update: {
                    enabled: c.enabled,
                    channelId: c.channelId
                  },
                  create: {
                    guildId,
                    eventType: c.eventType,
                    enabled: c.enabled,
                    channelId: c.channelId
                  }
                }))
              );
            },
            oublier: (cle) => cache.delete(cle),
          },
          guildId,
          body.configs.map(c => ({
            eventType: c.eventType,
            enabled: c.enabled,
            channelId: c.channelId ? c.channelId : null,
          })),
        );

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour configuration logs granulaires',
          context: getGuildName(client, guildId),
          module: 'Logs',
          eventType: 'Manuel',
          details: 'Configuration par événement mise à jour.',
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('LogsConfigAPI', 'Error updating logs event configs:', err);
        jsonFailure(res, err, 'Erreur lors de la mise à jour de la configuration des événements', 'LogsConfigAPI');
      }
      return true;
    }
  }

  return false;
}
