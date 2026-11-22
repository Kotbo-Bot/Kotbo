/**
 * Outils communs des routes `/api/dashboard/*` portées sur Hono.
 *
 * Chaque outil reproduit son équivalent de l'ancien routeur (`json`,
 * `readJsonBody`, `jsonFailure`, `verifyAuth`, la garde serveur) : une route
 * déplacée doit répondre exactement comme avant au dashboard.
 */
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import {
  HttpError,
  auditActorStore,
  etagMatches,
  splitPath,
  verifyAuthHeaders,
  weakEtag,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';
import { failurePayload } from '../../shared/failure.js';
import { auditGlobalAdminWrite, evaluateGuildGate } from '../../routes/dashboard/guildGate.js';
import { cache } from '../../../utils/cache.js';

declare module 'hono' {
  interface ContextVariableMap {
    dashboardUser: AuthClaims;
    /** Accès réel de la personne : sert aux cartes de droits mises en cache. */
    access: DashboardAccess;
    /** Accès élevé par la case « Configurer » de la section visée. */
    effectiveAccess: DashboardAccess;
  }
}

/** Réponse JSON signée d'un ETag sur les lectures, comme `json()`. */
export function send(c: Context, data: unknown, status = 200): Response {
  if (status === 204) return c.body(null, 204);
  const body = JSON.stringify(data);
  const method = c.req.method;
  if (status === 200 && (method === 'GET' || method === 'HEAD')) {
    const etag = weakEtag(body);
    c.header('ETag', etag);
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'private, no-cache');
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304);
  }
  return c.body(body, status as 200, { 'Content-Type': 'application/json; charset=utf-8' });
}

/** Corps JSON de la requête, comme `readJsonBody` : 415, 400 ou `null` si vide. */
export async function readBody<T = Record<string, unknown>>(c: Context): Promise<T | null> {
  if (!c.req.header('content-type')?.includes('application/json')) {
    throw new HttpError(415, 'Content-Type doit être application/json');
  }
  const text = (await c.req.text()).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Format JSON invalide');
  }
}

/**
 * Corps tolérant de quelques anciennes routes : pas de Content-Type exigé et
 * `{}` si vide. Un JSON invalide reste une erreur (500, comme avant).
 */
export async function readLenientBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return JSON.parse((await c.req.text()) || '{}') as T;
  } catch {
    throw new Error('Invalid JSON');
  }
}

/** Échec d'une route, comme `jsonFailure`. */
export function fail(c: Context, err: unknown, fallbackMessage: string, scope = 'API'): Response {
  if (err instanceof HttpError) {
    return c.json({ error: err.expose ? err.message : fallbackMessage }, err.statusCode as 400);
  }
  const { status, body } = failurePayload(err, fallbackMessage, scope);
  return c.json(body, status as 500);
}

/** Nom inscrit dans le journal par les routes de `modules/`. */
export const auditUserOf = (c: Context): string =>
  c.var.dashboardUser.username ?? `User${c.var.dashboardUser.userId}`;

export const requestIp = (c: Context): string | null =>
  c.req.header('x-forwarded-for')?.split(',')[0].trim() || null;

/** Session obligatoire, avec le 401 JSON qu'attend le dashboard. */
export const dashboardAuth = createMiddleware(async (c, next) => {
  const user = await verifyAuthHeaders(c.req.header('authorization'), c.req.header('cookie'));
  if (!user) return c.json({ error: 'Non authentifié' }, 401);
  c.set('dashboardUser', user);
  await auditActorStore.run({ userId: user.userId, username: user.username ?? null }, next);
});

/**
 * Garde d'une route `/api/dashboard/guilds/:guildId/...` : session, audit de
 * l'admin global, puis `evaluateGuildGate`. Après une écriture, le cache du
 * serveur est purgé comme le faisait l'ancien routeur.
 *
 * À poser sur chaque route, jamais en `router.use` : un middleware de chemin
 * s'exécuterait aussi pour les routes encore servies par l'ancien routeur,
 * qui referait l'audit et compterait deux fois le rate limit.
 */
export function guildRoute(client: Client, options: { invalidateCache?: boolean } = {}) {
  const invalidate = options.invalidateCache ?? true;
  return [
    dashboardAuth,
    createMiddleware(async (c, next) => {
      const user = c.var.dashboardUser;
      const parts = splitPath(c.req.path);
      const method = c.req.method;
      await auditGlobalAdminWrite(client, user, parts, method, requestIp(c));
      const gate = await evaluateGuildGate(client, user, parts, method);
      if (gate.denied) return c.json(gate.denied.body, gate.denied.status as 403);
      c.set('access', gate.access);
      c.set('effectiveAccess', gate.effectiveAccess);
      await next();
      if (invalidate && method !== 'GET') await cache.invalidateGuild(parts[3]);
    }),
  ] as const;
}
