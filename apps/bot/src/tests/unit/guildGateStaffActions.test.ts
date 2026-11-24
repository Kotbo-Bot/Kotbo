// Sans « Gérer les réglages », seules les exceptions dont la route revérifie
// le droit exact passent la garde. Seuls le rôle et l'état du serveur sont simulés.
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import type { FeatureAccess, FeatureAccessMap } from '../../api/shared.js';

const ROOT = path.resolve(import.meta.dir, '../..');

/** Modérateur Discord du serveur, sans « Gérer les réglages » (DASHBOARD_ACCESS_MODERATOR). */
const MODERATOR = {
  level: 'moderator',
  canViewDashboard: true,
  canModerateContent: true,
  canManageSettings: false,
  canManageTutoring: false,
};
/** Membre du staff qui consulte le dashboard, sans droit de modération (DASHBOARD_ACCESS_STAFF_VIEWER). */
const STAFF = { ...MODERATOR, canModerateContent: false };

let roleAccess: typeof MODERATOR = MODERATOR;
/** Droits du rôle par fonctionnalité du centre de gestion. */
let featureAccess: FeatureAccessMap = {};

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
    resolveMemberFeatureAccess: async () => featureAccess,
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

describe('garde des écritures : planning du staff', () => {
  const MODERATE_ONLY: FeatureAccess = { canView: true, canModerate: true, canConfigure: false, canDelete: false };

  test("un responsable qui n'a que « Modérer » sur Absences peut décider d'une absence", async () => {
    featureAccess = { absences: MODERATE_ONLY };
    const result = await gate('PATCH', 'absences/absence-1', STAFF);
    expect(result.denied).toBeNull();
    // Sans élévation : absences.ts revérifie lui-même « Modérer » ou « Configurer ».
    if (result.denied === null) expect(result.effectiveAccess.canManageSettings).toBe(false);
  });

  test('un membre du staff sans droit de section peut supprimer une absence', async () => {
    // absences.ts ne laisse ensuite supprimer que sa propre absence.
    featureAccess = {};
    expect((await gate('DELETE', 'absences/absence-1', STAFF)).denied).toBeNull();
  });

  test('un membre du staff peut planifier un appel', async () => {
    // canUserCreateCall, dans calls.ts, tranche ensuite selon la configuration des appels.
    featureAccess = {};
    expect((await gate('POST', 'calls', STAFF)).denied).toBeNull();
  });

  test('les réglages des absences et la gestion des appels restent réservés aux administrateurs', async () => {
    featureAccess = { absences: MODERATE_ONLY };
    expect((await gate('POST', 'absences/config', STAFF)).denied).toEqual(ADMIN_ONLY);
    expect((await gate('POST', 'calls/config', STAFF)).denied).toEqual(ADMIN_ONLY);
    expect((await gate('PATCH', 'calls/appel-1', STAFF)).denied).toEqual(ADMIN_ONLY);
    expect((await gate('DELETE', 'calls/appel-1', STAFF)).denied).toEqual(ADMIN_ONLY);
  });
});

describe('garde des écritures : preuves de sanction', () => {
  test('un modérateur peut téléverser et supprimer une pièce de preuve', async () => {
    featureAccess = {};
    const result = await gate('POST', 'sanctions/evidence-files');
    expect(result.denied).toBeNull();
    // sanctions.ts revérifie ensuite canModerateSanctions avec l'accès réel.
    if (result.denied === null) expect(result.effectiveAccess.canManageSettings).toBe(false);
    expect((await gate('DELETE', 'sanctions/evidence-files/rapport-1')).denied).toBeNull();
  });

  test('les barèmes et le retrait d\'une sanction restent réservés aux administrateurs', async () => {
    featureAccess = {};
    expect((await gate('PUT', 'sanctions/tables')).denied).toEqual(ADMIN_ONLY);
    expect((await gate('DELETE', 'sanctions/sanction-1')).denied).toEqual(ADMIN_ONLY);
  });
});

describe('garde des écritures : préférences du lecteur', () => {
  test('un modérateur peut enregistrer sa disposition et gérer ses préréglages', async () => {
    featureAccess = {};
    for (const [method, route] of [['PUT', 'user-settings'], ['POST', 'layout-presets/import'], ['DELETE', 'layout-presets/preset-1'], ['POST', 'layout-presets/preset-1/apply']]) {
      expect({ route, denied: (await gate(method, route)).denied }).toEqual({ route, denied: null });
    }
  });
});

describe('garde des écritures : widget de profil', () => {
  test('un membre du staff gère son propre widget, pas le rafraîchissement de tout le staff', async () => {
    featureAccess = {};
    for (const action of ['activate', 'deactivate', 'refresh', 'rotate-token']) {
      expect({ action, denied: (await gate('POST', `widget/${action}`, STAFF)).denied }).toEqual({ action, denied: null });
    }
    expect((await gate('POST', 'widget/refresh-all', STAFF)).denied).toEqual(ADMIN_ONLY);
  });
});

describe('garde des écritures : cellule bien-être', () => {
  test('un membre du staff peut ouvrir un dossier, le modifier, le noter ou demander un accès d urgence', async () => {
    // wellbeing.ts revérifie ensuite l'appartenance à la cellule ou à la direction.
    featureAccess = {};
    for (const [method, route] of [
      ['POST', 'wellbeing/cases'],
      ['PATCH', 'wellbeing/cases/dossier-1'],
      ['DELETE', 'wellbeing/cases/dossier-1'],
      ['POST', 'wellbeing/cases/dossier-1/notes'],
      ['POST', 'wellbeing/break-glass'],
    ] as const) {
      const result = await gate(method, route, STAFF);
      expect({ route, method, denied: result.denied }).toEqual({ route, method, denied: null });
      if (result.denied === null) expect(result.effectiveAccess.canManageSettings).toBe(false);
    }
  });

  test('la composition de la cellule reste derrière la garde des administrateurs', async () => {
    featureAccess = {};
    expect((await gate('PUT', 'wellbeing/config', STAFF)).denied).toEqual(ADMIN_ONLY);
  });
});
