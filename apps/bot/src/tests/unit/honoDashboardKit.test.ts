import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import { Hono } from 'hono';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

// Garde serveur et session simulées : on vérifie le câblage du kit, pas les règles
// de la garde (couvertes par les tests de l'ancien routeur, qui la partagent).
const gateCalls: string[][] = [];
let gateDenial: { status: number; body: Record<string, unknown> } | null = null;
const access = { level: 'admin', canViewDashboard: true, canManageSettings: true };
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../api/routes/dashboard/guildGate.${ext}`), () =>
    completeModuleMock(path.resolve(import.meta.dir, '../../api/routes/dashboard/guildGate.ts'), {
      auditGlobalAdminWrite: async () => {},
      evaluateGuildGate: async (_client: unknown, _user: unknown, parts: string[]) => {
        gateCalls.push(parts);
        return gateDenial ? { denied: gateDenial } : { denied: null, access, effectiveAccess: access };
      },
    }));
  mock.module(path.resolve(import.meta.dir, `../../api/auth/sessionStore.${ext}`), () =>
    completeModuleMock(path.resolve(import.meta.dir, '../../api/auth/sessionStore.ts'), {
      sessionIdFromCookieHeader: (cookie?: string) => (cookie ? 'sid' : null),
      getDashboardSession: async (sid: string | null) => (sid ? { userId: '42', username: 'u' } : null),
    }));
}
const invalidated: string[] = [];
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/cache.${ext}`), () =>
    completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), {
      cache: { invalidateGuild: async (id: string) => { invalidated.push(id); } },
    }));
}

const { send, readBody, fail, guildRoute } = await import('../../api/hono/dashboard/kit.js');
const { HttpError } = await import('../../api/shared.js');

const app = new Hono();
app.get('/data', (c) => send(c, { a: 1 }));
app.post('/body', async (c) => {
  try {
    return send(c, { body: await readBody(c) });
  } catch (err) {
    return fail(c, err, 'échec');
  }
});
app.get('/boom', (c) => fail(c, new HttpError(409, 'Déjà pris'), 'échec'));
const client = {} as Client;
app.get('/api/dashboard/guilds/:guildId/x', ...guildRoute(client), (c) => send(c, { level: c.var.effectiveAccess.level }));
app.post('/api/dashboard/guilds/:guildId/x', ...guildRoute(client), (c) => send(c, { ok: true }));

const cookie = { cookie: 'kotbo_session=abc' };

describe('kit Hono du dashboard', () => {
  test('send signe les lectures et répond 304 si le client a la même version', async () => {
    const first = await app.request('/data');
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toStartWith('W/"');
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const again = await app.request('/data', { headers: { 'if-none-match': etag! } });
    expect(again.status).toBe(304);
  });

  test('readBody : 415 sans JSON, 400 si invalide, null si vide', async () => {
    expect((await app.request('/body', { method: 'POST', body: 'x' })).status).toBe(415);
    const bad = await app.request('/body', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    const empty = await app.request('/body', { method: 'POST', body: '', headers: { 'content-type': 'application/json' } });
    expect(await empty.json()).toEqual({ body: null });
  });

  test('fail garde le statut et le message d\'une HttpError', async () => {
    const res = await app.request('/boom');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Déjà pris' });
  });

  test('guildRoute : 401 sans session, garde appliquée, refus relayé', async () => {
    expect((await app.request('/api/dashboard/guilds/1/x')).status).toBe(401);

    const ok = await app.request('/api/dashboard/guilds/1/x', { headers: cookie });
    expect(await ok.json()).toEqual({ level: 'admin' });
    expect(gateCalls.at(-1)).toEqual(['api', 'dashboard', 'guilds', '1', 'x']);

    gateDenial = { status: 403, body: { error: 'non' } };
    const denied = await app.request('/api/dashboard/guilds/1/x', { headers: cookie });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'non' });
    gateDenial = null;
  });

  test('guildRoute purge le cache du serveur après une écriture', async () => {
    invalidated.length = 0;
    await app.request('/api/dashboard/guilds/7/x', { headers: cookie });
    expect(invalidated).toEqual([]);
    await app.request('/api/dashboard/guilds/7/x', { method: 'POST', headers: cookie });
    expect(invalidated).toEqual(['7']);
  });
});
