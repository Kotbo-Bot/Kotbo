import type { Client } from 'discord.js';
import { Hono } from 'hono';
/** Routes dashboard du module `invitations`. */
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../../shared.js';
import { withInviterAvatars } from '../../../../services/analytics/inviterAvatars.js';

import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';
export function createInvitationsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/invitations`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild) {
        const { syncGuildInvites } = await import('../../../../services/analytics/inviteService.js');
        // 60 s : recharger la page ne relance pas l'appel Discord a chaque fois.
        await syncGuildInvites(discordGuild, { maxAgeMs: 60_000 });
      }

      const invitations = await prisma.guildInvite.findMany({
        where: { guildId }
      });

      const suspendedInviters = await prisma.suspendedInviter.findMany({
        where: { guildId }
      });

      const inviteUsage = await prisma.memberInvite.groupBy({
        by: ['inviteCode'],
        where: { guildId, inviteCode: { not: null } },
        _count: {
          _all: true,
          leftAt: true,
        },
        _max: {
          joinedAt: true,
        }
      });

      const inviterUsage = await prisma.memberInvite.groupBy({
        by: ['inviterId', 'inviterTag'],
        where: { guildId, inviterId: { not: null } },
        _count: {
          _all: true,
          leftAt: true,
        },
        _max: {
          joinedAt: true,
        }
      });

      const totalJoined = await prisma.memberInvite.count({
        where: { guildId }
      });

      const totalLeft = await prisma.memberInvite.count({
        where: { guildId, leftAt: { not: null } }
      });

      return send(c, {
        invitations,
        suspendedInviters,
        inviteUsage,
        inviterUsage: await withInviterAvatars(client, guildId, inviterUsage),
        summary: { totalJoined, totalLeft }
      });
    } catch (err) {
      logger.error('InvitationsAPI', 'Error fetching invitations:', err);
      return fail(c, err, 'Erreur lors de la récupération des invitations', 'InvitationsAPI');
    }
  });

  router.post(`${base}/invitations/suspended-inviters`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent && !access.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions de modération requises.' }, 403);
    }

    try {
      const body = await readBody<{ userId: string; userTag?: string; reason?: string; cascade?: boolean }>(c);
      if (!body || !body.userId) {
        return send(c, { error: 'ID utilisateur requis' }, 400);
      }

      const suspended = await prisma.suspendedInviter.upsert({
        where: { guildId_userId: { guildId, userId: body.userId } },
        create: {
          guildId,
          userId: body.userId,
          userTag: body.userTag || null,
          reason: body.reason || null
        },
        update: {
          userTag: body.userTag || null,
          reason: body.reason || null
        }
      });

      let cascadeResult: { purgedCount: number } | undefined;

      if (body.cascade) {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
          const invites = await discordGuild.invites.fetch().catch(() => null);
          if (invites) {
            for (const invite of invites.values()) {
              if (invite.inviter?.id === body.userId) {
                await invite.delete('Creator suspended').catch(() => null);
              }
            }
          }
        }

        await prisma.guildInvite.updateMany({
          where: { guildId, inviterId: body.userId },
          data: { isSuspended: true }
        });

        const membersToPurge = await prisma.memberInvite.findMany({
          where: { guildId, inviterId: body.userId, leftAt: null }
        });

        let purgedCount = 0;
        if (discordGuild) {
          for (const m of membersToPurge) {
            const memberObj = await discordGuild.members.fetch(m.userId).catch(() => null);
            if (memberObj) {
              await memberObj.kick('Purge en cascade (créateur suspendu)').catch(() => null);
              purgedCount++;
            }
          }
        }

        await prisma.memberInvite.updateMany({
          where: { guildId, inviterId: body.userId, leftAt: null },
          data: { leftAt: new Date() }
        });

        cascadeResult = { purgedCount };
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suspension Créateur',
        context: getGuildName(client, guildId),
        module: 'Invitations',
        eventType: 'Manuel',
        details: `Créateur d'invitations ${body.userId} suspendu.${body.cascade ? ` Cascade purge active.` : ''}`,
        channelId: null
      });

      return send(c, { ok: true, suspended, cascade: cascadeResult });
    } catch (err) {
      logger.error('InvitationsAPI', 'Error suspending creator:', err);
      return fail(c, err, 'Erreur lors de la suspension du créateur', 'InvitationsAPI');
    }
  });

  router.delete(`${base}/invitations/suspended-inviters/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent && !access.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions de modération requises.' }, 403);
    }

    const userId = c.req.param('userId');
    try {
      await prisma.suspendedInviter.delete({
        where: { guildId_userId: { guildId, userId } }
      });

      await prisma.guildInvite.updateMany({
        where: { guildId, inviterId: userId },
        data: { isSuspended: false }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Restauration Créateur',
        context: getGuildName(client, guildId),
        module: 'Invitations',
        eventType: 'Manuel',
        details: `Créateur d'invitations ${userId} réhabilité.`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('InvitationsAPI', `Error removing suspended inviter ${userId}:`, err);
      return fail(c, err, 'Erreur lors de la réhabilitation du créateur', 'InvitationsAPI');
    }
  });

  router.post(`${base}/invitations/inviters/:userId/purge`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent && !access.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions de modération requises.' }, 403);
    }

    const userId = c.req.param('userId');
    try {
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const membersToPurge = await prisma.memberInvite.findMany({
        where: { guildId, inviterId: userId, leftAt: null }
      });

      let purgedCount = 0;
      if (discordGuild) {
        for (const m of membersToPurge) {
          const memberObj = await discordGuild.members.fetch(m.userId).catch(() => null);
          if (memberObj) {
            await memberObj.kick('Purge en cascade (inviter purge)').catch(() => null);
            purgedCount++;
          }
        }
      }

      await prisma.memberInvite.updateMany({
        where: { guildId, inviterId: userId, leftAt: null },
        data: { leftAt: new Date() }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Purge Créateur',
        context: getGuildName(client, guildId),
        module: 'Invitations',
        eventType: 'Manuel',
        details: `Membres invités par ${userId} purgés (${purgedCount} exclus).`,
        channelId: null
      });

      return send(c, { purgedCount });
    } catch (err) {
      logger.error('InvitationsAPI', `Error purging inviter ${userId} members:`, err);
      return fail(c, err, 'Erreur lors de la purge du créateur', 'InvitationsAPI');
    }
  });

  router.put(`${base}/invitations/:code/suspend`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent && !access.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions de modération requises.' }, 403);
    }

    const code = c.req.param('code');
    try {
      // Un code d'invitation est public : sans ce filtre, le staff d'un autre serveur
      // pouvait marquer celle d'ici comme suspendue ou supprimée dans les statistiques.
      const owned = await prisma.guildInvite.findFirst({ where: { code, guildId }, select: { code: true } });
      if (!owned) {
        return send(c, { error: 'Invitation introuvable' }, 404);
      }

      const body = await readBody<{ suspended: boolean }>(c);
      if (!body || typeof body.suspended !== 'boolean') {
        return send(c, { error: 'Statut de suspension requis' }, 400);
      }

      await prisma.guildInvite.update({
        where: { code },
        data: { isSuspended: body.suspended }
      });

      if (body.suspended) {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
          const inviteObj = await discordGuild.invites.fetch(code).catch(() => null);
          if (inviteObj) {
            await inviteObj.delete('Suspendu depuis le tableau de bord').catch(() => null);
          }
        }
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: body.suspended ? 'Suspension Invitation' : 'Restauration Invitation',
        context: getGuildName(client, guildId),
        module: 'Invitations',
        eventType: 'Manuel',
        details: `L'invitation ${code} a été ${body.suspended ? 'suspendue' : 'restaurée'}.`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('InvitationsAPI', `Error suspending invite ${code}:`, err);
      return fail(c, err, "Erreur lors de la suspension de l'invitation", 'InvitationsAPI');
    }
  });

  router.post(`${base}/invitations/:code/purge`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent && !access.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions de modération requises.' }, 403);
    }

    const code = c.req.param('code');
    try {
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const membersToPurge = await prisma.memberInvite.findMany({
        where: { guildId, inviteCode: code, leftAt: null }
      });

      let purgedCount = 0;
      if (discordGuild) {
        for (const m of membersToPurge) {
          const memberObj = await discordGuild.members.fetch(m.userId).catch(() => null);
          if (memberObj) {
            await memberObj.kick('Purge en cascade (code purge)').catch(() => null);
            purgedCount++;
          }
        }
      }

      await prisma.memberInvite.updateMany({
        where: { guildId, inviteCode: code, leftAt: null },
        data: { leftAt: new Date() }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Purge Invitation',
        context: getGuildName(client, guildId),
        module: 'Invitations',
        eventType: 'Manuel',
        details: `Membres invités via le code ${code} purgés (${purgedCount} exclus).`,
        channelId: null
      });

      return send(c, { purgedCount });
    } catch (err) {
      logger.error('InvitationsAPI', `Error purging members of invite ${code}:`, err);
      return fail(c, err, "Erreur lors de la purge de l'invitation", 'InvitationsAPI');
    }
  });

  router.delete(`${base}/invitations/:code`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canModerateContent && !access.canManageSettings) {
      return send(c, { error: 'Accès refusé. Permissions de modération requises.' }, 403);
    }

    const code = c.req.param('code');
    try {
      // Un code d'invitation est public : sans ce filtre, le staff d'un autre serveur
      // pouvait marquer celle d'ici comme suspendue ou supprimée dans les statistiques.
      const owned = await prisma.guildInvite.findFirst({ where: { code, guildId }, select: { code: true } });
      if (!owned) {
        return send(c, { error: 'Invitation introuvable' }, 404);
      }

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild) {
        const inviteObj = await discordGuild.invites.fetch(code).catch(() => null);
        if (inviteObj) {
          await inviteObj.delete('Supprimé depuis le tableau de bord').catch(() => null);
        }
      }

      await prisma.guildInvite.update({
        where: { code },
        data: { isDeleted: true }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression Invitation',
        context: getGuildName(client, guildId),
        module: 'Invitations',
        eventType: 'Manuel',
        details: `L'invitation ${code} a été supprimée.`,
        channelId: null
      });

      return send(c, { ok: true });
    } catch (err) {
      logger.error('InvitationsAPI', `Error deleting invite ${code}:`, err);
      return fail(c, err, "Erreur lors de la suppression de l'invitation", 'InvitationsAPI');
    }
  });

  return router;
}

