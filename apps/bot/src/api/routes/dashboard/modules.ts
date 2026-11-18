/**
 * Repartiteur des routes `/<guildId>/<moduleKey>/...` du dashboard.
 *
 * Chaque module vit dans ./modules/<moduleKey>.ts. Les branches testaient
 * toutes `moduleKey`, donc mutuellement exclusives : le switch est
 * equivalent a la chaine de `if` d origine, et l ordre des routes est
 * preserve a l interieur de chaque sous-routeur.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../shared.js';
import type { ModuleRouteContext } from './modules/_shared.js';
import { handleSanctionsRoutes } from './modules/sanctions.js';
import { handleAutoThreadRoutes } from './modules/auto-thread.js';
import { handleChannelsManagementRoutes } from './modules/channels-management.js';
import { handleTicketsRoutes } from './modules/tickets.js';
import { handleServerTemplateRoutes } from './modules/server-template.js';

export async function handleModulesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const auditUser = user.username ?? `User${user.userId}`;
  const moduleKey = parts[4];

  const ctx: ModuleRouteContext = { req, res, parts, url, client, user, guildId, access, method, auditUser, moduleKey };

  switch (moduleKey) {
    case 'sanctions': return handleSanctionsRoutes(ctx);
    case 'auto-thread': return handleAutoThreadRoutes(ctx);
    case 'channels-management': return handleChannelsManagementRoutes(ctx);
    case 'tickets': return handleTicketsRoutes(ctx);
    case 'server-template': return handleServerTemplateRoutes(ctx);
    default: return false;
  }
}
