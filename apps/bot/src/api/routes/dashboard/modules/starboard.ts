/**
 * Routes dashboard du module `starboard` (Starlight, messages à la une).
 *
 * - GET   /starboard          réglages, statistiques, meilleurs messages, état du salon
 * - GET   /starboard/entries  galerie paginée (period, sort, channelId, authorId, cursor)
 * - PATCH /starboard          réglages ; un membre tout juste exclu perd ses messages à la une
 * - POST  /starboard/entries/:id/block    retirer un message de la une, sans retour possible
 * - POST  /starboard/entries/:id/unblock  annuler ce retrait
 *
 * Retirer ou rétablir demande le droit « Modérer » de la fonctionnalité, ou la
 * modération de contenu quand le centre de gestion ne l'a pas retiré au rôle,
 * comme pour les suggestions.
 *
 * `enabled` n'est pas modifiable ici. Le segment est fermé par la garde des
 * modules tant que Starlight est éteint : une route qu'on ne peut atteindre
 * qu'allumé ne peut pas servir à l'allumer. L'activation passe donc par
 * `/modules`, qui écrit les deux états (la pastille et `StarboardConfig`) et
 * propage les dépendances.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import type { StarboardEntry } from '@prisma/client';
import {
  STARBOARD_BLOCKED_USERS_MAX,
  STARBOARD_CHANNEL_THRESHOLDS_MAX,
  STARBOARD_CHANNELS_MAX,
  STARBOARD_MAX_AGE_DAYS,
  STARBOARD_REWARD_COINS,
  STARBOARD_REWARD_XP,
  REPUTATION_TIERS_MAX,
  REPUTATION_TIER_THRESHOLD,
  STARBOARD_EMOJIS_MAX,
  STARBOARD_THRESHOLD,
  decodeScoreCursor,
  decodeTimeCursor,
  isStarboardPeriod,
  isStarboardSort,
  normalizeStarboardChannelThresholds,
  validateReputationTiers,
  type ReputationTierError,
  type StarboardChannelThresholdError,
  type StarboardSettings,
} from '@kotbo/shared';
import { logger } from '../../../../utils/logger.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { normalizeEmojiKey } from '../../../../services/features/starboardTally.js';
import { getStarboardOverview, listStarboardEntries } from '../../../../services/features/starboardDashboard.js';
import { getStarboardSettings, saveStarboardSettings } from '../../../../services/features/starboardSettings.js';
import { starboardChannelHealth } from '../../../../services/features/starboardHealth.js';
import { starboardMessageLabels } from '../../../../services/features/starboardMessageLabels.js';
import { blockStarboardEntry, removeHighlightsOfAuthors, unblockStarboardEntry } from '../../../../services/features/starboardService.js';
import { getMemberIdentities } from '../../../../services/moderation/memberIdentityService.js';
import { manageableRole } from '../../../../services/community/reputationTierService.js';
import { getGuildName, pushAudit, type DashboardAccess } from '../../../shared.js';
import { getCachedFeatureAccess } from '../featureGate.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../../hono/dashboard/kit.js';

/** Identifiant Discord : salon, rôle, membre ou emoji custom. */
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CUID_RE = /^[a-z0-9]{20,40}$/i;

const TIER_ERRORS: Record<ReputationTierError, string> = {
  NOT_ARRAY: 'Les paliers doivent être une liste',
  TOO_MANY: `Pas plus de ${REPUTATION_TIERS_MAX} paliers`,
  BAD_THRESHOLD: `Le seuil d'un palier est un entier entre ${REPUTATION_TIER_THRESHOLD.min} et ${REPUTATION_TIER_THRESHOLD.max}`,
  BAD_ROLE: 'Un palier porte un rôle invalide',
  DUPLICATE_THRESHOLD: 'Deux paliers ont le même seuil',
  DUPLICATE_ROLE: 'Deux paliers donnent le même rôle',
};

const CHANNEL_THRESHOLD_ERRORS: Record<StarboardChannelThresholdError, string> = {
  NOT_OBJECT: 'Les seuils par salon doivent être un objet { salon: seuil }',
  TOO_MANY: `Pas plus de ${STARBOARD_CHANNEL_THRESHOLDS_MAX} seuils par salon`,
  BAD_CHANNEL: 'Un seuil par salon porte un identifiant de salon invalide',
  BAD_THRESHOLD: `Un seuil par salon doit être un entier entre ${STARBOARD_THRESHOLD.min} et ${STARBOARD_THRESHOLD.max}`,
};

const BOOLEAN_KEYS = ['countEmbedReactions', 'autoReactEmbed', 'allowBots', 'ignoreAuthorVotes', 'removeBelowThreshold', 'notifyAuthor'] as const;
const CHANNEL_LIST_KEYS = ['autoReactChannels', 'watchedChannels', 'ignoredChannels'] as const;
const EMOJI_LIST_KEYS = ['upvoteEmojis', 'downvoteEmojis'] as const;

