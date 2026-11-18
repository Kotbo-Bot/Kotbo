import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import {
  getChannelHealthDashboardData,
  analyzeGuildChannelHealth,
  resolveHealthAlert,
  upsertChannelHealthConfig,
  createSplitChannel,
  archiveChannel,
} from '../../../services/analytics/channelHealthService.js';
import { fail, guildRoute, readLenientBody, send } from '../../hono/dashboard/kit.js';

const CONFIG_FIELDS = [
  'enabled', 'alertChannelId', 'splitMode', 'archiveMode',
  'analysisPeriodDays', 'overloadMsgPerHour', 'overloadUniqueUsers',
  'underusedMsgPerDay', 'underusedUniqueUsers', 'deadMsgPerWeek',
  'excludedChannelIds', 'archiveCategoryId', 'splitNameTemplate',
  'weeklyDigestEnabled', 'weeklyDigestDay',
];

export function createChannelHealthRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId/channel-health';
  const gate = guildRoute(client);

  router.get(base, ...gate, async (c) => {
    try {
      return send(c, await getChannelHealthDashboardData(c.req.param('guildId')));
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error fetching channel health data:', err);
      return fail(c, err, 'Erreur lors de la récupération des données', 'ChannelHealthAPI');
    }
  });

  router.get(`${base}/analyse`, ...gate, async (c) => {
    try {
      const summary = await analyzeGuildChannelHealth(client, c.req.param('guildId'));
      return send(c, summary ?? { channels: [], overloaded: [], underused: [], dead: [], healthy: [] });
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error running analysis:', err);
      return fail(c, err, 'Erreur lors de l\'analyse', 'ChannelHealthAPI');
    }
  });

  router.put(`${base}/config`, ...gate, async (c) => {
    try {
      const body = await readLenientBody(c);
      const sanitized: Record<string, unknown> = {};
      for (const key of CONFIG_FIELDS) {
        if (body[key] !== undefined) sanitized[key] = body[key];
      }

      if (sanitized.excludedChannelIds !== undefined) {
        const ids = sanitized.excludedChannelIds;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          return send(c, { error: 'excludedChannelIds doit être une liste d\'identifiants de salons' }, 400);
        }
        sanitized.excludedChannelIds = [...new Set(ids as string[])];
      }

      return send(c, await upsertChannelHealthConfig(c.req.param('guildId'), sanitized));
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error updating config:', err);
      return fail(c, err, 'Erreur lors de la mise à jour', 'ChannelHealthAPI');
    }
  });

  router.post(`${base}/alerts/:alertId/resolve`, ...gate, async (c) => {
    try {
      const body = await readLenientBody<{ action: string; note?: string }>(c);
      if (!['APPLIED', 'DISMISSED'].includes(body.action)) {
        return send(c, { error: 'Action invalide (APPLIED ou DISMISSED)' }, 400);
      }
      const success = await resolveHealthAlert(
        c.req.param('guildId'),
        c.req.param('alertId'),
        body.action as 'APPLIED' | 'DISMISSED',
        c.var.dashboardUser.userId,
        body.note,
      );
      return success ? send(c, { ok: true }) : send(c, { error: 'Alerte introuvable' }, 404);
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error resolving alert:', err);
      return fail(c, err, 'Erreur lors de la résolution', 'ChannelHealthAPI');
    }
  });

  router.post(`${base}/split`, ...gate, async (c) => {
    try {
      const body = await readLenientBody<{ channelId: string }>(c);
      if (!body.channelId) return send(c, { error: 'channelId requis' }, 400);
      const newChannelId = await createSplitChannel(client, c.req.param('guildId'), body.channelId);
      return newChannelId
        ? send(c, { ok: true, channelId: newChannelId })
        : send(c, { error: 'Impossible de créer le salon' }, 500);
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error splitting channel:', err);
      return fail(c, err, 'Erreur lors du split', 'ChannelHealthAPI');
    }
  });

  router.post(`${base}/archive`, ...gate, async (c) => {
    try {
      const body = await readLenientBody<{ channelId: string }>(c);
      if (!body.channelId) return send(c, { error: 'channelId requis' }, 400);
      const success = await archiveChannel(client, c.req.param('guildId'), body.channelId);
      return success ? send(c, { ok: true }) : send(c, { error: 'Impossible d\'archiver le salon' }, 500);
    } catch (err) {
      logger.error('ChannelHealthAPI', 'Error archiving channel:', err);
      return fail(c, err, 'Erreur lors de l\'archivage', 'ChannelHealthAPI');
    }
  });

  return router;
}
