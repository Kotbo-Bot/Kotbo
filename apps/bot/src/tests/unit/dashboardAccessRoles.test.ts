import { describe, expect, test } from 'bun:test';
import { isManagedRole, withoutManagedRoles } from '../../services/core/dashboardAccessRoles';

/** Serveur factice : seul `roles.cache.get` est lu. */
function fakeGuild(roles: Array<{ id: string; managed: boolean }>) {
  return { roles: { cache: new Map(roles.map((role) => [role.id, role])) } } as unknown as Parameters<typeof isManagedRole>[0];
}

const guild = fakeGuild([
  { id: 'admin', managed: false },
  { id: 'bot', managed: true },
]);

describe('isManagedRole', () => {
  test('reconnaît un rôle géré par Discord', () => {
    expect(isManagedRole(guild, 'bot')).toBe(true);
  });

  test('un rôle humain ou inconnu ne compte pas comme géré', () => {
    expect(isManagedRole(guild, 'admin')).toBe(false);
    expect(isManagedRole(guild, 'supprime')).toBe(false);
  });

  test('sans serveur en cache, rien n’est considéré comme géré', () => {
    expect(isManagedRole(null, 'bot')).toBe(false);
  });
});

describe('withoutManagedRoles', () => {
  test('écarte les règles posées sur un rôle de bot', () => {
    const rules = [{ roleId: 'admin', canView: true }, { roleId: 'bot', canView: true }];
    expect(withoutManagedRoles(guild, rules)).toEqual([{ roleId: 'admin', canView: true }]);
  });

  test('garde tout quand le serveur est introuvable', () => {
    const rules = [{ roleId: 'bot' }];
    expect(withoutManagedRoles(null, rules)).toEqual(rules);
  });
});