const has = (body: object, key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

/** Liste de salons : dédoublonnée, bornée, et rejetée si un id est mal formé. */
function parseChannelList(value: unknown, field: string): { ids: string[] } | { error: string } {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { error: `Le champ ${field} doit être un tableau de chaînes` };
  }
  const ids = [...new Set((value as string[]).map((id) => id.trim()).filter(Boolean))];
  if (ids.length > STARBOARD_CHANNELS_MAX) {
    return { error: `Le champ ${field} ne peut pas contenir plus de ${STARBOARD_CHANNELS_MAX} salons` };
  }
  if (ids.some((id) => !SNOWFLAKE_RE.test(id))) {
    return { error: `Le champ ${field} contient un identifiant de salon invalide` };
  }
  return { ids };
}

/**
 * Liste d'emojis de vote. Un emoji custom est stocké sous son seul id : le nom
 * peut changer sur le serveur, l'id non. `normalizeEmojiKey` fait cette
 * réduction, la même que celle appliquée au décompte des réactions.
 */
function parseEmojiList(value: unknown, field: string): { emojis: string[] } | { error: string } {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { error: `Le champ ${field} doit être un tableau de chaînes` };
  }
  const emojis = [...new Set((value as string[]).map((raw) => normalizeEmojiKey(raw)).filter(Boolean))];
  if (emojis.length > STARBOARD_EMOJIS_MAX) {
    return { error: `Le champ ${field} ne peut pas contenir plus de ${STARBOARD_EMOJIS_MAX} emojis` };
  }
  // Un emoji custom arrive réduit à son id, qui compte 17 à 20 chiffres : il
  // doit passer avant la borne des emojis unicode. Un emoji unicode tient en
  // quelques points de code ; au-delà, c'est du texte collé par erreur, que
  // Discord refuserait à la réaction.
  if (emojis.some((e) => !SNOWFLAKE_RE.test(e) && [...e].length > 8)) {
    return { error: `Le champ ${field} contient une valeur qui n'est pas un emoji` };
  }
  return { emojis };
}

/** Valide un corps de PATCH. Rend les champs à écrire, ou le motif du refus. */
export function parseStarboardConfigPatch(body: unknown): { patch: Partial<StarboardSettings> } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Payload invalide' };
  const input = body as Record<string, unknown>;
  const patch: Partial<StarboardSettings> = {};

  for (const key of BOOLEAN_KEYS) {
    if (!has(input, key)) continue;
    const value = input[key];
    if (typeof value !== 'boolean') return { error: `Le champ ${key} doit être un booléen` };
    patch[key] = value;
  }

  if (has(input, 'channelId')) {
    const value = input.channelId;
    if (value !== null && (typeof value !== 'string' || !SNOWFLAKE_RE.test(value.trim()))) {
      return { error: 'Le salon de publication est invalide' };
    }
    patch.channelId = value === null ? null : value.trim();
  }

  if (has(input, 'threshold')) {
    const value = input.threshold;
    const { min, max } = STARBOARD_THRESHOLD;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `Le seuil doit être un entier entre ${min} et ${max}` };
    }
    patch.threshold = value;
  }

  if (has(input, 'embedColor')) {
    const color = typeof input.embedColor === 'string' ? input.embedColor.trim() : '';
    if (!HEX_COLOR_RE.test(color)) return { error: 'La couleur doit être au format hexadécimal (#RRGGBB)' };
    patch.embedColor = color.toUpperCase();
  }

  for (const key of EMOJI_LIST_KEYS) {
    if (!has(input, key)) continue;
    const parsed = parseEmojiList(input[key], key);
    if ('error' in parsed) return parsed;
    patch[key] = parsed.emojis;
  }

  // Sans emoji positif, aucun vote ne peut être compté : le module tournerait
  // en silence. On refuse plutôt que de le laisser inerte.
  if (patch.upvoteEmojis && patch.upvoteEmojis.length === 0) {
    return { error: 'Au moins un emoji de vote positif est requis' };
  }

  for (const key of CHANNEL_LIST_KEYS) {
    if (!has(input, key)) continue;
    const parsed = parseChannelList(input[key], key);
    if ('error' in parsed) return parsed;
    patch[key] = parsed.ids;
  }

  if (has(input, 'maxMessageAgeDays')) {
    const value = input.maxMessageAgeDays;
    const { min, max } = STARBOARD_MAX_AGE_DAYS;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `L'âge maximum doit être un entier entre ${min} et ${max} jours` };
    }
    patch.maxMessageAgeDays = value;
  }

  const rewards = [
    ['rewardXp', STARBOARD_REWARD_XP, "L'XP de récompense"],
    ['rewardCoins', STARBOARD_REWARD_COINS, 'Les pièces de récompense'],
  ] as const;
  for (const [key, { min, max }, label] of rewards) {
    if (!has(input, key)) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `${label} doit être un entier entre ${min} et ${max}` };
    }
    patch[key] = value;
  }

  if (has(input, 'tiers')) {
    const parsed = validateReputationTiers(input.tiers);
    if ('error' in parsed) return { error: TIER_ERRORS[parsed.error] };
    patch.tiers = parsed.tiers;
  }

  if (has(input, 'channelThresholds')) {
    const parsed = normalizeStarboardChannelThresholds(input.channelThresholds);
    if ('error' in parsed) return { error: CHANNEL_THRESHOLD_ERRORS[parsed.error] };
    patch.channelThresholds = parsed.thresholds;
  }

  if (has(input, 'blockedUserIds')) {
    const value = input.blockedUserIds;
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !SNOWFLAKE_RE.test(id))) {
      return { error: 'Les membres exclus doivent être une liste d\'identifiants' };
    }
    const unique = [...new Set(value as string[])];
    if (unique.length > STARBOARD_BLOCKED_USERS_MAX) {
      return { error: `Pas plus de ${STARBOARD_BLOCKED_USERS_MAX} membres exclus` };
    }
    patch.blockedUserIds = unique;
  }

  if (Object.keys(patch).length === 0) return { error: 'Aucun champ à mettre à jour' };
  return { patch };
}

