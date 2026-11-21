/**
 * La vraie garde et la vraie table segment -> fonctionnalités sont testées ;
 * seuls les droits du rôle et l'état du serveur sont simulés.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

type Rights = { canView: boolean; canModerate: boolean; canConfigure: boolean; canDelete: boolean };

const ROOT = path.resolve(import.meta.dir, '../..');
const NONE: Rights = { canView: false, canModerate: false, canConfigure: false, canDelete: false };
const VIEW: Rights = { canView: true, canModerate: false, canConfigure: false, canDelete: false };
const FULL: Rights = { canView: true, canModerate: true, canConfigure: true, canDelete: true };

/** Droits du rôle par fonctionnalité du centre de gestion, sans « Gérer les réglages ». */
let featureAccess: Record<string, Rights> = {};
const roleAccess = {
  level: 'moderator',
  canViewDashboard: true,
  canModerateContent: true,
  canManageSettings: false,
  canManageTutoring: false,
};

function mockModule(relative: string, overrides: Record<string, unknown>): void {
  for (const ext of ['ts', 'js']) {
    mock.module(path.join(ROOT, `${relative}.${ext}`), () =>
      completeModuleMock(path.join(ROOT, `${relative}.ts`), overrides));
  }
}

// api/shared.ts ne fait que réexporter (`export *`) : completeModuleMock n'y lit
// aucun nom, la liste des exports utilisés par guildGate et featureGate est donc
// donnée à la main.
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
const user = { userId: 'member-1', username: 'membre' };
const ADMIN_ONLY = 'Action réservée aux administrateurs du dashboard.';

function gate(method: string, ...segments: string[]) {
  return evaluateGuildGate(client, user, ['api', 'dashboard', 'guilds', 'guild-1', ...segments], method);
}

beforeEach(() => {
  featureAccess = {};
});

describe('garde d\'écriture des segments partagés', () => {
  test('« Configurer » sur Niveaux n\'ouvre ni l\'écriture ni la remise à zéro des clans', async () => {
    featureAccess = { leveling: FULL, clans: NONE };

    for (const [method, ...segments] of [
      ['POST', 'clans', 'reset-all'],
      ['POST', 'clans', 'distribute'],
      ['PATCH', 'clans', 'config'],
      ['DELETE', 'clans', 'clan-1'],
    ]) {
      const result = await gate(method, ...segments);
      expect(result.denied).toEqual({ status: 403, body: { error: ADMIN_ONLY } });
    }

    // La lecture partagée, elle, ne change pas : la page Niveaux lit toujours les clans.
    expect((await gate('GET', 'clans')).denied).toBeNull();
  });

  test('les formulaires et les mots bannis ne s\'écrivent pas depuis une section qui ne fait que les lire', async () => {
    featureAccess = { custom_forms: NONE, recruitment: FULL, ban_appeals: FULL, events: FULL };
    expect((await gate('POST', 'custom-forms')).denied?.status).toBe(403);
    expect((await gate('GET', 'custom-forms')).denied).toBeNull();

    featureAccess = { automod: FULL, nickname_moderation: NONE };
    expect((await gate('PUT', 'banned-words')).denied?.status).toBe(403);
    expect((await gate('GET', 'banned-words')).denied).toBeNull();
  });

  test('la fonctionnalité propriétaire ouvre toujours l\'écriture de son segment', async () => {
    featureAccess = { clans: FULL, leveling: VIEW };
    const clans = await gate('POST', 'clans', 'reset-all');
    expect(clans.denied).toBeNull();
    if (clans.denied === null) expect(clans.effectiveAccess.canManageSettings).toBe(true);

    featureAccess = { custom_forms: FULL };
    expect((await gate('POST', 'custom-forms')).denied).toBeNull();

    featureAccess = { nickname_moderation: FULL };
    expect((await gate('PUT', 'banned-words')).denied).toBeNull();
  });

  test('la page Niveaux règle le bonus de clan par PATCH /clans, sans rien ouvrir d\'autre', async () => {
    featureAccess = { leveling: FULL, clans: NONE };
    expect((await gate('PATCH', 'clans')).denied).toBeNull();
    expect((await gate('POST', 'clans', 'reset-all')).denied?.status).toBe(403);
  });
});
