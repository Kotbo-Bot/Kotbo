import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Client } from 'discord.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import {
  getPublicProfileSnapshot,
  resolveProfileRoleDisplay,
  resolveDashboardAccess,
} from '../../../shared.js';
import { optionalAuth } from '../../middleware/auth.js';
import { UserId } from '../../schemas/common.js';
import { syncMutualMemberProfiles } from '../../../routes/user.js';

// ---------------------------------------------------------------------------
// Schémas de réponse
// ---------------------------------------------------------------------------

const RoleDisplay = z.object({
  id:   z.string(),
  name: z.string(),
});

const PublicInvite = z.object({
  inviteCode: z.string().nullable(),
  inviterId:  z.string().nullable(),
  inviterTag: z.string().nullable(),
  joinedAt:   z.string(),
});

const PublicProfileResponse = z.object({
  userId:           z.string(),
  username:         z.string().nullable(),
  globalName:       z.string().nullable(),
  displayName:      z.string().nullable(),
  avatar:           z.string().nullable(),
  banner:           z.string().nullable(),
  bio:              z.string().nullable(),
  isPrivate:        z.boolean(),
  roles:            z.array(RoleDisplay),
  primaryRole:      RoleDisplay.nullable(),
  accountCreatedAt: z.string().nullable(),
  guildJoinedAt:    z.string().nullable(),
  guildLeftAt:      z.string().nullable(),
  lastSeenAt:       z.string().nullable(),
  messageCount:     z.number().nullable(),
  voiceTimeSeconds: z.number().nullable(),
  invite:           PublicInvite.nullable(),
  eventParticipations: z.array(z.object({
    id:      z.string(),
    eventId: z.string(),
    title:   z.string(),
    type:    z.string(),
    date:    z.string(),
    score:   z.number().nullable(),
  })),
});

