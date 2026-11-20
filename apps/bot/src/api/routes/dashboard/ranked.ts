/**
 * Routes du module Ranked (classement compétitif RP).
 *
 * Base : `/api/dashboard/guilds/:guildId/ranked`
 */

import { Hono } from 'hono';
import { Client, PermissionFlagsBits } from 'discord.js';
import { DEFAULT_LADDER_CURVE, DEFAULT_RANKED_LADDER, generateRankedLadder, normalizeRankedLadder } from '@kotbo/shared';
import { logger } from '../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../shared.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import {
  acquireProvisionLock,
  ensureTextChannel,
  missingProvisionPermissions,
  provisionCooldown,
  provisionCooldownMessage,
  releaseProvisionLock,
  startProvisionCooldown,
} from '../../../services/core/channelProvisioningService.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';
import {
  getGuildLadder,
  getOrCreateRankedConfig,
  getTierRoles,
  removeTierRole,
  setTierRole,
  updateRankedConfig,
  type RankedConfigPatch,
} from '../../../services/progression/ranked/rankedConfigService.js';
import {
  computeLadderImpact,
  deleteTierRoles,
  getTierRoleSyncStatus,
  provisionTierRoles,
  resyncRankedTiers,
  startTierRoleSync,
  stopTierRoleSync,
} from '../../../services/progression/ranked/rankedTierRoleService.js';
import {
  adjustMemberRp,
  getRankedHistory,
  getRankedProfile,
} from '../../../services/progression/ranked/rankedService.js';
import {
  getGlobalLeaderboard,
  getRankedGuildStats,
  getRankedLeaderboard,
  getRankedLeaderboardPage,
  getStreakLeaderboard,
} from '../../../services/progression/ranked/rankedLeaderboardService.js';
import {
  cancelRankedEvent,
  createRankedEvent,
  isRankedEventType,
  listRankedEvents,
} from '../../../services/progression/ranked/rankedEventService.js';
import { previewGuildDecay, runGuildDecay } from '../../../services/progression/ranked/rankedDecayService.js';

import { fail, guildRoute, readLenientBody, send } from '../../hono/dashboard/kit.js';
const LOG_TAG = 'RankedAPI';

/**
 * Complète des lignes de classement avec de quoi les afficher.
 *
 * `RankedMember` ne connaît que des identifiants : sans cette résolution, le
 * dashboard alignait des suites de chiffres à la place des pseudos.
 */
async function withIdentities<T extends { userId: string }>(
  client: Client,
  guildId: string,
  rows: T[],
): Promise<Array<T & { displayName: string | null; avatarUrl: string | null }>> {
  const identities = await getMemberIdentities(client, guildId, rows.map((row) => row.userId))
    .catch(() => new Map());
  return rows.map((row) => ({
    ...row,
    displayName: identities.get(row.userId)?.displayName ?? null,
    avatarUrl: identities.get(row.userId)?.avatarUrl || null,
  }));
}


