import { describe, expect, test } from 'bun:test';
import { pickAbsenceSuperiors, type SuperiorStaff } from '../../services/staff/absenceSuperiors.js';

// Grades du plus haut (0) au plus bas.
const roles = [
  { name: 'Admin', sortOrder: 0 },
  { name: 'Superviseur', sortOrder: 1 },
  { name: 'Modérateur', sortOrder: 2 },
  { name: 'Helper', sortOrder: 3 },
];

const member = (id: string, grade: string, extra: Partial<SuperiorStaff> = {}): SuperiorStaff => ({
  id: `sm-${id}`,
  userId: id,
  username: id,
  displayName: id,
  avatarUrl: null,
  grade,
  inTesting: false,
  ...extra,
});

const staff = [
  member('admin', 'Admin'),
  member('sup', 'Superviseur'),
  member('mod2', 'Modérateur'),
  member('helper', 'Helper'),
  member('modTest', 'Modérateur', { inTesting: true }),
  member('me', 'Modérateur'),
];

describe("destinataires d'une absence", () => {
  test('un modérateur voit les grades égaux et supérieurs, pas les inférieurs', () => {
    const ids = pickAbsenceSuperiors({ requesterUserId: 'me', requesterGrade: 'Modérateur', mentorIds: [], staff, roles, owner: null })
      .map((c) => c.userId);
    expect(ids).toEqual(['admin', 'sup', 'mod2']);
  });

  test('le tuteur passe en tête, même de grade inférieur, puis le fondateur hors staff', () => {
    const result = pickAbsenceSuperiors({
      requesterUserId: 'me',
      requesterGrade: 'Modérateur',
      mentorIds: ['sm-helper'],
      staff,
      roles,
      owner: { userId: 'owner', displayName: 'Fondateur', avatarUrl: null },
    });
    expect(result.map((c) => [c.userId, c.reason])).toEqual([
      ['helper', 'tutor'],
      ['owner', 'owner'],
      ['admin', 'rank'],
      ['sup', 'rank'],
      ['mod2', 'rank'],
    ]);
  });

  test("le fondateur inscrit au staff n'apparaît qu'une fois, marqué fondateur", () => {
    const result = pickAbsenceSuperiors({
      requesterUserId: 'me',
      requesterGrade: 'Modérateur',
      mentorIds: [],
      staff,
      roles,
      owner: { userId: 'admin', displayName: 'admin', avatarUrl: null },
    });
    expect(result.filter((c) => c.userId === 'admin')).toEqual([expect.objectContaining({ reason: 'owner' })]);
  });

  test("le fondateur ne se voit pas lui-même et le staff en tutorat n'est pas proposé", () => {
    const ids = pickAbsenceSuperiors({
      requesterUserId: 'owner',
      requesterGrade: null,
      mentorIds: [],
      staff,
      roles,
      owner: { userId: 'owner', displayName: 'Fondateur', avatarUrl: null },
    }).map((c) => c.userId);
    expect(ids).not.toContain('owner');
    expect(ids).not.toContain('modTest');
    expect(ids).toContain('helper');
  });
});
