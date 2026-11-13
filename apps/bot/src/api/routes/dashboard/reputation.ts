/**
 * Routes dashboard du module Réputation.
 *
 * - GET    /reputation?period=week|month|all  réglages, statistiques, classement
 * - GET    /reputation/votes                  historique paginé (period, userId, cursor)
 * - PATCH  /reputation/config                 réglages
 * - DELETE /reputation/votes/:id              retrait d'un vote abusif
 *
 * L'activation du module passe par la page Modules : la garde des segments
 * ferme déjà ces routes quand il est éteint. Le service prévient le dashboard
 * en temps réel à chaque écriture, qu'elle vienne d'ici ou de Discord.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import {
  REPUTATION_COINS_PER_REP,
  REPUTATION_DAILY_LIMIT,
  REPUTATION_XP_PER_REP,
  REPUTATION_TIERS_MAX,
  REPUTATION_TIER_THRESHOLD,
  isReputationPeriod,
  validateReputationTiers,
  type ReputationPeriod,
  type ReputationTierError,
} from '@kotbo/shared';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import { logger } from '../../../utils/logger.js';
import {
  getGuildName,
  json,
  pushAudit,
  readJsonBody,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';
import {
  getReputationConfig,
  getReputationDashboardData,
  listReputationVotes,
  saveReputationConfig,
  type ReputationSettings,
} from '../../../services/community/reputationService.js';
import { revokeRep } from '../../../services/community/reputationActions.js';
import { manageableRole, tierAnnouncementLabels } from '../../../services/community/reputationTierService.js';
import { normalizeEmojiKey } from '../../../services/features/starboardTally.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { jsonFailure } from '../../shared/failure.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,40}$/;

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
  return {
    name: (userId: string) => identities.get(userId)?.displayName ?? null,
    avatar: (userId: string) => identities.get(userId)?.avatarUrl || null,
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
  ] as const;
  for (const [key, { min, max }, label] of integers) {
    if (!has(body, key)) continue;
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `${label} doit être un entier entre ${min} et ${max}` };
    }
    patch[key] = value;
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

export async function handleReputationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  const method = req.method;
  if (parts[4] !== 'reputation') return false;
  const auditUser = `${user.username} (${user.userId})`;

  // GET /reputation
  if (parts.length === 5 && method === 'GET') {
    try {
      const data = await getReputationDashboardData(guildId, periodOf(url));
      const who = await identityResolver(client, guildId, data.leaderboard.entries.map((entry) => entry.userId));
      const guild = client.guilds.cache.get(guildId);
      const locale = await resolveGuildLocale(guildId, guild?.preferredLocale);
      json(res, 200, {
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
      jsonFailure(res, err, 'Erreur lors de la récupération des données', 'ReputationAPI');
    }
    return true;
  }

  // GET /reputation/votes
  if (parts.length === 6 && parts[5] === 'votes' && method === 'GET') {
    const userId = url.searchParams.get('userId') || undefined;
    const cursor = url.searchParams.get('cursor') || undefined;
    if (userId && !SNOWFLAKE_RE.test(userId)) {
      json(res, 400, { error: 'Identifiant de membre invalide' });
      return true;
    }
    if (cursor && !CURSOR_RE.test(cursor)) {
      json(res, 400, { error: 'Curseur invalide' });
      return true;
    }

    try {
      const page = await listReputationVotes(guildId, { period: periodOf(url), userId, cursor });
      const who = await identityResolver(client, guildId, page.votes.flatMap((vote) => [vote.giverId, vote.receiverId]));
      json(res, 200, {
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
      jsonFailure(res, err, 'Erreur lors de la récupération de l\'historique', 'ReputationAPI');
    }
    return true;
  }

  // PATCH /reputation/config
  if (parts.length === 6 && parts[5] === 'config' && method === 'PATCH') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Permissions insuffisantes' });
      return true;
    }

    try {
      const guild = client.guilds.cache.get(guildId);
      const guildRoleIds = guild ? new Set(guild.roles.cache.keys()) : null;
      const parsed = parseConfigPatch(await readJsonBody<unknown>(req), guildId, guildRoleIds);
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }

      // Allumer la réaction sans emoji laisserait l'option inerte sans le dire.
      const { patch } = parsed;
      if (patch.reactionEnabled === true || (has(patch, 'reactionEmoji') && !patch.reactionEmoji)) {
        const current = await getReputationConfig(guildId);
        const enabled = patch.reactionEnabled ?? current.reactionEnabled;
        const emoji = has(patch, 'reactionEmoji') ? patch.reactionEmoji : current.reactionEmoji;
        if (enabled && !emoji) {
          json(res, 400, { error: 'Choisis un emoji pour remercier par réaction' });
          return true;
        }
      }

      const config = await saveReputationConfig(guildId, patch);
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Réputation',
        context: getGuildName(client, guildId),
        module: 'Réputation',
        eventType: 'Manuel',
        details: `Limite par jour : ${config.dailyLimit} vote(s), réaction : ${config.reactionEnabled ? config.reactionEmoji : 'non'}, gains : ${config.xpPerRep} XP / ${config.coinsPerRep} pièce(s), ${config.tiers.length} palier(s), annonce : ${config.announceChannelId ?? 'aucune'}.`,
        channelId: null,
      });
      json(res, 200, { config });
    } catch (err) {
      logger.error('ReputationAPI', 'Error saving reputation config:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour', 'ReputationAPI');
    }
    return true;
  }

  // DELETE /reputation/votes/:id
  if (parts.length === 7 && parts[5] === 'votes' && method === 'DELETE') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Permissions insuffisantes' });
      return true;
    }

    try {
      const vote = await revokeRep(client, guildId, parts[6]);
      if (!vote) {
        json(res, 404, { error: 'Vote introuvable' });
        return true;
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Retrait d\'un vote de réputation',
        context: getGuildName(client, guildId),
        module: 'Réputation',
        eventType: 'Manuel',
        details: `Vote de ${vote.giverId} pour ${vote.receiverId} retiré.`,
        channelId: null,
      });
      json(res, 200, { deleted: true });
    } catch (err) {
      logger.error('ReputationAPI', 'Error deleting reputation vote:', err);
      jsonFailure(res, err, 'Erreur lors du retrait du vote', 'ReputationAPI');
    }
    return true;
  }

  return false;
}
