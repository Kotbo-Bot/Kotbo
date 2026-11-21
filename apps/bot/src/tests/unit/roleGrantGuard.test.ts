import { describe, expect, test } from 'bun:test';
import { PermissionFlagsBits } from 'discord.js';
import { evaluateRoleGrant, type RoleGrantActor, type RoleGrantTarget } from '../../api/shared/roleGrantGuard.js';

const perms = (...flags: bigint[]) => ({ has: (flag: bigint) => flags.includes(flag) });

function actor(overrides: Partial<RoleGrantActor> = {}): RoleGrantActor {
  return {
    isOwner: false,
    isAdministrator: false,
    highestPosition: 5,
    hasPermission: () => false,
    ...overrides,
  };
}

const role = (overrides: Partial<RoleGrantTarget> = {}): RoleGrantTarget => ({
  id: 'r1',
  name: 'Membre',
  position: 2,
  permissions: perms(),
  ...overrides,
});

describe('evaluateRoleGrant', () => {
  test('autorise un rôle inférieur et sans permission critique', () => {
    expect(evaluateRoleGrant(actor(), [role()])).toBeNull();
  });

  test('refuse un rôle de même niveau ou au-dessus du rôle le plus haut de l\'acteur', () => {
    expect(evaluateRoleGrant(actor(), [role({ position: 5 })])).toContain('au-dessus');
    expect(evaluateRoleGrant(actor(), [role({ position: 9 })])).not.toBeNull();
  });

  test('refuse un rôle qui donne un droit critique absent chez l\'acteur', () => {
    const refusal = evaluateRoleGrant(actor(), [role({ position: 1, permissions: perms(PermissionFlagsBits.Administrator) })]);
    expect(refusal).toContain('Administrateur');
  });

  test('autorise ce droit critique quand l\'acteur le possède déjà', () => {
    const allowed = evaluateRoleGrant(
      actor({ hasPermission: (flag) => flag === PermissionFlagsBits.BanMembers }),
      [role({ position: 1, permissions: perms(PermissionFlagsBits.BanMembers) })],
    );
    expect(allowed).toBeNull();
  });

  test('le propriétaire et l\'administrateur ne sont pas limités', () => {
    const risky = role({ position: 50, permissions: perms(PermissionFlagsBits.Administrator) });
    expect(evaluateRoleGrant(actor({ isOwner: true }), [risky])).toBeNull();
    expect(evaluateRoleGrant(actor({ isAdministrator: true }), [risky])).toBeNull();
  });

  test('refuse quand l\'acteur n\'est pas membre du serveur', () => {
    expect(evaluateRoleGrant(null, [role()])).not.toBeNull();
  });
});
