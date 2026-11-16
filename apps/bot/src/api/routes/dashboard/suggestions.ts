/**
 * Routes dashboard du module Suggestions.
 *
 * - GET   /suggestions                réglages, statistiques et file d'attente
 * - GET   /suggestions/list           historique paginé (status, userId, cursor)
 * - PATCH /suggestions/config         réglages
 * - POST  /suggestions/:id/resolve    décision du staff, révisable
 *
 * L'activation du module passe par la page Modules. Trancher une suggestion
 * demande le droit « Modérer » de la fonctionnalité, ou la modération de
 * contenu quand le centre de gestion ne l'a pas retiré au rôle, comme pour les
 * appels de bannissement.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import type { Suggestion } from '@prisma/client';
import {
  SUGGESTION_ALLOWED_ROLES_MAX,
  SUGGESTION_RESPONSE_MAX,
  decodeTimeCursor,
  isSuggestionStatus,
  suggestionNeedsComment,
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
import { getCachedFeatureAccess } from './featureGate.js';
import { getSuggestionsOverview, listSuggestions } from '../../../services/features/suggestionDashboard.js';
import { getSuggestionSettings, saveSuggestionSettings, type SuggestionSettings } from '../../../services/features/suggestionSettings.js';
import { resolveSuggestion } from '../../../services/features/suggestionService.js';
import { suggestionMessageLabels } from '../../../services/features/suggestionMessageLabels.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';
import { jsonFailure } from '../../shared/failure.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const CUID_RE = /^[a-z0-9]{20,40}$/i;

const has = (body: object, key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

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

  for (const key of ['requireComment', 'voteWhileApproved'] as const) {
    if (!has(body, key)) continue;
    const value = (body as Record<string, unknown>)[key];
    if (typeof value !== 'boolean') return { error: `Le champ ${key} doit être un booléen` };
    patch[key] = value;
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

export async function handleSuggestionRoutes(
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
  if (parts[4] !== 'suggestions') return false;
  const auditUser = `${user.username} (${user.userId})`;

  // GET /suggestions
  if (parts.length === 5 && method === 'GET') {
    try {
      const overview = await getSuggestionsOverview(guildId);
      const guild = client.guilds.cache.get(guildId);
      const locale = await resolveGuildLocale(guildId, guild?.preferredLocale);
      json(res, 200, {
        config: overview.config,
        stats: overview.stats,
        queue: await presentSuggestions(client, guildId, overview.queue),
        queueTruncated: overview.queueTruncated,
        // Gabarits du message public, pour l'aperçu des réglages.
        messageLabels: suggestionMessageLabels(locale),
      });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error fetching suggestions overview:', err);
      jsonFailure(res, err, 'Erreur de récupération des suggestions', 'SuggestionsAPI');
    }
    return true;
  }

  // GET /suggestions/list
  if (parts.length === 6 && parts[5] === 'list' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    const userId = url.searchParams.get('userId') || undefined;
    const cursor = url.searchParams.get('cursor') || undefined;
    if (status && !isSuggestionStatus(status)) {
      json(res, 400, { error: 'Statut invalide' });
      return true;
    }
    if (userId && !SNOWFLAKE_RE.test(userId)) {
      json(res, 400, { error: 'Identifiant de membre invalide' });
      return true;
    }
    if (cursor && !decodeTimeCursor(cursor)) {
      json(res, 400, { error: 'Curseur invalide' });
      return true;
    }

    try {
      const page = await listSuggestions(guildId, { status: status && isSuggestionStatus(status) ? status : undefined, userId, cursor });
      json(res, 200, {
        suggestions: await presentSuggestions(client, guildId, page.suggestions),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error listing suggestions:', err);
      jsonFailure(res, err, 'Erreur de récupération des suggestions', 'SuggestionsAPI');
    }
    return true;
  }

  // PATCH /suggestions/config
  if (parts.length === 6 && parts[5] === 'config' && method === 'PATCH') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Permissions insuffisantes' });
      return true;
    }

    try {
      const guild = client.guilds.cache.get(guildId);
      const guildRoleIds = guild ? new Set(guild.roles.cache.keys()) : null;
      const parsed = parseSuggestionConfigPatch(await readJsonBody<unknown>(req), guildId, guildRoleIds);
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }

      const config = await saveSuggestionSettings(guildId, parsed.patch);
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration suggestions',
        context: getGuildName(client, guildId),
        module: 'Suggestions',
        eventType: 'Manuel',
        details: `Salon : ${config.channelId ? `<#${config.channelId}>` : 'aucun'}, commentaire ${config.requireComment ? 'obligatoire' : 'facultatif'}, votes ${config.voteWhileApproved ? 'ouverts' : 'fermés'} après approbation, ${config.allowedRoleIds.length > 0 ? `${config.allowedRoleIds.length} rôle(s) autorisé(s) à proposer` : 'tout le monde peut proposer'}.`,
        channelId: config.channelId,
      });
      json(res, 200, { config });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error updating suggestions config:', err);
      jsonFailure(res, err, 'Erreur lors de la mise à jour de la configuration', 'SuggestionsAPI');
    }
    return true;
  }

  // POST /suggestions/:id/resolve
  if (parts.length === 7 && parts[6] === 'resolve' && method === 'POST') {
    const suggestionId = parts[5];
    if (!CUID_RE.test(suggestionId)) {
      json(res, 400, { error: 'Identifiant de suggestion invalide' });
      return true;
    }

    try {
      if (!(await canDecide(client, guildId, access, user.userId))) {
        json(res, 403, { error: 'Accès modérateur requis pour trancher une suggestion' });
        return true;
      }

      const body = await readJsonBody<{ status?: unknown; responseText?: unknown }>(req);
      if (!body || !isSuggestionStatus(body.status)) {
        json(res, 400, { error: 'Statut invalide' });
        return true;
      }
      if (body.responseText !== undefined && body.responseText !== null && typeof body.responseText !== 'string') {
        json(res, 400, { error: 'Commentaire invalide' });
        return true;
      }
      const responseText = typeof body.responseText === 'string' ? body.responseText.trim() : '';
      if (responseText.length > SUGGESTION_RESPONSE_MAX) {
        json(res, 400, { error: `Le commentaire ne doit pas dépasser ${SUGGESTION_RESPONSE_MAX} caractères` });
        return true;
      }
      const { requireComment } = await getSuggestionSettings(guildId);
      if (suggestionNeedsComment(body.status, requireComment) && !responseText) {
        json(res, 400, { error: 'Un commentaire public est requis pour cette décision' });
        return true;
      }

      const result = await resolveSuggestion(guildId, suggestionId, body.status, responseText || null, user.userId, client);
      if (!result) {
        json(res, 404, { error: 'Suggestion introuvable' });
        return true;
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
      json(res, 200, { suggestion });
    } catch (err) {
      logger.error('SuggestionsAPI', 'Error resolving suggestion:', err);
      jsonFailure(res, err, 'Erreur lors de la décision', 'SuggestionsAPI');
    }
    return true;
  }

  return false;
}
