import { describe, expect, test } from 'bun:test';
import { wbPeople } from './wellbeingPeople';

const profile = (over: Partial<Parameters<typeof wbPeople>[0][number]> = {}) => ({
  subjectUserId: 'u1', subjectName: 'Alex', subjectLeftAt: null, noteCount: 2, nextExpiry: '2027-01-01T00:00:00Z', ...over,
});
const dossier = (over: Partial<Parameters<typeof wbPeople>[1][number]> = {}) => ({
  id: 'c1', subjectUserId: 'u1', subjectName: 'Alex', status: 'OPEN', ...over,
});

describe('personnes suivies', () => {
  test('une personne avec des notes et des dossiers apparaît une seule fois, avec les deux', () => {
    expect(wbPeople([profile()], [dossier(), dossier({ id: 'c2', status: 'CLOSED' })])).toEqual([
      { userId: 'u1', name: 'Alex', noteCount: 2, nextExpiry: '2027-01-01T00:00:00Z', leftAt: null, activeCases: 1, caseCount: 2 },
    ]);
  });

  test('une personne qui n a que des dossiers a aussi sa page', () => {
    const [person] = wbPeople([], [dossier({ subjectUserId: 'u2', subjectName: 'Sam' })]);
    expect(person).toMatchObject({ userId: 'u2', name: 'Sam', noteCount: 0, activeCases: 1 });
  });

  test('un seul nom par personne : celui de la fiche, sinon celui du dossier le plus récent', () => {
    const withProfile = wbPeople([profile({ subjectName: 'Alex (pseudo actuel)' })], [dossier({ subjectName: 'Alex' })]);
    expect(withProfile[0]?.name).toBe('Alex (pseudo actuel)');
    const casesOnly = wbPeople([], [
      dossier({ id: 'old', subjectUserId: 'u5', subjectName: 'Ancien', updatedAt: '2026-01-01T00:00:00Z' }),
      dossier({ id: 'new', subjectUserId: 'u5', subjectName: 'Récent', updatedAt: '2026-11-01T00:00:00Z' }),
    ]);
    expect(casesOnly[0]?.name).toBe('Récent');
  });

  test('un signalement anonyme, sans personne, reste aux dossiers', () => {
    expect(wbPeople([], [dossier({ subjectUserId: null })])).toEqual([]);
  });

  test('les personnes aux dossiers actifs passent devant, puis par nom', () => {
    const people = wbPeople(
      [profile({ subjectUserId: 'u3', subjectName: 'Zoé' }), profile({ subjectUserId: 'u4', subjectName: 'Bea' })],
      [dossier({ subjectUserId: 'u3', subjectName: 'Zoé' })],
    );
    expect(people.map((person) => person.name)).toEqual(['Zoé', 'Bea']);
  });
});
