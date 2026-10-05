import { errorCode } from '../utils/errors.js';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Client } from 'discord.js';

import prisma from '../utils/db.js';
import { mayBeTicketChannel } from '../services/features/ticketChannelLookup.js';
import { logger } from '../utils/logger.js';
import {
  json,
  getDiscordClientId,
  getDashboardOrigin,
  CORS_EXTRA_ORIGINS,
  isKotboPublicOrigin,
  splitPath,
  configRateLimiter,
  errorReportRateLimiter,
  feedbackReportRateLimiter,
  partnershipRateLimiter,
  dashboardWriteRateLimiter,
  dashboardSensitiveRateLimiter,
  rankCardPreviewRateLimiter,
  setDashboardStateBroadcaster,
  setDashboardEventBroadcaster,
  collectShardGuilds,
  resolveDashboardAccess,
  type DashboardEvent,
  type DashboardSanctionType,
  BunServerResponse,
} from './shared.js';
import { getDashboardSession, sessionIdFromCookieHeader } from './auth/sessionStore.js';
import { getCurrentInstance } from '../utils/instanceContext.js';
import { getAllInstances } from '../utils/instanceResolver.js';

// Modular Route Handlers (legacy - maintenu pendant la migration progressive)
import { handlePublicRoutes } from './routes/public.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleReportErrorRoute } from './routes/error.js';
import { handleReportFeedbackRoute } from './routes/feedback.js';
import { handlePartnershipRoute } from './routes/partnership.js';
import { handleUserRoutes } from './routes/user.js';
import { handleAdminRoutes } from './routes/admin.js';
import { startBroadcastScheduler } from '../services/system/broadcastService.js';
import { handleDashboardRoutes } from './routes/dashboard.js';
import { handleVerifyRoutes } from './routes/verify.js';
import { handleMCPRoutes, mcpRateLimiter } from './mcp/mcpServer.js';

// Hono - nouveau routeur typé (migration progressive)
import { createHonoApp } from './hono/app.js';

import { jsonFailure } from './shared/failure.js';
import { canViewFeatureSection } from './routes/dashboard/featureGate.js';
import {
  addLiveSubscriber,
  liveSnapshot,
  liveTopic,
  removeLiveSubscriber,
  startLivePublisher,
} from '../services/analytics/analyticsLiveService.js';
export type { DashboardSanctionType };

export async function notifyDashboardSanctionReportRequired(params: {
  guildId: string;
  sanctionId: string;
  sanctionType: DashboardSanctionType;
  targetTag: string;
  moderatorTag: string;
}) {
  const details = [
    `Sanction ${params.sanctionType} appliquée à ${params.targetTag}.`,
    `Rapport à compléter pour ${params.moderatorTag}.`,
    `ID sanction: ${params.sanctionId}.`,
  ].join(' ');

  await prisma.dashboardAuditLog.create({
    data: {
      guildId: params.guildId,
      user: params.moderatorTag,
      action: 'Rapport de sanction requis',
      context: `Sanction ${params.sanctionType}`,
      module: 'Sanctions',
      eventType: 'Action requise',
      details,
      dateIso: new Date(),
    },
  });

  const broadcaster = (globalThis as unknown as Record<string, unknown>).KOTBO_WS_BROADCASTER;
  if (typeof broadcaster === 'function') {
    (broadcaster as (guildId: string, reason: string) => void)(params.guildId, 'sanction_report_required');
  }
}

interface WebSocketData {
  isAuthenticated: boolean;
  userId?: string;
  /** Serveurs dont ce socket suit le temps réel d'Analytics. */
  liveGuilds?: Set<string>;
}

const SNOWFLAKE_RE = /^\d{17,20}$/;
/** Plafond d'abonnements live par socket : un onglet n'en suit qu'un à la fois. */
const LIVE_SUBSCRIPTIONS_MAX = 5;