async function canModerate(client: Client, guildId: string, access: DashboardAccess, userId: string): Promise<boolean> {
  if (access.canManageSettings) return true;
  const rights = (await getCachedFeatureAccess(client, guildId, access, userId)).starboard;
  return rights?.canModerate === true || (access.canModerateContent && rights?.canModerate !== false);
}

/**
 * Forme renvoyée au dashboard : pseudo et photo actuels de l'auteur, liens
 * vers le message d'origine et vers sa republication quand elle est affichée.
 */
async function presentEntries(client: Client, guildId: string, rows: StarboardEntry[]) {
  const identities = await getMemberIdentities(client, guildId, [...new Set(rows.map((row) => row.authorId))]);
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    authorName: identities.get(row.authorId)?.displayName || null,
    avatarUrl: identities.get(row.authorId)?.avatarUrl || null,
    excerpt: row.excerpt,
    imageUrl: row.imageUrl,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    score: row.score,
    peakScore: row.peakScore,
    onBoard: row.starMessageId !== null,
    blocked: row.blockedAt !== null,
    createdAt: row.createdAt,
    postedAt: row.postedAt,
    messageUrl: `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`,
    starUrl: row.starMessageId && row.starChannelId
      ? `https://discord.com/channels/${guildId}/${row.starChannelId}/${row.starMessageId}`
      : null,
  }));
}

