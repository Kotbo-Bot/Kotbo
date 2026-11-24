/**
 * Persistance et signature de l'attribution d'acquisition à travers le flux
 * OAuth2 Discord (landing -> `/api/public/invite` -> Discord -> callback API).
 *
 * Deux vecteurs complémentaires :
 *  1. Le paramètre `state` signé (HMAC-SHA256) transmis à Discord OAuth2.
 *  2. Le cookie cross-subdomain `kotbo_attr` (`.kotbo.fr`), utilisé en repli.
 */
import crypto from 'node:crypto';
import { getJwtSecret } from '../shared.js';

export type InviteAttribution = {
  source: string;
  content?: string | null;
  campaign?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  popup?: boolean;
};

export const ATTR_COOKIE_NAME = 'kotbo_attr';
const STATE_TTL_SECONDS = 3600;
const SHORT_MAX = 64;

function cleanShort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, SHORT_MAX);
  return trimmed || null;
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed || null;
}

function signPayload(encoded: string): string {
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update(encoded)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

/**
 * Encode et signe l'attribution dans un paramètre `state` OAuth2 compact.
 */
export function signInviteState(attr: InviteAttribution): string {
  const payload = {
    s: cleanShort(attr.source) ?? 'direct',
    c: cleanShort(attr.content),
    k: cleanShort(attr.campaign),
    r: cleanShort(attr.referrer),
    p: cleanPath(attr.landingPath),
    pop: attr.popup ? 1 : 0,
    iat: Math.floor(Date.now() / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signPayload(encoded)}`;
}

/**
 * Vérifie et décode le `state` OAuth2 d'une invitation.
 */
export function verifyInviteState(state: string | undefined): InviteAttribution | null {
  if (!state || typeof state !== 'string') return null;
  const dot = state.indexOf('.');
  if (dot <= 0 || dot === state.length - 1) return null;

  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = signPayload(encoded);

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    const iat = typeof raw.iat === 'number' ? raw.iat : 0;
    const now = Math.floor(Date.now() / 1000);
    if (iat <= 0 || now - iat > STATE_TTL_SECONDS || iat - now > 300) {
      return null;
    }

    return {
      source: cleanShort(raw.s) ?? 'direct',
      content: cleanShort(raw.c),
      campaign: cleanShort(raw.k),
      referrer: cleanShort(raw.r),
      landingPath: cleanPath(raw.p),
      popup: raw.pop === 1 || raw.pop === true,
    };
  } catch {
    return null;
  }
}

/**
 * Construit l'en-tête `Set-Cookie` cross-subdomain pour `kotbo_attr`.
 */
export function makeAttributionCookie(attr: InviteAttribution): string {
  const value = encodeURIComponent(
    JSON.stringify({
      s: cleanShort(attr.source) ?? 'direct',
      c: cleanShort(attr.content),
      k: cleanShort(attr.campaign),
      r: cleanShort(attr.referrer),
      p: cleanPath(attr.landingPath),
    }),
  );
  const isProd = process.env.NODE_ENV === 'production';
  const domainPart = isProd ? '; Domain=.kotbo.fr; Secure' : '';
  return `${ATTR_COOKIE_NAME}=${value}; Path=/${domainPart}; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`;
}

/**
 * Lit l'attribution depuis l'en-tête `Cookie` (format API ou landing).
 */
export function readAttributionCookie(cookieHeader: string | undefined): InviteAttribution | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== ATTR_COOKIE_NAME) continue;
    const rawVal = part.slice(idx + 1).trim();
    if (!rawVal) return null;
    try {
      const decoded = JSON.parse(decodeURIComponent(rawVal)) as Record<string, unknown>;
      return {
        source: cleanShort(decoded.s ?? decoded.utmSource ?? decoded.source) ?? 'direct',
        content: cleanShort(decoded.c ?? decoded.buttonId ?? decoded.content),
        campaign: cleanShort(decoded.k ?? decoded.campaign),
        referrer: cleanShort(decoded.r ?? decoded.referrer),
        landingPath: cleanPath(decoded.p ?? decoded.landingPath),
      };
    } catch {
      return null;
    }
  }
  return null;
}
