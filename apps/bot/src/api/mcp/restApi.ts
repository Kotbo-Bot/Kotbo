/**
 * API REST en lecture : expose les outils de lecture MCP en GET, avec la même
 * clé `mcp_…` créée depuis le dashboard (mêmes permissions, même plafond,
 * même offre). Pas de second jeu de requêtes à maintenir : chaque outil MCP
 * de lecture devient une route.
 *
 *   GET /api/v1/:guildId                → outils accessibles à la clé
 *   GET /api/v1/:guildId/:outil?arg=…   → résultat de l'outil, en JSON
 *
 * Authentification : `Authorization: Bearer mcp_…` ou `X-API-Key: mcp_…`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { json } from '../shared.js';
import { verifyMcpKey } from './mcpKeyService.js';
import { registerMcpTools } from './mcpTools.js';
import { checkRateLimit, isValidMcpGuildId } from './mcpServer.js';
import type { McpToolConfig, McpToolHandler } from './toolkit.js';
import { getGuildPlan } from '../../services/system/planService.js';
import { logger } from '../../utils/logger.js';
import { GENERIC_ERROR_MESSAGE, publicErrorMessage } from '../../utils/publicError.js';

// shortcut: lecture seule déduite du nom de l'outil, faute d'annotation readOnlyHint sur les outils.
export const isReadTool = (name: string) => /^(get|list|search|read)_/.test(name);

type Tool = { config: McpToolConfig; handler: McpToolHandler };

function collectTools(guildId: string, permissions: Parameters<typeof registerMcpTools>[2], client: Client, ownerId: string | null) {
  const tools = new Map<string, Tool>();
  const collector = {
    registerTool: (name: string, config: McpToolConfig, handler: McpToolHandler) => {
      if (isReadTool(name)) tools.set(name, { config, handler });
    },
  };
  registerMcpTools(collector as unknown as McpServer, guildId, permissions, client, { ownerId });
  return tools;
}

function inputSchemaOf(config: McpToolConfig): z.ZodObject<z.ZodRawShape> {
  const raw = config.inputSchema ?? {};
  return raw instanceof z.ZodObject ? raw : z.object(raw as z.ZodRawShape);
}

/**
 * La query string n'a que des chaînes : chaque champ garde sa valeur brute si
 * son schéma l'accepte, sinon on essaie sa lecture JSON (nombre, booléen,
 * tableau). Les IDs Discord restent des chaînes, JSON.parse les arrondirait.
 */
export function argsFromQuery(schema: z.ZodObject<z.ZodRawShape>, params: URLSearchParams) {
  const args: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    const raw: unknown = values.length > 1 ? values : values[0];
    const field = schema.shape[key];
    if (!field || field.safeParse(raw).success) {
      args[key] = raw;
      continue;
    }
    try {
      args[key] = JSON.parse(String(raw));
    } catch {
      args[key] = values.length > 1 ? values : raw;
    }
  }
  return schema.strict().safeParse(args);
}

export async function handleRestApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client
): Promise<boolean> {
  if (parts[0] !== 'api' || parts[1] !== 'v1') return false;

  const guildId = parts[2];
  if (!guildId || !isValidMcpGuildId(guildId)) {
    json(res, 400, { error: 'invalid_guild_id', error_description: 'Chemin attendu : /api/v1/:guildId/:outil' });
    return true;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed', error_description: "L'API REST est en lecture seule (GET)." });
    return true;
  }

  if ((await getGuildPlan(guildId)) === 'FREE') {
    json(res, 402, {
      error: 'plan_required',
      error_description: "L'API Kotbo fait partie de l'offre complète. Abonne le serveur depuis la page Facturation du dashboard.",
    });
    return true;
  }

  const authHeader = req.headers.authorization;
  const headerKey = req.headers['x-api-key'];
  const rawKey = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : Array.isArray(headerKey) ? headerKey[0] : headerKey)?.trim();
  const key = rawKey?.startsWith('mcp_') ? await verifyMcpKey(rawKey, guildId, client) : null;
  if (!key) {
    json(res, 401, { error: 'invalid_api_key', error_description: 'Clé API absente, invalide ou inactive pour ce serveur.' });
    return true;
  }
  if (!checkRateLimit(key.id)) {
    json(res, 429, { error: 'rate_limited', error_description: 'Trop de requêtes (100 req/min max).' });
    return true;
  }

  const tools = collectTools(guildId, key.permissions, client, key.ownerId ?? null);
  const toolName = parts[3];

  if (!toolName) {
    json(res, 200, {
      permissions: key.permissions,
      tools: [...tools].map(([name, { config }]) => ({
        name,
        description: config.description ?? null,
        params: zodToJsonSchema(inputSchemaOf(config)),
      })),
    });
    return true;
  }

  const tool = tools.get(toolName);
  if (!tool) {
    json(res, 404, { error: 'unknown_tool', error_description: `Outil « ${toolName} » introuvable ou non autorisé pour cette clé.` });
    return true;
  }

  const parsed = argsFromQuery(inputSchemaOf(tool.config), url.searchParams);
  if (!parsed.success) {
    json(res, 400, { error: 'invalid_params', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return true;
  }

  try {
    const result = await tool.handler(parsed.data);
    const text = result.content?.find((c) => c.type === 'text')?.text ?? 'null';
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    json(res, result.isError ? 400 : 200, data);
  } catch (e) {
    logger.error('RestApi', `Outil ${toolName} en échec :`, e);
    json(res, 500, { error: publicErrorMessage(e, GENERIC_ERROR_MESSAGE, 'RestApi') });
  }
  return true;
}
