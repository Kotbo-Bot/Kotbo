/**
 * Routes dashboard du module Réputation.
 *
 * - GET    /reputation?period=week|month|all  réglages, statistiques, classement
 * - GET    /reputation/votes                  historique paginé (period, userId, cursor)
 * - GET    /reputation/members/:userId        réputation d'un membre, pour sa fiche
 * - PATCH  /reputation/config                 réglages
 * - DELETE /reputation/votes/:id              retrait d'un vote abusif ou d'un ajustement
 * - POST   /reputation/adjustments            points donnés ou retirés par le staff
 * - POST   /reputation/reset                  remise à zéro d'un membre ou du serveur
 *
 * L'activation du module passe par la page Modules : la garde des segments
 * ferme déjà ces routes quand il est éteint. Le service prévient le dashboard
 * en temps réel à chaque écriture, qu'elle vienne d'ici ou de Discord.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import {
  REPUTATION_ADJUSTMENT,
  REPUTATION_COINS_PER_REP,
  REPUTATION_DAILY_LIMIT,
  REPUTATION_EXCLUDED_MAX,
  REPUTATION_MIN_ACCOUNT_AGE_DAYS,
  REPUTATION_MIN_MEMBER_DAYS,
  REPUTATION_SAME_MEMBER_COOLDOWN_DAYS,
  REPUTATION_XP_PER_REP,
  decodeReputationCursor,
  REPUTATION_TIERS_MAX,
  REPUTATION_TIER_THRESHOLD,
  isReputationPeriod,
  validateReputationTiers,
  type ReputationPeriod,
  type ReputationTierError,
} from '@kotbo/shared';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import { logger } from '../../../utils/logger.js';
import { getGuildName, pushAudit } from '../../shared.js';
import {
  getMemberReputationSummary,
  getReputationConfig,
  getReputationDashboardData,
  listReputationVotes,
  saveReputationConfig,
  type ReputationSettings,
} from '../../../services/community/reputationService.js';
import { adjustRep, resetGuildRep, resetMemberRep, revokeRep } from '../../../services/community/reputationActions.js';
import { manageableRole, tierAnnouncementLabels } from '../../../services/community/reputationTierService.js';
import { normalizeEmojiKey } from '../../../services/features/starboardTally.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const ADJUSTMENT_REASON_MAX = 200;

const has = (body: object, key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

function periodOf(url: URL): ReputationPeriod {
  const raw = url.searchParams.get('period');
  return isReputationPeriod(raw) ? raw : 'all';
}

/**
 * La réputation ne stocke que des identifiants : sans cette résolution, le
 * classement et l'historique affichent des suites de chiffres.
 */
async function identityResolver(client: Client, guildId: string, userIds: string[]) {
  const identities = await getMemberIdentities(client, guildId, [...new Set(userIds)]);
  const name = (userId: string) => identities.get(userId)?.displayName ?? null;
  return {
    name,
    avatar: (userId: string) => identities.get(userId)?.avatarUrl || null,
    /**
     * Désignation pour le journal d'audit : « pseudo (id) », ou l'id seul pour
     * un membre parti. L'id reste écrit : la fiche membre retrouve ses entrées
     * en le cherchant dans les détails.
     */
    label: (userId: string) => {
      const display = name(userId);
      return display ? `${display} (${userId})` : userId;
    },
  };
}

const TIER_ERRORS: Record<ReputationTierError, string> = {
  NOT_ARRAY: 'Les paliers doivent être une liste',
  TOO_MANY: `Pas plus de ${REPUTATION_TIERS_MAX} paliers`,
  BAD_THRESHOLD: `Chaque seuil doit être un entier entre ${REPUTATION_TIER_THRESHOLD.min} et ${REPUTATION_TIER_THRESHOLD.max}`,
  BAD_ROLE: 'Chaque palier doit désigner un rôle',
  DUPLICATE_THRESHOLD: 'Deux paliers ne peuvent pas avoir le même seuil',
  DUPLICATE_ROLE: 'Un même rôle ne peut pas servir à deux paliers',
};

/**
 * Valide un corps de PATCH. Rend les champs à écrire, ou le motif du refus.
 * `guildRoleIds` vaut `null` quand le serveur n'est pas dans le cache de ce
 * shard : l'existence des rôles n'est alors pas vérifiable ici.
 */
