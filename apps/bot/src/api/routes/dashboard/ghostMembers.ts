import { Hono, type Context } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getGuildName, safePushAudit } from '../../shared.js';
import {
  GHOST_STATUSES,
  PRUNABLE_STATUSES,
  GhostPruneValidationError,
  executeGhostPrune,
  getGhostConfig,
  getGhostDistribution,
  getGhostPruneRuns,
  listGhostMembers,
  previewGhostPrune,
  recomputeGhostStatuses,
  sanitizeGhostConfigPatch,
  upsertGhostConfig,
  type GhostStatus,
} from '../../../services/analytics/ghostMembersService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

function parseStatus(raw: string | undefined): GhostStatus | undefined {
  if (!raw) return undefined;
  return GHOST_STATUSES.includes(raw as GhostStatus) ? (raw as GhostStatus) : undefined;
}

function parseTargetStatuses(raw: unknown): GhostStatus[] {
  if (!Array.isArray(raw)) return ['INACTIVE'];
  const statuses = raw.filter((s): s is GhostStatus =>
    typeof s === 'string' && PRUNABLE_STATUSES.includes(s as GhostStatus));
  return statuses.length > 0 ? statuses : ['INACTIVE'];
}

const auditUserOf = (c: Context) => `${c.var.dashboardUser.username ?? 'Inconnu'} (${c.var.dashboardUser.userId})`;

export function createGhostMembersRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/ghost-members';
  const gate = guildRoute(client);

  const audit = (c: Context, action: string, details: string) => {
    const guildId = c.req.param('guildId')!;
    return safePushAudit(guildId, {
      user: auditUserOf(c),
      action,
      context: getGuildName(client, guildId),
      module: 'Ghost Members',
      eventType: 'Manuel',
      details,
      channelId: null,
    }, action);
  };

  // Répartition de la communauté + configuration
  router.get(base, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const [distribution, config] = await Promise.all([
        getGhostDistribution(guildId),
        getGhostConfig(guildId),
      ]);
      return send(c, { distribution, config });
    } catch (err) {
      logger.error('GhostMembersAPI', 'Erreur GET répartition:', err);
      return fail(c, err, 'Erreur lors du calcul de la répartition', 'GhostMembersAPI');
    }
  });

  // ?status=&page=&pageSize=&search=&onlyPrunable=
  router.get(`${base}/members`, ...gate, async (c) => {
    try {
      return send(c, await listGhostMembers(client, c.req.param('guildId'), {
        status: parseStatus(c.req.query('status')),
        search: c.req.query('search') ?? undefined,
        onlyPrunable: c.req.query('onlyPrunable') === 'true',
        page: Number(c.req.query('page')) || 1,
        pageSize: Number(c.req.query('pageSize')) || 50,
      }));
    } catch (err) {
      logger.error('GhostMembersAPI', 'Erreur GET membres:', err);
      return fail(c, err, 'Erreur lors de la récupération des membres', 'GhostMembersAPI');
    }
  });

  // Seuils et garde-fous
  router.patch(`${base}/config`, ...gate, async (c) => {
    try {
      const body = await readBody(c);
      if (!body) return send(c, { error: 'Corps de requête manquant' }, 400);
      const patch = sanitizeGhostConfigPatch(body);
      if (Object.keys(patch).length === 0) return send(c, { error: 'Aucun champ valide à mettre à jour' }, 400);
      const config = await upsertGhostConfig(c.req.param('guildId'), patch);
      await audit(
        c,
        'Mise à jour Ghost Members',
        `Seuils: inactif ${config.inactiveDays}j, spectateur ${config.spectatorWindowDays}j, grâce ${config.gracePeriodDays}j.`,
      );
      return send(c, { config });
    } catch (err) {
      logger.error('GhostMembersAPI', 'Erreur PATCH config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'GhostMembersAPI');
    }
  });

  // Reclassement complet du serveur
  router.post(`${base}/recompute`, ...gate, async (c) => {
    try {
      const counts = await recomputeGhostStatuses(c.req.param('guildId'));
      await audit(
        c,
        'Recalcul Ghost Members',
        `Actifs: ${counts.ACTIVE}, spectateurs: ${counts.SPECTATOR}, inactifs: ${counts.INACTIVE}, récents: ${counts.NEW}.`,
      );
      return send(c, { counts });
    } catch (err) {
      logger.error('GhostMembersAPI', 'Erreur recompute:', err);
      return fail(c, err, 'Erreur lors du recalcul des statuts', 'GhostMembersAPI');
    }
  });

  // Étape 1 : prévisualisation
  router.post(`${base}/prune/preview`, ...gate, async (c) => {
    try {
      const body = await readBody<{ statuses?: unknown }>(c);
      return send(c, await previewGhostPrune(client, c.req.param('guildId'), {
        statuses: parseTargetStatuses(body?.statuses),
      }));
    } catch (err) {
      logger.error('GhostMembersAPI', 'Erreur prévisualisation prunage:', err);
      return fail(c, err, 'Erreur lors de la prévisualisation', 'GhostMembersAPI');
    }
  });

  // Étape 2 : expulsion confirmée
  router.post(`${base}/prune`, ...gate, async (c) => {
    try {
      const body = await readBody<{
        statuses?: unknown;
        userIds?: unknown;
        confirmCount?: unknown;
        reason?: unknown;
      }>(c);
      if (!body || !Array.isArray(body.userIds)) return send(c, { error: 'Liste de membres manquante' }, 400);

      const result = await executeGhostPrune(
        client,
        c.req.param('guildId'),
        {
          statuses: parseTargetStatuses(body.statuses),
          userIds: body.userIds.filter((id): id is string => typeof id === 'string'),
          confirmCount: typeof body.confirmCount === 'number' ? body.confirmCount : -1,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        },
        { userId: c.var.dashboardUser.userId, username: auditUserOf(c) },
      );

      await audit(
        c,
        'Prunage Ghost Members',
        `${result.successCount} membre(s) expulsé(s), ${result.failureCount} échec(s) sur ${result.totalTargeted} ciblé(s).`,
      );
      return send(c, result);
    } catch (err) {
      if (err instanceof GhostPruneValidationError) return send(c, { error: err.message }, 400);
      logger.error('GhostMembersAPI', 'Erreur exécution prunage:', err);
      return fail(c, err, 'Erreur lors du prunage', 'GhostMembersAPI');
    }
  });

  // Historique des prunages
  router.get(`${base}/runs`, ...gate, async (c) => {
    try {
      const runs = await getGhostPruneRuns(c.req.param('guildId'), Number(c.req.query('take')) || 20);
      return send(c, { runs });
    } catch (err) {
      logger.error('GhostMembersAPI', 'Erreur GET historique:', err);
      return fail(c, err, 'Erreur lors de la récupération de l\'historique', 'GhostMembersAPI');
    }
  });

  return router;
}
