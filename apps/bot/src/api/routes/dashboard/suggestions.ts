/**
 * Routes dashboard du module Suggestions.
 *
 * - GET   /suggestions                réglages, statistiques et file d'attente
 * - GET   /suggestions/list           historique paginé (status, userId, category, cursor)
 * - GET   /suggestions/:id/voters     votants, quand le serveur les montre au staff
 * - PATCH /suggestions/config         réglages
 * - POST  /suggestions/:id/resolve    décision du staff, révisable
 * - DELETE /suggestions/:id           suppression (doublon, abus), message et fil compris
 * - POST  /suggestions/refresh        messages déjà publiés repassés au format actuel
 *
 * L'activation du module passe par la page Modules. Trancher une suggestion
 * demande le droit « Modérer » de la fonctionnalité, ou la modération de
 * contenu quand le centre de gestion ne l'a pas retiré au rôle, comme pour les
 * appels de bannissement.
 */
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import type { Suggestion } from '@prisma/client';
import {
  SUGGESTION_ALLOWED_ROLES_MAX,
  SUGGESTION_COOLDOWN_MINUTES,
  SUGGESTION_MIN_ACCOUNT_AGE_DAYS,
  SUGGESTION_MIN_MEMBER_DAYS,
  SUGGESTION_CATEGORIES_MAX,
  SUGGESTION_CATEGORY_NAME_MAX,
  SUGGESTION_RESPONSE_MAX,
  SUGGESTION_REWARD_COINS,
  SUGGESTION_REWARD_XP,
  SUGGESTION_VOTE_THRESHOLD,
  normalizeSuggestionCategories,
  type SuggestionCategoryError,
  decodeTimeCursor,
  isSuggestionStatus,
  suggestionNeedsComment,
} from '@kotbo/shared';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import { logger } from '../../../utils/logger.js';
import { getGuildName, pushAudit, type DashboardAccess } from '../../shared.js';
import { getCachedFeatureAccess } from './featureGate.js';
import { getSuggestionVoters, getSuggestionsOverview, listSuggestions } from '../../../services/features/suggestionDashboard.js';
import { getSuggestionSettings, saveSuggestionSettings, type SuggestionSettings } from '../../../services/features/suggestionSettings.js';
import {
  countPublishedSuggestionMessages,
  deleteSuggestion,
  refreshPublishedSuggestionMessages,
  resolveSuggestion,
} from '../../../services/features/suggestionService.js';
import { suggestionMessageLabels } from '../../../services/features/suggestionMessageLabels.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const CUID_RE = /^[a-z0-9]{20,40}$/i;

const has = (body: object, key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

const CATEGORY_ERRORS: Record<SuggestionCategoryError, string> = {
  NOT_ARRAY: 'Les catégories doivent être une liste de noms',
  TOO_MANY: `Pas plus de ${SUGGESTION_CATEGORIES_MAX} catégories`,
  TOO_LONG: `Un nom de catégorie ne dépasse pas ${SUGGESTION_CATEGORY_NAME_MAX} caractères`,
};

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Forme renvoyée au dashboard : compteurs plutôt que listes de votants, pseudo
 * et photo actuels de l'auteur, nom de qui a tranché.
 */
async function presentSuggestions(client: Client, guildId: string, rows: Suggestion[]) {
  const userIds = rows.flatMap((row) => [
    row.userId,
    ...(row.respondedById && SNOWFLAKE_RE.test(row.respondedById) ? [row.respondedById] : []),
  ]);
  const identities = await getMemberIdentities(client, guildId, [...new Set(userIds)]);
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    username: identities.get(row.userId)?.displayName || row.username,
    avatarUrl: identities.get(row.userId)?.avatarUrl || null,
    title: row.title,
    category: row.category,
    content: row.content,
    status: row.status,
    responseText: row.responseText,
    respondedById: row.respondedById,
    respondedByName: row.respondedById ? identities.get(row.respondedById)?.displayName ?? null : null,
    respondedAt: row.respondedAt,
    upvotes: row.upvoters.length,
    downvotes: row.downvoters.length,
    createdAt: row.createdAt,
    messageUrl: row.channelId && row.messageId
      ? `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}`
      : null,
    threadUrl: row.threadId ? `https://discord.com/channels/${guildId}/${row.threadId}` : null,
    thresholdReachedAt: row.thresholdReachedAt,
    /** Récompense réellement versée à l'auteur. */
    rewarded: { xp: row.xpGranted, coins: row.coinsGranted },
  }));
}

/**
 * Valide un corps de PATCH. Rend les champs à écrire, ou le motif du refus.
 * `guildRoleIds` vaut `null` quand le serveur n'est pas dans le cache de ce
 * shard : l'existence des rôles n'est alors pas vérifiable ici.
 */
