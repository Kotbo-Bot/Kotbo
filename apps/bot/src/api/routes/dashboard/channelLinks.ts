import { Hono } from 'hono';
import pLimit from 'p-limit';
import { createMiddleware } from 'hono/factory';
import { ChannelType, Client, PermissionFlagsBits } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  addGroupMember,
  canManageGuild,
  createDirectGroup,
  getGroup,
  inspectRelayPermissions,
  needsMessageMapping,
  permissionsSalonDePont,
  refreshGroupTopics,
  removeGroup,
  removeGroupMember,
  updateGroupConfig,
  updateGroupMemberConfig,
  type LinkGroup,
  type LinkMemberMode,
  type LinkRelayMode,
} from '../../../services/features/channelLinkService.js';
import { isLinkGuestGuild } from '../../../services/features/channelLinkGuestService.js';
import { getLinkGroupStats } from '../../../services/features/channelLinkStatsService.js';
import { INVITE_SOURCE, recordBotInvite } from '../../../services/analytics/inviteService.js';
import { fetchOAuthGuilds } from '../user.js';

import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

const OTHER_GUILDS_FETCH_CONCURRENCY = 10;

function readMode(value: unknown, fallback: LinkMemberMode = 'BOTH'): LinkMemberMode {
  return value === 'SEND_ONLY' || value === 'RECEIVE_ONLY' || value === 'BOTH' ? value : fallback;
}

function readRelayMode(value: unknown, fallback: LinkRelayMode = 'WEBHOOK'): LinkRelayMode {
  return value === 'EMBED' ? 'EMBED' : fallback;
}

function serializeGroup(group: LinkGroup, guildId: string, client: Client) {
  const issuesByMember = new Map(inspectRelayPermissions(client, group).map((issue) => [issue.memberId, issue]));

  const members = group.members.map((member) => {
    const memberGuild = client.guilds.cache.get(member.guildId);
    const channel = memberGuild?.channels.cache.get(member.channelId);
    const issue = issuesByMember.get(member.id);
    return {
      id: member.id,
      guildId: member.guildId,
      guildName: memberGuild?.name ?? member.guildId,
      guildIcon: memberGuild?.iconURL() ?? null,
      channelId: member.channelId,
      channelName: channel?.name ?? member.channelId,
      mode: member.mode,
      relayMode: member.relayMode,
      enabled: member.enabled,
      isLocal: member.guildId === guildId,
      // Ce serveur n'a pas de clé : il ne voit que ce pont, et Kotbo n'y
      // collecte rien. À afficher pour lever le doute des communautés qui
      // acceptent un lien sans vouloir « du bot ».
      isLinkOnly: isLinkGuestGuild(member.guildId),
      // Ce qui manque à ce salon pour relayer complètement. Un webhook emprunte
      // les permissions d'@everyone : sans emojis externes, Discord réduit les
      // emojis venus d'ailleurs à leur raccourci, sans que rien ne l'explique.
      missingBotPermissions: issue?.bot.map((permission) => permission.key) ?? [],
      missingEveryonePermissions: issue?.everyone.map((permission) => permission.key) ?? [],
      channelMissing: issue?.channelMissing ?? false,
    };
  });

  return {
    ...group,
    members,
    localMembers: members.filter((m) => m.isLocal),
    remoteGuildCount: new Set(members.filter((m) => !m.isLocal).map((m) => m.guildId)).size,
    // `true` quand ce pont inscrit en base la correspondance entre un message et
    // ses copies - nécessaire aux éditions, suppressions, réactions et
    // épinglages, inutile autrement.
    storesMessageMap: needsMessageMapping(group),
  };
}

