import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getMcpConnectionLogs, makeMcpDirectUrl } from '../../mcp/mcpServer.js';
import { createMcpKey, getMcpKeys, deactivateMcpKey, findActiveMcpKeyById } from '../../mcp/mcpKeyService.js';
import type { McpKeyPermission } from '@prisma/client';
import { fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';

const VALID_PERMISSIONS: McpKeyPermission[] = [
  'READ_STATS',
  'READ_MEMBERS',
  'READ_SANCTIONS',
  'READ_STAFF',
  'READ_TICKETS',
  'READ_COMMUNITY',
  'READ_ECONOMY',
  'READ_MODERATION',
  'READ_ANALYTICS',
  'WRITE_SANCTIONS',
  'WRITE_MESSAGES',
  'WRITE_TICKETS',
  'WRITE_COMMUNITY',
  'WRITE_MEMBERS',
  'READ_WORKFLOWS',
  'WRITE_WORKFLOWS',
  'READ_SITE',
  'WRITE_SITE',
];

export function createMcpKeysRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';

  const adminOnly = createMiddleware(async (c, next) => {
    if (!c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Réservé aux administrateurs du dashboard.' }, 403);
    }
    await next();
  });
  const gate = [...guildRoute(client), adminOnly] as const;

  router.get(`${base}/mcp-logs`, ...gate, (c) => send(c, { logs: getMcpConnectionLogs(c.req.param('guildId')) }));

  router.get(`${base}/mcp-keys`, ...gate, async (c) => {
    try {
      return send(c, await getMcpKeys(c.req.param('guildId')));
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error fetching MCP keys:', error);
      return fail(c, error, 'Erreur lors de la récupération des clés MCP', 'MCPKeyRoutes');
    }
  });

  router.post(`${base}/mcp-keys`, ...gate, async (c) => {
    try {
      const body = await readBody<{ name?: string; permissions?: string[] }>(c);
      if (!body?.name || typeof body.name !== 'string' || !body.name.trim()) {
        return send(c, { error: 'Le champ "name" est requis.' }, 400);
      }

      const permissions: McpKeyPermission[] = (body.permissions ?? ['READ_STATS', 'READ_MEMBERS', 'READ_SANCTIONS'])
        .filter((p): p is McpKeyPermission => VALID_PERMISSIONS.includes(p as McpKeyPermission));

      // La cle agit au nom de qui la cree : c'est ce rattachement qui permet
      // de la couper quand ce compte perd ses droits sur le serveur.
      const created = await createMcpKey(c.req.param('guildId'), body.name.trim(), permissions, c.var.dashboardUser.userId);
      return send(c, {
        id: created.id,
        name: created.name,
        displayKey: created.displayKey,
        permissions: created.permissions,
        isActive: created.isActive,
        createdAt: created.createdAt,
        fullKey: created.fullKey,
      }, 201);
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error creating MCP key:', error);
      return fail(c, error, 'Erreur lors de la création de la clé MCP', 'MCPKeyRoutes');
    }
  });

  router.get(`${base}/mcp-keys/:keyId/direct-url`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    try {
      const key = await findActiveMcpKeyById(c.req.param('keyId'), guildId);
      if (!key) return send(c, { error: 'Clé MCP introuvable ou inactive' }, 404);
      return send(c, makeMcpDirectUrl({ headers: c.req.header() }, new URL(c.req.url), guildId, key.id));
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error creating MCP direct URL:', error);
      return fail(c, error, 'Erreur lors de la génération de l URL MCP directe', 'MCPKeyRoutes');
    }
  });

  router.delete(`${base}/mcp-keys/:keyId`, ...gate, async (c) => {
    try {
      await deactivateMcpKey(c.req.param('guildId'), c.req.param('keyId'));
      return send(c, { ok: true });
    } catch (error) {
      logger.error('MCPKeyRoutes', 'Error deactivating MCP key:', error);
      return fail(c, error, 'Erreur lors de la suppression de la clé MCP', 'MCPKeyRoutes');
    }
  });

  return router;
}