export function createRankedRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);

  router.onError((err, c) => {
    logger.error(LOG_TAG, `Erreur sur ${c.req.method} ${c.req.path}:`, err);
    return fail(c, err, 'Erreur du module de classement');
  });



  router.get(`${base}/ranked`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const [config, ladder, tierRoles, stats, leaderboard, streaks, events] = await Promise.all([
      getOrCreateRankedConfig(guildId),
      getGuildLadder(guildId),
      getTierRoles(guildId),
      getRankedGuildStats(guildId),
      getRankedLeaderboard(guildId, 25),
      getStreakLeaderboard(guildId, 10),
      listRankedEvents(guildId, 15),
    ]);

    return send(c, {
      config,
      ladder,
      defaultLadder: DEFAULT_RANKED_LADDER,
      defaultLadderCurve: DEFAULT_LADDER_CURVE,
      tierRoles,
      tierRoleSync: getTierRoleSyncStatus(guildId),
      stats,
      leaderboard: await withIdentities(client, guildId, leaderboard),
      streaks: await withIdentities(client, guildId, streaks),
      events,
    });
  });

  router.patch(`${base}/ranked/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readLenientBody(c);
    // La validation vit dans le service (`sanitizeRankedConfigPatch`) : elle
    // borne aussi les commandes Discord et le MCP, pas seulement cette route.
    const previousLadder = await getGuildLadder(guildId);
    const config = await updateRankedConfig(guildId, body as RankedConfigPatch);
    const ladder = await getGuildLadder(guildId);
    // Une échelle qui bouge redistribue les paliers : la colonne `tierKey`
    // est réalignée tout de suite, sinon un membre inactif garderait une clé
    // absente de la nouvelle échelle jusqu'à son prochain gain de RP. Les
    // rôles, eux, attendent une demande explicite (`tier-roles/sync`) : en
    // déplacer des milliers ne doit pas être l'effet de bord d'un curseur.
    const ladderChanged = JSON.stringify(previousLadder) !== JSON.stringify(ladder);
    const retiered = ladderChanged ? await resyncRankedTiers(guildId, ladder) : 0;
    return send(c, { config, ladder, retiered });
  });

  // proposée, avant enregistrement. Le corps porte soit une échelle complète,
  // soit une courbe ; sans corps, l'échelle enregistrée sert de référence.
  router.post(`${base}/ranked/ladder/impact`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readLenientBody(c) as { ladder?: unknown; curve?: unknown };
    const ladder = body.ladder
      ? normalizeRankedLadder(body.ladder)
      : body.curve
        ? generateRankedLadder(body.curve)
        : await getGuildLadder(guildId);

    return send(c, { ladder, ...await computeLadderImpact(guildId, ladder) });
  });

  router.get(`${base}/ranked/leaderboard`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const search = (c.req.query('search') ?? '').trim();
    const page = (c.req.query('page') ?? null);
    // L'ancienne forme limit/offset reste servie : le classement du bot et
    // les widgets s'en servent, et rien n'oblige à les migrer d'un bloc.
    if (page === null && !search && c.req.query('limit') !== undefined) {
      const limit = Number(c.req.query('limit') ?? 25);
      const offset = Number(c.req.query('offset') ?? 0);
      const rows = await getRankedLeaderboard(guildId, limit, offset);
      return send(c, { leaderboard: await withIdentities(client, guildId, rows) });
    }

    const result = await getRankedLeaderboardPage(guildId, { page: Number(page) || 1, search });
    return send(c, { ...result, rows: await withIdentities(client, guildId, result.rows) });
  });

  router.get(`${base}/ranked/global`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const rows = await getGlobalLeaderboard(Number(c.req.query('limit') ?? 25));
    // Les identités viennent de cette guilde : un membre du classement global
    // qui n'en fait pas partie reste un identifiant, ce que le dashboard sait
    // afficher.
    return send(c, { leaderboard: await withIdentities(client, guildId, rows) });
  });

  router.get(`${base}/ranked/members/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    const [profile, history] = await Promise.all([
      getRankedProfile(guildId, userId),
      getRankedHistory(guildId, userId),
    ]);
    const [identified] = await withIdentities(client, guildId, [{ userId: userId }]);
    return send(c, { profile: { ...profile, ...identified }, history });
  });

  router.post(`${base}/ranked/members/:userId/adjust`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    const body = await readLenientBody(c) as { delta?: number; reason?: string };
    const delta = Math.trunc(Number(body.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      return send(c, { error: 'delta doit être un entier non nul' }, 400);
    }

    const result = await adjustMemberRp(guildId, userId, delta, client, body.reason);
    return send(c, { result });
  });

  router.post(`${base}/ranked/announce-channel`, ...gate, async (c) => {
    const user = c.var.dashboardUser;
    const guildId = c.req.param('guildId');
    const discordGuild = client.guilds.cache.get(guildId)
      || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) {
      return send(c, { error: 'Serveur introuvable' }, 404);
    }

    const lockKey = `${guildId}:rankedAnnounceChannel`;
    if (!acquireProvisionLock(lockKey)) {
      return send(c, { error: 'Une création est déjà en cours' }, 429);
    }

    try {
      const cooldown = await provisionCooldown(lockKey);
      if (cooldown) {
        return send(c, { error: provisionCooldownMessage(cooldown, 'Le salon a déjà été créé') }, 429);
      }

      const missing = await missingProvisionPermissions(discordGuild, [PermissionFlagsBits.ManageChannels]);
      if (missing.length > 0) {
        return send(c, { error: `Le bot n'a pas les permissions nécessaires : ${missing.join(', ')}.` }, 400);
      }

      // Nom dans la langue du serveur : le salon est lu par ses membres, pas
      // par l'admin qui clique depuis le dashboard.
      const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
      const config = await getOrCreateRankedConfig(guildId);
      const botId = discordGuild.members.me?.id;

      const { channel, entry } = await ensureTextChannel(discordGuild, {
        key: 'rankedAnnounceChannel',
        existingId: config.announceChannelId,
        name: m.setup_channel_ranked({}, { locale }),
        permissionOverwrites: [
          {
            id: discordGuild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages],
          },
          ...(botId
            ? [{
                id: botId,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.EmbedLinks,
                ],
              }]
            : []),
        ],
        reason: m.setup_reason_ranked({ user: `${user.username ?? 'Utilisateur'} (${user.userId})` }, { locale }),
      });

      // Écrit tout de suite : un salon créé que la page n'enregistrerait pas
      // resterait sur le serveur sans que rien n'y renvoie.
      if (entry.created) {
        await updateRankedConfig(guildId, { announceChannelId: channel.id });
        await startProvisionCooldown(lockKey, user.username ?? 'Utilisateur');
        await pushAudit(guildId, {
          user: `${user.username ?? 'Utilisateur'} (${user.userId})`,
          action: "Création du salon d'annonce du prestige",
          context: getGuildName(client, guildId),
          module: 'Prestige',
          eventType: 'Manuel',
          details: `Salon créé : #${channel.name}`,
          channelId: channel.id,
        });
      }

      return send(c, { channelId: channel.id, name: channel.name, created: entry.created });
    } finally {
      releaseProvisionLock(lockKey);
    }
  });

  // de l'échelle et les associe à leur palier.
  router.post(`${base}/ranked/tier-roles/provision`, ...gate, async (c) => {
    const user = c.var.dashboardUser;
    const guildId = c.req.param('guildId');
    const result = await provisionTierRoles(guildId, client, {
      reason: `Rôles de palier créés depuis le dashboard par ${user.username ?? 'un administrateur'}`,
    });
    return send(c, {
      ...result,
      tierRoles: await getTierRoles(guildId),
    }, result.error && result.created === 0 ? 400 : 200);
  });

  // leurs associations. Geste destructif : le dashboard le fait confirmer.
  router.delete(`${base}/ranked/tier-roles`, ...gate, async (c) => {
    const user = c.var.dashboardUser;
    const guildId = c.req.param('guildId');
    const result = await deleteTierRoles(guildId, client, {
      reason: `Rôles de palier supprimés depuis le dashboard par ${user.username ?? 'un administrateur'}`,
    });

    if (result.deleted > 0 || result.cleared > 0) {
      await pushAudit(guildId, {
        user: `${user.username ?? 'Utilisateur'} (${user.userId})`,
        action: 'Suppression des rôles de palier du prestige',
        context: getGuildName(client, guildId),
        module: 'Prestige',
        eventType: 'Manuel',
        details: `${result.deleted} rôles supprimés, ${result.cleared} associations orphelines retirées, ${result.failed} en échec`,
        channelId: null,
      });
    }

    return send(c, {
      ...result,
      tierRoles: await getTierRoles(guildId),
    }, result.error ? 400 : 200);
  });

  router.get(`${base}/ranked/tier-roles/sync`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    return send(c, getTierRoleSyncStatus(guildId));
  });

  router.post(`${base}/ranked/tier-roles/sync`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readLenientBody(c) as { stop?: boolean };
    if (body.stop) {
      stopTierRoleSync(guildId);
      return send(c, getTierRoleSyncStatus(guildId));
    }

    const started = await startTierRoleSync(guildId, client);
    return send(c, { ...started, ...getTierRoleSyncStatus(guildId) });
  });

  router.on(['PUT', 'DELETE'], `${base}/ranked/tier-roles/:tierKey`, ...gate, async (c) => {
    const method = c.req.method;
    const guildId = c.req.param('guildId');
    const ladder = await getGuildLadder(guildId);
    const tierKey = c.req.param('tierKey');
    if (!ladder.some((tier) => tier.key === tierKey)) {
      return send(c, { error: 'Palier inconnu' }, 404);
    }

    if (method === 'PUT') {
      const body = await readLenientBody(c) as { roleId?: string };
      if (!body.roleId) {
        return send(c, { error: 'roleId manquant' }, 400);
      }
      const mapping = await setTierRole(guildId, tierKey, body.roleId);
      return send(c, { mapping });
    }

    if (method === 'DELETE') {
      const removed = await removeTierRole(guildId, tierKey);
      return send(c, removed ? { ok: true } : { error: 'Aucune association à retirer' }, removed ? 200 : 404);
    }
  });

  router.get(`${base}/ranked/events`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    return send(c, { events: await listRankedEvents(guildId, 50) });
  });

  router.post(`${base}/ranked/events`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const body = await readLenientBody(c) as {
      type?: string;
      name?: string;
      multiplier?: number;
      startsAt?: string;
      durationMinutes?: number;
      announceChannelId?: string;
    };

    if (!isRankedEventType(body.type)) {
      return send(c, { error: "Type d'événement invalide" }, 400);
    }

    const durationMinutes = Math.max(5, Math.min(1440, Number(body.durationMinutes) || 60));
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    if (Number.isNaN(startsAt.getTime())) {
      return send(c, { error: 'startsAt invalide' }, 400);
    }

    const event = await createRankedEvent(guildId, {
      type: body.type,
      name: body.name ?? body.type,
      multiplier: Number(body.multiplier) || 2,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
      announceChannelId: body.announceChannelId ?? null,
    });

    return send(c, { event }, 201);
  });

  router.delete(`${base}/ranked/events/:eventId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const eventId = c.req.param('eventId');
    const cancelled = await cancelRankedEvent(guildId, eventId);
    return send(c, cancelled ? { ok: true } : { error: 'Événement introuvable ou déjà terminé' }, cancelled ? 200 : 404);
  });

  router.get(`${base}/ranked/decay/preview`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    return send(c, await previewGuildDecay(guildId));
  });

  router.post(`${base}/ranked/decay/run`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    return send(c, await runGuildDecay(guildId, client));
  });

  return router;
}

