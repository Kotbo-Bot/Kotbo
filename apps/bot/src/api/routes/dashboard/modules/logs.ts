/** Routes dashboard du module `logs`. */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { cache } from '../../../../utils/cache.js';
import { getGuildName, pushAudit, resolveFeatureAccessMap } from '../../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

const LOG_EVENT_TYPES = [
  'message_delete', 'message_edit', 'message_bulk_delete',
  'member_join', 'member_leave', 'member_roles_update', 'member_timeout', 'member_tag_update',
  'moderation_kick', 'moderation_ban', 'moderation_unban', 'moderation_timeout',
  'voice_join', 'voice_leave', 'voice_move', 'voice_moderation', 'voice_panel',
  'channel_lifecycle', 'role_lifecycle'
];

export function createLogsRouter(client: Client) {
  const router = new Hono();
  const path = '/api/dashboard/guilds/:guildId/logs/event-configs';

  const logsAccess = createMiddleware(async (c, next) => {
    const guildId = c.req.param('guildId')!;
    const userId = c.var.dashboardUser.userId;
    const access = c.var.effectiveAccess;
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
    const roleIds = member
      ? member.roles.cache
        .map((role) => role?.id)
        .filter((roleId): roleId is string => !!roleId)
      : [];
    const featureAccess = await resolveFeatureAccessMap(client, guildId, access, userId, roleIds);

    const isGetMethod = c.req.method === 'GET';
    if (!isGetMethod && !access.canManageSettings && !featureAccess.logs?.canConfigure) {
      return send(c, { error: 'Accès refusé. Seuls les administrateurs peuvent modifier les logs.' }, 403);
    }
    if (isGetMethod && !access.canViewDashboard) {
      return send(c, { error: "Accès refusé. Vous n'avez pas accès au dashboard." }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), logsAccess] as const;

  router.get(path, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const existingConfigs = await prisma.guildLogEventConfig.findMany({ where: { guildId } });
      const existingMap = new Map(existingConfigs.map(cfg => [cfg.eventType, cfg]));
      const missingTypes = LOG_EVENT_TYPES.filter(t => !existingMap.has(t));

      if (missingTypes.length > 0) {
        await prisma.$transaction(
          missingTypes.map(t => prisma.guildLogEventConfig.create({
            data: { guildId, eventType: t, enabled: true, channelId: null }
          }))
        );
      }

      const allConfigs = await prisma.guildLogEventConfig.findMany({
        where: { guildId },
        orderBy: { eventType: 'asc' }
      });
      return send(c, { configs: allConfigs });
    } catch (err) {
      logger.error('LogsConfigAPI', 'Error fetching logs event configs:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration des événements', 'LogsConfigAPI');
    }
  });

  router.put(path, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const body = await readBody<{
        configs: Array<{ eventType: string; enabled: boolean; channelId: string | null }>;
      }>(c);
      if (!body?.configs || !Array.isArray(body.configs)) {
        return send(c, { error: 'Format invalide. Liste de configurations attendue.' }, 400);
      }

      await prisma.$transaction(
        body.configs.map(cfg => prisma.guildLogEventConfig.upsert({
          where: { guildId_eventType: { guildId, eventType: cfg.eventType } },
          update: { enabled: cfg.enabled, channelId: cfg.channelId ? cfg.channelId : null },
          create: { guildId, eventType: cfg.eventType, enabled: cfg.enabled, channelId: cfg.channelId ? cfg.channelId : null }
        }))
      );

      // Sans ca, le bot applique l ancienne configuration jusqu a expiration
      // du cache : soixante secondes de comportement garanti faux apres
      // chaque sauvegarde. Efface aussi les entrees d absence de ligne.
      await cache.invalidateGuild(guildId);

      await pushAudit(guildId, {
        user: auditUserOf(c),
        action: 'Mise à jour configuration logs granulaires',
        context: getGuildName(client, guildId),
        module: 'Logs',
        eventType: 'Manuel',
        details: 'Configuration par événement mise à jour.',
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('LogsConfigAPI', 'Error updating logs event configs:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration des événements', 'LogsConfigAPI');
    }
  });

  return router;
}
