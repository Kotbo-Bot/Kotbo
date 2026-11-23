import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import type { Client, EmbedBuilder } from 'discord.js';
import { dashboardCall, mockDashboardGate } from '../helpers/honoDashboard.js';

const ADMIN_ID = '700000000000000001';
const mockDb = {
  globalAdmin: { findMany: mock(async () => [{ userId: ADMIN_ID }]) },
  feedback: { create: mock(async () => ({ id: 'ckfeedback0000000000001' })) },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { DASHBOARD_ACCESS_ADMIN } = await import('../../api/shared.js');
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: '700000000000000002', username: 'Membre' });
const { createReportFeedbackRouter } = await import('../../api/routes/feedback.js');

describe('retour envoyé depuis le dashboard', () => {
  test('un message de plus de 1024 caractères parvient en entier aux administrateurs', async () => {
    const send = mock(async (_message: { embeds: EmbedBuilder[] }) => ({}));
    const client = { users: { fetch: async () => ({ send }) } } as unknown as Client;
    const message = 'Le bouton Enregistrer ne répond plus sur la page des paramètres. '.repeat(30).slice(0, 1500);

    const { status, body } = await dashboardCall(createReportFeedbackRouter(client), 'POST', '/api/report-feedback', {
      type: 'bloquage',
      message,
      url: 'https://kotbo.fr/dashboard/parametres',
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    const embed = send.mock.calls[0]![0].embeds[0]!.toJSON();
    expect(embed.description).toContain(message);
  });
});
