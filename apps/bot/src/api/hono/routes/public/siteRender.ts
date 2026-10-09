import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Client } from 'discord.js';
import { getApiUrl, getDashboardUrl } from '../../../shared.js';
import { getAllInstances } from '../../../../utils/instanceResolver.js';
import { logger } from '../../../../utils/logger.js';
import { handleSiteRequest, robotsTxt } from '../../../../services/site/sitePages.js';

// ============================================================================
// RENDU PUBLIC DES SITES COMMUNAUTAIRES
//
// Le dashboard sert `/s/…` en relayant la requête ici (cf. nginx.conf) :
//   GET /api/site/render/s/<chemin>   page, fichier commun ou image d'un site
//   GET /api/site/robots.txt          robots.txt du dashboard
//
// Le site doit toujours être servi depuis l'origine du dashboard : servi
// depuis celle de l'API, du contenu écrit par un serveur vivrait à côté du
// cookie de session. Une requête qui n'arrive pas par le proxy d'un dashboard
// connu est donc renvoyée vers lui.
//
// Les réponses portent `X-Kotbo-Handled` : une page introuvable répond 404,
// et le répartiteur ne doit pas la prendre pour une route absente de Hono.
// ============================================================================

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;
const MAX_TRACKED = 20_000;
const hits = new Map<string, number[]>();

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > MAX_TRACKED) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
      if (hits.size <= MAX_TRACKED) break;
    }
  }
  return recent.length > RATE_MAX;
}

/** Origine du dashboard qui relaie la requête, si elle est connue ; sinon nulle. */
function proxiedDashboardOrigin(c: Context): string | null {
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (!forwardedHost) return null;
  const candidates = [getDashboardUrl(), ...getAllInstances().map((i) => i.dashboardOrigin)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.host === forwardedHost) return url.origin;
    } catch {
      // Instance mal configurée : ignorée.
    }
  }
  // Développement : le serveur Vite relaie depuis localhost.
  if (process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(forwardedHost)) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
    return `${proto}://${forwardedHost}`;
  }
  return null;
}

function apiOrigin(): string {
  try {
    return new URL(getApiUrl()).origin;
  } catch {
    return getApiUrl().replace(/\/$/, '');
  }
}

function decodeSegments(path: string): string[] | null {
  const raw = path.split('/').filter(Boolean);
  if (raw.length > 8) return null;
  try {
    const segments = raw.map((s) => decodeURIComponent(s));
    return segments.every((s) => s.length <= 200 && !s.includes('/') && s !== '..') ? segments : null;
  } catch {
    return null;
  }
}

export function createSiteRenderRouter(client: Client): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get('/api/site/robots.txt', (c) => {
    const origin = proxiedDashboardOrigin(c) ?? getDashboardUrl().replace(/\/$/, '');
    return c.body(robotsTxt(origin), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  });

  app.get('/api/site/render/s/*', async (c) => {
    const url = new URL(c.req.url);
    const rest = url.pathname.slice('/api/site/render/s'.length);
    const origin = proxiedDashboardOrigin(c);
    if (!origin) {
      return c.redirect(`${getDashboardUrl().replace(/\/$/, '')}/s${rest}${url.search}`, 302);
    }

    const ip = clientIp(c);
    if (rateLimited(ip)) {
      return c.body('Trop de requêtes', 429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60', 'X-Kotbo-Handled': '1' });
    }

    const segments = decodeSegments(rest);
    if (!segments) return c.body('Chemin invalide', 400, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Kotbo-Handled': '1' });

    try {
      const response = await handleSiteRequest({
        client,
        segments,
        query: url.searchParams,
        acceptLanguage: c.req.header('accept-language') ?? null,
        origin,
        host: new URL(origin).host,
        apiOrigin: apiOrigin(),
        userAgent: c.req.header('user-agent') ?? null,
        referrer: c.req.header('referer') ?? null,
        ip,
      });
      const headers = new Headers({ ...response.headers, 'X-Kotbo-Handled': '1', Vary: 'Accept-Language' });
      // Les en-têtes communs de l'API (CSP `default-src 'self'`, X-Frame-Options)
      // ne s'appliquent pas : chaque réponse du site porte les siens.
      if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "default-src 'none'");
      if ((headers.get('Content-Security-Policy') ?? '').includes('frame-ancestors *')) headers.delete('X-Frame-Options');
      else headers.set('X-Frame-Options', 'DENY');
      headers.delete('Access-Control-Allow-Credentials');
      const body = typeof response.body === 'string' ? response.body : new Uint8Array(response.body);
      return new Response(c.req.method === 'HEAD' ? null : body, { status: response.status, headers });
    } catch (err) {
      logger.error('SiteRender', `Rendu de ${rest} impossible :`, err);
      return c.body('Erreur interne', 500, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Kotbo-Handled': '1' });
    }
  });

  return app;
}