export function parseSuggestionConfigPatch(
  body: unknown,
  guildId: string,
  guildRoleIds: Set<string> | null,
): { patch: Partial<SuggestionSettings> } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Payload invalide' };
  const patch: Partial<SuggestionSettings> = {};

  if (has(body, 'channelId')) {
    const value = (body as { channelId: unknown }).channelId;
    if (value !== null && (typeof value !== 'string' || !SNOWFLAKE_RE.test(value.trim()))) {
      return { error: 'Le salon des suggestions est invalide' };
    }
    patch.channelId = value === null ? null : value.trim();
  }

  for (const key of ['requireComment', 'voteWhileApproved', 'notifyAuthor', 'createThread', 'pinAtThreshold', 'showVoters'] as const) {
    if (!has(body, key)) continue;
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== 'boolean') return { error: `Le champ ${key} doit être un booléen` };
    patch[key] = value;
  }

  const integers = [
    ['cooldownMinutes', SUGGESTION_COOLDOWN_MINUTES, 'Le délai entre deux suggestions'],
    ['minAccountAgeDays', SUGGESTION_MIN_ACCOUNT_AGE_DAYS, 'L\'âge minimum du compte'],
    ['minMemberDays', SUGGESTION_MIN_MEMBER_DAYS, 'L\'ancienneté minimum sur le serveur'],
    ['rewardXp', SUGGESTION_REWARD_XP, 'L\'XP de récompense'],
    ['rewardCoins', SUGGESTION_REWARD_COINS, 'Les pièces de récompense'],
  ] as const;
  for (const [key, { min, max }, label] of integers) {
    if (!has(body, key)) continue;
    const value = (body as Record<string, unknown>)[key];
    if (!isIntegerIn(value, min, max)) return { error: `${label} doit être un entier entre ${min} et ${max}` };
    patch[key] = value;
  }

  if (has(body, 'voteThreshold')) {
    const value = (body as { voteThreshold: unknown }).voteThreshold;
    const { min, max } = SUGGESTION_VOTE_THRESHOLD;
    if (value !== null && !isIntegerIn(value, min, max)) {
      return { error: `Le seuil de votes doit être un entier entre ${min} et ${max}` };
    }
    patch.voteThreshold = value as number | null;
  }

  if (has(body, 'categories')) {
    const parsed = normalizeSuggestionCategories((body as { categories: unknown }).categories);
    if ('error' in parsed) return { error: CATEGORY_ERRORS[parsed.error] };
    patch.categories = parsed.categories;
  }

  if (has(body, 'allowedRoleIds')) {
    const value = (body as { allowedRoleIds: unknown }).allowedRoleIds;
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !SNOWFLAKE_RE.test(id))) {
      return { error: 'Les rôles autorisés doivent être une liste d\'identifiants' };
    }
    const unique = [...new Set(value as string[])];
    if (unique.length > SUGGESTION_ALLOWED_ROLES_MAX) {
      return { error: `Pas plus de ${SUGGESTION_ALLOWED_ROLES_MAX} rôles autorisés` };
    }
    // @everyone porte l'id du serveur : le mettre revient à ne rien restreindre.
    if (unique.some((roleId) => roleId === guildId || (guildRoleIds && !guildRoleIds.has(roleId)))) {
      return { error: 'Un rôle autorisé est absent du serveur' };
    }
    patch.allowedRoleIds = unique;
  }

  if (Object.keys(patch).length === 0) return { error: 'Aucun champ à mettre à jour' };
  return { patch };
}

async function canDecide(client: Client, guildId: string, access: DashboardAccess, userId: string): Promise<boolean> {
  if (access.canManageSettings) return true;
  const rights = (await getCachedFeatureAccess(client, guildId, access, userId)).suggestions;
  return rights?.canModerate === true || (access.canModerateContent && rights?.canModerate !== false);
}

