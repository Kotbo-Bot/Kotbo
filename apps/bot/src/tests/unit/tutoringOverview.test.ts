/**
 * Tutorat : qui a la main sur un tutorat, quel objectif s'y applique, quand
 * tombe le prochain point d'étape et ce qui bloque la validation.
 */
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const mockDb = {};
for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const { itemAppliesTo, nextReportDue, reportReminderDue, tutoringReadiness, tutoringRole } = await import('../../services/staff/tutoringOverview.js');

const period = { staffUserId: 'apprentice', mentorId: 'mentor' };

describe('rôle sur un tutorat', () => {
  test('le responsable a la main sur tous les tutorats', () => {
    expect(tutoringRole({ isManager: true, staffId: null }, period)).toBe('manager');
  });

  test('le tuteur et le tutoré sont reconnus', () => {
    expect(tutoringRole({ isManager: false, staffId: 'mentor' }, period)).toBe('mentor');
    expect(tutoringRole({ isManager: false, staffId: 'apprentice' }, period)).toBe('apprentice');
  });

  test("un autre membre du staff n'y a pas accès", () => {
    expect(tutoringRole({ isManager: false, staffId: 'someone' }, period)).toBeNull();
    expect(tutoringRole({ isManager: false, staffId: null }, period)).toBeNull();
  });

  test("un tutorat sans tuteur ne donne pas la main à qui n'a pas de fiche staff", () => {
    expect(tutoringRole({ isManager: false, staffId: null }, { staffUserId: 'apprentice', mentorId: null })).toBeNull();
  });
});

describe('objectifs applicables', () => {
  test('commun, propre à la hiérarchie, propre au grade', () => {
    expect(itemAppliesTo({ hierarchyId: null, grade: null }, 'modo', 'Helper')).toBe(true);
    expect(itemAppliesTo({ hierarchyId: 'modo', grade: null }, 'modo', 'Helper')).toBe(true);
    expect(itemAppliesTo({ hierarchyId: 'anim', grade: null }, 'modo', 'Helper')).toBe(false);
    expect(itemAppliesTo({ hierarchyId: 'modo', grade: 'Modérateur' }, 'modo', 'Helper')).toBe(false);
  });
});

describe("points d'étape et validation", () => {
  const start = new Date('2026-10-01T10:00:00Z');

  test("le prochain point se compte depuis le dernier, sinon depuis le début", () => {
    expect(nextReportDue({ startDate: start, lastReportAt: null }, 7).toISOString()).toBe('2026-10-08T10:00:00.000Z');
    expect(nextReportDue({ startDate: start, lastReportAt: new Date('2026-10-10T10:00:00Z') }, 7).toISOString()).toBe('2026-10-17T10:00:00.000Z');
  });

  test("le tuteur est relancé avant l'échéance, puis tous les trois jours de retard", () => {
    const due = new Date('2026-10-20T10:00:00Z');
    const at = (iso: string) => new Date(iso).getTime();
    expect(reportReminderDue(due, 2, at('2026-10-15T10:00:00Z'))).toBeNull();
    expect(reportReminderDue(due, 2, at('2026-10-19T10:00:00Z'))).toBe('soon');
    expect(reportReminderDue(due, 0, at('2026-10-19T10:00:00Z'))).toBeNull();
    expect(reportReminderDue(due, 2, at('2026-10-20T10:00:00Z'))).toBe('overdue');
    expect(reportReminderDue(due, 2, at('2026-10-21T10:00:00Z'))).toBeNull();
    expect(reportReminderDue(due, 2, at('2026-10-23T10:00:00Z'))).toBe('overdue');
  });

  test('seule la durée minimale bloque, les objectifs et les points éclairent', () => {
    const checks = tutoringReadiness({ daysElapsed: 5, minDays: 14, acquired: 2, total: 4, reports: 0 });
    expect(checks.find((check) => check.key === 'duration')).toMatchObject({ ok: false, blocking: true });
    expect(checks.find((check) => check.key === 'objectives')).toMatchObject({ ok: false, blocking: false });
    expect(checks.find((check) => check.key === 'reports')).toMatchObject({ ok: false, blocking: false });
    expect(tutoringReadiness({ daysElapsed: 20, minDays: 14, acquired: 0, total: 0, reports: 1 }).every((check) => check.ok)).toBe(true);
  });
});
