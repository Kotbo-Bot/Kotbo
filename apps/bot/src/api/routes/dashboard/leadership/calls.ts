import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../../utils/logger.js';
import { formatGuildDateTime } from '../../../../utils/timezone.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  getCalls,
  createCall,
  updateCall,
  deleteCall,
  getCallPermissionConfig,
  updateCallPermissionConfig,
  canUserCreateCall,
  
  
  
  
} from '../../../../services/staff/staffLeadershipService.js';
import { publicErrorMessage } from '../../../../utils/publicError.js';

export function createCallsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/calls`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const calls = await getCalls(guildId);
      return send(c, { calls });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting calls:', err);
      return fail(c, err, 'Erreur lors de la récupération des appels', 'StaffAPI');
    }
  });

  router.post(`${base}/calls`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    try {
      const body = await readBody<{
        title: string;
        description?: string | null;
        scheduledAt: string;
        channelMode: string;
        channelType?: string | null;
        discordChannelId?: string | null;
        isTempChannel?: boolean;
        inviteeUserIds?: string[];
      }>(c);

      if (!body?.title || !body?.scheduledAt || !body?.channelMode) {
        return send(c, { error: 'title, scheduledAt et channelMode sont obligatoires' }, 400);
      }

      const scheduledAt = new Date(body.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        return send(c, { error: "Date d'appel invalide" }, 400);
      }

      if (!access.canManageSettings && access.level !== 'admin') {
        const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
        const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
        const allowed = await canUserCreateCall(guildId, user.userId, roleIds);
        if (!allowed) {
          return send(c, { error: "Vous n'avez pas la permission de planifier des appels." }, 403);
        }
      }

      const call = await createCall(
        client,
        guildId,
        user.userId,
        body.title,
        body.description || null,
        scheduledAt,
        body.channelMode,
        body.channelType || null,
        body.discordChannelId || null,
        body.isTempChannel !== false,
        body.inviteeUserIds || []
      );

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Création appel',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Appel "${body.title}" planifié pour le ${await formatGuildDateTime(guildId, scheduledAt)}`,
        channelId: null,
      });

      return send(c, { call }, 201);
    } catch (err: unknown) {
      logger.error('StaffAPI', 'Error creating call:', err);
      return send(c, { error: publicErrorMessage(err, "Erreur lors de la planification de l'appel") }, 500);
    }
  });

  router.patch(`${base}/calls/:callId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const callId = c.req.param('callId');
    try {
      const body = await readBody<{
        title?: string;
        description?: string | null;
        scheduledAt?: string;
        endedAt?: string;
        status?: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';
        invitees?: string[];
      }>(c);

      const updateData: Record<string, unknown> = {};
      if (body?.title) updateData.title = body.title;
      if (body?.description !== undefined) updateData.description = body.description;
      if (body?.scheduledAt) updateData.scheduledAt = new Date(body.scheduledAt);
      if (body?.endedAt) updateData.endedAt = new Date(body.endedAt);
      if (body?.status) updateData.status = body.status;
      if (body?.invitees) updateData.invitees = body.invitees;

      const call = await updateCall(client, guildId, callId, updateData);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour appel',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Appel ${callId} mis à jour. Statut: ${call.status}`,
        channelId: null,
      });

      return send(c, { call });
    } catch (err: unknown) {
      logger.error('StaffAPI', 'Error updating call:', err);
      return send(c, { error: publicErrorMessage(err, "Erreur lors de la mise à jour de l'appel") }, 500);
    }
  });

  router.delete(`${base}/calls/:callId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const callId = c.req.param('callId');
    try {
      await deleteCall(client, guildId, callId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression appel',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Appel ${callId} supprimé`,
        channelId: null,
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffAPI', 'Error deleting call:', err);
      return fail(c, err, "Erreur lors de la suppression de l'appel", 'StaffAPI');
    }
  });

  router.get(`${base}/calls/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    try {
      const config = await getCallPermissionConfig(guildId);

      let canCreate = access.canManageSettings || access.level === 'admin';
      if (!canCreate) {
        const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
        const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
        canCreate = await canUserCreateCall(guildId, user.userId, roleIds);
      }

      return send(c, { config, canCreate });
    } catch (err) {
      logger.error('StaffAPI', 'Error getting call permission config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration des appels', 'StaffAPI');
    }
  });

  router.post(`${base}/calls/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canManageSettings) {
      return send(c, { error: 'Accès refusé' }, 403);
    }

    try {
      const body = await readBody<{
        mode: 'EVERYONE' | 'RESTRICTED';
        allowedRoleIds?: string[];
        allowedUserIds?: string[];
      }>(c);

      if (body?.mode !== 'EVERYONE' && body?.mode !== 'RESTRICTED') {
        return send(c, { error: 'mode doit être EVERYONE ou RESTRICTED' }, 400);
      }

      const config = await updateCallPermissionConfig(guildId, {
        mode: body.mode,
        allowedRoleIds: Array.isArray(body.allowedRoleIds) ? body.allowedRoleIds.filter((id) => typeof id === 'string') : [],
        allowedUserIds: Array.isArray(body.allowedUserIds) ? body.allowedUserIds.filter((id) => typeof id === 'string') : [],
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour permissions appels',
        context: getGuildName(client, guildId),
        module: 'Staff Management',
        eventType: 'Manuel',
        details: `Mode: ${config.mode}, Rôles: ${config.allowedRoleIds.length}, Membres: ${config.allowedUserIds.length}`,
        channelId: null,
      });

      return send(c, { config });
    } catch (err) {
      logger.error('StaffAPI', 'Error updating call permission config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration des appels', 'StaffAPI');
    }
  });

  return router;
}

