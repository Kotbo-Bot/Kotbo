import { describe, expect, mock, test } from 'bun:test';

let row: Record<string, unknown> | null = null;

mock.module('../../utils/db.js', () => {
  const db = { aegisConfig: { findUnique: async () => row } };
  return { default: db, prisma: db, prismaRead: db };
});

mock.module('../../utils/cache.js', () => ({
  cache: {
    wrap: async (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
    delete: async () => {},
  },
}));

let plan = 'PRO';
mock.module('../../services/system/planService.js', () => ({ getGuildPlan: async () => plan }));

const { AegisConfigError, getAegisConfig, getAegisSendConfig, sanitizeAegisPatch } = await import('../../services/moderation/aegis/aegisConfig');

const current = { reviewThreshold: 80, autoThreshold: 95 };

describe('getAegisConfig / getAegisSendConfig', () => {
  test('module éteint sans consentement : rien ne part', async () => {
    row = { guildId: '1', enabled: false, trainingConsent: false };
    expect(await getAegisConfig('1')).toBeNull();
    expect(await getAegisSendConfig('1')).toBeNull();
  });

  test('module éteint mais partage accepté : envoi seul autorisé', async () => {
    row = { guildId: '1', enabled: false, trainingConsent: true };
    expect(await getAegisConfig('1')).toBeNull();
    expect(await getAegisSendConfig('1')).toMatchObject({ guildId: '1', enabled: false, trainingConsent: true });
  });

  test('module allumé : actif dans les deux cas', async () => {
    row = { guildId: '1', enabled: true, trainingConsent: false };
    expect(await getAegisConfig('1')).toMatchObject({ guildId: '1', enabled: true });
    expect(await getAegisSendConfig('1')).toMatchObject({ guildId: '1', enabled: true });
  });

  test('offre gratuite : l IA ne note rien, le partage accepte part encore', async () => {
    plan = 'FREE';
    row = { guildId: '1', enabled: true, trainingConsent: false };
    expect(await getAegisConfig('1')).toBeNull();
    expect(await getAegisSendConfig('1')).toBeNull();

    row = { guildId: '1', enabled: true, trainingConsent: true };
    expect(await getAegisSendConfig('1')).toMatchObject({ enabled: false, trainingConsent: true });
    plan = 'PRO';
  });
});

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