export function createSuggestionsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  const gate = guildRoute(client);


  router.get(`${base}/suggestions`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const overview = await getSuggestionsOverview(guildId);
      const guild = client.guilds.cache.get(guildId);
      const locale = await resolveGuildLocale(guildId, guild?.preferredLocale);
      return send(c, {
        config: overview.config,
        stats: overview.stats,
        queue: await presentSuggestions(client, guildId, overview.queue),
        queueTruncated: overview.queueTruncated,
        categoryStats: overview.categoryStats,
        // Gabarits du message public, pour l'aperçu des réglages.
        messageLabels: suggestionMessageLabels(locale),
      });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error fetching suggestions overview:', err);
      return fail(c, err, 'Erreur de récupération des suggestions', 'SuggestionsAPI');
    }
  });

  router.get(`${base}/suggestions/list`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const status = (c.req.query('status') ?? null) || undefined;
    const userId = (c.req.query('userId') ?? null) || undefined;
    const cursor = (c.req.query('cursor') ?? null) || undefined;
    // `none` : les suggestions sans catégorie.
    const rawCategory = (c.req.query('category') ?? null);
    const category = rawCategory === null || rawCategory === '' ? undefined : rawCategory === 'none' ? null : rawCategory;
    if (typeof category === 'string' && category.length > SUGGESTION_CATEGORY_NAME_MAX) {
      return send(c, { error: 'Catégorie invalide' }, 400);
    }
    if (status && !isSuggestionStatus(status)) {
      return send(c, { error: 'Statut invalide' }, 400);
    }
    if (userId && !SNOWFLAKE_RE.test(userId)) {
      return send(c, { error: 'Identifiant de membre invalide' }, 400);
    }
    if (cursor && !decodeTimeCursor(cursor)) {
      return send(c, { error: 'Curseur invalide' }, 400);
    }

    try {
      const page = await listSuggestions(guildId, { status: status && isSuggestionStatus(status) ? status : undefined, userId, cursor, category });
      return send(c, {
        suggestions: await presentSuggestions(client, guildId, page.suggestions),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error listing suggestions:', err);
      return fail(c, err, 'Erreur de récupération des suggestions', 'SuggestionsAPI');
    }
  });

  router.get(`${base}/suggestions/:suggestionId/voters`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const suggestionId = c.req.param('suggestionId');
    if (!CUID_RE.test(suggestionId)) {
      return send(c, { error: 'Identifiant de suggestion invalide' }, 400);
    }

    try {
      // Réglage du serveur d'abord : sans lui, les votes restent anonymes pour tous.
      if (!(await getSuggestionSettings(guildId)).showVoters) {
        return send(c, { error: 'Les votants ne sont pas visibles sur ce serveur' }, 403);
      }
      if (!(await canDecide(client, guildId, access, user.userId))) {
        return send(c, { error: 'Accès modérateur requis pour voir les votants' }, 403);
      }
      const voters = await getSuggestionVoters(guildId, suggestionId);
      if (!voters) {
        return send(c, { error: 'Suggestion introuvable' }, 404);
      }
      const identities = await getMemberIdentities(client, guildId, [...new Set([...voters.upvoters, ...voters.downvoters])]);
      const present = (userIds: string[]) => userIds.map((userId) => ({
        userId,
        name: identities.get(userId)?.displayName ?? null,
        avatarUrl: identities.get(userId)?.avatarUrl || null,
      }));
      return send(c, { up: present(voters.upvoters), down: present(voters.downvoters) });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error listing suggestion voters:', err);
      return fail(c, err, 'Erreur de récupération des votants', 'SuggestionsAPI');
    }
  });

  router.patch(`${base}/suggestions/config`, ...gate, async (c) => {
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
      const parsed = parseSuggestionConfigPatch(await readBody<unknown>(c), guildId, guildRoleIds);
      if ('error' in parsed) {
        return send(c, { error: parsed.error }, 400);
      }

      const before = parsed.patch.voteWhileApproved === undefined ? null : await getSuggestionSettings(guildId);
      const config = await saveSuggestionSettings(guildId, parsed.patch);
      // Les messages déjà publiés suivent le réglage, sans faire attendre la réponse.
      if (before && before.voteWhileApproved !== config.voteWhileApproved) {
        void refreshPublishedSuggestionMessages(client, guildId, { status: 'APPROVED' }).catch((err: unknown) => {
          logger.error('SuggestionsAPI', `Rafraîchissement des suggestions approuvées de ${guildId} impossible:`, err);
        });
      }
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration suggestions',
        context: getGuildName(client, guildId),
        module: 'Suggestions',
        eventType: 'Manuel',
        details: `Salon : ${config.channelId ? `<#${config.channelId}>` : 'aucun'}, commentaire ${config.requireComment ? 'obligatoire' : 'facultatif'}, votes ${config.voteWhileApproved ? 'ouverts' : 'fermés'} après approbation, ${config.allowedRoleIds.length > 0 ? `${config.allowedRoleIds.length} rôle(s) autorisé(s) à proposer` : 'tout le monde peut proposer'}, auteur ${config.notifyAuthor ? 'prévenu' : 'non prévenu'}, fil ${config.createThread ? 'ouvert' : 'non'}, seuil ${config.voteThreshold ?? 'aucun'}${config.voteThreshold && config.pinAtThreshold ? ' (épinglé)' : ''}, garde-fous : délai ${config.cooldownMinutes} min, compte ${config.minAccountAgeDays} j, ancienneté ${config.minMemberDays} j, récompense ${config.rewardXp} XP / ${config.rewardCoins} pièce(s), ${config.categories.length} catégorie(s), votants ${config.showVoters ? 'visibles' : 'anonymes'}.`,
        channelId: config.channelId,
      });
      return send(c, { config });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error updating suggestions config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'SuggestionsAPI');
    }
  });

  router.post(`${base}/suggestions/:suggestionId/resolve`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = `${user.username} (${user.userId})`;
    const suggestionId = c.req.param('suggestionId');
    if (!CUID_RE.test(suggestionId)) {
      return send(c, { error: 'Identifiant de suggestion invalide' }, 400);
    }

    try {
      if (!(await canDecide(client, guildId, access, user.userId))) {
        return send(c, { error: 'Accès modérateur requis pour trancher une suggestion' }, 403);
      }

      const body = await readBody<{ status?: unknown; responseText?: unknown }>(c);
      if (!body || !isSuggestionStatus(body.status)) {
        return send(c, { error: 'Statut invalide' }, 400);
      }
      if (body.responseText !== undefined && body.responseText !== null && typeof body.responseText !== 'string') {
        return send(c, { error: 'Commentaire invalide' }, 400);
      }
      const responseText = typeof body.responseText === 'string' ? body.responseText.trim() : '';
      if (responseText.length > SUGGESTION_RESPONSE_MAX) {
        return send(c, { error: `Le commentaire ne doit pas dépasser ${SUGGESTION_RESPONSE_MAX} caractères` }, 400);
      }
      const { requireComment } = await getSuggestionSettings(guildId);
      if (suggestionNeedsComment(body.status, requireComment) && !responseText) {
        return send(c, { error: 'Un commentaire public est requis pour cette décision' }, 400);
      }

      const result = await resolveSuggestion(guildId, suggestionId, body.status, responseText || null, user.userId, client);
      if (!result) {
        return send(c, { error: 'Suggestion introuvable' }, 404);
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: body.status === 'PENDING' ? 'Réouverture suggestion' : 'Décision suggestion',
        context: getGuildName(client, guildId),
        module: 'Suggestions',
        eventType: 'Manuel',
        details: `Suggestion ${suggestionId} : ${result.previousStatus} -> ${result.suggestion.status}.`,
        channelId: null,
      });

      const [suggestion] = await presentSuggestions(client, guildId, [result.suggestion]);
      return send(c, { suggestion });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error resolving suggestion:', err);
      return fail(c, err, 'Erreur lors de la décision', 'SuggestionsAPI');
    }
  });

  router.delete(`${base}/suggestions/:suggestionId`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = `${user.username} (${user.userId})`;
    if (!access.canManageSettings) {
      return send(c, { error: 'Permissions insuffisantes' }, 403);
    }
    const suggestionId = c.req.param('suggestionId');
    if (!CUID_RE.test(suggestionId)) {
      return send(c, { error: 'Identifiant de suggestion invalide' }, 400);
    }

    try {
      const deleted = await deleteSuggestion(client, guildId, suggestionId);
      if (!deleted) {
        return send(c, { error: 'Suggestion introuvable' }, 404);
      }
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression suggestion',
        context: getGuildName(client, guildId),
        module: 'Suggestions',
        eventType: 'Manuel',
        details: `Suggestion ${deleted.id} de ${deleted.username} (${deleted.userId}) supprimée : « ${deleted.content.slice(0, 200)} ».`,
        channelId: deleted.channelId,
      });
      return send(c, { deleted: true });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error deleting suggestion:', err);
      return fail(c, err, 'Erreur lors de la suppression', 'SuggestionsAPI');
    }
  });

  router.post(`${base}/suggestions/refresh`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const access = c.var.effectiveAccess;
    const auditUser = `${user.username} (${user.userId})`;
    if (!access.canManageSettings) {
      return send(c, { error: 'Permissions insuffisantes' }, 403);
    }

    try {
      // Une édition à la fois pour ménager Discord : trop long pour faire
      // attendre la réponse, la page reçoit le nombre de messages repris.
      const total = await countPublishedSuggestionMessages(guildId);
      void refreshPublishedSuggestionMessages(client, guildId).catch((err: unknown) => {
        logger.error('SuggestionsAPI', `Mise à jour des messages de suggestions de ${guildId} impossible:`, err);
      });
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour des messages de suggestions',
        context: getGuildName(client, guildId),
        module: 'Suggestions',
        eventType: 'Manuel',
        details: `${total} message(s) repris au format actuel.`,
        channelId: null,
      });
      return send(c, { total }, 202);
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error refreshing suggestion messages:', err);
      return fail(c, err, 'Erreur lors de la mise à jour des messages', 'SuggestionsAPI');
    }
  });

  return router;
}

