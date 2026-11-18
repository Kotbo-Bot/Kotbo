/**
 * Banc d'essai des routes Hono du dashboard.
 *
 * Simule la session et la garde serveur (`guildGate`), que couvrent leurs
 * propres tests : un test de route vérifie la route, avec l'accès qu'il choisit.
 * `mockDashboardGate` doit être appelé avant d'importer la route testée.
 */
import { mock } from 'bun:test';
import path from 'node:path';
import type { Hono } from 'hono';
import { completeModuleMock } from './moduleMock.js';
import type { AuthClaims, DashboardAccess } from '../../api/shared.js';

const API = path.resolve(import.meta.dir, '../../api');
let currentAccess: DashboardAccess;
let currentUser: AuthClaims;

export function mockDashboardGate(access: DashboardAccess, user: AuthClaims): void {
  currentAccess = access;
  currentUser = user;
  for (const ext of ['ts', 'js']) {
    mock.module(path.join(API, `routes/dashboard/guildGate.${ext}`), () =>
      completeModuleMock(path.join(API, 'routes/dashboard/guildGate.ts'), {
        READ_METHODS: new Set(['GET', 'HEAD', 'OPTIONS']),
        auditGlobalAdminWrite: async () => {},
        evaluateGuildGate: async () => ({ denied: null, access: currentAccess, effectiveAccess: currentAccess }),
      }));
    mock.module(path.join(API, `auth/sessionStore.${ext}`), () =>
      completeModuleMock(path.join(API, 'auth/sessionStore.ts'), {
        sessionIdFromCookieHeader: () => 'sid',
        getDashboardSession: async () => ({ ...currentUser }),
      }));
  }
}

/** Accès et personne des requêtes suivantes. */
export function setDashboardAccess(access: DashboardAccess, user: AuthClaims = currentUser): void {
  currentAccess = access;
  currentUser = user;
}

/** Appelle une route ; le corps est rendu décodé quand c'est du JSON. */
export async function dashboardCall(router: Hono, method: string, url: string, body?: unknown) {
  const res = await router.request(url, {
    method,
    headers: { cookie: 'kotbo_session=test', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, res };
}

/** Contexte des anciens tests de sous-routeurs `modules/` (forme de `ModuleRouteContext`). */
export interface LegacyModuleContext {
  req: AsyncIterable<unknown> & { bodyText?: string };
  res: { writeHead?: (status: number) => unknown; end: (chunk?: string) => unknown; statusCode?: number };
  parts: string[];
  url?: URL;
  method?: string;
  user: AuthClaims;
  access: DashboardAccess;
  /** guildId, auditUser, moduleKey… : portés par les anciens tests, ignorés ici. */
  [extra: string]: unknown;
}

/**
 * Rejoue un appel écrit pour l'ancien sous-routeur sur sa version Hono : le corps
 * est lu dans la fausse requête, le statut et la réponse écrits dans la fausse
 * réponse. Les assertions des tests restent celles d'origine.
 */
export async function legacyModuleCall(router: Hono, ctx: LegacyModuleContext): Promise<boolean> {
  // `auditUser` du contexte d'origine = nom de session côté Hono (`auditUserOf`).
  const auditUser = typeof ctx.auditUser === 'string' ? ctx.auditUser : undefined;
  setDashboardAccess(ctx.access, auditUser ? { ...ctx.user, username: auditUser } : ctx.user);
  let body = ctx.req.bodyText ?? '';
  if (!body) {
    const chunks: string[] = [];
    for await (const chunk of ctx.req) chunks.push(String(chunk));
    body = chunks.join('');
  }
  const method = ctx.method ?? 'GET';
  const response = await router.request(`/${ctx.parts.join('/')}${ctx.url?.search ?? ''}`, {
    method,
    headers: { cookie: 'kotbo_session=test', 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' || !body ? {} : { body }),
  });
  const text = await response.text();
  ctx.res.statusCode = response.status;
  ctx.res.writeHead?.(response.status);
  ctx.res.end(text);
  return response.status !== 404;
}
