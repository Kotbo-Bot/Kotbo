import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { fetchExternal } from '../../../utils/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireGuildAccess } from '../middleware/guildAccess.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { dashboardSensitiveRateLimiter } from '../../limiters.js';
import { getVerificationService } from '../../../serviceFactory.js';
import {
  getMissingOAuthConfig,
  getDiscordClientId,
  getDiscordClientSecret,
  getDashboardUrl,
  getApiUrl,
  HttpError,
} from '../../shared.js';
import {
  getVerificationByToken,
  completeVerification,
} from '../../../services/moderation/securityVerificationService.js';
import { fail, readBody, requestIp } from '../dashboard/kit.js';

export function createVerificationRouter(client: Client) {
  const router = new OpenAPIHono();

  // 1. GET /api/verify/callback - Callback OAuth Discord pour la vérification
  router.get('/api/verify/callback', async (c) => {
    const code = c.req.query('code');
    const stateParam = c.req.query('state');

    if (!code || !stateParam) {
      return c.redirect(`${getDashboardUrl()}/verify?error=missing_params`, 302);
    }

    let stateData: { guildId: string; token: string; clientInfo?: string | null };
    try {
      stateData = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf-8'));
    } catch {
      return c.redirect(`${getDashboardUrl()}/verify?error=invalid_state`, 302);
    }

    const verification = await getVerificationByToken(stateData.token);
    if (!verification) {
      return c.redirect(`${getDashboardUrl()}/verify/${stateData.guildId}/${stateData.token}?error=expired`, 302);
    }

    const missingOAuth = getMissingOAuthConfig({ includeSecret: true });
    if (missingOAuth.length > 0) {
      return c.redirect(`${getDashboardUrl()}/verify/${stateData.guildId}/${stateData.token}?error=oauth_config`, 302);
    }

    const VERIFY_REDIRECT_URI = `${getApiUrl()}/api/verify/callback`;

    try {
      const tokenResponse = await fetchExternal('https://discord.com/api/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: getDiscordClientId()!,
          client_secret: getDiscordClientSecret(),
          grant_type: 'authorization_code',
          code,
          redirect_uri: VERIFY_REDIRECT_URI,
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };
      if (tokenData.error || !tokenData.access_token) {
        return c.redirect(`${getDashboardUrl()}/verify/${stateData.guildId}/${stateData.token}?error=oauth_failed`, 302);
      }

      const ipAddress = requestIp(c) || '127.0.0.1';
      const userResponse = await fetchExternal('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userResponse.ok) {
        return c.redirect(`${getDashboardUrl()}/verify/${stateData.guildId}/${stateData.token}?error=user_fetch`, 302);
      }

      const userData = await userResponse.json() as { id: string; username: string; email?: string | null };

      let connectionsData: any = null;
      if (verification.level === 'HIGH') {
        try {
          const connectionsResponse = await fetchExternal('https://discord.com/api/users/@me/connections', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (connectionsResponse.ok) {
            connectionsData = await connectionsResponse.json();
          }
        } catch (err) {
          logger.error('VerifyAPI', 'Failed to fetch user connections:', err);
        }
      }

      let guildsData: any = null;
      if (verification.level === 'HIGH') {
        try {
          const guildsResponse = await fetchExternal('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (guildsResponse.ok) {
            guildsData = await guildsResponse.json();
          }
        } catch (err) {
          logger.error('VerifyAPI', 'Failed to fetch user guilds:', err);
        }
      }

      let clientInfoDecoded: any = null;
      if (stateData.clientInfo) {
        try {
          const raw = Buffer.from(stateData.clientInfo, 'base64url').toString('utf-8');
          clientInfoDecoded = JSON.parse(decodeURIComponent(raw));
        } catch {
          try {
            clientInfoDecoded = JSON.parse(Buffer.from(stateData.clientInfo, 'base64url').toString('utf-8'));
          } catch (e) {
            logger.error('VerifyAPI', 'Failed to decode clientInfo:', e);
          }
        }
      }

      const result = await completeVerification({
        token: stateData.token,
        verifiedDiscordId: userData.id,
        ipAddress,
        dashboardUrl: getDashboardUrl(),
        client,
        email: userData.email || null,
        connections: connectionsData,
        guilds: guildsData,
        userFetched: userData,
        clientInfo: clientInfoDecoded,
      });

      const resultParam = Buffer.from(JSON.stringify(result)).toString('base64url');
      return c.redirect(`${getDashboardUrl()}/verify/${stateData.guildId}/${stateData.token}?result=${resultParam}`, 302);
    } catch (err) {
      logger.error('VerifyAPI', 'OAuth callback error:', err);
      return c.redirect(`${getDashboardUrl()}/verify/${stateData.guildId}/${stateData.token}?error=internal`, 302);
    }
  });

  // 2. GET /api/verify/:guildId/:token - Informations sur la session de vérification
  router.get('/api/verify/:guildId/:token', async (c) => {
    const guildId = c.req.param('guildId');
    const token = c.req.param('token');

    const verification = await getVerificationByToken(token);
    if (!verification || verification.guildId !== guildId) {
      return c.json({ error: 'Session de vérification invalide ou expirée.' }, 404);
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    const guildConfig = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        verificationEmbedTitle: true,
        verificationEmbedColor: true,
      },
    });

    return c.json({
      guildId: verification.guildId,
      userId: verification.userId,
      guildName: guild?.name || 'Serveur inconnu',
      guildIcon: guild?.iconURL({ size: 128 }) || null,
      title: guildConfig?.verificationEmbedTitle || 'Vérification de sécurité',
      color: guildConfig?.verificationEmbedColor || '#5865F2',
      expiresAt: verification.expiresAt.toISOString(),
      level: verification.level,
      // Clé publique : destinée au navigateur, contrairement au secret.
      turnstileSiteKey: verification.level === 'LINK' ? (process.env.TURNSTILE_SITE_KEY || null) : null,
    }, 200);
  });

  // 2b. POST /api/verify/:guildId/:token/captcha - Niveau LINK : le lien identifie
  // l'utilisateur, Turnstile prouve qu'il est humain. Pas de connexion Discord.
  router.post('/api/verify/:guildId/:token/captcha', async (c) => {
    const guildId = c.req.param('guildId');
    const token = c.req.param('token');
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) return c.json({ error: 'Captcha non configuré.' }, 503);

    try {
      const body = await readBody<{ cfToken?: unknown; clientInfo?: unknown }>(c);
      const cfToken = body?.cfToken;
      if (typeof cfToken !== 'string' || !cfToken || cfToken.length > 2048) {
        return c.json({ error: 'Captcha requis.' }, 400);
      }

      const verification = await getVerificationByToken(token);
      if (!verification || verification.guildId !== guildId || verification.level !== 'LINK') {
        return c.json({ error: 'Session de vérification invalide ou expirée.' }, 404);
      }

      const ipAddress = requestIp(c) || '127.0.0.1';
      const check = await fetchExternal('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: cfToken, remoteip: ipAddress }),
      }, 10_000);
      const verdict = check.ok
        ? await check.json() as { success?: boolean; action?: string; hostname?: string }
        : null;
      const allowedHosts = (process.env.TURNSTILE_HOSTNAMES || '').split(',').map((h) => h.trim()).filter(Boolean);
      if (
        !verdict?.success ||
        (verdict.action && verdict.action !== 'verify') ||
        (allowedHosts.length > 0 && !allowedHosts.includes(verdict.hostname || ''))
      ) {
        return c.json({ error: 'Captcha refusé, réessaie.' }, 400);
      }

      // Empreinte facultative : objet plat de petite taille, sinon ignorée.
      const rawInfo = body?.clientInfo;
      const clientInfo = rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo) && JSON.stringify(rawInfo).length <= 2000
        ? rawInfo
        : null;

      const result = await completeVerification({
        token,
        verifiedDiscordId: verification.userId,
        ipAddress,
        dashboardUrl: getDashboardUrl(),
        client,
        clientInfo,
      });
      return c.json(result, result.success ? 200 : 400);
    } catch (err) {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.statusCode as 400);
      }
      logger.error('VerifyAPI', 'Erreur captcha:', err);
      return fail(c, err, 'Erreur interne.', 'VerifyAPI');
    }
  });

  // 3. GET /api/verify/:guildId/:token/oauth - Redirection vers OAuth Discord pour vérification
  router.get('/api/verify/:guildId/:token/oauth', async (c) => {
    const guildId = c.req.param('guildId');
    const token = c.req.param('token');

    const missingOAuth = getMissingOAuthConfig();
    if (missingOAuth.length > 0) {
      return c.json({ error: 'Configuration OAuth invalide.' }, 500);
    }

    const verification = await getVerificationByToken(token);
    if (!verification || verification.guildId !== guildId) {
      return c.redirect(`${getDashboardUrl()}/verify/${guildId}/${token}?error=expired`, 302);
    }

    const VERIFY_REDIRECT_URI = `${getApiUrl()}/api/verify/callback`;
    const clientInfo = c.req.query('clientInfo') || null;
    const state = Buffer.from(JSON.stringify({ guildId, token, clientInfo })).toString('base64url');

    let scope = 'identify';
    if (verification.level === 'MEDIUM') {
      scope = 'identify email';
    } else if (verification.level === 'HIGH') {
      scope = 'identify email connections guilds guilds.members.read';
    }

    const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${getDiscordClientId()}&redirect_uri=${encodeURIComponent(VERIFY_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
    return c.redirect(discordUrl, 302);
  });

  // 4. POST /api/verify/:guildId/:token/complete - Finaliser la vérification avec un token Discord
  router.post('/api/verify/:guildId/:token/complete', async (c) => {
    const _guildId = c.req.param('guildId');
    const token = c.req.param('token');
    const ipAddress = requestIp(c) || '127.0.0.1';

    try {
      const body = await readBody<{ discordToken?: string }>(c);
      if (!body?.discordToken) {
        return c.json({ error: 'Token Discord requis.' }, 400);
      }

      const verification = await getVerificationByToken(token);
      if (!verification) {
        return c.json({ error: 'Session de vérification invalide ou expirée.' }, 404);
      }

      const userResponse = await fetchExternal('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${body.discordToken}` },
      });

      if (!userResponse.ok) {
        return c.json({ error: 'Token Discord invalide.' }, 401);
      }

      const userData = await userResponse.json() as { id: string; username: string; avatar: string | null; email?: string | null };

      let connectionsData: any = null;
      if (verification.level === 'HIGH') {
        try {
          const connectionsResponse = await fetchExternal('https://discord.com/api/users/@me/connections', {
            headers: { Authorization: `Bearer ${body.discordToken}` },
          });
          if (connectionsResponse.ok) {
            connectionsData = await connectionsResponse.json();
          }
        } catch (err) {
          logger.error('VerifyAPI', 'Failed to fetch user connections:', err);
        }
      }

      let guildsData: any = null;
      if (verification.level === 'HIGH') {
        try {
          const guildsResponse = await fetchExternal('https://discord.com/api/users/@me/guilds', {
            headers: { Authorization: `Bearer ${body.discordToken}` },
          });
          if (guildsResponse.ok) {
            guildsData = await guildsResponse.json();
          }
        } catch (err) {
          logger.error('VerifyAPI', 'Failed to fetch user guilds:', err);
        }
      }

      const result = await completeVerification({
        token,
        verifiedDiscordId: userData.id,
        ipAddress,
        dashboardUrl: getDashboardUrl(),
        client,
        email: userData.email || null,
        connections: connectionsData,
        guilds: guildsData,
        userFetched: userData,
      });

      return c.json(result, result.success ? 200 : 400);
    } catch (err) {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.statusCode as 400);
      }
      logger.error('VerifyAPI', 'Erreur lors de la vérification:', err);
      return fail(c, err, 'Erreur interne.', 'VerifyAPI');
    }
  });

  // 5. POST /api/verify/:guildId/deploy - Déploiement de l'embed de vérification
  const deployRoute = createRoute({
    method: 'post',
    path: '/api/verify/{guildId}/deploy',
    summary: 'Déployer un embed de vérification dans un salon',
    tags: ['Verification'],
    request: {
      params: z.object({ guildId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ channelId: z.string().min(15).max(20) }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Embed déployé',
        content: {
          'application/json': {
            schema: z.object({ success: z.boolean(), message: z.string().optional() }),
          },
        },
      },
      400: {
        description: 'Erreur',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      401: {
        description: 'Non authentifié',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      403: {
        description: 'Accès refusé',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
    },
  });

  router.use('/api/verify/:guildId/deploy', requireAuth);
  router.use('/api/verify/:guildId/deploy', requireGuildAccess(client, 'moderator'));
  router.use('/api/verify/:guildId/deploy', rateLimit(dashboardSensitiveRateLimiter, 5, 60 * 1000));

  router.openapi(deployRoute, async (c) => {
    const { guildId } = c.req.valid('param');
    const { channelId } = c.req.valid('json');

    const service = getVerificationService();
    const result = await service.deployVerificationEmbed({
      guildId,
      channelId,
      dashboardUrl: getDashboardUrl(),
    });

    if (!result.success) {
      return c.json({ error: result.error! }, 400);
    }
    return c.json({ success: true, message: 'Embed de vérification envoyé.' }, 200);
  });

  return router;
}
