/**
 * Rôles que le bot ne pourra pas donner, montrés au staff avant que Discord ne
 * refuse : un menu à boutons avant qu'un membre ne clique, une saison avant sa
 * clôture. Même règle que le bot (`roleBlocker` des contrats).
 */
import { roleBlocker, type BotRoleAccess, type RoleBlocker } from '@kotbo/contracts';

export function dashboardRoleBlocker(
  roleId: string,
  roles: Array<{ id: string; position?: number }>,
  access: BotRoleAccess | null,
): RoleBlocker | null {
  // Avant chargement, tout rôle passerait pour supprimé.
  if (!roleId || !access || roles.length === 0) return null;
  const role = roles.find((entry) => entry.id === roleId);
  return roleBlocker({
    // La liste du dashboard écarte les rôles d'intégration : un tel rôle s'y
    // lit comme absent, et le conseil est le même (en choisir un autre).
    exists: !!role,
    managed: false,
    botCanManageRoles: access.canManageRoles,
    rolePosition: role?.position ?? 0,
    botTopPosition: access.topPosition,
  });
}