export function createChannelLinksRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  /** Le pont visé, dont le serveur ouvert doit faire partie. */
  const loadGroup = createMiddleware<{ Variables: { group: NonNullable<Awaited<ReturnType<typeof getGroup>>> } }>(async (c, next) => {
    const group = await getGroup(c.req.param('groupId')!);
    if (!group || !group.members.some((m) => m.guildId === c.req.param('guildId'))) {
      return send(c, { error: 'Pont introuvable' }, 404);
    }
    c.set('group', group);
    await next();
  });
  const groupGate = [...gate, loadGroup] as const;



  router.get(`${base}/channel-links`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const groups = await prisma.channelLinkGroup.findMany({
        where: { members: { some: { guildId } } },
        include: { members: true },
        orderBy: { createdAt: 'desc' },
      });

      const stats = await getLinkGroupStats(groups.map((group) => group.id));
      return send(c, groups.map((group) => ({
        ...serializeGroup(group, guildId, client),
        // Trafic des 30 derniers jours, `null` tant que le pont n'a rien relayé.
        stats: stats.get(group.id) ?? null,
      })));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur GET channel-links', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.get(`${base}/channel-links/other-guilds`, ...gate, async (c) => {
    const user = c.var.dashboardUser;
    try {
      // Le membre etait cherche dans chaque serveur du bot, avec un appel Discord
      // par serveur ou il n'etait pas en cache : la page ralentissait a mesure
      // que le bot rejoignait des serveurs. La liste OAuth du compte borne la
      // recherche a ceux qu'il a rejoints ; sans elle, on les parcourt tous.
      const oauthGuildIds = user.discordToken
        ? await fetchOAuthGuilds(user.discordToken)
            .then((guilds) => new Set(guilds.map((guild) => guild.id)))
            .catch(() => null)
        : null;
      const candidates = [...client.guilds.cache.values()]
        .filter((guild) => !oauthGuildIds || oauthGuildIds.has(guild.id));

      const limit = pLimit(OTHER_GUILDS_FETCH_CONCURRENCY);
      const resolved = await Promise.all(
        candidates.map((guild) => limit(async () => {
          const member = guild.members.cache.get(user.userId)
            ?? await guild.members.fetch(user.userId).catch(() => null);
          if (!member) return null;
          if (!member.permissions.has('Administrator') && !member.permissions.has('ManageGuild')) return null;

          const channels = guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
            .map((c) => ({ id: c.id, name: c.name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

          return {
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL({ size: 64 }) ?? null,
            channels,
          };
        })),
      );

      return send(c, resolved.filter((guild) => guild !== null));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur GET other-guilds', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.post(`${base}/channel-links/direct`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody(c);
      const sourceChannelId = typeof body?.sourceChannelId === 'string' ? body.sourceChannelId : null;

      // Le dashboard envoie une liste de cibles ; l'ancien couple
      // targetGuildId/targetChannelId reste accepté pour les appels existants.
      const rawTargets: any[] = Array.isArray(body?.targets)
        ? body.targets
        : (body?.targetGuildId && body?.targetChannelId
          ? [{ guildId: body.targetGuildId, channelId: body.targetChannelId, mode: body?.direction === 'UNIDIRECTIONAL' ? 'RECEIVE_ONLY' : 'BOTH' }]
          : []);

      if (!sourceChannelId || rawTargets.length === 0) {
        return send(c, { error: 'sourceChannelId et au moins une cible sont requis' }, 400);
      }

      const targets = [];
      const toCreate: { guildId: string; mode: LinkMemberMode }[] = [];
      for (const raw of rawTargets) {
        const targetGuildId = typeof raw?.guildId === 'string' ? raw.guildId : null;
        const createChannel = raw?.createChannel === true;
        const targetChannelId = typeof raw?.channelId === 'string' ? raw.channelId : null;
        if (!targetGuildId || (!targetChannelId && !createChannel)) {
          return send(c, { error: 'Chaque cible doit préciser guildId et channelId.' }, 400);
        }
        if (!client.guilds.cache.get(targetGuildId)) {
          return send(c, { error: 'Le bot n\'est pas présent sur l\'un des serveurs cibles.' }, 400);
        }
        if (!(await canManageGuild(client, targetGuildId, user.userId))) {
          return send(c, { error: 'Vous devez être admin de chacun des serveurs cibles.' }, 403);
        }
        if (createChannel) toCreate.push({ guildId: targetGuildId, mode: readMode(raw?.mode) });
        else targets.push({ guildId: targetGuildId, channelId: targetChannelId!, mode: readMode(raw?.mode) });
      }

      // « Créer le salon pour moi » : un salon texte du même nom que la source,
      // créé seulement une fois toutes les cibles validées.
      const createdChannels: { delete: (reason?: string) => Promise<unknown> }[] = [];
      const annulerSalonsCrees = () => Promise.all(createdChannels.map((c) => c.delete('Kotbo Link: création du pont annulée').catch(() => null)));
      if (toCreate.length > 0) {
        const sourceGuild = client.guilds.cache.get(guildId);
        const sourceChannel = sourceGuild?.channels.cache.get(sourceChannelId);
        const sourcePublique = !!sourceGuild && sourceChannel?.permissionsFor(sourceGuild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) === true;
        const channelName = sourceChannel?.name ?? 'pont-kotbo';
        for (const item of toCreate) {
          try {
            const created = await client.guilds.cache.get(item.guildId)!.channels.create({
              name: channelName,
              type: ChannelType.GuildText,
              permissionOverwrites: permissionsSalonDePont(sourcePublique, item.guildId, client.user!.id),
              reason: 'Kotbo Link: salon créé pour le pont',
            });
            createdChannels.push(created);
            targets.push({ guildId: item.guildId, channelId: created.id, mode: item.mode });
          } catch (err) {
            logger.warn('ChannelLinkAPI', `Création du salon impossible sur ${item.guildId}`, err);
            await annulerSalonsCrees();
            return send(c, { error: 'Le bot n\'a pas pu créer le salon sur l\'un des serveurs (permission Gérer les salons ?).' }, 400);
          }
        }
      }

      const result = await createDirectGroup({
        ownerGuildId: guildId,
        ownerChannelId: sourceChannelId,
        targets,
        createdByUserId: user.userId,
        name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null,
        ownerMode: readMode(body?.ownerMode, body?.direction === 'UNIDIRECTIONAL' ? 'SEND_ONLY' : 'BOTH'),
        relayMode: readRelayMode(body?.relayMode),
        client,
      }).catch(async (err) => {
        await annulerSalonsCrees();
        throw err;
      });

      if ('error' in result) {
        await annulerSalonsCrees();
        return send(c, { error: result.error }, 400);
      }

      let serverInviteUrl: string | null = null;
      if (body?.createServerInvite) {
        try {
          const sourceGuild = client.guilds.cache.get(guildId);
          const sourceChannel = sourceGuild?.channels.cache.get(sourceChannelId);
          if (sourceChannel && 'createInvite' in sourceChannel && typeof sourceChannel.createInvite === 'function') {
            const discordInvite = await sourceChannel.createInvite({
              maxAge: 0,
              maxUses: 0,
              reason: 'Kotbo Link: Invitation pour la description des salons liés',
            });
            serverInviteUrl = discordInvite.url;
            await recordBotInvite(discordInvite, INVITE_SOURCE.channelLinkPairing());
          }
        } catch (err) {
          logger.warn('ChannelLinkAPI', 'Impossible de créer l\'invitation Discord', err);
        }
      }

      return send(c, { ...serializeGroup(result, guildId, client), serverInviteUrl }, 201);
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST direct link', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.get(`${base}/channel-links/invites`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const invites = await prisma.channelLinkInvite.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return send(c, invites);
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur GET invites', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.post(`${base}/channel-links/invites`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody(c);
      if (!body?.channelId) {
        return send(c, { error: 'channelId requis' }, 400);
      }

      // Un code peut viser un pont existant : chaque serveur qui l'utilise
      // rejoint alors le même pont, au lieu d'en ouvrir un nouveau à deux.
      const groupId = typeof body?.groupId === 'string' ? body.groupId : null;
      if (groupId) {
        const group = await getGroup(groupId);
        if (!group || !group.members.some((m) => m.guildId === guildId)) {
          return send(c, { error: 'Pont introuvable' }, 404);
        }
      }

      const { randomBytes } = await import('node:crypto');
      const code = randomBytes(6).toString('hex').toUpperCase();
      const requestedMaxUses = typeof body?.maxUses === 'number' ? body.maxUses : Number.NaN;
      const maxUses = Number.isInteger(requestedMaxUses) && requestedMaxUses > 0
        ? Math.min(requestedMaxUses, 25)
        : 1;

      const invite = await prisma.channelLinkInvite.create({
        data: {
          code,
          guildId,
          channelId: String(body?.channelId ?? ''),
          groupId,
          memberMode: readMode(body?.memberMode),
          direction: body?.direction === 'UNIDIRECTIONAL' ? 'UNIDIRECTIONAL' : 'BIDIRECTIONAL',
          relayMode: readRelayMode(body?.relayMode),
          relayText: typeof body?.relayText === 'boolean' ? body.relayText : true,
          relayImages: typeof body?.relayImages === 'boolean' ? body.relayImages : true,
          relayEmbeds: typeof body?.relayEmbeds === 'boolean' ? body.relayEmbeds : false,
          relayReactions: typeof body?.relayReactions === 'boolean' ? body.relayReactions : false,
          relayEdits: typeof body?.relayEdits === 'boolean' ? body.relayEdits : true,
          relayDeletes: typeof body?.relayDeletes === 'boolean' ? body.relayDeletes : true,
          relayPins: typeof body?.relayPins === 'boolean' ? body.relayPins : true,
          maxUses,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          createdByUserId: user.userId,
        },
      });

      let serverInviteUrl: string | null = null;
      if (body.createServerInvite) {
        try {
          const guild = client.guilds.cache.get(guildId);
          const channel = guild?.channels.cache.get(String(body?.channelId ?? ''));
          if (channel && 'createInvite' in channel && typeof channel.createInvite === 'function') {
            const discordInvite = await channel.createInvite({
              maxAge: 24 * 60 * 60,
              maxUses: 5,
              reason: 'Kotbo Link: Invitation pour lier le salon',
            });
            serverInviteUrl = discordInvite.url;
            // Le serveur distant n'est pas encore connu à ce stade de l'appairage.
            await recordBotInvite(discordInvite, INVITE_SOURCE.channelLinkPairing());
          }
        } catch (err) {
          logger.warn('ChannelLinkAPI', 'Impossible de créer l\'invitation Discord', err);
        }
      }

      return send(c, { ...invite, serverInviteUrl }, 201);
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST invite', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.patch(`${base}/channel-links/:groupId`, ...groupGate, async (c) => {
    const guildId = c.req.param('guildId');
    const groupId = c.req.param('groupId');
    try {
      const body = await readBody(c);

      const allowedFields = ['name', 'relayText', 'relayImages', 'relayEmbeds', 'relayReactions', 'relayEdits', 'relayDeletes', 'relayThreads', 'relayPolls', 'relayPins', 'enabled', 'updateTopic'];
      const updateData: Record<string, any> = {};
      for (const field of allowedFields) {
        if (body?.[field] !== undefined) updateData[field] = body[field];
      }

      // Passe par le service : lui seul sait invalider le cache des ponts,
      // rouvrir ou refermer la garde des serveurs en liaison seule et purger les
      // correspondances de messages devenues inutiles.
      const updated = await updateGroupConfig(groupId, updateData);
      if (!updated) {
        return send(c, { error: 'Pont introuvable' }, 404);
      }

      return send(c, serializeGroup(updated, guildId, client));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur PATCH channel-link', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.delete(`${base}/channel-links/:groupId`, ...groupGate, async (c) => {
    const groupId = c.req.param('groupId');
    try {
      await removeGroup(groupId, client);
      return send(c, { ok: true });
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur DELETE channel-link', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.post(`${base}/channel-links/:groupId/members`, ...groupGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const groupId = c.req.param('groupId');
    try {
      const body = await readBody(c);
      const memberGuildId = typeof body?.guildId === 'string' ? body.guildId : null;
      const memberChannelId = typeof body?.channelId === 'string' ? body.channelId : null;
      if (!memberGuildId || !memberChannelId) {
        return send(c, { error: 'guildId et channelId requis' }, 400);
      }

      if (!client.guilds.cache.get(memberGuildId)) {
        return send(c, { error: 'Le bot n\'est pas présent sur ce serveur.' }, 400);
      }
      if (!(await canManageGuild(client, memberGuildId, user.userId))) {
        return send(c, { error: 'Vous devez être admin du serveur ajouté.' }, 403);
      }

      const result = await addGroupMember({
        groupId,
        guildId: memberGuildId,
        channelId: memberChannelId,
        addedByUserId: user.userId,
        mode: readMode(body?.mode),
        relayMode: readRelayMode(body?.relayMode),
        client,
      });

      if ('error' in result) {
        return send(c, { error: result.error }, 400);
      }

      return send(c, serializeGroup(result, guildId, client), 201);
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST membre de pont', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.patch(`${base}/channel-links/:groupId/members/:memberId`, ...groupGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const groupId = c.req.param('groupId');
    const memberId = c.req.param('memberId');
    try {
      // Régler le salon d'un autre serveur (le passer en émission, le couper) suppose d'y
      // être admin, comme pour le retirer : sans cela, un partenaire du pont décidait de
      // ce que le salon d'un autre serveur relaie vers tous.
      const target = c.var.group.members.find((m) => m.id === memberId);
      if (!target) {
        return send(c, { error: 'Salon introuvable dans ce pont' }, 404);
      }
      if (target.guildId !== guildId && !(await canManageGuild(client, target.guildId, user.userId))) {
        return send(c, { error: 'Vous devez être admin de ce serveur pour modifier son salon.' }, 403);
      }

      const body = await readBody(c);
      const data: Record<string, any> = {};
      if (body?.mode !== undefined) data.mode = readMode(body.mode);
      if (body?.relayMode !== undefined) data.relayMode = readRelayMode(body.relayMode);
      if (typeof body?.enabled === 'boolean') data.enabled = body.enabled;

      const updated = await updateGroupMemberConfig(groupId, memberId, data);
      if (!updated) {
        return send(c, { error: 'Salon introuvable dans ce pont' }, 404);
      }

      return send(c, serializeGroup(updated, guildId, client));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur PATCH membre de pont', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.delete(`${base}/channel-links/:groupId/members/:memberId`, ...groupGate, async (c) => {
    const group = c.var.group;
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const groupId = c.req.param('groupId');
    try {
      const memberId = c.req.param('memberId');
      const member = group.members.find((m) => m.id === memberId);
      if (!member) {
        return send(c, { error: 'Salon introuvable dans ce pont' }, 404);
      }
      // Retirer le salon d'un autre serveur suppose d'y être admin ; retirer le
      // sien est toujours permis, c'est la façon de quitter un pont.
      if (member.guildId !== guildId && !(await canManageGuild(client, member.guildId, user.userId))) {
        return send(c, { error: 'Vous devez être admin de ce serveur pour le retirer.' }, 403);
      }

      const remaining = await removeGroupMember(groupId, memberId, client);
      return send(c, { ok: true, group: remaining ? serializeGroup(remaining, guildId, client) : null });
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur DELETE membre de pont', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  router.post(`${base}/channel-links/:groupId/invite`, ...groupGate, async (c) => {
    const group = c.var.group;
    const guildId = c.req.param('guildId');
    try {
      const localMember = group.members.find((m) => m.guildId === guildId);
      const localChannel = localMember ? client.guilds.cache.get(guildId)?.channels.cache.get(localMember.channelId) : null;

      if (!localChannel || !('createInvite' in localChannel) || typeof localChannel.createInvite !== 'function') {
        return send(c, { error: 'Impossible de créer une invitation sur ce salon.' }, 400);
      }

      const discordInvite = await localChannel.createInvite({
        maxAge: 0,
        maxUses: 0,
        reason: 'Kotbo Link: Invitation pour la description des salons liés',
      });

      const guild = client.guilds.cache.get(guildId);
      await recordBotInvite(discordInvite, INVITE_SOURCE.channelLink(guild?.name ?? guildId));

      // Les descriptions listent tous les participants : les réécrire propage
      // l'invitation partout, au lieu du seul salon d'en face.
      let topicUpdated = false;
      if (group.updateTopic) {
        void refreshGroupTopics(client, group, true);
        topicUpdated = true;
      }

      return send(c, { inviteUrl: discordInvite.url, topicUpdated }, 201);
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST invite pour pont', err);
      return fail(c, err, 'Erreur serveur', 'ChannelLinkAPI');
    }
  });

  return router;
}

