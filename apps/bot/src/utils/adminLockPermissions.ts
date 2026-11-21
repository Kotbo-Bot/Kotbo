/**
 * Fonctions pures d'Admin Permission Lock : détection de la permission
 * ADMINISTRATOR dans un bitfield, et résolution du bypass (owner / rôles
 * sécurité). Aucune dépendance à Prisma/DB ou au client Discord - gardé
 * séparé de adminLockService.ts pour rester unitairement testable en
 * isolation (voir apps/bot/src/tests/unit/adminLockService.test.ts).
 */

import { PermissionsBitField } from 'discord.js';

export function roleGrantsAdministrator(bits: bigint): boolean {
  return new PermissionsBitField(bits).has(PermissionsBitField.Flags.Administrator);
}

export function isAdminLockBypassedCore(
  actorId: string,
  ownerId: string,
  actorRoleIds: string[],
  securityRoleIds: string[]
): boolean {
  if (actorId === ownerId) return true;
  return actorRoleIds.some((id) => securityRoleIds.includes(id));
}
