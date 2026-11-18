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
