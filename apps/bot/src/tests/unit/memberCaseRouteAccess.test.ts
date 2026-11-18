import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import {
  DASHBOARD_ACCESS_ADMIN,
  DASHBOARD_ACCESS_MODERATOR,
  type AuthClaims,
  type DashboardAccess,
  type FeatureAccessMap,
} from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

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

// La carte des droits par section vient du test, sans base ni Discord.
let currentFeatureAccess: FeatureAccessMap = {};
const featureGatePath = path.resolve(__dirname, '../../api/routes/dashboard/featureGate.ts');
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(__dirname, `../../api/routes/dashboard/featureGate.${ext}`), () =>
    completeModuleMock(featureGatePath, { getCachedFeatureAccess: async () => currentFeatureAccess }));
}

// Import après les mocks
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: VIEWER, username: 'viewer' });
const { createMembersRouter } = await import('../../api/routes/dashboard/members.js');

const client = { guilds: { cache: new Map() } } as unknown as Client;
const user: AuthClaims = { userId: VIEWER, username: 'viewer' };

async function readMemberCase(access: DashboardAccess, featureAccess: FeatureAccessMap) {
  setDashboardAccess(access, user);
  currentFeatureAccess = featureAccess;
  const { status, body } = await dashboardCall(createMembersRouter(client), 'GET', `/api/dashboard/guilds/${GUILD}/members/${TARGET}`);
  return { handled: status !== 404 || body?.error !== 'Route introuvable', status, body };
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
