import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN } from '../../api/shared.js';
import { dashboardCall, mockDashboardGate } from '../helpers/honoDashboard.js';

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
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: '200000000000000000', username: 'Tojii' });
const { createSettingsRouter } = await import('../../api/routes/dashboard/modules/settings.js');

async function putSettings(body: Record<string, unknown>) {
  const client = { guilds: { cache: new Map() } } as unknown as Client;
  const { status, body: json } = await dashboardCall(createSettingsRouter(client), 'PUT', `/api/dashboard/guilds/${GUILD}/settings`, body);
  return { statusCode: status, body: JSON.stringify(json) };
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
