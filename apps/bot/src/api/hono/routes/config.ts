import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  getDiscordClientId,
  getMissingOAuthConfig,
} from '../../shared.js';
import { configRateLimiter } from '../../limiters.js';
import { getCurrentInstance } from '../../../utils/instanceContext.js';
import { rateLimit } from '../middleware/rateLimit.js';
import crypto from 'node:crypto';
import { customDomainForHost, refreshCustomDomains, traefikDynamicConfig } from '../../../services/system/customDomain.js';

export const configRouter = new OpenAPIHono();

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

const configRoute = createRoute({
  method:  'get',
  path:    '/api/config',
  summary: 'Configuration publique du client Discord (OAuth)',
  tags:    ['Config'],
  responses: {
    200: {
      description: 'Configuration OAuth',
      content: {
        'application/json': {
          schema: z.object({ discordClientId: z.string() }),
        },
      },
    },
    429: {
      description: 'Trop de requêtes',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
    500: {
      description: 'Configuration OAuth invalide côté serveur',
      content: { 'application/json': { schema: z.object({ error: z.string(), missing: z.array(z.string()) }) } },
    },
  },
});

configRouter.use('/api/config', rateLimit(configRateLimiter, 30, 60 * 1000));
configRouter.openapi(configRoute, (c) => {
  const missingOAuth = getMissingOAuthConfig();
  if (missingOAuth.length > 0) {
    return c.json({
      error: 'Configuration OAuth invalide côté serveur.',
      missing: missingOAuth,
    }, 500);
  }
  return c.json({ discordClientId: getDiscordClientId() }, 200);
});

// ---------------------------------------------------------------------------
// GET /api/branding
// ---------------------------------------------------------------------------

const BrandingResponse = z.object({
  instanceId:   z.string(),
  slug:         z.string(),
  name:         z.string(),
  color:        z.string().nullable(),
  logoUrl:      z.string().nullable(),
  faviconUrl:   z.string().nullable(),
  footerText:   z.string().nullable(),
  isWhiteLabel: z.boolean(),
  /** Domaine perso d'un serveur : le serveur qu'il sert. */
  guildId:      z.string().nullable(),
});

const brandingRoute = createRoute({
  method:  'get',
  path:    '/api/branding',
  summary: 'Informations de branding white-label pour le dashboard',
  tags:    ['Config'],
  responses: {
    200: {
      description: 'Branding de l\'instance courante',
      content: { 'application/json': { schema: BrandingResponse } },
    },
  },
});

configRouter.openapi(brandingRoute, (c) => {
  const inst = getCurrentInstance();
  // Sur le domaine perso d'un serveur, le dashboard prend le nom et l'avatar de son bot.
  const custom = customDomainForHost(c.req.header('host'));
  if (custom) {
    return c.json({
      instanceId:   inst.id,
      slug:         inst.slug,
      name:         custom.botName || inst.brandName,
      color:        inst.brandColor,
      logoUrl:      custom.botAvatarUrl,
      faviconUrl:   custom.botAvatarUrl,
      footerText:   null,
      isWhiteLabel: true,
      guildId:      custom.guildId,
    }, 200);
  }
  return c.json({
    instanceId:   inst.id,
    slug:         inst.slug,
    name:         inst.brandName,
    color:        inst.brandColor,
    logoUrl:      inst.brandLogoUrl,
    faviconUrl:   inst.brandFaviconUrl,
    footerText:   inst.brandFooterText,
    isWhiteLabel: !inst.isDefault,
    guildId:      null,
  }, 200);
});

// ---------------------------------------------------------------------------
// GET /api/internal/custom-domains/traefik
// Lu par le fournisseur HTTP de Traefik (cf. docs/domaines-perso.md). Hors
// documentation OpenAPI : ce n'est pas une route publique.
// ---------------------------------------------------------------------------

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

configRouter.get('/api/internal/custom-domains/traefik', async (c) => {
  const expected = process.env.CUSTOM_DOMAIN_PROVIDER_TOKEN;
  if (!expected || !sameSecret(c.req.query('token') ?? '', expected)) return c.json({ error: 'Not found' }, 404);
  const domains = await refreshCustomDomains();
  return c.json(traefikDynamicConfig(domains.map((d) => d.host)));
});
