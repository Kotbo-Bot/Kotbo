import { describe, expect, test } from 'bun:test';
import { blockedSeasonRoles } from './seasonRoleBlockers';
import { m } from '../../i18n';

const roles = [
  { id: 'bas', name: 'Bas', position: 1 },
  { id: 'haut', name: 'Haut', position: 20 },
];
const access = { canManageRoles: true, topPosition: 10 };

describe('blockedSeasonRoles', () => {
  test('rend chaque rôle refusé une fois, avec son nom et sa raison', () => {
    expect(blockedSeasonRoles(['haut', 'bas', null, 'haut', 'disparu'], roles, access)).toEqual([
      { roleId: 'haut', name: 'Haut', reason: m.sea_blocked_too_high() },
      { roleId: 'disparu', name: 'disparu', reason: m.sea_blocked_missing() },
    ]);
  });

  test('sans accès connu, rien n\'est signalé', () => {
    expect(blockedSeasonRoles(['haut'], roles, null)).toEqual([]);
  });

  test('sans la permission, chaque rôle est signalé', () => {
    expect(blockedSeasonRoles(['bas'], roles, { canManageRoles: false, topPosition: 10 }).map((entry) => entry.reason)).toEqual([m.sea_blocked_no_permission()]);
  });
});
