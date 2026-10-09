/**
 * Liens d'aperçu d'un brouillon : `/s/<slug>/preview/<jeton>`.
 *
 * Le jeton porte l'identifiant de la page et une échéance, signés en
 * HMAC-SHA256 avec le secret de l'API : rien n'est stocké, et un jeton expiré
 * ou retouché est refusé. Qui a le lien voit le brouillon, sans compte : c'est
 * l'usage voulu (« faire relire avant publication »).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getJwtSecret } from '../../api/shared.js';

export const PREVIEW_TTL_MS = 7 * 24 * 3600 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', `site-preview:${getJwtSecret()}`).update(payload).digest('base64url');
}

export function createPreviewToken(pageId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const expiresAt = now + PREVIEW_TTL_MS;
  const payload = `${pageId}.${expiresAt.toString(36)}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(expiresAt) };
}

/** Identifiant de page d'un jeton valide et non expiré, sinon nul. */
export function verifyPreviewToken(token: string, now = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [pageId, expiry, signature] = parts;
  if (!/^[a-z0-9]{20,32}$/.test(pageId) || !/^[a-z0-9]{1,12}$/.test(expiry)) return null;
  const expected = Buffer.from(sign(`${pageId}.${expiry}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return Number.parseInt(expiry, 36) > now ? pageId : null;
}
