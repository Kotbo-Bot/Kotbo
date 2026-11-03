/**
 * Pourquoi le bot ne peut pas donner un rôle d'un menu à boutons : le membre
 * reçoit une réponse claire et le staff sait quoi corriger.
 */

import { describe, it, expect } from 'bun:test';
import { roleBlocker, shouldAlertStaff } from '../../services/features/reactionRoleAccess.js';

const OK = { exists: true, managed: false, botCanManageRoles: true, rolePosition: 3, botTopPosition: 10 };

describe('roleBlocker', () => {
  it("laisse passer un rôle placé sous celui du bot", () => {
    expect(roleBlocker(OK)).toBeNull();
  });

  it('signale un rôle supprimé', () => {
    expect(roleBlocker({ ...OK, exists: false })).toBe('missing');
  });

  it("signale un rôle géré par une intégration (bot, boost)", () => {
    expect(roleBlocker({ ...OK, managed: true })).toBe('managed');
  });

  it('signale l\'absence de la permission Gérer les rôles', () => {
    expect(roleBlocker({ ...OK, botCanManageRoles: false })).toBe('no_permission');
  });

  it('signale un rôle au-dessus du rôle le plus haut du bot', () => {
    expect(roleBlocker({ ...OK, rolePosition: 12 })).toBe('too_high');
  });

  it('signale un rôle au même niveau que celui du bot', () => {
    expect(roleBlocker({ ...OK, rolePosition: 10 })).toBe('too_high');
  });
});

describe('shouldAlertStaff', () => {
  const HOUR = 60 * 60 * 1000;

  it('prévient à la première panne', () => {
    expect(shouldAlertStaff(undefined, 1_000)).toBe(true);
  });

  it("ne prévient pas de nouveau dans l'heure", () => {
    expect(shouldAlertStaff(1_000, 1_000 + HOUR - 1)).toBe(false);
  });

  it('prévient de nouveau après une heure', () => {
    expect(shouldAlertStaff(1_000, 1_000 + HOUR)).toBe(true);
  });
});
