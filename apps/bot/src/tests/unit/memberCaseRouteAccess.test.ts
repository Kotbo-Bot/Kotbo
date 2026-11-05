import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import {
  DASHBOARD_ACCESS_ADMIN,
  DASHBOARD_ACCESS_MODERATOR,
  type AuthClaims,
  type DashboardAccess,
  type FeatureAccessMap,
} from '../../api/shared.js';

/**
 * Lecture de la fiche membre : `GET /members/:userId`.
 *
 * Le dashboard ouvre cette fiche d'un clic sur un pseudo depuis une vingtaine de pages, et
 * n'y masque le clic qu'avec `memberCaseModal.canOpen`. Ce masquage n'est qu'un confort :
 * la barrière est ici. Un rôle à qui le centre de gestion ferme « Membres » doit recevoir
 * un refus avant que la moindre donnée du membre soit lue.
 *
 * Ne pas mocker `../../api/shared` ni `../../utils/logger` ici : `mock.module` est global au
 * process, et le mock fuiterait dans les autres fichiers de test.
 */

const GUILD = '100000000000000000';
const VIEWER = '200000000000000000';
const TARGET = '300000000000000000';

/** Chaque appel à la base, sous la forme `modele.methode`. */
const dbCalls: string[] = [];
const mockDb = new Proxy({}, {
  get: (_, model) => model === 'then'
    ? undefined
    : new Proxy({}, {
      get: (__, method) => async () => {
        dbCalls.push(`${String(model)}.${String(method)}`);
        return null;
      },
    }),
});

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

// Import après les mocks
const { handleMembersRoutes } = await import('../../api/routes/dashboard/members.js');

interface MockResponse extends ServerResponse {
  body: string;
}

function createMockResponse(): MockResponse {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as MockResponse;
  let statusCode = 200;
  let body = '';

  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (code: number) => { statusCode = code; },
  });

  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (code: number) => { statusCode = code; return res; };
  res.end = (chunk?: unknown) => {
    if (chunk) body += String(chunk);
    res.body = body;
    return res;
  };

  return res;
}

const client = { guilds: { cache: new Map() } } as unknown as Client;
const user: AuthClaims = { userId: VIEWER, username: 'viewer' };

async function readMemberCase(access: DashboardAccess, featureAccess: FeatureAccessMap) {
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  req.url = `/api/dashboard/guilds/${GUILD}/members/${TARGET}`;
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const res = createMockResponse();

  const handled = await handleMembersRoutes(req, res, parts, url, client, user, GUILD, access, featureAccess);
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const MEMBERS_CLOSED: FeatureAccessMap = {
  members: { canView: false, canModerate: false, canConfigure: false, canDelete: false },
};

describe('GET /members/:userId', () => {
  beforeEach(() => {
    dbCalls.length = 0;
  });

  test('refuse la fiche à un modérateur à qui « Membres » est fermé, sans lire la base', async () => {
    const { handled, status, body } = await readMemberCase(DASHBOARD_ACCESS_MODERATOR, MEMBERS_CLOSED);

    expect(handled).toBe(true);
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: 'feature_denied', featureKey: 'members' });
    expect(dbCalls).toEqual([]);
  });

  test("ne refuse pas la fiche à qui gère les réglages, même sans l'entrée « Membres »", async () => {
    // La fiche se construit ensuite sur une base vide : seul compte ici que le refus d'accès
    // ne tombe pas, le statut qui suit dépend de cette construction.
    const { body } = await readMemberCase(DASHBOARD_ACCESS_ADMIN, MEMBERS_CLOSED);

    expect(body?.code).not.toBe('feature_denied');
  });
});
