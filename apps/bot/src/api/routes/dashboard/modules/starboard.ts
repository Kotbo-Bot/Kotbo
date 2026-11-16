/**
 * Routes dashboard du module `starboard` (Starlight, messages à la une).
 *
 * - GET   /starboard          réglages, statistiques, meilleurs messages, état du salon
 * - GET   /starboard/entries  galerie paginée (period, sort, channelId, authorId, cursor)
 * - PATCH /starboard          réglages
 *
 * `enabled` n'est pas modifiable ici. Le segment est fermé par la garde des
 * modules tant que Starlight est éteint : une route qu'on ne peut atteindre
 * qu'allumé ne peut pas servir à l'allumer. L'activation passe donc par
 * `/modules`, qui écrit les deux états (la pastille et `StarboardConfig`) et
 * propage les dépendances.
 */
import type { Client } from 'discord.js';
import type { StarboardEntry } from '@prisma/client';
import {
  STARBOARD_CHANNELS_MAX,
  STARBOARD_EMOJIS_MAX,
  STARBOARD_THRESHOLD,
  decodeScoreCursor,
  decodeTimeCursor,
  isStarboardPeriod,
  isStarboardSort,
  type StarboardSettings,
} from '@kotbo/shared';
import { logger } from '../../../../utils/logger.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { normalizeEmojiKey } from '../../../../services/features/starboardTally.js';
import { getStarboardOverview, listStarboardEntries } from '../../../../services/features/starboardDashboard.js';
import { getStarboardSettings, saveStarboardSettings } from '../../../../services/features/starboardSettings.js';
import { starboardChannelHealth } from '../../../../services/features/starboardHealth.js';
import { starboardMessageLabels } from '../../../../services/features/starboardMessageLabels.js';
import { getMemberIdentities } from '../../../../services/moderation/memberIdentityService.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { jsonFailure } from '../../../shared/failure.js';
import { type ModuleRouteContext } from './_shared.js';

/** Identifiant Discord : salon, rôle, membre ou emoji custom. */
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const BOOLEAN_KEYS = ['countEmbedReactions', 'autoReactEmbed', 'allowBots', 'ignoreAuthorVotes', 'removeBelowThreshold'] as const;
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

  if (Object.keys(patch).length === 0) return { error: 'Aucun champ à mettre à jour' };
  return { patch };
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
    createdAt: row.createdAt,
    postedAt: row.postedAt,
    messageUrl: `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`,
    starUrl: row.starMessageId && row.starChannelId
      ? `https://discord.com/channels/${guildId}/${row.starChannelId}/${row.starMessageId}`
      : null,
  }));
}

export async function handleStarboardRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, url, client, guildId, method, auditUser, access } = ctx;

  // GET /starboard
  if (parts.length === 5 && method === 'GET') {
    try {
      const [config, overview] = await Promise.all([getStarboardSettings(guildId), getStarboardOverview(guildId)]);
      const guild = client.guilds.cache.get(guildId);
      const locale = await resolveGuildLocale(guildId, guild?.preferredLocale);
      json(res, 200, {
        config,
        stats: overview.stats,
        topEntries: await presentEntries(client, guildId, overview.topEntries),
        channelStats: overview.channelStats,
        health: starboardChannelHealth(client, guildId, config.channelId, config.autoReactEmbed),
        // Textes du message publié, pour l'aperçu des réglages.
        messageLabels: starboardMessageLabels(locale),
      });
    } catch (err) {
      logger.error('StarboardAPI', 'GET starboard error:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération de Starlight', 'StarboardAPI');
    }
    return true;
  }

  // GET /starboard/entries
  if (parts.length === 6 && parts[5] === 'entries' && method === 'GET') {
    const period = url.searchParams.get('period') || 'all';
    const sort = url.searchParams.get('sort') || 'recent';
    const channelId = url.searchParams.get('channelId') || undefined;
    const authorId = url.searchParams.get('authorId') || undefined;
    const cursor = url.searchParams.get('cursor') || undefined;

    if (!isStarboardPeriod(period)) {
      json(res, 400, { error: 'Période invalide' });
      return true;
    }
    if (!isStarboardSort(sort)) {
      json(res, 400, { error: 'Tri invalide' });
      return true;
    }
    if (channelId && !SNOWFLAKE_RE.test(channelId)) {
      json(res, 400, { error: 'Identifiant de salon invalide' });
      return true;
    }
    if (authorId && !SNOWFLAKE_RE.test(authorId)) {
      json(res, 400, { error: 'Identifiant de membre invalide' });
      return true;
    }
    // Le curseur suit le tri : un score pour `score`, une date pour `recent`.
    if (cursor && !(sort === 'score' ? decodeScoreCursor(cursor) : decodeTimeCursor(cursor))) {
      json(res, 400, { error: 'Curseur invalide' });
      return true;
    }

    try {
      const page = await listStarboardEntries(guildId, { period, sort, channelId, authorId, cursor });
      json(res, 200, { entries: await presentEntries(client, guildId, page.entries), nextCursor: page.nextCursor });
    } catch (err) {
      logger.error('StarboardAPI', 'GET starboard entries error:', err);
      jsonFailure(res, err, 'Erreur lors de la récupération des messages à la une', 'StarboardAPI');
    }
    return true;
  }

  // PATCH /starboard
  if (parts.length === 5 && method === 'PATCH') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Permissions insuffisantes' });
      return true;
    }

    try {
      const parsed = parseStarboardConfigPatch(await readJsonBody<unknown>(req));
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }

      const config = await saveStarboardSettings(guildId, parsed.patch);
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde configuration Starlight',
        context: getGuildName(client, guildId),
        module: 'Starlight',
        eventType: 'Manuel',
        details: `Configuration Starlight mise à jour (seuil: ${config.threshold}).`,
        channelId: config.channelId,
      });
      json(res, 200, { config });
    } catch (err) {
      logger.error('StarboardAPI', 'PATCH starboard error:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour', 'StarboardAPI');
    }
    return true;
  }

  return false;
}