export function createStarboardRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/starboard`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [config, overview] = await Promise.all([getStarboardSettings(guildId), getStarboardOverview(guildId)]);
      const guild = client.guilds.cache.get(guildId);
      const locale = await resolveGuildLocale(guildId, guild?.preferredLocale);
      const [blocked, authors] = await Promise.all([
        getMemberIdentities(client, guildId, config.blockedUserIds),
        getMemberIdentities(client, guildId, overview.topAuthors.map((row) => row.authorId)),
      ]);
      return send(c, {
        config,
        stats: overview.stats,
        topEntries: await presentEntries(client, guildId, overview.topEntries),
        channelStats: overview.channelStats,
        topAuthors: overview.topAuthors.map((row) => ({
          authorId: row.authorId,
          name: authors.get(row.authorId)?.displayName || null,
          avatarUrl: authors.get(row.authorId)?.avatarUrl || null,
          count: row.count,
          bestScore: row.bestScore,
        })),
        health: starboardChannelHealth(client, guildId, config.channelId, config.autoReactEmbed),
        // Textes du message publié, pour l'aperçu des réglages.
        messageLabels: starboardMessageLabels(locale),
        // Rôles de palier que le bot ne peut pas donner (supprimé, géré par une
        // intégration, au-dessus du sien) ; `[]` quand le serveur n'est pas
        // dans le cache de ce shard, faute de pouvoir le dire.
        unmanageableTierRoleIds: guild
          ? config.tiers.filter((tier) => !manageableRole(guild, tier.roleId)).map((tier) => tier.roleId)
          : [],
        blockedMembers: config.blockedUserIds.map((userId) => ({
          userId,
          name: blocked.get(userId)?.displayName || null,
          avatarUrl: blocked.get(userId)?.avatarUrl || null,
        })),
      });
    } catch (err) {
      logger.error('StarboardAPI', 'GET starboard error:', err);
      return fail(c, err, 'Erreur lors de la récupération de Starlight', 'StarboardAPI');
    }
  });

  router.get(`${base}/starboard/entries`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const period = (c.req.query('period') ?? null) || 'all';
    const sort = (c.req.query('sort') ?? null) || 'recent';
    const channelId = (c.req.query('channelId') ?? null) || undefined;
    const authorId = (c.req.query('authorId') ?? null) || undefined;
    const cursor = (c.req.query('cursor') ?? null) || undefined;
    if (!isStarboardPeriod(period)) {
      return send(c, { error: 'Période invalide' }, 400);
    }
    if (!isStarboardSort(sort)) {
      return send(c, { error: 'Tri invalide' }, 400);
    }
    if (channelId && !SNOWFLAKE_RE.test(channelId)) {
      return send(c, { error: 'Identifiant de salon invalide' }, 400);
    }
    if (authorId && !SNOWFLAKE_RE.test(authorId)) {
      return send(c, { error: 'Identifiant de membre invalide' }, 400);
    }
    // Le curseur suit le tri : un score pour `score`, une date pour `recent`.
    if (cursor && !(sort === 'score' ? decodeScoreCursor(cursor) : decodeTimeCursor(cursor))) {
      return send(c, { error: 'Curseur invalide' }, 400);
    }

    try {
      const page = await listStarboardEntries(guildId, { period, sort, channelId, authorId, cursor });
      return send(c, { entries: await presentEntries(client, guildId, page.entries), nextCursor: page.nextCursor });
    } catch (err) {
      logger.error('StarboardAPI', 'GET starboard entries error:', err);
      return fail(c, err, 'Erreur lors de la récupération des messages à la une', 'StarboardAPI');
    }
  });

  router.patch(`${base}/starboard`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    if (!access.canManageSettings) {
      return send(c, { error: 'Permissions insuffisantes' }, 403);
    }

    try {
      const parsed = parseStarboardConfigPatch(await readBody<unknown>(c));
      if ('error' in parsed) {
        return send(c, { error: parsed.error }, 400);
      }

      const before = parsed.patch.blockedUserIds ? await getStarboardSettings(guildId) : null;
      const config = await saveStarboardSettings(guildId, parsed.patch);
      // Un membre tout juste exclu quitte la une, sans faire attendre la réponse.
      const newlyBlocked = before ? config.blockedUserIds.filter((id) => !before.blockedUserIds.includes(id)) : [];
      if (newlyBlocked.length > 0) {
        void removeHighlightsOfAuthors(client, guildId, newlyBlocked).catch((err: unknown) => {
          logger.error('StarboardAPI', `Retrait des messages des membres exclus de ${guildId} impossible:`, err);
        });
      }
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde configuration Starlight',
        context: getGuildName(client, guildId),
        module: 'Starlight',
        eventType: 'Manuel',
        details: newlyBlocked.length > 0
          ? `Configuration Starlight mise à jour (seuil: ${config.threshold}). Membres exclus : ${newlyBlocked.join(', ')}.`
          : `Configuration Starlight mise à jour (seuil: ${config.threshold}).`,
        channelId: config.channelId,
      });
      return send(c, { config });
    } catch (err) {
      logger.error('StarboardAPI', 'PATCH starboard error:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'StarboardAPI');
    }
  });

  router.post(`${base}/starboard/entries/:entryId/:action`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = auditUserOf(c);
    const action = c.req.param('action');
    if (action !== 'block' && action !== 'unblock') return send(c, { error: 'Route introuvable' }, 404);
    const entryId = c.req.param('entryId');
    const block = action === 'block';
    if (!CUID_RE.test(entryId)) {
      return send(c, { error: 'Identifiant de message invalide' }, 400);
    }
    if (!(await canModerate(client, guildId, access, user.userId))) {
      return send(c, { error: 'Accès modérateur requis' }, 403);
    }

    try {
      const entry = block
        ? await blockStarboardEntry(client, guildId, entryId, user.userId)
        : await unblockStarboardEntry(client, guildId, entryId);
      if (!entry) {
        return send(c, { error: 'Message introuvable' }, 404);
      }
      await pushAudit(guildId, {
        user: auditUser,
        action: block ? 'Retrait d\'un message à la une' : 'Retour d\'un message à la une',
        context: getGuildName(client, guildId),
        module: 'Starlight',
        eventType: 'Manuel',
        details: block
          ? `Message ${entry.messageId} retiré de la une, sans retour possible.`
          : `Message ${entry.messageId} de nouveau admis à la une.`,
        channelId: entry.channelId,
      });
      const [presented] = await presentEntries(client, guildId, [entry]);
      return send(c, { entry: presented });
    } catch (err) {
      logger.error('StarboardAPI', `POST starboard entry ${block ? 'block' : 'unblock'} error:`, err);
      return fail(c, err, 'Erreur lors de la mise à jour du message', 'StarboardAPI');
    }
  });

  return router;
}

