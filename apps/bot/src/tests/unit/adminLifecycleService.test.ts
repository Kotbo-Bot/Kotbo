import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

let lastVisit: { dateKey: string } | null = null;
let work = { spam: 0, aegis: 0, sanctions: 0, tickets: 0 };
let journey: { steps: Array<{ key: string; label: string; why: string; done: boolean; href: string }> } | null = null;

const prismaMock = {
  dashboardTelemetryDailyStat: { findFirst: mock(async () => lastVisit) },
};

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../services/core/setupJourney', () => ({ computeSetupJourney: mock(async () => journey) })],
  ['../../services/analytics/analyticsReportService', () => ({ getKotboWork: mock(async () => work) })],
];

for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { pickReminder } = await import('../../services/core/adminLifecycleService.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T10:45:00Z');
const client = {} as never;

function guild(overrides: Partial<{ createdAt: Date; onboardingCompletedAt: Date | null; lifecycleRemindersSent: string[] }> = {}) {
  return {
    id: '123456789012345678',
    createdAt: new Date(NOW.getTime() - 3 * DAY),
    onboardingCompletedAt: null,
    billingOwnerId: null,
    lifecycleRemindersSent: [],
    ...overrides,
  };
}

describe('pickReminder', () => {
  test('configuration laissée en plan depuis trois jours : reprise', async () => {
    const reminder = await pickReminder(client, guild(), 'Les Nerds', 'fr', NOW);
    expect(reminder?.kind).toBe('onboarding_resume');
    expect(reminder?.path).toBe('/onboarding');
  });

  test('trop tôt (un jour) ou trop tard (trois semaines) : rien', async () => {
    expect(await pickReminder(client, guild({ createdAt: new Date(NOW.getTime() - DAY) }), 'S', 'fr', NOW)).toBeNull();
    expect(await pickReminder(client, guild({ createdAt: new Date(NOW.getTime() - 21 * DAY) }), 'S', 'fr', NOW)).toBeNull();
  });

  test('une relance déjà envoyée ne repart pas', async () => {
    expect(await pickReminder(client, guild({ lifecycleRemindersSent: ['onboarding_resume'] }), 'S', 'fr', NOW)).toBeNull();
  });

  test('une semaine après la configuration : la première étape utile restante', async () => {
    journey = {
      steps: [
        { key: 'installed', label: 'Kotbo ajouté', why: '', done: true, href: '/' },
        { key: 'timezone', label: 'Fuseau', why: '', done: false, href: '/management' },
        { key: 'logs', label: 'Salon de logs', why: 'Pour garder une trace.', done: false, href: '/logs/config' },
      ],
    };
    const reminder = await pickReminder(
      client,
      guild({ createdAt: new Date(NOW.getTime() - 10 * DAY), onboardingCompletedAt: new Date(NOW.getTime() - 8 * DAY) }),
      'S',
      'fr',
      NOW,
    );
    expect(reminder?.kind).toBe('next_step');
    expect(reminder?.path).toBe('/logs/config');
  });

  test('absence de trente jours sans rien à montrer : pas de relance creuse', async () => {
    journey = null;
    lastVisit = { dateKey: '2026-08-01' };
    work = { spam: 0, aegis: 0, sanctions: 0, tickets: 0 };
    const old = guild({ createdAt: new Date(NOW.getTime() - 90 * DAY), onboardingCompletedAt: new Date(NOW.getTime() - 80 * DAY) });
    expect(await pickReminder(client, old, 'S', 'fr', NOW)).toBeNull();
  });

  test('absence de trente jours avec du travail fait : bilan', async () => {
    lastVisit = { dateKey: '2026-08-01' };
    work = { spam: 12, aegis: 0, sanctions: 3, tickets: 0 };
    const old = guild({ createdAt: new Date(NOW.getTime() - 90 * DAY), onboardingCompletedAt: new Date(NOW.getTime() - 80 * DAY) });
    const reminder = await pickReminder(client, old, 'S', 'fr', NOW);
    expect(reminder?.kind).toBe('winback');
    expect(reminder?.body).toContain('12');
  });

  test('visite récente : pas de bilan', async () => {
    lastVisit = { dateKey: '2026-10-05' };
    work = { spam: 12, aegis: 0, sanctions: 0, tickets: 0 };
    const old = guild({ createdAt: new Date(NOW.getTime() - 90 * DAY), onboardingCompletedAt: new Date(NOW.getTime() - 80 * DAY) });
    expect(await pickReminder(client, old, 'S', 'fr', NOW)).toBeNull();
  });
});
