import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

/**
 * `GET /channel-links/other-guilds` cherchait le membre dans chaque serveur du
 * bot, avec un appel Discord par serveur ou il n'etait pas en cache : la page
 * ralentissait a mesure que le bot rejoignait des serveurs. Elle se limite aux
 * serveurs que la liste OAuth du compte declare.
 */

const GUILD = '100000000000000000';
const VIEWER = '200000000000000000';
const OTHER_GUILDS = ['100000000000000001', '100000000000000002', '100000000000000003'];

let oauthGuildIds: string[] | null = null;
const userRoutesPath = path.resolve(__dirname, '../../api/routes/user.ts');
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(__dirname, `../../api/routes/user.${ext}`), () =>
    completeModuleMock(userRoutesPath, {
      fetchOAuthGuilds: async () => {
        if (!oauthGuildIds) throw new Error('Discord guilds API: 401');
        return oauthGuildIds.map((id) => ({ id, name: id, icon: null, owner: false, permissions: '0' }));
      },
    }));
}

const featureGatePath = path.resolve(__dirname, '../../api/routes/dashboard/featureGate.ts');
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(__dirname, `../../api/routes/dashboard/featureGate.${ext}`), () =>
    completeModuleMock(featureGatePath, { getCachedFeatureAccess: async () => ({}) }));
}

mockDashboardGate(DASHBOARD_ACCESS_ADMIN,{ userId: VIEWER, username: 'viewer', discordToken: 'token' });
const { createChannelLinksRouter } = await import('../../api/routes/dashboard/channelLinks.js');

const fetchedGuildIds: string[] = [];

function fakeGuild(id: string) {
  const admin = { permissions: { has: () => true } };
  return {
    id,
    name: `Serveur ${id}`,
    iconURL: () => null,
    channels: { cache: { filter: () => ({ map: () => [] }) } },
    members: {
      cache: new Map(),
      fetch: async () => {
        fetchedGuildIds.push(id);
        return admin;
      },
    },
  };
}

const client = {
  guilds: { cache: new Map([GUILD, ...OTHER_GUILDS].map((id) => [id, fakeGuild(id)])) },
} as unknown as Client;
const user: AuthClaims = { userId: VIEWER, username: 'viewer', discordToken: 'token' };

async function readOtherGuilds() {
  return dashboardCall(createChannelLinksRouter(client), 'GET', `/api/dashboard/guilds/${GUILD}/channel-links/other-guilds`);
}

describe('GET /channel-links/other-guilds', () => {
  beforeEach(() => {
    fetchedGuildIds.length = 0;
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, user);
  });

  test('ne cherche le membre que dans les serveurs de son compte', async () => {
    oauthGuildIds = [OTHER_GUILDS[1]];
    const { status, body } = await readOtherGuilds();

    expect(status).toBe(200);
    expect(fetchedGuildIds).toEqual([OTHER_GUILDS[1]]);
    expect(body.map((guild: { id: string }) => guild.id)).toEqual([OTHER_GUILDS[1]]);
  });

  test('sans liste OAuth, retombe sur tous les serveurs du bot', async () => {
    oauthGuildIds = null;
    const { status } = await readOtherGuilds();

    expect(status).toBe(200);
    expect(fetchedGuildIds.sort()).toEqual([GUILD, ...OTHER_GUILDS].sort());
  });
});
