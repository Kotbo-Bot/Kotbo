import { describe, expect, test } from 'bun:test';
import { dashboardRoleBlocker } from './reactionRoleBlockers';

const ROLES = [
  { id: 'bas', position: 2 },
  { id: 'haut', position: 12 },
];
const ACCESS = { canManageRoles: true, topPosition: 10 };

describe('dashboardRoleBlocker', () => {
  test('un rôle sous celui du bot est attribuable', () => {
    expect(dashboardRoleBlocker('bas', ROLES, ACCESS)).toBeNull();
  });

  test('un rôle au-dessus du bot est signalé', () => {
    expect(dashboardRoleBlocker('haut', ROLES, ACCESS)).toBe('too_high');
  });

  test('sans la permission Gérer les rôles, rien n’est attribuable', () => {
    expect(dashboardRoleBlocker('bas', ROLES, { ...ACCESS, canManageRoles: false })).toBe('no_permission');
  });

  test('un rôle absent de la liste (supprimé ou tenu par une intégration) est signalé', () => {
    expect(dashboardRoleBlocker('disparu', ROLES, ACCESS)).toBe('missing');
  });

  test('ne conclut rien tant que les rôles ou l’accès du bot ne sont pas chargés', () => {
    expect(dashboardRoleBlocker('bas', [], ACCESS)).toBeNull();
    expect(dashboardRoleBlocker('bas', ROLES, null)).toBeNull();
    expect(dashboardRoleBlocker('', ROLES, ACCESS)).toBeNull();
  });
});
