import { Hono, type Context } from 'hono';
import { Client, ChannelType } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  fullSyncStaffRoles,
  autoSetupRoleMappings,
  createStaffServerLink,
  removeStaffServerLink,
  invalidateStaffLinkCache,
} from '../../../services/staff/staffServerService.js';
import { reconcileStaffGuildActivation } from '../../../utils/activation.js';
import { isModuleEnabled } from '../../../services/core/moduleGate.js';

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
export function createStaffServerRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  const helpers = (c: Context) => {
    const guildId = c.req.param('guildId')!;
    return {
      /**
       * Le lien doit relier le serveur ouvert, comme pour sa modification ou sa suppression :
       * les correspondances de rôles et la synchronisation le prenaient par son seul
       * identifiant, et le staff d'un autre serveur pouvait décider des rôles distribués ici.
       */
      ownsLink: async (linkId: string): Promise<boolean> => {
        const link = await prisma.staffServerLink.findUnique({
          where: { id: linkId },
          select: { mainGuildId: true, staffGuildId: true },
        });
        return Boolean(link && (link.mainGuildId === guildId || link.staffGuildId === guildId));
      },
    };
  };

  router.get(`${base}/staff-server`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const links = await prisma.staffServerLink.findMany({
        where: {
          OR: [{ mainGuildId: guildId }, { staffGuildId: guildId }],
        },
        include: {
          roleMappings: {
            include: { staffRole: true },
          },
          hierarchy: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const enriched = links.map((l) => {
        const isMain = l.mainGuildId === guildId;
        const otherGuildId = isMain ? l.staffGuildId : l.mainGuildId;
        const otherGuild = client.guilds.cache.get(otherGuildId);
        const mainGuild = client.guilds.cache.get(l.mainGuildId);
        const staffGuild = client.guilds.cache.get(l.staffGuildId);

        return {
          ...l,
          isMain,
          otherGuildId,
          otherGuildName: otherGuild?.name ?? otherGuildId,
          otherGuildIcon: otherGuild?.iconURL() ?? null,
          mainGuildName: mainGuild?.name ?? l.mainGuildId,
          staffGuildName: staffGuild?.name ?? l.staffGuildId,
          roleMappings: l.roleMappings.map((m) => {
            const mainRole = mainGuild?.roles.cache.get(m.mainDiscordRoleId ?? '');
            const staffRole = staffGuild?.roles.cache.get(m.staffDiscordRoleId ?? '');
            return {
              ...m,
              mainRoleName: mainRole?.name ?? m.mainDiscordRoleId,
              mainRoleColor: mainRole?.hexColor ?? null,
              staffRoleName: staffRole?.name ?? m.staffDiscordRoleId,
              staffRoleColor: staffRole?.hexColor ?? null,
            };
          }),
        };
      });

      return send(c, enriched);
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur GET staff-server', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  router.post(`${base}/staff-server`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody(c);
      const staffGuildId = typeof body?.staffGuildId === 'string' ? body.staffGuildId : null;
      const syncMode = body?.syncMode;
      if (!staffGuildId || (syncMode !== 'BIDIRECTIONAL' && syncMode !== 'MAIN_TO_STAFF' && syncMode !== 'STAFF_TO_MAIN')) {
        return send(c, { error: 'staffGuildId et syncMode requis' }, 400);
      }

      const optionalId = (value: unknown) => (typeof value === 'string' ? value : undefined);

      const staffGuild = client.guilds.cache.get(staffGuildId);
      if (!staffGuild) {
        return send(c, { error: 'Le bot n\'est pas présent sur le serveur staff.' }, 400);
      }

      const linkResult = await createStaffServerLink({
        mainGuildId: guildId,
        staffGuildId,
        syncMode,
        hierarchyId: optionalId(body?.hierarchyId),
        simpleStaffRoleId: optionalId(body?.simpleStaffRoleId),
        mainLogChannelId: optionalId(body?.mainLogChannelId),
        staffLogChannelId: optionalId(body?.staffLogChannelId),
        createdByUserId: user.userId,
        client,
      });

      if ('error' in linkResult) {
        return send(c, { error: linkResult.error }, 400);
      }

      const link = linkResult;
      const roleSetup = await autoSetupRoleMappings(link, client);
      const syncResult = await fullSyncStaffRoles(link.id, client);

      const updatedLink = await prisma.staffServerLink.findUnique({
        where: { id: link.id },
        include: { roleMappings: true, hierarchy: true },
      });

      return send(c, {
        ...updatedLink,
        autoSetup: roleSetup,
        initialSync: syncResult,
      }, 201);
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur POST staff-server', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  // serveur staff lié (mainGuildId = guildId), pour les sélecteurs de salon
  // cross-serveur (ex: notifications staff qui doivent vivre sur le serveur
  // staff dédié plutôt que sur le serveur communautaire).
  router.get(`${base}/staff-server/channels`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      // Ce selecteur est exempte de la garde des modules : les pages Staff,
      // Reunions et Tickets l'appellent a chaque ouverture, sur des serveurs
      // qui n'ont jamais allume « Serveur staff ». Le module eteint, la reponse
      // est vide plutot que refusee.
      const link = (await isModuleEnabled(guildId, 'staff_server'))
        ? await prisma.staffServerLink.findFirst({
          where: { mainGuildId: guildId, enabled: true },
        })
        : null;
      if (!link) {
        return send(c, { staffGuildId: null, staffGuildName: null, channels: [], voiceChannels: [], categories: [] });
      }

      let staffGuild = client.guilds.cache.get(link.staffGuildId) ?? null;
      if (!staffGuild) {
        staffGuild = await client.guilds.fetch(link.staffGuildId).catch(() => null);
      }
      if (staffGuild && staffGuild.channels.cache.size === 0) {
        await staffGuild.channels.fetch().catch(() => null);
      }

      const allChannels = staffGuild ? Array.from(staffGuild.channels.cache.values()) : [];
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'fr');

      const channels = allChannels
        .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort(byName);
      const voiceChannels = allChannels
        .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort(byName);
      const categories = allChannels
        .filter((c) => c.type === ChannelType.GuildCategory)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort(byName);

      return send(c, {
        staffGuildId: link.staffGuildId,
        staffGuildName: staffGuild?.name ?? link.staffGuildId,
        channels,
        voiceChannels,
        categories,
      });
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur GET staff-server/channels', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  router.patch(`${base}/staff-server/:linkId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const linkId = c.req.param('linkId');
      const body = await readBody(c);

      const link = await prisma.staffServerLink.findUnique({ where: { id: linkId } });
      if (!link || (link.mainGuildId !== guildId && link.staffGuildId !== guildId)) {
        return send(c, { error: 'Lien introuvable' }, 404);
      }

      const allowedFields = [
        'syncMode', 'simpleStaffRoleId', 'mainLogChannelId', 'staffLogChannelId', 'enabled',
        'modlogMirrorChannelId', 'sanctionReportChannelId', 'internalReportChannelId', 'recruitmentAlertChannelId',
        'recruitmentOnStaffServer', 'staffRecruitmentCategoryId',
        'onboardingInviteEnabled', 'onboardingInviteChannelId', 'offboardingAlertChannelId',
      ];
      const updateData: Record<string, any> = {};
      for (const field of allowedFields) {
        if (body?.[field] !== undefined) updateData[field] = body[field];
      }

      const updated = await prisma.staffServerLink.update({
        where: { id: linkId },
        data: updateData,
        include: { roleMappings: true, hierarchy: true },
      });

      await invalidateStaffLinkCache(updated);

      if ('enabled' in updateData) {
        await reconcileStaffGuildActivation(updated.staffGuildId);
      }

      return send(c, updated);
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur PATCH staff-server', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  router.delete(`${base}/staff-server/:linkId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const linkId = c.req.param('linkId');
      const link = await prisma.staffServerLink.findUnique({ where: { id: linkId } });
      if (!link || (link.mainGuildId !== guildId && link.staffGuildId !== guildId)) {
        return send(c, { error: 'Lien introuvable' }, 404);
      }

      await removeStaffServerLink(linkId);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur DELETE staff-server', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  router.post(`${base}/staff-server/:linkId/mappings`, ...gate, async (c) => {
    const { ownsLink } = helpers(c);
    try {
      const linkId = c.req.param('linkId');
      if (!(await ownsLink(linkId))) {
        return send(c, { error: 'Lien introuvable' }, 404);
      }
      const body = await readBody(c);
      const mainDiscordRoleId = typeof body?.mainDiscordRoleId === 'string' ? body.mainDiscordRoleId : null;
      const staffDiscordRoleId = typeof body?.staffDiscordRoleId === 'string' ? body.staffDiscordRoleId : null;

      // Chaque rôle doit exister dans le serveur du lien auquel il est rattaché.
      const link = await prisma.staffServerLink.findUnique({
        where: { id: linkId },
        select: { mainGuildId: true, staffGuildId: true },
      });
      const roleIn = (guildId: string | undefined, roleId: string | null) =>
        !roleId || Boolean(guildId && client.guilds.cache.get(guildId)?.roles.cache.has(roleId));
      if (!roleIn(link?.mainGuildId, mainDiscordRoleId) || !roleIn(link?.staffGuildId, staffDiscordRoleId)) {
        return send(c, { error: 'Rôle introuvable sur le serveur concerné.' }, 400);
      }

      const mapping = await prisma.staffServerRoleMapping.create({
        data: {
          staffServerLinkId: linkId,
          staffRoleId: typeof body?.staffRoleId === 'string' ? body.staffRoleId : null,
          mainDiscordRoleId,
          staffDiscordRoleId,
        },
      });

      return send(c, mapping, 201);
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur POST mapping', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  router.delete(`${base}/staff-server/:linkId/mappings/:mappingId`, ...gate, async (c) => {
    const { ownsLink } = helpers(c);
    try {
      const linkId = c.req.param('linkId');
      const mappingId = c.req.param('mappingId');
      if (!(await ownsLink(linkId))) {
        return send(c, { error: 'Lien introuvable' }, 404);
      }
      // La correspondance doit aussi appartenir à ce lien, pas à celui d'un autre serveur.
      const removed = await prisma.staffServerRoleMapping.deleteMany({ where: { id: mappingId, staffServerLinkId: linkId } });
      if (removed.count === 0) {
        return send(c, { error: 'Correspondance introuvable' }, 404);
      }
      return send(c, { ok: true });
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur DELETE mapping', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  router.post(`${base}/staff-server/:linkId/sync`, ...gate, async (c) => {
    const { ownsLink } = helpers(c);
    try {
      const linkId = c.req.param('linkId');
      if (!(await ownsLink(linkId))) {
        return send(c, { error: 'Lien introuvable' }, 404);
      }
      const result = await fullSyncStaffRoles(linkId, client);
      return send(c, result);
    } catch (err) {
      logger.error('StaffServerAPI', 'Erreur sync', err);
      return fail(c, err, 'Erreur serveur', 'StaffServerAPI');
    }
  });

  return router;
}

