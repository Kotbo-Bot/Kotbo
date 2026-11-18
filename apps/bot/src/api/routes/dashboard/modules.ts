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
import { handleNicknameModerationRoutes } from './modules/nickname-moderation.js';
import { handleAutoThreadRoutes } from './modules/auto-thread.js';
import { handleChannelsManagementRoutes } from './modules/channels-management.js';
import { handleVerificationRoutes } from './modules/verification.js';
import { handleBannedWordsRoutes } from './modules/banned-words.js';
import { handleSettingsRoutes } from './modules/settings.js';
import { handleRegulationRoutes } from './modules/regulation.js';
import { handleNewsRoutes } from './modules/news.js';
import { handleSocialFollowsRoutes } from './modules/social-follows.js';
import { handleDailyAlgoProblemsRoutes } from './modules/daily-algo-problems.js';
import { handleInvitationsRoutes } from './modules/invitations.js';
import { handleDailyAlgoSubmissionsRoutes } from './modules/daily-algo-submissions.js';
import { handleTicketsRoutes } from './modules/tickets.js';
import { handleServerTemplateRoutes } from './modules/server-template.js';
import { handleStarboardRoutes } from './modules/starboard.js';
import { handleTagAutomodRoutes } from './modules/tag-automod.js';

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
    case 'nickname-moderation': return handleNicknameModerationRoutes(ctx);
    case 'auto-thread': return handleAutoThreadRoutes(ctx);
    case 'channels-management': return handleChannelsManagementRoutes(ctx);
    case 'verification': return handleVerificationRoutes(ctx);
    case 'banned-words': return handleBannedWordsRoutes(ctx);
    case 'settings': return handleSettingsRoutes(ctx);
    case 'regulation': return handleRegulationRoutes(ctx);
    case 'news': return handleNewsRoutes(ctx);
    case 'social-follows': return handleSocialFollowsRoutes(ctx);
    case 'daily-algo-problems': return handleDailyAlgoProblemsRoutes(ctx);
    case 'invitations': return handleInvitationsRoutes(ctx);
    case 'daily-algo-submissions': return handleDailyAlgoSubmissionsRoutes(ctx);
    case 'tickets': return handleTicketsRoutes(ctx);
    case 'server-template': return handleServerTemplateRoutes(ctx);
    case 'starboard': return handleStarboardRoutes(ctx);
    case 'tag-automod': return handleTagAutomodRoutes(ctx);
    default: return false;
  }
}
