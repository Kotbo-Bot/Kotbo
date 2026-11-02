import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims } from '../../api/shared.js';

/**
 * Journal des actions du staff sur la route des paramètres globaux.
 *
 * Le dashboard renvoie les favoris de la barre latérale à chaque changement de serveur :
 * ce n'est qu'une préférence d'interface, et la journaliser remplissait les actions du
 * staff de « Sauvegarde paramètres globaux » que personne n'avait faites.
 */

const GUILD = '100000000000000000';

const auditCreate = mock(async () => ({}));
const mockDb = {
  guild: { findUnique: mock(async () => null), update: mock(async () => ({})) },
  dashboardSettings: { upsert: mock(async () => ({})), update: mock(async () => ({})) },
  dashboardFeatureConfig: { upsert: mock(async () => ({})) },
  dashboardAuditLog: { create: auditCreate },
};

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

// Import après les mocks
const { handleSettingsRoutes } = await import('../../api/routes/dashboard/modules/settings.js');

function createMockRequest(body: Record<string, unknown>): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = 'PUT';
  req.url = `/api/dashboard/guilds/${GUILD}/settings`;
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

interface MockResponse extends ServerResponse {
  body: string;
}

function createMockResponse(): MockResponse {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket)) as MockResponse;

  let _statusCode = 200;
  let _body = '';

  Object.defineProperty(res, 'statusCode', {
    get: () => _statusCode,
    set: (code: number) => { _statusCode = code; },
  });

  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (statusCode: number) => { _statusCode = statusCode; return res; };
  res.end = (chunk?: unknown) => {
    if (chunk) _body += String(chunk);
    res.body = _body;
    return res;
  };

  return res;
}

async function putSettings(body: Record<string, unknown>) {
  const req = createMockRequest(body);
  const res = createMockResponse();
  const url = new URL(`http://localhost${req.url}`);

  await handleSettingsRoutes({
    req,
    res,
    parts: url.pathname.split('/').filter(Boolean),
    url,
    client: { guilds: { cache: new Map() } } as unknown as Client,
    user: { userId: '200000000000000000', username: 'Tojii' } as AuthClaims,
    guildId: GUILD,
    access: DASHBOARD_ACCESS_ADMIN,
    method: 'PUT',
    auditUser: 'Tojii',
    moduleKey: 'settings',
  });

  return res;
}

beforeEach(() => {
  auditCreate.mockClear();
});

describe('PUT /settings et journal des actions du staff', () => {
  test('les seuls favoris de la barre latérale ne créent aucune ligne d\'audit', async () => {
    const res = await putSettings({ sidebarFavorites: ['/overview', '/logs'] });

    expect(res.statusCode).toBe(200);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  test('une vraie sauvegarde des paramètres reste journalisée', async () => {
    const res = await putSettings({ messageTemplate: 'Bonjour {user}' });

    expect(res.statusCode).toBe(200);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0]).toMatchObject([
      { data: { guildId: GUILD, user: 'Tojii', action: 'Sauvegarde paramètres globaux' } },
    ]);
  });
});
