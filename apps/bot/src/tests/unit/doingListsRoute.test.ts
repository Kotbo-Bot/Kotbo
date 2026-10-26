/**
 * Listes de suivi : un élément ne s'épingle que depuis un module relié à la
 * liste et seulement s'il appartient au serveur, et l'écriture suit le droit
 * de la section, pas le seul droit de configuration.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

let listRow: { id: string; guildId: string; name: string; modules: string[] } | null = null;
let ticketRow: { reason: string; username: string } | null = null;
let featureRights: Record<string, { canView: boolean; canModerate: boolean; canConfigure: boolean; canDelete: boolean }> = {};

const createItem = mock(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'item-1', ...data }));
const mockDb = {
  doingList: { findFirst: mock(async () => listRow) },
  doingListItem: {
    count: mock(async () => 0),
    findFirst: mock(async () => null),
    create: createItem,
  },
  ticket: { findFirst: mock(async () => ticketRow) },
  suggestion: { findFirst: mock(async () => null) },
  dashboardAuditLog: { create: mock(async () => ({})) },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const featureGatePath = path.resolve(__dirname, '../../api/routes/dashboard/featureGate.ts');
for (const suffix of ['../../api/routes/dashboard/featureGate.ts', '../../api/routes/dashboard/featureGate.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(featureGatePath, {
    getCachedFeatureAccess: mock(async () => featureRights),
  }));
}

const { handleDoingListRoutes } = await import('../../api/routes/dashboard/doingLists.js');

function request(method: string, body: Record<string, unknown>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

function response(): ServerResponse & { body: string } {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as ServerResponse & { body: string };
  res.setHeader = () => res;
  res.writeHead = (code: number) => { res.statusCode = code; return res; };
  res.end = (chunk?: unknown) => { res.body = chunk ? String(chunk) : ''; return res; };
  return res;
}

const client = { guilds: { cache: new Map() } } as unknown as Client;
const user: AuthClaims = { userId: 'user-1', username: 'Staff' };
const moderatorAccess = { ...DASHBOARD_ACCESS_ADMIN, canManageSettings: false } as DashboardAccess;
const itemsPath = ['api', 'dashboard', 'guilds', 'guild-1', 'doing-lists', 'list-1', 'items'];
const pin = { sourceModule: 'tickets', sourceId: 'ticket-1' };

async function call(access: DashboardAccess, body: Record<string, unknown>) {
  const res = response();
  await handleDoingListRoutes(request('POST', body), res, itemsPath, new URL('http://x'), client, user, 'guild-1', access);
  return res;
}

beforeEach(() => {
  listRow = { id: 'list-1', guildId: 'guild-1', name: 'Projet', modules: ['tickets'] };
  ticketRow = { reason: 'Bug boutique', username: 'alice' };
  featureRights = {};
  createItem.mockClear();
});

describe('épingler un élément', () => {
  test("reprend le titre de la source et l'épingle", async () => {
    const res = await call(DASHBOARD_ACCESS_ADMIN, pin);
    expect(res.statusCode).toBe(201);
    expect(createItem.mock.calls[0][0].data).toMatchObject({ title: 'Bug boutique (alice)', sourceModule: 'tickets', sourceId: 'ticket-1' });
  });

  test("refuse un module que la liste ne relie pas", async () => {
    listRow = { ...listRow!, modules: ['suggestions'] };
    expect((await call(DASHBOARD_ACCESS_ADMIN, pin)).statusCode).toBe(400);
    expect(createItem).not.toHaveBeenCalled();
  });

  test("refuse un ticket d'un autre serveur", async () => {
    ticketRow = null;
    expect((await call(DASHBOARD_ACCESS_ADMIN, pin)).statusCode).toBe(404);
    expect(createItem).not.toHaveBeenCalled();
  });
});

describe('droits', () => {
  test('un modérateur de la section peut épingler sans droit de configuration', async () => {
    featureRights = { doing_lists: { canView: true, canModerate: true, canConfigure: false, canDelete: false } };
    expect((await call(moderatorAccess, pin)).statusCode).toBe(201);
  });

  test('un simple lecteur ne peut pas', async () => {
    featureRights = { doing_lists: { canView: true, canModerate: false, canConfigure: false, canDelete: false } };
    expect((await call(moderatorAccess, pin)).statusCode).toBe(403);
    expect(createItem).not.toHaveBeenCalled();
  });
});
