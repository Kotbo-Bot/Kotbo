import { describe, expect, test } from 'bun:test';
import {
  CLOSED_CASE_RETENTION_DAYS,
  closedCaseCutoff,
  describeConfigChange,
  READ_ALERT_COOLDOWN_MS,
  alertText,
  cleanAlertEvents,
  idListChange,
  shouldSendReadAlert,
  resolveWellbeingAccess,
  type WellbeingAccessLists,
} from '../../services/staff/wellbeingPolicy';

const empty: WellbeingAccessLists = {
  enabled: false,
  requireReason: true,
  teamRoleIds: [],
  teamUserIds: [],
  directorRoleIds: [],
  directorUserIds: [],
};
const names: Record<string, string> = { r1: '@Écoute', r2: '@Direction', u1: 'alice' };
const nameOf = (id: string) => names[id] ?? id;

describe('idListChange', () => {
  test('sépare les ajouts et les retraits', () => {
    expect(idListChange(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
  });

  test('une liste inchangée ne donne rien', () => {
    expect(idListChange(['a'], ['a'])).toEqual({ added: [], removed: [] });
  });
});

describe('describeConfigChange', () => {
  test('nomme les rôles et membres ajoutés à l\'équipe', () => {
    const after = { ...empty, enabled: true, teamRoleIds: ['r1'], teamUserIds: ['u1'] };
    expect(describeConfigChange(empty, after, nameOf)).toBe('Cellule activée · Équipe : +@Écoute, +alice');
  });

  test('nomme les retraits de la direction', () => {
    const before = { ...empty, enabled: true, directorRoleIds: ['r2'] };
    const after = { ...empty, enabled: true };
    expect(describeConfigChange(before, after, nameOf)).toBe('Direction : -@Direction');
  });

  test('signale le motif d\'accès d\'urgence rendu facultatif', () => {
    const after = { ...empty, requireReason: false };
    expect(describeConfigChange(empty, after, nameOf)).toBe('Motif d\'accès d\'urgence : facultatif');
  });

  test('une première configuration part d\'une cellule vide', () => {
    expect(describeConfigChange(null, { ...empty, teamRoleIds: ['r1'] }, nameOf)).toBe('Équipe : +@Écoute');
  });

  test('sans changement, le dit', () => {
    expect(describeConfigChange(empty, empty, nameOf)).toBe('Aucun changement');
  });
});

describe('closedCaseCutoff', () => {
  test('recule de la durée de conservation', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    const cutoff = closedCaseCutoff(now);
    expect(now.getTime() - cutoff.getTime()).toBe(CLOSED_CASE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe('droits sur la cellule', () => {
  const config: WellbeingAccessLists = {
    ...empty,
    enabled: true,
    teamRoleIds: ['r1'],
    teamUserIds: ['u1'],
    directorRoleIds: ['r2'],
    directorUserIds: ['u9'],
  };
  const actor = (userId: string, roleIds: string[] = [], isOwner = false) => ({ userId, roleIds: new Set(roleIds), isOwner });

  test('la cellule lit et écrit les dossiers, par membre ou par rôle', () => {
    for (const who of [actor('u1'), actor('u2', ['r1'])]) {
      const access = resolveWellbeingAccess(config, who, false);
      expect(access.canReadCases).toBe(true);
      expect(access.canWriteCases).toBe(true);
    }
  });

  test("sous accès d'urgence, la direction lit sans pouvoir écrire", () => {
    const access = resolveWellbeingAccess(config, actor('u3', ['r2']), true);
    expect(access.isDirector).toBe(true);
    expect(access.canReadCases).toBe(true);
    expect(access.canWriteCases).toBe(false);
  });

  test("être administrateur du dashboard ne fait pas partie de la direction", () => {
    // Seuls le propriétaire et les membres ou rôles désignés peuvent déclencher un accès d'urgence.
    const access = resolveWellbeingAccess(config, actor('u4', ['admin']), false);
    expect(access.isDirector).toBe(false);
    expect(access.canReadCases).toBe(false);
  });

  test('le propriétaire est de la direction et seul à configurer', () => {
    const owner = resolveWellbeingAccess(config, actor('u5', [], true), false);
    expect(owner.isDirector).toBe(true);
    expect(owner.canConfigure).toBe(true);
    expect(owner.canReadCases).toBe(false);
    expect(resolveWellbeingAccess(config, actor('u9'), false).canConfigure).toBe(false);
  });

  test('une cellule désactivée ne donne accès à aucun dossier', () => {
    const access = resolveWellbeingAccess({ ...config, enabled: false }, actor('u1'), true);
    expect(access.isTeamMember).toBe(false);
    expect(access.canReadCases).toBe(false);
    expect(access.canWriteCases).toBe(false);
  });
});

describe('alertes de la cellule', () => {
  test('seuls les événements connus sont retenus, sans doublon', () => {
    expect(cleanAlertEvents(['BREAK_GLASS', 'TEAM_READ', 'BREAK_GLASS', 'INCONNU', 3])).toEqual(['BREAK_GLASS', 'TEAM_READ']);
    expect(cleanAlertEvents('BREAK_GLASS')).toEqual([]);
  });

  test("l'alerte nomme l'auteur sans rien dévoiler des dossiers", () => {
    const text = alertText('TEAM_READ', { actorId: '200000000000000001', caseCount: 3 });
    expect(text).toContain('<@200000000000000001>');
    expect(text).toContain('3');
  });

  test("l'activation d'un accès d'urgence donne le motif et l'échéance", () => {
    const expiresAt = new Date('2026-11-24T12:00:00Z');
    const text = alertText('BREAK_GLASS', { actorId: '1', reason: 'Enquête sur un signalement', expiresAt });
    expect(text).toContain('Enquête sur un signalement');
    expect(text).toContain(`<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`);
  });

  test("une consultation n'est signalée qu'une fois par période, par personne", () => {
    const now = 1_000_000_000;
    expect(shouldSendReadAlert(undefined, now)).toBe(true);
    expect(shouldSendReadAlert(now - 1_000, now)).toBe(false);
    expect(shouldSendReadAlert(now - READ_ALERT_COOLDOWN_MS, now)).toBe(true);
  });

  test("un changement des alertes figure au journal d'audit", () => {
    const after = { ...empty, alertChannelId: '300000000000000001', alertEvents: ['BREAK_GLASS'] };
    expect(describeConfigChange(empty, after, nameOf)).toContain('Alertes');
  });

  test("retirer la seconde validation ou ouvrir les signalements figure au journal", () => {
    const before = { ...empty, breakGlassApproval: true, reportEnabled: false, staleCriticalDays: 7 };
    const after = { ...before, breakGlassApproval: false, reportEnabled: true, staleCriticalDays: 3 };
    const line = describeConfigChange(before, after, nameOf);
    expect(line).toContain("Seconde validation de l'accès d'urgence : retirée");
    expect(line).toContain('Signalements Discord : ouverts');
    expect(line).toContain('Relance des dossiers critiques : 3 jour(s)');
  });
});

