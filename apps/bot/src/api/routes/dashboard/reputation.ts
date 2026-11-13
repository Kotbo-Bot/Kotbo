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
import { REPUTATION_DAILY_LIMIT, isReputationPeriod, type ReputationPeriod } from '@kotbo/shared';
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
  deleteReputationVote,
  getReputationDashboardData,
  listReputationVotes,
  saveReputationConfig,
  type ReputationSettings,
} from '../../../services/community/reputationService.js';
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

/** Valide un corps de PATCH. Rend les champs à écrire, ou le motif du refus. */
function parseConfigPatch(body: unknown): { patch: Partial<ReputationSettings> } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Payload invalide' };
  const patch: Partial<ReputationSettings> = {};

  if (has(body, 'dailyLimit')) {
    const value = (body as { dailyLimit: unknown }).dailyLimit;
    const { min, max } = REPUTATION_DAILY_LIMIT;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { error: `La limite par jour doit être un entier entre ${min} et ${max}` };
    }
    patch.dailyLimit = value;
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
      json(res, 200, {
        ...data,
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
      const parsed = parseConfigPatch(await readJsonBody<unknown>(req));
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }

      const config = await saveReputationConfig(guildId, parsed.patch);
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour configuration Réputation',
        context: getGuildName(client, guildId),
        module: 'Réputation',
        eventType: 'Manuel',
        details: `Limite par jour : ${config.dailyLimit} vote(s).`,
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
      const vote = await deleteReputationVote(guildId, parts[6]);
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