function parseConfigPatch(
  body: unknown,
  guildId: string,
  guildRoleIds: Set<string> | null,
): { patch: Partial<ReputationSettings> } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Payload invalide' };
  const patch: Partial<ReputationSettings> = {};

  const integers = [
    ['dailyLimit', REPUTATION_DAILY_LIMIT, 'La limite par jour'],
    ['xpPerRep', REPUTATION_XP_PER_REP, 'L\'XP par remerciement'],
    ['coinsPerRep', REPUTATION_COINS_PER_REP, 'Les pièces par remerciement'],
    ['minAccountAgeDays', REPUTATION_MIN_ACCOUNT_AGE_DAYS, 'L\'âge minimum du compte'],
    ['minMemberDays', REPUTATION_MIN_MEMBER_DAYS, 'L\'ancienneté minimum sur le serveur'],
    ['sameMemberCooldownDays', REPUTATION_SAME_MEMBER_COOLDOWN_DAYS, 'L\'attente avant de remercier le même membre'],
  ] as const;
  for (const [key, { min, max }, label] of integers) {
    if (!has(body, key)) continue;
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `${label} doit être un entier entre ${min} et ${max}` };
    }
    patch[key] = value;
  }

  const idLists = [
    ['excludedRoleIds', 'Les rôles exclus'],
    ['excludedChannelIds', 'Les salons exclus'],
  ] as const;
  for (const [key, label] of idLists) {
    if (!has(body, key)) continue;
    const value = (body as Record<string, unknown>)[key];
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !SNOWFLAKE_RE.test(id))) {
      return { error: `${label} doivent être une liste d'identifiants` };
    }
    const unique = [...new Set(value as string[])];
    if (unique.length > REPUTATION_EXCLUDED_MAX) return { error: `${label} : pas plus de ${REPUTATION_EXCLUDED_MAX}` };
    patch[key] = unique;
  }

  if (has(body, 'reactionEnabled')) {
    const value = (body as { reactionEnabled: unknown }).reactionEnabled;
    if (typeof value !== 'boolean') return { error: 'Le champ reactionEnabled doit être un booléen' };
    patch.reactionEnabled = value;
  }

  if (has(body, 'reactionEmoji')) {
    const value = (body as { reactionEmoji: unknown }).reactionEmoji;
    if (value !== null && typeof value !== 'string') return { error: 'L\'emoji de remerciement est invalide' };
    // Même réduction que Starlight : un emoji custom est gardé sous son seul id.
    const emoji = value === null ? '' : normalizeEmojiKey(value);
    if (emoji && !SNOWFLAKE_RE.test(emoji) && [...emoji].length > 8) {
      return { error: 'L\'emoji de remerciement est invalide' };
    }
    patch.reactionEmoji = emoji || null;
  }

  if (has(body, 'announceChannelId')) {
    const value = (body as { announceChannelId: unknown }).announceChannelId;
    if (value !== null && (typeof value !== 'string' || !SNOWFLAKE_RE.test(value.trim()))) {
      return { error: 'Le salon d\'annonce est invalide' };
    }
    patch.announceChannelId = value === null ? null : value.trim();
  }

  if (has(body, 'tiers')) {
    const parsed = validateReputationTiers((body as { tiers: unknown }).tiers);
    if ('error' in parsed) return { error: TIER_ERRORS[parsed.error] };
    // @everyone porte l'id du serveur : le « donner » ne changerait rien.
    if (parsed.tiers.some((tier) => tier.roleId === guildId || (guildRoleIds && !guildRoleIds.has(tier.roleId)))) {
      return { error: 'Un palier désigne un rôle absent du serveur' };
    }
    patch.tiers = parsed.tiers;
  }

  if (Object.keys(patch).length === 0) return { error: 'Aucun champ à mettre à jour' };
  return { patch };
}

