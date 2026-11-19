// Sans « Gérer les réglages », seules les exceptions dont la route revérifie
// le droit exact passent la garde. Seuls le rôle et l'état du serveur sont simulés.
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

const ROOT = path.resolve(import.meta.dir, '../..');

/** Modérateur Discord du serveur, sans « Gérer les réglages » (DASHBOARD_ACCESS_MODERATOR). */
const MODERATOR = {
  level: 'moderator',
  canViewDashboard: true,
  canModerateContent: true,
  canManageSettings: false,
  canManageTutoring: false,
};

let roleAccess: typeof MODERATOR = MODERATOR;

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  for (const ext of ['ts', 'js']) {
    mock.module(path.join(ROOT, `${relative}.${ext}`), () =>
      completeModuleMock(path.join(ROOT, `${relative}.ts`), overrides));
  }
}

// api/shared.ts ne fait que réexporter (`export *`) : completeModuleMock n'y lit
// aucun nom, les exports utilisés par guildGate et featureGate sont donc donnés
// à la main.
for (const ext of ['ts', 'js']) {
  mock.module(path.join(ROOT, `api/shared.${ext}`), () => ({
    resolveDashboardAccess: async () => roleAccess,
    resolveAdminAccess: async () => false,
    checkRateLimit: () => true,
    dashboardWriteRateLimiter: new Map(),
    dashboardSensitiveRateLimiter: new Map(),
    resolveMemberFeatureAccess: async () => ({}),
  }));
}
mockModule('utils/cache', { cache: { get: async () => null, set: async () => {} } });
mockModule('utils/activation', { isGuildActivated: () => true });
mockModule('services/core/moduleGate', { isModuleEnabled: async () => true });
mockModule('services/core/onboardingGate', { WIZARD_CONFIG_SEGMENTS: new Set(), isGuildInOnboarding: async () => false });
mockModule('services/analytics/ghostActivityTracker', { trackDashboardVisit: () => {} });
mockModule('services/system/adminAuditService', { recordAdminAudit: async () => {} });

const { evaluateGuildGate } = await import('../../api/routes/dashboard/guildGate.js');

const client = {} as Client;
const user = { userId: '200000000000000001', username: 'staff' };
const ADMIN_ONLY = { status: 403, body: { error: 'Action réservée aux administrateurs du dashboard.' } };

/** Passe la garde comme la requête `method /api/dashboard/guilds/<id>/<route>`. */
function gate(method: string, route: string, access = MODERATOR) {
  roleAccess = access;
  return evaluateGuildGate(client, user, ['api', 'dashboard', 'guilds', '100000000000000001', ...route.split('/')], method);
}

describe('garde des écritures : appels de bannissement', () => {
  test('un modérateur peut trancher un appel, demander des informations et statuer sur une sanction contestée', async () => {
    for (const route of ['appeals/appel-1/decide', 'appeals/appel-1/request-info', 'appeals/appel-1/items/item-1']) {
      const result = await gate('POST', route);
      expect({ route, denied: result.denied }).toEqual({ route, denied: null });
      // Laisser passer n'élève pas les droits : `appealsAccess`, juste après
      // la garde, tranche avec l'accès réel du rôle.
      if (result.denied === null) expect(result.effectiveAccess.canManageSettings).toBe(false);
    }
  });

  test('la configuration et la liste noire des appels restent réservées aux administrateurs', async () => {
    expect((await gate('PUT', 'appeals/config')).denied).toEqual(ADMIN_ONLY);
    expect((await gate('DELETE', 'appeals/blacklist/300000000000000001')).denied).toEqual(ADMIN_ONLY);
    // Même geste, mauvaise méthode : l'exception ne vaut que pour le POST.
    expect((await gate('PATCH', 'appeals/appel-1/decide')).denied).toEqual(ADMIN_ONLY);
  });
});
