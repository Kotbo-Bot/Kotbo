import { describe, expect, test } from 'bun:test';
import {
  CLOSED_CASE_RETENTION_DAYS,
  closedCaseCutoff,
  describeConfigChange,
  idListChange,
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