export function createReputationRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/reputation`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const data = await getReputationDashboardData(guildId, periodOf(new URL(c.req.url)));
      const who = await identityResolver(client, guildId, data.leaderboard.entries.map((entry) => entry.userId));
      const guild = client.guilds.cache.get(guildId);
      const locale = await resolveGuildLocale(guildId, guild?.preferredLocale);
      return send(c, {
        ...data,
        announcement: tierAnnouncementLabels(locale),
        // Rôles de palier que le bot ne pourra pas donner : supprimés, gérés par
        // une intégration ou placés au-dessus du sien. Inconnu hors du cache.
        unmanageableTierRoleIds: guild
          ? data.config.tiers.filter((tier) => !manageableRole(guild, tier.roleId)).map((tier) => tier.roleId)
          : [],
        leaderboard: {
          ...data.leaderboard,
          entries: data.leaderboard.entries.map((entry) => ({
            ...entry,
            displayName: who.name(entry.userId),
            avatarUrl: who.avatar(entry.userId),
          })),
        },
      });
    } catch (err) {
      logger.error('ReputationAPI', 'Error fetching reputation data:', err);
      return fail(c, err, 'Erreur lors de la récupération des données', 'ReputationAPI');
    }
  });

  router.get(`${base}/reputation/votes`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = (c.req.query('userId') ?? null) || undefined;
    const cursor = (c.req.query('cursor') ?? null) || undefined;
    if (userId && !SNOWFLAKE_RE.test(userId)) {
      return send(c, { error: 'Identifiant de membre invalide' }, 400);
    }
    if (cursor && !decodeReputationCursor(cursor)) {
      return send(c, { error: 'Curseur invalide' }, 400);
    }

    try {
      const page = await listReputationVotes(guildId, { period: periodOf(new URL(c.req.url)), userId, cursor });
      const who = await identityResolver(client, guildId, page.votes.flatMap((vote) => [vote.giverId, vote.receiverId]));
      return send(c, {
        nextCursor: page.nextCursor,
        votes: page.votes.map((vote) => ({
          ...vote,
          giverName: who.name(vote.giverId),
          giverAvatarUrl: who.avatar(vote.giverId),
          receiverName: who.name(vote.receiverId),
          receiverAvatarUrl: who.avatar(vote.receiverId),
          messageUrl: vote.channelId && vote.messageId
            ? `https://discord.com/channels/${guildId}/${vote.channelId}/${vote.messageId}`
            : null,
        })),
      });
    } catch (err) {
      logger.error('ReputationAPI', 'Error listing reputation votes:', err);
      return fail(c, err, 'Erreur lors de la récupération de l\'historique', 'ReputationAPI');
    }
  });

  router.patch(`${base}/reputation/config`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = `${user.username} (${user.userId})`;
    if (!access.canManageSettings) {
      return send(c, { error: 'Permissions insuffisantes' }, 403);
    }

    try {
      const guild = client.guilds.cache.get(guildId);
      const guildRoleIds = guild ? new Set(guild.roles.cache.keys()) : null;
      const parsed = parseConfigPatch(await readBody<unknown>(c), guildId, guildRoleIds);
      if ('error' in parsed) {
        return send(c, { error: parsed.error }, 400);
      }

      // Allumer la réaction sans emoji laisserait l'option inerte sans le dire.
      const { patch } = parsed;
      if (patch.reactionEnabled === true || (has(patch, 'reactionEmoji') && !patch.reactionEmoji)) {
        const current = await getReputationConfig(guildId);
        const enabled = patch.reactionEnabled ?? current.reactionEnabled;
        const emoji = has(patch, 'reactionEmoji') ? patch.reactionEmoji : current.reactionEmoji;
        if (enabled && !emoji) {
          return send(c, { error: 'Choisis un emoji pour remercier par réaction' }, 400);
        }
      }

      const config = await saveReputationConfig(guildId, patch);
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Réputation',
        context: getGuildName(client, guildId),
        module: 'Réputation',
        eventType: 'Manuel',
        details: `Limite par jour : ${config.dailyLimit} vote(s), réaction : ${config.reactionEnabled ? config.reactionEmoji : 'non'}, gains : ${config.xpPerRep} XP / ${config.coinsPerRep} pièce(s), ${config.tiers.length} palier(s), annonce : ${config.announceChannelId ?? 'aucune'}, garde-fous : compte ${config.minAccountAgeDays} j, ancienneté ${config.minMemberDays} j, même membre tous les ${config.sameMemberCooldownDays} j, ${config.excludedRoleIds.length} rôle(s) et ${config.excludedChannelIds.length} salon(s) exclus.`,
        channelId: null,
      });
      return send(c, { config });
    } catch (err) {
      logger.error('ReputationAPI', 'Error saving reputation config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'ReputationAPI');
    }
  });

  router.delete(`${base}/reputation/votes/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = `${user.username} (${user.userId})`;
    const userId = c.req.param('userId');
    if (!access.canManageSettings) {
      return send(c, { error: 'Permissions insuffisantes' }, 403);
    }

    try {
      const vote = await revokeRep(client, guildId, c.req.param('userId'));
      if (!vote) {
        return send(c, { error: 'Vote introuvable' }, 404);
      }

      // Le vote est déjà retiré : un échec de résolution des pseudos ne doit
      // pas répondre une erreur, le journal garde alors les identifiants seuls.
      const who = await identityResolver(client, guildId, [vote.giverId, vote.receiverId]).catch(() => null);
      const label = (userId: string) => who?.label(userId) ?? userId;
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Retrait d\'un vote de réputation',
        context: getGuildName(client, guildId),
        module: 'Réputation',
        eventType: 'Manuel',
        details: vote.kind === 'ADJUSTMENT'
          ? `Ajustement de ${vote.value} point(s) pour ${label(vote.receiverId)} retiré.`
          : `Vote de ${label(vote.giverId)} pour ${label(vote.receiverId)} retiré.`,
        channelId: null,
      });
      return send(c, { deleted: true });
    } catch (err) {
      logger.error('ReputationAPI', 'Error deleting reputation vote:', err);
      return fail(c, err, 'Erreur lors du retrait du vote', 'ReputationAPI');
    }
  });

  router.get(`${base}/reputation/members/:userId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const userId = c.req.param('userId');
    if (!SNOWFLAKE_RE.test(userId)) {
      return send(c, { error: 'Identifiant de membre invalide' }, 400);
    }
    try {
      const summary = await getMemberReputationSummary(guildId, userId);
      const who = await identityResolver(client, guildId, summary.recent.map((entry) => entry.giverId));
      return send(c, {
        ...summary,
        recent: summary.recent.map((entry) => ({ ...entry, giverName: who.name(entry.giverId) })),
      });
    } catch (err) {
      logger.error('ReputationAPI', 'Error fetching member reputation:', err);
      return fail(c, err, 'Erreur lors de la récupération de la réputation du membre', 'ReputationAPI');
    }
  });

  router.post(`${base}/reputation/adjustments`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = `${user.username} (${user.userId})`;
    if (!access.canManageSettings) {
      return send(c, { error: 'Permissions insuffisantes' }, 403);
    }
    try {
      const body = await readBody<{ userId?: unknown; amount?: unknown; reason?: unknown }>(c);
      const userId = body?.userId;
      const amount = body?.amount;
      if (typeof userId !== 'string' || !SNOWFLAKE_RE.test(userId)) {
        return send(c, { error: 'Identifiant de membre invalide' }, 400);
      }
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount === 0
        || amount < REPUTATION_ADJUSTMENT.min || amount > REPUTATION_ADJUSTMENT.max) {
        return send(c, { error: `Le nombre de points doit être un entier non nul entre ${REPUTATION_ADJUSTMENT.min} et ${REPUTATION_ADJUSTMENT.max}` }, 400);
      }
      const rawReason = body?.reason ?? null;
      if (rawReason !== null && typeof rawReason !== 'string') {
        return send(c, { error: 'Le motif est invalide' }, 400);
      }
      const reason = typeof rawReason === 'string' ? rawReason.trim() || null : null;
      if (reason && reason.length > ADJUSTMENT_REASON_MAX) {
        return send(c, { error: `Le motif ne doit pas dépasser ${ADJUSTMENT_REASON_MAX} caractères` }, 400);
      }

      const result = await adjustRep(client, { guildId, staffId: user.userId, userId, amount, reason });
      if (!result.success) {
        return send(c, { error: `Le membre n'a que ${result.total} point(s) : impossible de descendre sous zéro`, total: result.total }, 409);
      }

      const who = await identityResolver(client, guildId, [userId]).catch(() => null);
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Ajustement de réputation',
        context: getGuildName(client, guildId),
        module: 'Réputation',
        eventType: 'Manuel',
        details: `${amount > 0 ? `+${amount}` : amount} point(s) pour ${who?.label(userId) ?? userId} (${result.before} → ${result.after})${reason ? `, motif : ${reason}` : ''}.`,
        channelId: null,
      });
      return send(c, { before: result.before, after: result.after });
    } catch (err) {
      logger.error('ReputationAPI', 'Error adjusting reputation:', err);
      return fail(c, err, 'Erreur lors de l\'ajustement', 'ReputationAPI');
    }
  });

  router.post(`${base}/reputation/reset`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = `${user.username} (${user.userId})`;
    if (!access.canManageSettings) {
      return send(c, { error: 'Permissions insuffisantes' }, 403);
    }
    try {
      const body = await readBody<{ scope?: unknown; userId?: unknown }>(c);
      const scope = body?.scope;

      if (scope === 'member') {
        const userId = body?.userId;
        if (typeof userId !== 'string' || !SNOWFLAKE_RE.test(userId)) {
          return send(c, { error: 'Identifiant de membre invalide' }, 400);
        }
        const removed = await resetMemberRep(client, guildId, userId);
        const who = await identityResolver(client, guildId, [userId]).catch(() => null);
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Remise à zéro de la réputation d\'un membre',
          context: getGuildName(client, guildId),
          module: 'Réputation',
          eventType: 'Manuel',
          details: `Réputation de ${who?.label(userId) ?? userId} remise à zéro (${removed} ligne(s) retirée(s)).`,
          channelId: null,
        });
        return send(c, { removed });
      }

      if (scope === 'guild') {
        const { count, members } = await resetGuildRep(client, guildId);
        await pushAudit(guildId, {
          user: auditUser,
          action: 'Remise à zéro de la réputation du serveur',
          context: getGuildName(client, guildId),
          module: 'Réputation',
          eventType: 'Manuel',
          details: `Toute la réputation du serveur remise à zéro : ${count} ligne(s), ${members} membre(s).`,
          channelId: null,
        });
        return send(c, { removed: count, members });
      }

      return send(c, { error: 'Portée de remise à zéro invalide' }, 400);
    } catch (err) {
      logger.error('ReputationAPI', 'Error resetting reputation:', err);
      return fail(c, err, 'Erreur lors de la remise à zéro', 'ReputationAPI');
    }
  });

  return router;
}

