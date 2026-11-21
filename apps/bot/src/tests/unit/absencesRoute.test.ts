/**
 * Décision d'une absence depuis le planning : la garde globale laisse passer le
 * PATCH au staff (voir guildGateStaffActions), la route tranche le droit exact.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import {
  DASHBOARD_ACCESS_ADMIN,
  DASHBOARD_ACCESS_MODERATOR,
  DASHBOARD_ACCESS_STAFF_VIEWER,
  type AuthClaims,
  type DashboardAccess,
  type FeatureAccess,
  type FeatureAccessMap,
} from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

const GUILD = '100000000000000001';
const ABSENCE = 'absence-1';
const user: AuthClaims = { userId: '200000000000000001', username: 'Responsable' };

const VIEW_ONLY: FeatureAccess = { canView: true, canModerate: false, canConfigure: false, canDelete: false };
const MODERATE: FeatureAccess = { canView: true, canModerate: true, canConfigure: false, canDelete: false };
const CONFIGURE: FeatureAccess = { canView: true, canModerate: false, canConfigure: true, canDelete: false };

let featureRights: FeatureAccessMap = {};
const updateAbsenceStatus = mock(
  async (_guildId: string, absenceId: string, status: string, _decidedById: string, _note?: string) => ({ id: absenceId, status }),
);
const auditWrites = mock(async (_args: unknown) => ({}));

const mockDb = {
  staffAbsence: { findFirst: mock(async () => ({ id: ABSENCE })) },
  dashboardAuditLog: { create: auditWrites },
};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(import.meta.dir, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relative}.ts`);
  for (const ext of ['ts', 'js']) {
    mock.module(path.resolve(import.meta.dir, `${relative}.${ext}`), () => completeModuleMock(source, overrides));
  }
}
mockModule('../../api/routes/dashboard/featureGate', { getCachedFeatureAccess: mock(async () => featureRights) });
mockModule('../../services/staff/staffLeadershipService', { updateAbsenceStatus });
mockModule('../../utils/cache', { cache: { invalidateGuild: async () => {} } });

// Session et garde serveur simulées : seule la route est testée ici.
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, user);
const { createAbsencesRouter } = await import('../../api/routes/dashboard/leadership/absences.js');

const client = { guilds: { cache: new Map() } } as unknown as Client;

async function decide(access: DashboardAccess, rights: FeatureAccessMap) {
  featureRights = rights;
  setDashboardAccess(access, user);
  return dashboardCall(createAbsencesRouter(client), 'PATCH', `/api/dashboard/guilds/${GUILD}/absences/${ABSENCE}`, {
    status: 'APPROVED',
    note: 'Bon rétablissement',
  });
}

beforeEach(() => {
  updateAbsenceStatus.mockClear();
  auditWrites.mockClear();
});

describe("décision d'une absence", () => {
  test("un membre du staff sans « Modérer » ni « Configurer » sur Absences ne décide pas d'une absence", async () => {
    for (const [access, rights] of [
      [DASHBOARD_ACCESS_STAFF_VIEWER, {}],
      [DASHBOARD_ACCESS_STAFF_VIEWER, { absences: VIEW_ONLY }],
      // Modérateur Discord dont le rôle n'a que la lecture de la section.
      [DASHBOARD_ACCESS_MODERATOR, { absences: VIEW_ONLY }],
    ] as const) {
      const { status, body } = await decide(access, rights);
      expect(status).toBe(403);
      expect(body).toEqual({ error: "Accès refusé. Décision d'absence non autorisée." });
    }
    expect(updateAbsenceStatus).not.toHaveBeenCalled();
    expect(auditWrites).not.toHaveBeenCalled();
  });

  test('« Modérer » ou « Configurer » sur Absences suffit pour décider', async () => {
    for (const rights of [MODERATE, CONFIGURE]) {
      const { status, body } = await decide(DASHBOARD_ACCESS_STAFF_VIEWER, { absences: rights });
      expect(status).toBe(200);
      expect(body).toEqual({ absence: { id: ABSENCE, status: 'APPROVED' } });
    }
    expect(updateAbsenceStatus).toHaveBeenCalledTimes(2);
    expect(updateAbsenceStatus.mock.calls[0]).toEqual([GUILD, ABSENCE, 'APPROVED', user.userId, 'Bon rétablissement']);
  });

  test('un administrateur du dashboard décide sans règle de rôle', async () => {
    const { status } = await decide(DASHBOARD_ACCESS_ADMIN, {});
    expect(status).toBe(200);
    expect(updateAbsenceStatus).toHaveBeenCalledTimes(1);
  });
});
