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

type RoleWithPermissions = { permissions: { bitfield: bigint } };
type GuildWithRoles = { roles: { cache: { get(id: string): RoleWithPermissions | undefined } } };

/**
 * Rôle qu'un octroi automatique (réglage, palier, boutique, workflow...) peut
 * donner : jamais l'admin, qui passe par l'Admin Lock et son approbation humaine.
 */
export function isAutoGrantableRole(role: RoleWithPermissions | null | undefined): boolean {
  return !!role && !roleGrantsAdministrator(role.permissions.bitfield);
}

/** Variante par identifiant, résolue dans le cache des rôles du serveur. */
export function isAutoGrantableRoleId(guild: GuildWithRoles, roleId: string): boolean {
  return isAutoGrantableRole(guild.roles.cache.get(roleId));
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