export const startDashboardApi = async (client: Client) => {
  const instance = getCurrentInstance();
  const port = instance.apiPort;
  const strictOAuthConfig = process.env.DASHBOARD_OAUTH_STRICT === 'true';

  // Instancie l'app Hono (nouveau routeur typé)
  const honoApp = createHonoApp(client);

  const clientId = getDiscordClientId();
  const missingOAuthAtStartup = (() => {
    const missing: string[] = [];
    if (!clientId?.trim()) missing.push('DISCORD_CLIENT_ID');
    if (!instance.discordRedirectUri && !process.env.DISCORD_REDIRECT_URI?.trim()) missing.push('DISCORD_REDIRECT_URI');
    if (!instance.discordClientSecret?.trim()) missing.push('DISCORD_CLIENT_SECRET');
    return missing;
  })();

  if (missingOAuthAtStartup.length > 0) {
    const message = `Configuration OAuth invalide: variables manquantes (${missingOAuthAtStartup.join(', ')})`;
    if (strictOAuthConfig) {
      logger.error('DashboardAPI', message);
      throw new Error(message);
    }

    logger.warn('DashboardAPI', `${message}. Les routes OAuth renverront une erreur tant que ces variables ne sont pas définies.`);
  }

  const broadcastDashboardEventLocal = (event: DashboardEvent) => {
    server.publish(
      'authenticated-dashboard',
      JSON.stringify({ at: new Date().toISOString(), ...event }),
    );
  };

  const broadcastDashboardStateChangeLocal = (guildId: string, reason: string) => {
    broadcastDashboardEventLocal({ type: 'dashboard_state_changed', guildId, reason });
  };

  setDashboardStateBroadcaster(broadcastDashboardStateChangeLocal);
  setDashboardEventBroadcaster(broadcastDashboardEventLocal);
  (globalThis as unknown as Record<string, unknown>).KOTBO_WS_BROADCASTER = broadcastDashboardStateChangeLocal;
  // Point d'entree des diffusions venues des autres shards, qui n'ont pas de
  // serveur WebSocket a eux (voir `broadcastDashboardEventAcrossShards`).
  (globalThis as unknown as Record<string, unknown>).KOTBO_WS_EVENT_BROADCASTER = broadcastDashboardEventLocal;

  // Clean up expired entries every 10 minutes
  setInterval(() => {
    const now = Date.now();
    const cleanLimiter = (limiterMap: Map<string, number[]>, windowMs: number) => {
      for (const [ip, timestamps] of limiterMap.entries()) {
        const valid = timestamps.filter(t => now - t < windowMs);
        if (valid.length === 0) {
          limiterMap.delete(ip);
        } else {
          limiterMap.set(ip, valid);
        }
      }
    };
    cleanLimiter(configRateLimiter, 60 * 1000);
    cleanLimiter(errorReportRateLimiter, 15 * 60 * 1000);
    cleanLimiter(feedbackReportRateLimiter, 15 * 60 * 1000);
    cleanLimiter(partnershipRateLimiter, 60 * 60 * 1000);
    cleanLimiter(mcpRateLimiter, 60 * 1000);
    cleanLimiter(dashboardWriteRateLimiter, 60 * 1000);
    cleanLimiter(dashboardSensitiveRateLimiter, 60 * 1000);
    cleanLimiter(rankCardPreviewRateLimiter, 60 * 1000);
  }, 10 * 60 * 1000).unref();

  // Annonces globales programmees : le planificateur vit dans le processus qui
  // porte l'API, seul endroit qui dispose a la fois du client Discord et de la
  // base. L'etat etant persiste, un redemarrage ne perd aucune annonce.
  startBroadcastScheduler(client, collectShardGuilds);

  const startServer = (listenPort: number) => Bun.serve<WebSocketData>({
    port: listenPort,
    reusePort: true,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);

      // WebSocket upgrade (inchangé)
      if (url.pathname === '/api/dashboard/ws') {
        const origin = request.headers.get('origin');
        let allowedOrigin = origin === getDashboardOrigin();
        if (!allowedOrigin && process.env.NODE_ENV !== 'production' && origin) {
          try {
            allowedOrigin = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
          } catch {
            allowedOrigin = false;
          }
        }
        if (!allowedOrigin) return new Response('Origine WebSocket refusée', { status: 403 });

        const session = await getDashboardSession(sessionIdFromCookieHeader(request.headers.get('cookie') ?? undefined));
        if (!session) return new Response('Session WebSocket absente ou expirée', { status: 401 });
        const success = serverInstance.upgrade(request, {
          data: { isAuthenticated: true, userId: session.userId },
        });
        if (success) return undefined;
      }

      // -----------------------------------------------------------------------
      // 1. Routeur Hono (routes migrées vers Zod + OpenAPI)
      //    Si Hono retourne 404, on tombe dans le fallback legacy.
      //    On clone le request pour que le body reste lisible par le legacy handler.
      // -----------------------------------------------------------------------
      try {
        const honoResponse = await honoApp.fetch(request.clone());
        if (honoResponse.status !== 404) {
          return honoResponse;
        }
      } catch (honoErr) {
        logger.error('DashboardAPI', 'Erreur Hono non gérée:', honoErr);
        return new Response(JSON.stringify({ error: 'Erreur interne API' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // -----------------------------------------------------------------------
      // 2. Fallback legacy - handlers non encore migrés vers Hono
      //    Conservé pendant la période de migration progressive.
      // -----------------------------------------------------------------------

      // Convert request standard to IncomingMessage
      const socket = new Socket();
      const req = new IncomingMessage(socket);
      req.method = request.method;
      req.url = url.pathname + url.search;
      req.headers = {};
      request.headers.forEach((value, key) => {
        req.headers[key.toLowerCase()] = value;
      });

      const logMsg = (msg: string) => {
        if (process.env.NODE_ENV !== 'production') {
          logger.debug('LegacyAPI', msg);
        }
      };

      const sanitizedPath = url.pathname.replace(/mcp_[a-f0-9]+/gi, 'mcp_[REDACTED]')
        .replace(/kotbo_ac_[A-Za-z0-9_-]+/gi, 'kotbo_ac_[REDACTED]')
        .replace(/kotbo_rt_[A-Za-z0-9_-]+/gi, 'kotbo_rt_[REDACTED]');
      logMsg(`[Legacy] Request: ${request.method} ${sanitizedPath}`);

      let bodyText = '';
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
          bodyText = await request.text();
        } catch (err) {
          const errMsg = err instanceof Error ? err.stack || err.message : String(err);
          logMsg(`Body read error: ${errMsg}`);
        }
      }
      req.bodyText = bodyText;

      if (bodyText) {
        req.push(Buffer.from(bodyText, 'utf8'));
      }
      req.push(null);

      return new Promise<Response>((resolve) => {
        const res = new BunServerResponse(req, resolve);

        void (async () => {
          // CORS + sécurité (legacy - géré par Hono middleware pour les routes migrées)
          const isMcpPath = url.pathname.startsWith('/api/mcp/')
            || url.pathname === '/.well-known/oauth-authorization-server'
            || url.pathname.startsWith('/.well-known/oauth-protected-resource/')
            || url.pathname.startsWith('/.well-known/oauth-authorization-server/');

          if (isMcpPath) {
            res.setHeader('Access-Control-Allow-Origin', '*');
          } else {
            const dashboardOrigin = getDashboardOrigin();
            const wlOrigins = getAllInstances().map(i => i.dashboardOrigin);
            const allowedOrigins = new Set([
              dashboardOrigin,
              ...CORS_EXTRA_ORIGINS,
              ...wlOrigins,
              'http://localhost:5173',
              'http://localhost:3000'
            ]);
            const isAllowedDevOrigin = (candidate: string) => {
              try {
                const parsed = new URL(candidate);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
                return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
              } catch { return false; }
            };
            const origin = req.headers.origin;
            const originStr = Array.isArray(origin) ? origin[0] : origin;
            if (originStr) {
              let normalizedOrigin: string;
              try { normalizedOrigin = new URL(originStr).origin; } catch { normalizedOrigin = originStr.replace(/\/$/, ''); }
              if (allowedOrigins.has(normalizedOrigin) || isAllowedDevOrigin(originStr) || isKotboPublicOrigin(originStr)) {
                res.setHeader('Access-Control-Allow-Origin', originStr);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
              } else {
                // Origine non autorisée : ne pas refléter l'origin ni les credentials.
                res.statusCode = 403;
                res.setHeader('Vary', 'Origin');
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: 'Origine refusée' }));
                return;
              }
            } else {
              res.setHeader('Access-Control-Allow-Origin', dashboardOrigin);
            }
            res.setHeader('Vary', 'Origin');
          }
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, Cache-Control, Pragma, If-None-Match, X-Kotbo-API-Key, X-API-Key');
          res.setHeader('Access-Control-Max-Age', '86400');
          // Reponses binaires : sans exposition explicite, le dashboard ne peut
          // pas lire l en-tete qui accompagne l image (aperçu de carte de rang).
          res.setHeader('Access-Control-Expose-Headers', 'X-Rank-Card-Preview, ETag');
          res.setHeader('Content-Security-Policy', "default-src 'self';");
          res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
          res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');

          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.end();
              return;
            }

            const parts = splitPath(url.pathname);

            // Routes legacy (non encore migrées vers Hono)
            if (await handlePublicRoutes(req, res, parts, url, client)) return;
            if (await handleAuthRoutes(req, res, parts, url, client)) return;
            if (await handleVerifyRoutes(req, res, parts, url, client)) return;
            if (await handleReportErrorRoute(req, res, parts, url, client)) return;
            if (await handleReportFeedbackRoute(req, res, parts, url, client)) return;
            if (await handlePartnershipRoute(req, res, parts, url, client)) return;
            if (await handleUserRoutes(req, res, parts, url, client)) return;
            if (await handleAdminRoutes(req, res, parts, url, client)) return;
            if (await handleMCPRoutes(req, res, parts, url, client)) return;
            if (await handleDashboardRoutes(req, res, parts, url, client)) return;

            json(res, 404, { error: 'Route introuvable' });
          } catch (error) {
            logger.error('DashboardAPI', error);
            jsonFailure(res, error, 'Erreur interne API dashboard', 'DashboardAPI');
          }
        })();
      });
    },
    websocket: {
      open(ws) {
        ws.subscribe('authenticated-dashboard');
        ws.send(JSON.stringify({ type: 'dashboard_ws_connected', at: new Date().toISOString() }));
      },
      async message(ws, messageData) {
        let data: { type?: string; guildId?: unknown };
        try {
          const raw = typeof messageData === 'string' ? messageData : new TextDecoder().decode(messageData);
          data = JSON.parse(raw) as { type?: string; guildId?: unknown };
        } catch {
          ws.close(4000, 'Payload invalide');
          return;
        }
        // Authentication happens during the HTTP upgrade. Keep accepting the
        // old client message as a harmless no-op during the frontend rollout.
        if (data.type === 'auth') return;

        // Temps réel d'Analytics : abonnement par serveur, droit de lecture de
        // la section revérifié ici (le sujet commun ne porte que des signaux).
        const guildId = typeof data.guildId === 'string' && SNOWFLAKE_RE.test(data.guildId) ? data.guildId : null;
        if (!guildId || !ws.data.userId) return;
        const live = (ws.data.liveGuilds ??= new Set());
        if (data.type === 'analytics_live_unsubscribe') {
          if (live.delete(guildId)) {
            ws.unsubscribe(liveTopic(guildId));
            removeLiveSubscriber(guildId);
          }
          return;
        }
        if (data.type !== 'analytics_live_subscribe' || live.has(guildId) || live.size >= LIVE_SUBSCRIPTIONS_MAX) return;
        try {
          const access = await resolveDashboardAccess(client, guildId, ws.data.userId);
          if (!access.canViewDashboard || !(await canViewFeatureSection(client, guildId, access, ws.data.userId, 'analytics'))) {
            ws.send(JSON.stringify({ type: 'analytics_live_denied', guildId }));
            return;
          }
          live.add(guildId);
          ws.subscribe(liveTopic(guildId));
          addLiveSubscriber(guildId);
          ws.send(JSON.stringify(liveSnapshot(client, guildId)));
        } catch (err) {
          logger.warn('DashboardWS', `Abonnement live refusé pour ${guildId} :`, err);
        }
      },
      close(ws) {
        ws.unsubscribe('authenticated-dashboard');
        for (const guildId of ws.data.liveGuilds ?? []) removeLiveSubscriber(guildId);
        ws.data.liveGuilds?.clear();
      }
    }
  });

  /**
   * Le rattrapage d'un port occupé passait par `cmd /c netstat | taskkill`,
   * une commande Windows. En conteneur Alpine, `Bun.spawnSync` echoue sur
   * `cmd` introuvable, le `catch` avalait l'echec et `startDashboardApi`
   * rendait la main : le bot continuait de tourner, Discord repondait, mais
   * plus rien n'ecoutait le port de l'API. Le reverse proxy n'avait alors que
   * des 502 a servir, sans que rien ne signale la panne cote bot.
   *
   * Hors Windows on ne tue donc plus personne : on laisse au port le temps de
   * se liberer, puis on echoue franchement pour que le superviseur redemarre
   * le conteneur au lieu de le laisser vivant et muet.
   */
  const RETRY_DELAYS_MS = [1000, 2000, 4000];

  const releaseWindowsPort = () => {
    if (process.platform !== 'win32') return;
    Bun.spawnSync(['cmd', '/c', `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F`]);
  };

  // `server` est capture par les diffusions WebSocket declarees plus haut :
  // il reste non optionnel pour elles, le drapeau porte l'echec du demarrage.
  let server!: ReturnType<typeof startServer>;
  let started = false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      server = startServer(port);
      started = true;
      break;
    } catch (err: unknown) {
      if (errorCode(err) !== 'EADDRINUSE') throw err;

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        logger.error('DashboardAPI', `Port ${port} toujours occupé après ${RETRY_DELAYS_MS.length} tentatives : l'API ne peut pas démarrer.`);
        throw err;
      }

      logger.warn('DashboardAPI', `Port ${port} occupé, nouvelle tentative dans ${delay} ms...`);
      releaseWindowsPort();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (!started) throw new Error(`API dashboard : impossible d'écouter sur le port ${port}.`);

  startLivePublisher(client, (topic, payload) => server.publish(topic, payload));

  logger.success('DashboardAPI', `API dashboard à l'écoute sur le port ${port}.`);

  // Signaler en temps reel les nouveaux messages des salons de tickets.
  //
  // `authenticated-dashboard` part vers toutes les sessions connectees, quels
  // que soient leurs serveurs : le contenu d'un message y serait lisible par
  // n'importe quel utilisateur du dashboard. On n'y publie que les
  // identifiants, et l'onglet concerne relit les messages par l'API, qui
  // verifie ses droits (cf. `broadcastDashboardEvent`).
  //
  // Une réaction, une modification ou une suppression change aussi ce que la
  // vue live affiche : elles relancent la même relecture. Le fil compte comme
  // le salon, pour les tickets en mode fil ou relayés depuis les MP.
  const notifyTicketConversation = async (channelId: string) => {
    try {
      if (!(await mayBeTicketChannel(channelId))) return;
      const ticket = await prisma.ticket.findFirst({
        where: { OR: [{ channelId }, { threadId: channelId }] },
        select: { id: true, guildId: true },
      });
      if (!ticket) return;

      server.publish('authenticated-dashboard', JSON.stringify({
        type: 'new_ticket_message',
        guildId: ticket.guildId,
        ticketId: ticket.id,
      }));
    } catch (err) {
      logger.error('DashboardWS', 'Erreur lors de la diffusion du message live du ticket:', err);
    }
  };

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot && msg.author.id !== client.user!.id) return;
    await notifyTicketConversation(msg.channelId);
  });
  client.on('messageUpdate', async (_old, msg) => notifyTicketConversation(msg.channelId));
  client.on('messageDelete', async (msg) => notifyTicketConversation(msg.channelId));
  client.on('messageReactionAdd', async (reaction) => notifyTicketConversation(reaction.message.channelId));
  client.on('messageReactionRemove', async (reaction) => notifyTicketConversation(reaction.message.channelId));

  logger.success('DashboardAPI', `API dashboard active sur http://localhost:${port}`);

  return server;
};
