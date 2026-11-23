import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { dashboardCall, mockDashboardGate, setDashboardAccess } from '../helpers/honoDashboard.js';

const ADMIN_ID = '700000000000000001';
const AUTEUR_ID = '700000000000000002';
const AUTRE_ID = '700000000000000003';
const FEEDBACK_ID = 'ckfeedback0000000000001';

const retour = { id: FEEDBACK_ID, userId: AUTEUR_ID, username: 'Auteur', type: 'suggestion', message: 'Ajoutez un mode sombre', status: 'NEW' };
const mockDb = {
  globalAdmin: {
    findMany: mock(async () => [{ userId: ADMIN_ID }]),
    findUnique: mock(async ({ where }: { where: { userId: string } }) => (where.userId === ADMIN_ID ? { userId: ADMIN_ID } : null)),
  },
  feedback: {
    findUnique: mock(async () => ({ ...retour })),
    update: mock(async ({ data }: { data: { status?: string } }) => ({ ...retour, ...data })),
  },
  feedbackMessage: { create: mock(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm1', ...data })) },
  adminAuditLog: { create: mock(async () => ({})) },
};
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { DASHBOARD_ACCESS_ADMIN } = await import('../../api/shared.js');
mockDashboardGate(DASHBOARD_ACCESS_ADMIN, { userId: AUTEUR_ID, username: 'Auteur' });
const { createReportFeedbackRouter } = await import('../../api/routes/feedback.js');
const { cleanFeedbackText, canAccessFeedback, isFeedbackStatus } = await import('../../services/system/feedbackService.js');

const dms: Array<{ to: string; embed: { toJSON(): { title?: string } } }> = [];
const client = {
  users: { fetch: async (id: string) => ({ send: async (msg: { embeds: Array<{ toJSON(): { title?: string } }> }) => { dms.push({ to: id, embed: msg.embeds[0]! }); } }) },
} as unknown as Client;
const router = createReportFeedbackRouter(client);

beforeEach(() => {
  dms.length = 0;
  mockDb.feedbackMessage.create.mockClear();
  mockDb.feedback.update.mockClear();
});

describe('règles du suivi des retours', () => {
  test('seul un statut connu est accepté', () => {
    expect(isFeedbackStatus('PLANNED')).toBe(true);
    expect(isFeedbackStatus('planned')).toBe(false);
    expect(isFeedbackStatus(undefined)).toBe(false);
  });

  test('un message vide ou trop long est rogné ou refusé', () => {
    expect(cleanFeedbackText('   ')).toBeNull();
    expect(cleanFeedbackText(42)).toBeNull();
    expect(cleanFeedbackText('a'.repeat(5000))).toHaveLength(2000);
  });

  test("l'auteur et les admins accèdent au retour, personne d'autre", () => {
    expect(canAccessFeedback({ userId: AUTEUR_ID }, AUTEUR_ID, false)).toBe(true);
    expect(canAccessFeedback({ userId: AUTEUR_ID }, AUTRE_ID, true)).toBe(true);
    expect(canAccessFeedback({ userId: AUTEUR_ID }, AUTRE_ID, false)).toBe(false);
  });
});

describe('conversation sur un retour', () => {
  test("un autre membre ne voit pas le retour d'autrui (404, pas 403)", async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: AUTRE_ID, username: 'Autre' });
    const { status } = await dashboardCall(router, 'GET', `/api/feedback/${FEEDBACK_ID}`);
    expect(status).toBe(404);
  });

  test("l'auteur répond et les admins sont prévenus", async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: AUTEUR_ID, username: 'Auteur' });
    const { status, body } = await dashboardCall(router, 'POST', `/api/feedback/${FEEDBACK_ID}/messages`, { content: 'Merci !' });
    expect(status).toBe(201);
    expect(body.message.fromStaff).toBe(false);
    expect(dms.map((d) => d.to)).toContain(ADMIN_ID);
    expect(dms.map((d) => d.to)).not.toContain(AUTEUR_ID);
  });

  test('un message vide est refusé', async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: AUTEUR_ID, username: 'Auteur' });
    const { status } = await dashboardCall(router, 'POST', `/api/feedback/${FEEDBACK_ID}/messages`, { content: '  ' });
    expect(status).toBe(400);
    expect(mockDb.feedbackMessage.create).not.toHaveBeenCalled();
  });
});

describe('administration des retours', () => {
  test('un non-admin ne peut pas changer le statut', async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: AUTEUR_ID, username: 'Auteur' });
    const { status } = await dashboardCall(router, 'POST', `/api/admin/feedback/${FEEDBACK_ID}/status`, { status: 'DONE' });
    expect(status).toBe(403);
    expect(mockDb.feedback.update).not.toHaveBeenCalled();
  });

  test("un statut inconnu est refusé", async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: ADMIN_ID, username: 'Admin' });
    const { status } = await dashboardCall(router, 'POST', `/api/admin/feedback/${FEEDBACK_ID}/status`, { status: 'WHATEVER' });
    expect(status).toBe(400);
  });

  test("un admin change le statut, joint un message et l'auteur reçoit un MP", async () => {
    setDashboardAccess(DASHBOARD_ACCESS_ADMIN, { userId: ADMIN_ID, username: 'Admin' });
    const { status, body } = await dashboardCall(router, 'POST', `/api/admin/feedback/${FEEDBACK_ID}/status`, { status: 'PLANNED', message: 'On le prévoit.' });
    expect(status).toBe(200);
    expect(body.feedback.status).toBe('PLANNED');
    expect(mockDb.feedbackMessage.create.mock.calls[0]![0].data).toMatchObject({ fromStaff: true, content: 'On le prévoit.' });
    expect(dms).toHaveLength(1);
    expect(dms[0]!.to).toBe(AUTEUR_ID);
    expect(dms[0]!.embed.toJSON().title).toContain('Prévu');
  });
});
