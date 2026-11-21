import { beforeEach, describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import { PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

const GUILD = '900000000000000001';
const ADMIN = { userId: '900000000000000003', username: 'Admin' };
// Gérer le serveur : administrateur du dashboard, sans la permission Administrateur.
const GERANT = { userId: '900000000000000005', username: 'Gérant' };

const backups: Record<string, Record<string, unknown>> = {
  'sauvegarde-du-serveur': {
    guildId: GUILD,
    name: 'Avant refonte',
    createdByUsername: 'Admin',
    createdAt: new Date('2026-11-01T10:00:00Z'),
    data: { roles: [], channels: [] },
    includeRoles: true,
    includeChannels: true,
    includeMembers: false,
    includeEmojis: true,
    includeStickers: false,
    includeMessages: false,
  },
  'sauvegarde-d-un-autre-serveur': { guildId: '900000000000000002' },
};

const auditCreate = mock(async (_args: { data: Record<string, unknown> }) => ({}));
const mockDb = {
  serverBackup: { findUnique: mock(async ({ where }: { where: { id: string } }) => backups[where.id] ?? null) },
  dashboardAuditLog: { create: auditCreate },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const restoreBackup = mock(async (_guild: unknown, _data: unknown, _options: unknown) => {});
let restoreRunning = false;
const restoreServicePath = path.resolve(import.meta.dir, '../../services/system/restoreService.ts');
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../services/system/restoreService.${ext}`), () =>
    completeModuleMock(restoreServicePath, { restoreBackup, isRestoringBackup: () => restoreRunning }));
}

const { DASHBOARD_ACCESS_ADMIN, DASHBOARD_ACCESS_MODERATOR } = await import('../../api/shared.js');
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, ADMIN);
const { createBackupsRouter } = await import('../../api/routes/dashboard/backups.js');

const permissions: Record<string, bigint> = {
  [ADMIN.userId]: PermissionFlagsBits.Administrator,
  [GERANT.userId]: PermissionFlagsBits.ManageGuild,
};
const guild = { id: GUILD, members: { fetch: async (id: string) => ({ permissions: new PermissionsBitField(permissions[id]) }) } };
const router = createBackupsRouter({ guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client);
const restaurer = (backupId: string) =>
  dashboardCall(router, 'POST', `/api/dashboard/guilds/${GUILD}/backups/${backupId}/restore`);

beforeEach(() => {
  restoreBackup.mockClear();
  auditCreate.mockClear();
  setDashboardAccess(DASHBOARD_ACCESS_ADMIN, ADMIN);
  restoreRunning = false;
});

describe('restauration d’une sauvegarde depuis le dashboard', () => {
  test('lance la restauration en écrasant l’existant, sans l’attendre, et la journalise une fois finie', async () => {
    const { status, body } = await restaurer('sauvegarde-du-serveur');
    await Bun.sleep(0);

    expect(status).toBe(202);
    expect(body).toEqual({ started: true });
    expect(restoreBackup.mock.calls).toEqual([[guild, { roles: [], channels: [] }, {
      fullRestore: true,
      includeRoles: true,
      includeChannels: true,
      includeMembers: false,
      includeEmojis: true,
      includeStickers: false,
      includeMessages: false,
      includeKotbo: true,
      conflictResolution: 'replace',
    }]]);
    expect(auditCreate.mock.calls.map(([args]) => [args.data.guildId, args.data.action, args.data.context])).toEqual([
      [GUILD, 'Restauration sauvegarde', 'Avant refonte'],
    ]);
  });

  test('refuse la sauvegarde d’un autre serveur, et toute restauration sans droit de configuration', async () => {
    const autreServeur = await restaurer('sauvegarde-d-un-autre-serveur');
    expect(autreServeur.status).toBe(403);

    setDashboardAccess(DASHBOARD_ACCESS_MODERATOR, { userId: '900000000000000004', username: 'Modo' });
    const moderateur = await restaurer('sauvegarde-du-serveur');
    expect(moderateur.status).toBe(403);

    expect(restoreBackup).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  test('refuse un gérant sans la permission Administrateur : un import forgé lui donnerait un rôle admin', async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, GERANT);
    expect((await restaurer('sauvegarde-du-serveur')).status).toBe(403);
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  test('refuse une seconde restauration tant que la première tourne', async () => {
    restoreRunning = true;
    expect((await restaurer('sauvegarde-du-serveur')).status).toBe(409);
    expect(restoreBackup).not.toHaveBeenCalled();
  });
});
