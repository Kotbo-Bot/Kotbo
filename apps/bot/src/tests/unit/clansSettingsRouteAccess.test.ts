// La garde laisse la page Niveaux écrire `PATCH /clans` (voir guildGateFeatureWrite) :
// la route ne lui ouvre que le bonus d'XP du clan vainqueur.
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_MODERATOR, type FeatureAccess, type FeatureAccessMap } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate } from '../helpers/honoDashboard.js';

const GUILD = '100000000000000001';
const FULL: FeatureAccess = { canView: true, canModerate: true, canConfigure: true, canDelete: true };
let featureRights: FeatureAccessMap = {};

// Toute lecture ou écriture Prisma réussit : seule la décision d'accès est testée.
const anyModel = new Proxy({}, { get: () => mock(async () => ({})) });
const mockDb = new Proxy({}, { get: (_target, key) => (key === '$transaction' ? async (ops: unknown) => ops : anyModel) });
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}
const featureGate = path.resolve(import.meta.dir, '../../api/routes/dashboard/featureGate.ts');
for (const ext of ['ts', 'js']) {
  mock.module(featureGate.replace(/\.ts$/, `.${ext}`), () => completeModuleMock(featureGate, { getCachedFeatureAccess: mock(async () => featureRights) }));
}

mockDashboardGate(DASHBOARD_ACCESS_MODERATOR, { userId: '200000000000000001', username: 'Niveaux' });
const { createClansRouter } = await import('../../api/routes/dashboard/clans.js');
const router = createClansRouter({ guilds: { cache: new Map() } } as unknown as Client);
const patch = (body: object) => dashboardCall(router, 'PATCH', `/api/dashboard/guilds/${GUILD}/clans`, body);

describe('réglages des clans depuis la page Niveaux', () => {
  test('le droit Niveaux seul ne règle que le bonus d\'XP du clan vainqueur', async () => {
    featureRights = { leveling: FULL };
    expect((await patch({ clanRewardXpBoost: true, clanRewardXpBoostRate: 1.5 })).status).not.toBe(403);
    expect((await patch({ clanRewardXpBoost: true, clanXpPerBoost: 50 })).status).toBe(403);
  });

  test('le droit Clans règle tout', async () => {
    featureRights = { clans: FULL };
    expect((await patch({ clanXpPerBoost: 50 })).status).not.toBe(403);
  });
});
