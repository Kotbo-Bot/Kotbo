import { describe, expect, test } from 'bun:test';
import {
  CLOSE_REASONS,
  NOTE_EDIT_HOURS,
  absenceActive,
  canEditNote,
  cellMemberIds,
  cleanCloseReason,
  digestCounts,
  digestDue,
  reminderRecipient,
  weeklyDigestText,
  wellbeingCellStats,
} from '../../services/staff/wellbeingPolicy';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-25T12:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

describe('motif de clôture', () => {
  test('quatre motifs connus, un motif inconnu est écarté', () => {
    expect([...CLOSE_REASONS]).toEqual(['RESOLVED', 'REFERRED', 'NO_FOLLOWUP', 'DUPLICATE']);
    expect(cleanCloseReason('REFERRED')).toBe('REFERRED');
    expect(cleanCloseReason('AUTRE')).toBeNull();
    expect(cleanCloseReason(undefined)).toBeNull();
  });

  test('le bilan compte les dossiers fermés par motif', () => {
    const base = { severity: 'NORMAL', category: 'SOUTIEN', source: 'DASHBOARD', assigneeId: null, createdAt: ago(100), events: [] };
    const stats = wellbeingCellStats([
      { ...base, status: 'CLOSED', closedReason: 'RESOLVED' },
      { ...base, status: 'CLOSED', closedReason: 'RESOLVED' },
      { ...base, status: 'CLOSED', closedReason: null },
      { ...base, status: 'OPEN', closedReason: null },
    ], NOW);
    expect(stats.closedByReason).toEqual({ RESOLVED: 2, UNSPECIFIED: 1 });
  });
});

describe('référent absent', () => {
  const absence = { status: 'APPROVED', isVoid: false, endedAt: null, startDate: ago(48), endDate: new Date(NOW.getTime() + 48 * HOUR), isIndefinite: false };

  test('une absence validée en cours compte, pas une demande ni une absence finie', () => {
    expect(absenceActive(absence, NOW)).toBe(true);
    expect(absenceActive({ ...absence, status: 'ACKNOWLEDGED' }, NOW)).toBe(true);
    expect(absenceActive({ ...absence, status: 'PENDING' }, NOW)).toBe(false);
    expect(absenceActive({ ...absence, isVoid: true }, NOW)).toBe(false);
    expect(absenceActive({ ...absence, endedAt: ago(1) }, NOW)).toBe(false);
    expect(absenceActive({ ...absence, endDate: ago(1) }, NOW)).toBe(false);
    expect(absenceActive({ ...absence, startDate: new Date(NOW.getTime() + HOUR) }, NOW)).toBe(false);
    expect(absenceActive({ ...absence, endDate: null, isIndefinite: true }, NOW)).toBe(true);
  });

  test('la relance va au suppléant quand le référent est absent', () => {
    expect(reminderRecipient('ref', new Set(['ref']), 'sup')).toBe('sup');
    expect(reminderRecipient('ref', new Set(), 'sup')).toBe('ref');
    expect(reminderRecipient('ref', new Set(['ref']), null)).toBe('ref');
    expect(reminderRecipient('ref', new Set(['ref']), 'ref')).toBe('ref');
    expect(reminderRecipient(null, new Set(), 'sup')).toBeNull();
  });
});

describe('correction d une note', () => {
  test("seul l'auteur corrige sa note, dans les 48 heures", () => {
    expect(NOTE_EDIT_HOURS).toBe(48);
    expect(canEditNote({ authorId: 'u1', createdAt: ago(2) }, 'u1', NOW)).toBe(true);
    expect(canEditNote({ authorId: 'u1', createdAt: ago(2) }, 'u2', NOW)).toBe(false);
    expect(canEditNote({ authorId: 'u1', createdAt: ago(48) }, 'u1', NOW)).toBe(false);
  });
});

describe('résumé hebdomadaire', () => {
  test('les membres de la cellule, nommés ou par rôle, sans doublon', () => {
    const ids = cellMemberIds(
      { teamUserIds: ['a'], teamRoleIds: ['r1'] },
      [{ id: 'a', roleIds: ['r1'] }, { id: 'b', roleIds: ['r1'] }, { id: 'c', roleIds: ['r2'] }],
    );
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  test('des chiffres seulement, et rien quand il n y a rien à dire', () => {
    const text = weeklyDigestText('Mon serveur', { assigned: 3, reviewsThisWeek: 1, triage: 2, criticalUnassigned: 0 });
    for (const part of ['Mon serveur', '3', '1', '2']) expect(text).toContain(part);
    expect(weeklyDigestText('S', { assigned: 0, reviewsThisWeek: 0, triage: 0, criticalUnassigned: 0 })).toBeNull();
  });
});

describe('chiffres du résumé', () => {
  const day = (days: number) => new Date(NOW.getTime() + days * 24 * HOUR);
  const base = { status: 'OPEN', severity: 'NORMAL', source: 'DASHBOARD', assigneeId: null as string | null, subjectUserId: null as string | null, reviewAt: null as Date | null };

  test('compte mes dossiers, mes échéances de la semaine, les signalements et les critiques sans référent', () => {
    const counts = digestCounts([
      { ...base, assigneeId: 'me', reviewAt: day(3) },
      { ...base, assigneeId: 'me', reviewAt: day(20) },
      { ...base, source: 'DISCORD' },
      { ...base, severity: 'CRITICAL' },
      { ...base, status: 'CLOSED', assigneeId: 'me' },
      { ...base, source: 'DISCORD', subjectUserId: 'me' },
    ], 'me', NOW);
    expect(counts).toEqual({ assigned: 2, reviewsThisWeek: 1, triage: 1, criticalUnassigned: 1 });
  });

  test('le lundi à partir de 8 h, une fois par semaine', () => {
    const monday9 = new Date('2026-11-30T09:00:00Z');
    expect(digestDue(null, monday9)).toBe(true);
    expect(digestDue(null, new Date('2026-11-30T07:00:00Z'))).toBe(false);
    expect(digestDue(null, new Date('2026-12-01T09:00:00Z'))).toBe(false);
    expect(digestDue(new Date('2026-11-30T08:20:00Z'), monday9)).toBe(false);
    expect(digestDue(new Date('2026-11-23T08:20:00Z'), monday9)).toBe(true);
  });
});
