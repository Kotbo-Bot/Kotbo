import { describe, expect, mock, test } from 'bun:test';

mock.module('../../utils/db.js', () => ({ default: {}, prisma: {}, prismaRead: {} }));

const { AegisConfigError, sanitizeAegisPatch } = await import('../../services/moderation/aegis/aegisConfig');

const current = { reviewThreshold: 80, autoThreshold: 95 };

describe('sanitizeAegisPatch', () => {
  test('garde les champs valides', () => {
    expect(sanitizeAegisPatch({ enabled: true, autoAction: 'DELETE', warnWeight: 3, exemptRoleIds: ['123456789012345678', '123456789012345678'] }, current))
      .toEqual({ enabled: true, autoAction: 'DELETE', warnWeight: 3, exemptRoleIds: ['123456789012345678'] });
  });

  test('ignore le consentement d’entraînement', () => {
    expect(sanitizeAegisPatch({ trainingConsent: true }, current)).toEqual({});
  });

  test('refuse un seuil automatique sous le seuil de revue', () => {
    expect(() => sanitizeAegisPatch({ autoThreshold: 80 }, current)).toThrow(AegisConfigError);
    expect(() => sanitizeAegisPatch({ reviewThreshold: 96 }, current)).toThrow(AegisConfigError);
    expect(sanitizeAegisPatch({ reviewThreshold: 70, autoThreshold: 90 }, current)).toEqual({ reviewThreshold: 70, autoThreshold: 90 });
  });

  test('refuse les valeurs hors bornes ou inconnues', () => {
    expect(() => sanitizeAegisPatch({ warnWeight: 4 }, current)).toThrow(AegisConfigError);
    expect(() => sanitizeAegisPatch({ autoAction: 'BAN' }, current)).toThrow(AegisConfigError);
    expect(() => sanitizeAegisPatch({ enabled: 'oui' }, current)).toThrow(AegisConfigError);
    expect(() => sanitizeAegisPatch({ reviewChannelId: 'abc' }, current)).toThrow(AegisConfigError);
  });

  test('un salon vide revient au salon de logs', () => {
    expect(sanitizeAegisPatch({ reviewChannelId: '' }, current)).toEqual({ reviewChannelId: null });
  });
});
