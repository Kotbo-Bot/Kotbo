import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

/**
 * Page Comptes suspects (issue #788) : la liste lancait l'analyse profonde
 * (messages, vocal, technique) de chaque suspect, tous en parallele. Passe une
 * vingtaine de suspects, la reponse depassait le delai du dashboard et la page
 * affichait « Aucune detection ». La liste se contente des preuves legeres ;
 * l'analyse complete se lit suspect par suspect.
 */

const GUILD = '100000000000000000';
const VIEWER = '200000000000000000';
const SUSPECTS = ['300000000000000001', '300000000000000002'];

const suspectRows = SUSPECTS.map((userId) => ({
  userId, username: `user${userId.slice(-1)}`, displayName: null, userTag: null, avatarUrl: null,
  isBot: false, accountCreatedAt: null, guildJoinedAt: null, guildLeftAt: null, lastSeenAt: null,
  messageCount: 0, isSuspectedDC: true,
}));

const mockDb = new Proxy({}, {
  get: (_, model) => model === 'then'
    ? undefined
    : new Proxy({}, {
      get: (__, method) => async (args?: { where?: { isSuspectedDC?: boolean } }) => {
        if (model === 'memberProfile' && method === 'findMany') {
          return args?.where?.isSuspectedDC ? suspectRows : [];
        }
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

const evidenceCalls: Array<{ userId: string; deep: boolean | undefined }> = [];
let evidenceResult: unknown = null;
const dcServicePath = path.resolve(__dirname, '../../services/moderation/dcDetectionService.ts');
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(__dirname, `../../services/moderation/dcDetectionService.${ext}`), () =>
    completeModuleMock(dcServicePath, {
      getDetectionEvidence: async (_guildId: string, userId: string, options?: { deep?: boolean }) => {
        evidenceCalls.push({ userId, deep: options?.deep });
        return evidenceResult;
      },
    }));
}

const featureGatePath = path.resolve(__dirname, '../../api/routes/dashboard/featureGate.ts');
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(__dirname, `../../api/routes/dashboard/featureGate.${ext}`), () =>
    completeModuleMock(featureGatePath, { getCachedFeatureAccess: async () => ({}) }));
}

mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: VIEWER, username: 'viewer' });
const { createMembersRouter } = await import('../../api/routes/dashboard/members.js');

const client = { guilds: { cache: new Map() } } as unknown as Client;
const user: AuthClaims = { userId: VIEWER, username: 'viewer' };

const fullEvidence = {
  userId: SUSPECTS[0],
  reasons: [{ type: 'stylometry', label: 'Style proche', score: 35, matchedUserId: SUSPECTS[1] }],
  suspectedAlts: [SUSPECTS[1]],
  totalScore: 35,
  detectedAt: new Date(0).toISOString(),
};

describe('GET /detections', () => {
  beforeEach(() => {
    evidenceCalls.length = 0;
    evidenceResult = null;
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, user);
  });

  test("liste chaque suspect sans lancer l'analyse profonde", async () => {
    const { status, body } = await dashboardCall(createMembersRouter(client), 'GET', `/api/dashboard/guilds/${GUILD}/detections`);

    expect(status).toBe(200);
    expect(body.detections.map((d: { id: string }) => d.id)).toEqual(SUSPECTS);
    expect(evidenceCalls).toEqual(SUSPECTS.map((userId) => ({ userId, deep: false })));
  });

  test("le detail d'un suspect rend l'analyse complete", async () => {
    evidenceResult = fullEvidence;
    const { status, body } = await dashboardCall(createMembersRouter(client), 'GET', `/api/dashboard/guilds/${GUILD}/detections/${SUSPECTS[0]}`);

    expect(status).toBe(200);
    expect(evidenceCalls).toEqual([{ userId: SUSPECTS[0], deep: undefined }]);
    expect(body.evidence).toEqual({ reasons: fullEvidence.reasons, totalScore: 35 });
    expect(body.suspectedAlts.map((a: { userId: string }) => a.userId)).toEqual([SUSPECTS[1]]);
  });

  test("le detail d'un membre qui n'est plus suspect repond 404", async () => {
    const { status } = await dashboardCall(createMembersRouter(client), 'GET', `/api/dashboard/guilds/${GUILD}/detections/${SUSPECTS[0]}`);

    expect(status).toBe(404);
  });
});
