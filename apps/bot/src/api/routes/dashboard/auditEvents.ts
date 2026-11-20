import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getGuildName, safePushAudit } from '../../shared.js';
import {
  AUDIT_EVENT_TYPES,
  getAuditConfig,
  getAuditExecutors,
  searchAuditEvents,
  sanitizeAuditConfigPatch,
  upsertAuditConfig,
  type AuditEventType,
} from '../../../services/analytics/auditDiffService.js';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

function parseEventType(raw: string | undefined): AuditEventType | undefined {
  if (!raw) return undefined;
  return AUDIT_EVENT_TYPES.includes(raw as AuditEventType) ? (raw as AuditEventType) : undefined;
}

/** Ignore une date invalide plutôt que de renvoyer une erreur pour un filtre optionnel. */
function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseSnowflake(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{5,25}$/.test(raw)) return undefined;
  return raw;
}

export function createAuditEventsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/audit-events';

  // Recherche filtrée et paginée
  router.get(base, ...guildRoute(client), async (c) => {
    const q = (key: string) => c.req.query(key);
    try {
      return send(c, await searchAuditEvents(c.req.param('guildId'), {
        eventType: parseEventType(q('eventType')),
        executorId: parseSnowflake(q('executorId')),
        channelId: parseSnowflake(q('channelId')),
        targetId: parseSnowflake(q('targetId')),
        search: q('search') ?? undefined,
        from: parseDate(q('from')),
        to: parseDate(q('to')),
        page: Number(q('page')) || 1,
        pageSize: Number(q('pageSize')) || 25,
      }));
    } catch (err) {
      logger.error('AuditEventsAPI', 'Erreur GET événements:', err);
      return fail(c, err, 'Erreur lors de la récupération des événements', 'AuditEventsAPI');
    }
  });

  router.get(`${base}/config`, ...guildRoute(client), async (c) => {
    try {
      return send(c, { config: await getAuditConfig(c.req.param('guildId')) });
    } catch (err) {
      logger.error('AuditEventsAPI', 'Erreur GET config:', err);
      return fail(c, err, 'Erreur lors de la récupération de la configuration', 'AuditEventsAPI');
    }
  });

  router.patch(`${base}/config`, ...guildRoute(client), async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    try {
      const body = await readBody(c);
      if (!body) return send(c, { error: 'Corps de requête manquant' }, 400);

      const patch = sanitizeAuditConfigPatch(body);
      if (Object.keys(patch).length === 0) return send(c, { error: 'Aucun champ valide à mettre à jour' }, 400);

      const config = await upsertAuditConfig(guildId, patch);
      await safePushAudit(guildId, {
        user: `${user.username ?? 'Inconnu'} (${user.userId})`,
        action: 'Mise à jour Audit structurel',
        context: getGuildName(client, guildId),
        module: 'Audit Logger',
        eventType: 'Manuel',
        details: `Actif: ${config.enabled}, rétention: ${config.retentionDays} jour(s).`,
        channelId: null,
      }, 'Mise à jour Audit structurel');

      return send(c, { config });
    } catch (err) {
      logger.error('AuditEventsAPI', 'Erreur PATCH config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour de la configuration', 'AuditEventsAPI');
    }
  });

  // Alimente le filtre « modérateur »
  router.get(`${base}/executors`, ...guildRoute(client), async (c) => {
    try {
      return send(c, { executors: await getAuditExecutors(c.req.param('guildId')) });
    } catch (err) {
      logger.error('AuditEventsAPI', 'Erreur GET auteurs:', err);
      return fail(c, err, 'Erreur lors de la récupération des auteurs', 'AuditEventsAPI');
    }
  });

  return router;
}
