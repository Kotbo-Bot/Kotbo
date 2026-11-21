import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getRedis, initRedis } from '../../infra/redis.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';
import { fetchExternal } from '../../utils/http.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_PREFIX = 'kotbo:dashboard-session:';

export const SESSION_COOKIE_NAME = '__Host-kotbo_session';
export const DEV_SESSION_COOKIE_NAME = 'kotbo_session';

type EncryptedValue = {
  iv: string;
  tag: string;
  value: string;
};

type StoredSession = {
  version: 1;
  instanceId: string;
  userId: string;
  username: string;
  avatar: string | null;
  discordAccessToken: EncryptedValue;
  discordRefreshToken: EncryptedValue | null;
  discordTokenExpiresAt: number;
  createdAt: number;
  expiresAt: number;
};

export type DashboardSession = {
  id: string;
  instanceId: string;
  userId: string;
  username: string;
  avatar: string | null;
  discordAccessToken: string;
  discordRefreshToken: string | null;
  discordTokenExpiresAt: number;
  createdAt: number;
  expiresAt: number;
};

function encryptionKey(): Buffer {
  return crypto
    .createHash('sha256')
    .update(`kotbo-dashboard-session:${getCurrentInstance().jwtSecret}`)
    .digest();
}

function encrypt(value: string): EncryptedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    value: encrypted.toString('base64url'),
  };
}

function decrypt(encrypted: EncryptedValue): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(encrypted.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.value, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function sessionKey(sessionId: string): string {
  const digest = crypto.createHash('sha256').update(sessionId).digest('hex');
  return `${SESSION_PREFIX}${digest}`;
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map((entry) => {
      const [name, ...value] = entry.trim().split('=');
      return [name, value.join('=')];
    }),
  );
}

export function sessionIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  const cookies = parseCookieHeader(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] ?? cookies[DEV_SESSION_COOKIE_NAME] ?? null;
}

export function sessionIdFromRequest(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  return sessionIdFromCookieHeader(Array.isArray(raw) ? raw[0] : raw);
}

export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? SESSION_COOKIE_NAME : DEV_SESSION_COOKIE_NAME;
}

export function makeSessionCookie(sessionId: string, maxAge = SESSION_TTL_SECONDS): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=${sessionId}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookies(): string[] {
  return [
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${DEV_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ];
}

export async function createDashboardSession(input: {
  userId: string;
  username: string;
  avatar: string | null;
  discordAccessToken: string;
  discordRefreshToken?: string | null;
  discordExpiresIn: number;
}): Promise<DashboardSession> {
  const redis = getRedis() ?? await initRedis();
  if (!redis) throw new Error('Redis est requis pour créer une session dashboard.');

  const id = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const stored: StoredSession = {
    version: 1,
    instanceId: getCurrentInstance().id,
    userId: input.userId,
    username: input.username,
    avatar: input.avatar,
    discordAccessToken: encrypt(input.discordAccessToken),
    discordRefreshToken: input.discordRefreshToken ? encrypt(input.discordRefreshToken) : null,
    discordTokenExpiresAt: now + Math.max(60, input.discordExpiresIn) * 1000,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };

  await redis.set(sessionKey(id), JSON.stringify(stored), 'EX', SESSION_TTL_SECONDS);
  return hydrateSession(id, stored);
}

function hydrateSession(id: string, stored: StoredSession): DashboardSession {
  return {
    id,
    instanceId: stored.instanceId,
    userId: stored.userId,
    username: stored.username,
    avatar: stored.avatar,
    discordAccessToken: decrypt(stored.discordAccessToken),
    discordRefreshToken: stored.discordRefreshToken ? decrypt(stored.discordRefreshToken) : null,
    discordTokenExpiresAt: stored.discordTokenExpiresAt,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
  };
}

export async function getDashboardSession(sessionId: string | null): Promise<DashboardSession | null> {
  if (!sessionId) return null;
  const redis = getRedis() ?? await initRedis();
  if (!redis) return null;

  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as StoredSession;
    if (stored.version !== 1 || stored.instanceId !== getCurrentInstance().id || stored.expiresAt <= Date.now()) {
      await redis.del(sessionKey(sessionId));
      return null;
    }
    if (stored.discordTokenExpiresAt <= Date.now() + 60_000 && stored.discordRefreshToken) {
      const refreshToken = decrypt(stored.discordRefreshToken);
      // shortcut: une session ouverte sur un domaine perso vient de l'appli Discord du serveur ;
      // ce rafraîchissement échoue alors et la session se ferme (le jeton vit autant qu'elle).
      // À stocker avec la session si l'on allonge sa durée.
      const instance = getCurrentInstance();
      const response = await fetchExternal('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: instance.discordClientId,
          client_secret: instance.discordClientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      const refreshed = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!response.ok || !refreshed.access_token) {
        await redis.del(sessionKey(sessionId));
        return null;
      }
      stored.discordAccessToken = encrypt(refreshed.access_token);
      stored.discordRefreshToken = encrypt(refreshed.refresh_token ?? refreshToken);
      stored.discordTokenExpiresAt = Date.now() + Math.max(60, refreshed.expires_in ?? 3600) * 1000;
      const ttl = Math.max(1, Math.ceil((stored.expiresAt - Date.now()) / 1000));
      await redis.set(sessionKey(sessionId), JSON.stringify(stored), 'EX', ttl);
    }
    return hydrateSession(sessionId, stored);
  } catch {
    await redis.del(sessionKey(sessionId));
    return null;
  }
}

export async function deleteDashboardSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const redis = getRedis() ?? await initRedis();
  await redis?.del(sessionKey(sessionId));
}