const UpdateProfileBody = z.object({
  bio:              z.string().max(500).nullable().optional(),
  isProfilePrivate: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Factory - injecte le client Discord via closure
// ---------------------------------------------------------------------------

export function createPublicProfileRouter(client: Client) {
  const router = new OpenAPIHono();

  // -------------------------------------------------------------------------
  // GET /api/public/profile/:userId
  // -------------------------------------------------------------------------

  const getProfileRoute = createRoute({
    method:  'get',
    path:    '/api/public/profile/{userId}',
    summary: 'Profil public d\'un utilisateur',
    tags:    ['Public'],
    request: {
      params: z.object({ userId: UserId }),
    },
    responses: {
      200: {
        description: 'Profil public (peut être masqué si privé)',
        content: { 'application/json': { schema: PublicProfileResponse } },
      },
      400: { description: 'ID utilisateur invalide', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      404: { description: 'Utilisateur introuvable', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      500: { description: 'Erreur interne', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  });

  router.use('/api/public/profile/*', optionalAuth);

  router.openapi(getProfileRoute, async (c) => {
    const { userId } = c.req.valid('param');

    try {
      let snapshot = await getPublicProfileSnapshot(userId);
      let profile = snapshot?.memberProfile;

      if (!snapshot || !profile) {
        const discordUser = await client.users.fetch(userId).catch(() => null);
        if (!discordUser) {
          return c.json({ error: 'Utilisateur introuvable' }, 404);
        }

        const sharedGuild = client.guilds.cache.find((g) => g.members.cache.has(userId));
        const fallbackGuildId = sharedGuild?.id || client.guilds.cache.first()?.id || '';

        profile = {
          id:                  `${fallbackGuildId}:${userId}`,
          guildId:             fallbackGuildId,
          userId,
          userTag:             discordUser.tag,
          username:            discordUser.username,
          globalName:          discordUser.globalName || null,
          displayName:         discordUser.globalName || discordUser.username,
          avatarUrl:           discordUser.displayAvatarURL(),
          bannerUrl:           null,
          accentColor:         discordUser.accentColor || null,
          locale:              null,
          isBot:               discordUser.bot,
          bio:                 null,
          isProfilePrivate:    false,
          accountCreatedAt:    discordUser.createdAt,
          guildJoinedAt:       null,
          guildLeftAt:         null,
          firstSeenAt:         new Date(),
          lastSeenAt:          new Date(),
          lastMessageAt:       null,
          lastMessageChannelId:null,
          messageCount:        0,
          voiceSessionCount:   0,
          voiceTimeSeconds:    0,
          voiceLastChannelId:  null,
          voiceLastJoinedAt:   null,
          voiceLastLeftAt:     null,
          rolesSnapshot:       [],
          isSuspectedDC:       false,
          moderatorNote:       null,
          createdAt:           new Date(),
          updatedAt:           new Date(),
        };

        snapshot = {
          memberProfile:          profile,
          invite:                 null,
          eventParticipations:    [],
        };
      }

      const roleDisplay = await resolveProfileRoleDisplay(client, profile.guildId, profile.rolesSnapshot);
      const authUser    = c.var.authOptional;
      const viewerGuildAccess = authUser
        ? await resolveDashboardAccess(client, profile.guildId, authUser.userId).catch(() => null)
        : null;
      const canViewPrivate =
        !profile.isProfilePrivate ||
        authUser?.userId === userId ||
        (!!viewerGuildAccess?.level && viewerGuildAccess.level !== 'none');

      if (canViewPrivate) {
        return c.json({
          userId:              profile.userId,
          username:            profile.username,
          globalName:          profile.globalName,
          displayName:         profile.displayName || profile.globalName || profile.username,
          avatar:              profile.avatarUrl,
          banner:              profile.bannerUrl,
          bio:                 profile.bio,
          isPrivate:           profile.isProfilePrivate,
          roles:               roleDisplay.roles,
          primaryRole:         roleDisplay.primaryRole,
          accountCreatedAt:    profile.accountCreatedAt?.toISOString() ?? null,
          guildJoinedAt:       profile.guildJoinedAt?.toISOString() ?? null,
          guildLeftAt:         profile.guildLeftAt?.toISOString() ?? null,
          lastSeenAt:          profile.lastSeenAt?.toISOString() ?? null,
          messageCount:        profile.messageCount,
          voiceTimeSeconds:    profile.voiceTimeSeconds,
          invite:              snapshot.invite
            ? {
                inviteCode: snapshot.invite.inviteCode,
                inviterId:  snapshot.invite.inviterId,
                inviterTag: snapshot.invite.inviterTag,
                joinedAt:   snapshot.invite.joinedAt.toISOString(),
              }
            : null,
          eventParticipations: snapshot.eventParticipations.map((entry) => ({
            id:      entry.id,
            eventId: entry.eventId,
            title:   entry.eventTitle,
            type:    entry.eventType,
            date:    entry.createdAt.toISOString(),
            score:   entry.score,
          })),
        }, 200);
      }

      // Profil privé - données masquées
      return c.json({
        userId:              profile.userId,
        username:            profile.username,
        globalName:          profile.globalName,
        displayName:         profile.displayName || profile.globalName || profile.username,
        avatar:              profile.avatarUrl,
        banner:              profile.bannerUrl,
        bio:                 null,
        isPrivate:           true,
        roles:               roleDisplay.roles,
        primaryRole:         roleDisplay.primaryRole,
        accountCreatedAt:    null,
        guildJoinedAt:       null,
        guildLeftAt:         profile.guildLeftAt?.toISOString() ?? null,
        lastSeenAt:          null,
        messageCount:        null,
        voiceTimeSeconds:    null,
        invite:              null,
        eventParticipations: [],
      }, 200);
    } catch (err) {
      logger.error('PublicAPI', `Error fetching public profile for ${userId}:`, err);
      return c.json({ error: 'Erreur interne du serveur' }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /api/public/profile/:userId
  // -------------------------------------------------------------------------

  const updateProfileRoute = createRoute({
    method:  'patch',
    path:    '/api/public/profile/{userId}',
    summary: 'Mettre à jour son propre profil public',
    tags:    ['Public'],
    request: {
      params: z.object({ userId: UserId }),
      body: {
        content: {
          'application/json': { schema: UpdateProfileBody },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'Profil mis à jour',
        content: {
          'application/json': {
            schema: z.object({
              ok:      z.boolean(),
              profile: z.object({ bio: z.string().nullable(), isProfilePrivate: z.boolean() }),
            }),
          },
        },
      },
      400: { description: 'Paramètres invalides', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      401: { description: 'Non authentifié',       content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      403: { description: 'Accès refusé',          content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      404: { description: 'Profil introuvable',    content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      500: { description: 'Erreur interne',        content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  });

  router.openapi(updateProfileRoute, async (c) => {
    const { userId } = c.req.valid('param');
    const authUser   = c.var.authOptional;

    if (!authUser) {
      return c.json({ error: 'Non authentifié' }, 401);
    }

    if (authUser.userId !== userId) {
      return c.json({ error: 'Seul le propriétaire du profil peut le modifier' }, 403);
    }

    try {
      let snapshot = await getPublicProfileSnapshot(userId);
      if (!snapshot) {
        // Personne n'a encore ecrit nulle part : on ouvre ses fiches sur les
        // serveurs partages plutot que de refuser l'enregistrement.
        await syncMutualMemberProfiles(client, userId, authUser.discordToken, { force: true });
        snapshot = await getPublicProfileSnapshot(userId);
      }
      if (!snapshot) {
        return c.json({ error: 'Profil introuvable' }, 404);
      }

      const body = c.req.valid('json');
      const profile = {
        bio: typeof body.bio === 'string'
          ? body.bio.trim().substring(0, 500)
          : body.bio === null
            ? null
            : snapshot.memberProfile.bio,
        isProfilePrivate: typeof body.isProfilePrivate === 'boolean'
          ? body.isProfilePrivate
          : snapshot.memberProfile.isProfilePrivate,
      };

      // Toutes les fiches, une par serveur : la lecture rend la plus recemment
      // touchee, qui ne serait pas celle-ci des le prochain message ailleurs.
      await prisma.memberProfile.updateMany({ where: { userId }, data: profile });

      return c.json({ ok: true, profile }, 200);
    } catch (err) {
      logger.error('PublicAPI', `Error updating public profile for ${userId}:`, err);
      return c.json({ error: 'Erreur lors de la mise à jour du profil' }, 500);
    }
  });

  return router;
}
