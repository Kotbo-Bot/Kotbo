import { describe, expect, test } from 'bun:test';
import {
  WB_SETUP_STEPS,
  wbAccessMatrix,
  wbConfigFromApi,
  wbConfigToApi,
  wbFirstSetup,
  wbSecurityChecks,
  wbSecurityScore,
  wbStepComplete,
  type WbConfigForm,
} from './wellbeingSettings';

const form = (over: Partial<WbConfigForm> = {}): WbConfigForm => ({
  ...wbConfigFromApi({}),
  ...over,
});

describe('formulaire de configuration', () => {
  test('valeurs par défaut sûres quand rien n est configuré', () => {
    const empty = wbConfigFromApi({});
    expect(empty).toMatchObject({ enabled: false, requireReason: true, breakGlassApproval: false, staleCriticalDays: 7, backupUserId: null, alertChannelId: '' });
  });

  test("l'aller-retour garde les valeurs et borne la relance", () => {
    const api = wbConfigToApi(form({ teamUserIds: ['u1'], alertChannelId: '', staleCriticalDays: 200, backupUserId: 'u1' }));
    expect(api).toMatchObject({ teamUserIds: ['u1'], alertChannelId: null, staleCriticalDays: 90, backupUserId: 'u1' });
  });
});

describe('score de sécurité', () => {
  const solid = form({
    enabled: true,
    teamUserIds: ['u1', 'u2'],
    breakGlassApproval: true,
    requireReason: true,
    alertChannelId: 'c1',
    alertEvents: ['BREAK_GLASS', 'REPORT'],
    backupUserId: 'u2',
  });

  test('une cellule bien réglée coche tout', () => {
    const checks = wbSecurityChecks(solid, { accessReviewDue: false });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(wbSecurityScore(checks)).toBe(100);
  });

  test('chaque manque est signalé avec la section où le corriger', () => {
    const checks = wbSecurityChecks(form({ teamRoleIds: ['r1'] }), { accessReviewDue: true });
    const failing = checks.filter((check) => !check.ok).map((check) => check.id);
    expect(failing).toEqual(['named_members', 'two_keys', 'alerts', 'backup', 'review']);
    expect(checks.find((check) => check.id === 'two_keys')?.section).toBe('direction');
  });

  test("les signalements sans personne pour les recevoir sont un manque, s'ils sont ouverts", () => {
    const open = wbSecurityChecks({ ...solid, reportEnabled: true, alertEvents: ['BREAK_GLASS'] }, { accessReviewDue: false });
    expect(open.find((check) => check.id === 'reports_noticed')?.ok).toBe(false);
    const closed = wbSecurityChecks({ ...solid, reportEnabled: false }, { accessReviewDue: false });
    expect(closed.some((check) => check.id === 'reports_noticed')).toBe(false);
  });
});

describe('qui peut quoi', () => {
  test('la cellule lit et écrit, la direction lit sous accès d urgence, le propriétaire configure', () => {
    const rows = wbAccessMatrix(form({ teamUserIds: ['u1'], teamRoleIds: ['r1'], directorUserIds: ['d1'], backupUserId: 'u1' }));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.team).toMatchObject({ read: 'yes', write: 'yes', configure: 'no', members: 1, roles: 1 });
    expect(byId.direction).toMatchObject({ read: 'emergency', write: 'no', configure: 'no', members: 1 });
    expect(byId.owner).toMatchObject({ read: 'emergency', configure: 'yes' });
    expect(byId.backup).toMatchObject({ read: 'yes', reminders: 'yes', members: 1 });
  });

  test('avec la seconde validation, la lecture d urgence attend une autre personne', () => {
    const rows = wbAccessMatrix(form({ breakGlassApproval: true }));
    expect(rows.find((row) => row.id === 'direction')?.read).toBe('emergency_two_keys');
  });

  test('sans suppléant, pas de ligne suppléant', () => {
    expect(wbAccessMatrix(form()).some((row) => row.id === 'backup')).toBe(false);
  });
});

describe('première configuration', () => {
  test('parcours en quatre étapes, puis récapitulatif', () => {
    expect([...WB_SETUP_STEPS]).toEqual(['team', 'direction', 'alerts', 'reports', 'summary']);
  });

  test('proposé tant que la cellule n a jamais été activée ni composée', () => {
    expect(wbFirstSetup(form())).toBe(true);
    expect(wbFirstSetup(form({ teamUserIds: ['u1'] }))).toBe(false);
    expect(wbFirstSetup(form({ enabled: true }))).toBe(false);
  });

  test('une étape est complète quand son essentiel est rempli', () => {
    expect(wbStepComplete(form(), 'team')).toBe(false);
    expect(wbStepComplete(form({ teamRoleIds: ['r1'] }), 'team')).toBe(true);
    expect(wbStepComplete(form(), 'alerts')).toBe(false);
    expect(wbStepComplete(form({ alertUserIds: ['u1'] }), 'alerts')).toBe(true);
    expect(wbStepComplete(form(), 'direction')).toBe(true);
    expect(wbStepComplete(form(), 'reports')).toBe(true);
  });
});
