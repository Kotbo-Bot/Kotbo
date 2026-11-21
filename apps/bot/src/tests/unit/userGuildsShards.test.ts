import { afterEach, describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import type { AuthClaims } from '../../api/shared.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

/**
 * L'API ne tourne que sur le fragment 0 : son `client.guilds.cache` ignore les
 * serveurs des autres fragments. La liste des serveurs du dashboard doit
 * pourtant les montrer, à leurs membres comme aux administrateurs globaux.
 */

const ADMIN_GLOBAL = '800000000000000001';
const MEMBRE = '800000000000000002';
const SERVEUR_FRAGMENT_0 = '800000000000000010';
const SERVEUR_FRAGMENT_1 = '800000000000000011';

const mockDb = {
  staffServerLink: { findMany: mock(async () => []) },
  guild: { findMany: mock(async () => []) },
  globalAdmin: {
    findUnique: mock(async ({ where }: { where: { userId: string } }) => (where.userId === ADMIN_GLOBAL ? { userId: ADMIN_GLOBAL } : null)),
  },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { DASHBOARD_ACCESS_ADMIN } = await import('../../api/shared.js');
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: MEMBRE, username: 'Membre' });
const { createUserRouter, clearOAuthGuildsCache } = await import('../../api/routes/user.js');
const { activatedGuilds } = await import('../../utils/activation.js');

// Chaque fragment ne connaît que ses propres serveurs ; le client de l'API est le fragment 0.
const fragments = [
  new Map([[SERVEUR_FRAGMENT_0, { id: SERVEUR_FRAGMENT_0, name: 'Serveur du fragment 0', icon: null, ownerId: '1' }]]),
  new Map([[SERVEUR_FRAGMENT_1, { id: SERVEUR_FRAGMENT_1, name: 'Serveur du fragment 1', icon: 'icone-1', ownerId: '1' }]]),
];
const client = {
  guilds: { cache: fragments[0] },
  shard: {
    broadcastEval: async (
      script: (shardClient: unknown, context: unknown) => unknown,
      options?: { context?: unknown },
    ) => Promise.all(fragments.map((cache) => script({ guilds: { cache } }, options?.context))),
  },
} as unknown as Client;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOAuthGuildsCache();
});

describe('GET /api/user/guilds sur un bot fragmenté', () => {
  test('un administrateur d’un serveur hébergé par un autre fragment le retrouve dans sa liste', async () => {
    activatedGuilds.add(SERVEUR_FRAGMENT_1);
    // Liste OAuth de la personne : administratrice du seul serveur du fragment 1.
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: SERVEUR_FRAGMENT_1, name: 'Serveur du fragment 1', icon: null, owner: false, permissions: '8' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: MEMBRE, username: 'Membre', discordAccessToken: 'jeton-membre' } as AuthClaims);

    const { status, body } = await dashboardCall(createUserRouter(client), 'GET', '/api/user/guilds');

    expect(status).toBe(200);
    expect(body.guilds).toEqual([
      expect.objectContaining({ id: SERVEUR_FRAGMENT_1, name: 'Serveur du fragment 1', botPresent: true, accessLevel: 'admin' }),
    ]);
  });

  test('un administrateur global voit les serveurs de tous les fragments, avec leur nom', async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: ADMIN_GLOBAL, username: 'Admin global' });

    const { status, body } = await dashboardCall(createUserRouter(client), 'GET', '/api/user/guilds');

    expect(status).toBe(200);
    expect(body.guilds.map((guild: { id: string; name: string; icon: string | null }) => [guild.id, guild.name, guild.icon])).toEqual([
      [SERVEUR_FRAGMENT_0, 'Serveur du fragment 0', null],
      [SERVEUR_FRAGMENT_1, 'Serveur du fragment 1', 'icone-1'],
    ]);
  });
});
