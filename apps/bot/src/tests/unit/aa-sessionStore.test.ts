/**
 * Prefixe `aa-` : ce fichier doit etre charge avant `dashboardApi.test.ts`,
 * qui remplace `api/auth/sessionStore` par un mock complet pour tout le
 * process. Charge apres lui, le test ci-dessous mesurerait le mock au lieu du
 * vrai magasin de sessions et echouerait sur un appel « non mocke ». Meme
 * mecanisme que le prefixe `zz-` employe a l inverse ailleurs dans ce dossier.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { setCurrentInstance } from '../../utils/instanceContext.js';

const values = new Map<string, string>();
const redis = {
  async set(key: string, value: string) { values.set(key, value); return 'OK'; },
  async get(key: string) { return values.get(key) ?? null; },
  async del(key: string) { return values.delete(key) ? 1 : 0; },
};

mock.module('../../infra/redis.js', () => ({
  getRedis: () => redis,
  initRedis: async () => redis,
}));

setCurrentInstance({
  id: '__test__', slug: 'test', name: 'Test', discordToken: '',
  discordClientId: 'client', discordClientSecret: 'secret', discordRedirectUri: null,
  dashboardUrl: 'http://localhost:5173', dashboardOrigin: 'http://localhost:5173',
  apiPort: 8787, brandName: 'Test', brandColor: '#000000', brandLogoUrl: null,
  brandFaviconUrl: null, brandFooterText: null, jwtSecret: 'test-secret-with-enough-entropy',
  ownerId: 'owner', maxGuilds: 1, isDefault: true,
});

let store: typeof import('../../api/auth/sessionStore.js');

beforeAll(async () => {
  store = await import('../../api/auth/sessionStore.js');
});

afterEach(() => values.clear());

describe('dashboard session store', () => {
  test('stores encrypted Discord credentials and restores the session', async () => {
    const created = await store.createDashboardSession({
      userId: '123', username: 'nathan', avatar: null,
      discordAccessToken: 'discord-access-secret',
      discordRefreshToken: 'discord-refresh-secret',
      discordExpiresIn: 3600,
    });

    expect(created.id.length).toBeGreaterThan(30);
    const serialized = [...values.values()][0];
    expect(serialized).not.toContain('discord-access-secret');
    expect(serialized).not.toContain('discord-refresh-secret');

    const restored = await store.getDashboardSession(created.id);
    expect(restored?.userId).toBe('123');
    expect(restored?.discordAccessToken).toBe('discord-access-secret');
  });

  test('deletes a session and rejects it afterwards', async () => {
    const created = await store.createDashboardSession({
      userId: '123', username: 'nathan', avatar: null,
      discordAccessToken: 'secret', discordExpiresIn: 3600,
    });
    await store.deleteDashboardSession(created.id);
    expect(await store.getDashboardSession(created.id)).toBeNull();
  });

  test('parses both production and development cookie names', () => {
    expect(store.sessionIdFromCookieHeader('__Host-kotbo_session=prod; other=1')).toBe('prod');
    expect(store.sessionIdFromCookieHeader('kotbo_session=dev')).toBe('dev');
    expect(store.sessionIdFromCookieHeader(undefined)).toBeNull();
  });
});
