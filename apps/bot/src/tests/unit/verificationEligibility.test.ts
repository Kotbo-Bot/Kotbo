import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

/**
 * Limites des demandes de vérification manuelles : une par semaine et par
 * membre, 5 par heure sur l'ensemble du bot.
 */

let history = { hasPending: false, cooldownUntil: null as Date | null };
let lastHourCount = 0;
const notifyBotAdmins = mock(async () => 1);

const mockDb = { securityVerification: { count: mock(async () => lastHourCount) } };
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, success: () => {}, debug: () => {} };

function mockModule(relative: string, factory: () => unknown) {
  for (const suffix of ['.ts', '.js']) {
    mock.module(path.resolve(__dirname, relative + suffix), factory);
  }
}

mockModule('../../utils/db', () => ({ default: mockDb, prisma: mockDb }));
mockModule('../../utils/logger', () => ({ logger: silentLogger }));
mockModule('../../services/moderation/securityVerificationService', () => ({
  getVerificationHistory: async () => history,
}));
mockModule('../../services/analytics/acquisitionAlertsService', () => ({ notifyBotAdmins }));

const { checkVerificationEligibility, VERIFICATION_GLOBAL_MAX_PER_HOUR } = await import(
  '../../services/moderation/verificationSpamGuard'
);

const params = { guildId: 'g1', guildName: 'Serveur', userId: 'u1', moderatorTag: 'mod#0001' };
const client = {} as never;

describe('checkVerificationEligibility', () => {
  beforeEach(() => {
    history = { hasPending: false, cooldownUntil: null };
    lastHourCount = 0;
    notifyBotAdmins.mockClear();
  });

  test('autorise une première demande', async () => {
    expect(await checkVerificationEligibility(client, params)).toEqual({ allowed: true });
  });

  test('refuse si une demande est déjà en cours', async () => {
    history.hasPending = true;
    const result = await checkVerificationEligibility(client, params);
    expect(result).toMatchObject({ allowed: false, reason: 'PENDING' });
  });

  test('refuse dans la semaine qui suit une demande, avec la durée restante', async () => {
    history.cooldownUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const result = await checkVerificationEligibility(client, params);
    expect(result).toMatchObject({ allowed: false, reason: 'WEEKLY' });
    expect(result.allowed === false && result.message).toContain('3 j');
  });

  test('refuse au-delà du plafond horaire global et prévient les admins une seule fois', async () => {
    lastHourCount = VERIFICATION_GLOBAL_MAX_PER_HOUR;
    expect(await checkVerificationEligibility(client, params)).toMatchObject({ allowed: false, reason: 'GLOBAL' });
    expect(await checkVerificationEligibility(client, params)).toMatchObject({ allowed: false, reason: 'GLOBAL' });
    expect(notifyBotAdmins).toHaveBeenCalledTimes(1);
  });

  test('autorise tant que le plafond horaire n\'est pas atteint', async () => {
    lastHourCount = VERIFICATION_GLOBAL_MAX_PER_HOUR - 1;
    expect(await checkVerificationEligibility(client, params)).toEqual({ allowed: true });
  });
});
