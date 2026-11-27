import { describe, expect, test } from 'bun:test';
import { READ_ALERT_COOLDOWN_MS, alertText } from '../../services/staff/wellbeingAlertPolicy';
import { endBreakGlassError } from '../../services/staff/wellbeingAccessPolicy';
import { CASE_TRASH_DAYS, trashCutoff } from '../../services/staff/wellbeingRetentionPolicy';
import {
  assigneeConflict,
  caseVisibilityWhere,
  isCaseSubject,
  shouldRecordView,
} from '../../services/staff/wellbeingCasePolicy';

const DAY = 24 * 60 * 60 * 1000;

describe('corbeille des dossiers', () => {
  test('un dossier reste 30 jours en corbeille avant la purge', () => {
    const now = new Date('2026-11-25T00:00:00Z');
    expect(CASE_TRASH_DAYS).toBe(30);
    expect(now.getTime() - trashCutoff(now).getTime()).toBe(30 * DAY);
  });

  test('la liste courante écarte la corbeille, la corbeille ne montre qu elle', () => {
    expect(caseVisibilityWhere('g1', 'u1')).toMatchObject({ guildId: 'g1', deletedAt: null });
    expect(caseVisibilityWhere('g1', 'u1', { trashed: true })).toMatchObject({ guildId: 'g1', deletedAt: { not: null } });
  });
});

describe("conflit d'intérêts", () => {
  test('la personne concernée par un dossier ne le voit pas, les dossiers sans membre lié restent visibles', () => {
    // `not` seul écarterait aussi les dossiers sans membre lié (NULL en SQL).
    expect(caseVisibilityWhere('g1', 'u1')).toMatchObject({
      OR: [{ subjectUserId: null }, { subjectUserId: { not: 'u1' } }],
    });
  });

  test('le filtre porte sur la personne qui consulte', () => {
    expect(caseVisibilityWhere('g1', 'u2').OR).toEqual([{ subjectUserId: null }, { subjectUserId: { not: 'u2' } }]);
  });

  test("on n'ouvre pas de dossier sur soi-même : on ne pourrait plus le voir", () => {
    expect(isCaseSubject('u1', 'u1')).toBe(true);
    expect(isCaseSubject('u1', 'u2')).toBe(false);
    expect(isCaseSubject(null, 'u1')).toBe(false);
  });

  test('la personne concernée ne peut pas être référente de son propre dossier', () => {
    expect(assigneeConflict('u1', 'u1')).toBe(true);
    expect(assigneeConflict('u1', 'u2')).toBe(false);
    expect(assigneeConflict(null, 'u2')).toBe(false);
    expect(assigneeConflict('u1', null)).toBe(false);
  });
});

describe("fin anticipée d'un accès d'urgence", () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const active = { status: 'APPROVED', actorId: 'dir', expiresAt: new Date(now.getTime() + 3_600_000) };
  const pending = { ...active, status: 'PENDING' };

  test("l'auteur termine son accès ou annule sa demande", () => {
    expect(endBreakGlassError(active, { userId: 'dir', isTeamMember: false, isOwner: false }, now)).toBeNull();
    expect(endBreakGlassError(pending, { userId: 'dir', isTeamMember: false, isOwner: false }, now)).toBeNull();
  });

  test('la cellule et le propriétaire révoquent celui des autres', () => {
    expect(endBreakGlassError(active, { userId: 'cell', isTeamMember: true, isOwner: false }, now)).toBeNull();
    expect(endBreakGlassError(active, { userId: 'owner', isTeamMember: false, isOwner: true }, now)).toBeNull();
  });

  test("un autre membre de la direction ne coupe pas l'accès d'un pair", () => {
    expect(endBreakGlassError(active, { userId: 'dir2', isTeamMember: false, isOwner: false }, now)).toBe('forbidden');
  });

  test('un accès échu, refusé ou déjà terminé ne se termine plus', () => {
    const ender = { userId: 'dir', isTeamMember: false, isOwner: false };
    expect(endBreakGlassError({ ...active, expiresAt: now }, ender, now)).toBe('closed');
    expect(endBreakGlassError({ ...active, status: 'REJECTED' }, ender, now)).toBe('closed');
    expect(endBreakGlassError({ ...active, status: 'ENDED' }, ender, now)).toBe('closed');
  });

  test("l'alerte de fin nomme qui a coupé l'accès", () => {
    const text = alertText('BREAK_GLASS', { actorId: '200000000000000001', stage: 'ended' });
    expect(text).toContain('<@200000000000000001>');
    expect(text).toContain('terminé');
  });
});

describe('trace de lecture par dossier', () => {
  const now = new Date('2026-11-25T12:00:00Z');

  test('la première ouverture laisse une trace', () => {
    expect(shouldRecordView(null, now)).toBe(true);
  });

  test("une réouverture rapprochée n'en ajoute pas une seconde", () => {
    expect(shouldRecordView(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  test('passé le délai, une nouvelle ouverture est tracée', () => {
    expect(shouldRecordView(new Date(now.getTime() - READ_ALERT_COOLDOWN_MS), now)).toBe(true);
  });
});
