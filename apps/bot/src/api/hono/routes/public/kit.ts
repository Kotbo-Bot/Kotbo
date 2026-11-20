/**
 * Outils communs des routes publiques `/api/public/*` portées sur Hono.
 * Chaque outil répond comme son équivalent de l'ancien routeur node:http.
 */
import type { Context } from 'hono';
import type { IncomingHttpHeaders } from 'node:http';
import { verifyAuthHeaders, checkRateLimit, type AuthClaims } from '../../../shared.js';

export { send, readBody, fail } from '../../dashboard/kit.js';

/** IP derrière le reverse-proxy ; sans en-tête, la boucle locale comme avant. */
export const ipOf = (c: Context): string =>
  c.req.header('x-forwarded-for')?.split(',')[0].trim() || '127.0.0.1';

/** En-têtes dans la forme qu'attendent `isBrowserPageRequest` & co. */
export const headersOf = (c: Context): IncomingHttpHeaders => {
  const out: IncomingHttpHeaders = {};
  c.req.raw.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
};

export const authOf = (c: Context): Promise<AuthClaims | null> =>
  verifyAuthHeaders(c.req.header('authorization'), c.req.header('cookie'));

/** `true` si la requête passe ; sinon l'appelant renvoie le 429. */
export const underLimit = (
  c: Context,
  limiter: Map<string, number[]>,
  limit: number,
  windowMs: number,
): boolean => checkRateLimit(limiter, ipOf(c), limit, windowMs);

export const SNOWFLAKE = /^\d{17,19}$/;
