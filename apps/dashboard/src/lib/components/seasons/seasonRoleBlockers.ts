/**
 * Rôles de récompense qu'une saison ne pourra pas donner à sa clôture, montrés
 * au staff tant qu'il peut encore y remédier. Même règle que le bot.
 */
import type { BotRoleAccess, RoleBlocker } from '@kotbo/contracts';
import { dashboardRoleBlocker } from '../../reactionRoleBlockers';
import { m } from '../../i18n';

export const SEASON_BLOCKER_MESSAGES: Record<RoleBlocker, () => string> = {
  missing: () => m.sea_blocked_missing(),
  managed: () => m.sea_blocked_managed(),
  no_permission: () => m.sea_blocked_no_permission(),
  too_high: () => m.sea_blocked_too_high(),
};

export interface BlockedSeasonRole {
  roleId: string;
  name: string;
  reason: string;
}

/** Raison du refus d'un rôle, `null` s'il sera donné (ou si l'accès du bot est inconnu). */
export function seasonRoleRefusal(
  roleId: string | null,
  roles: Array<{ id: string; position?: number }>,
  access: BotRoleAccess | null,
): string | null {
  const blocker = roleId ? dashboardRoleBlocker(roleId, roles, access) : null;
  return blocker ? SEASON_BLOCKER_MESSAGES[blocker]() : null;
}

export function blockedSeasonRoles(
  roleIds: Array<string | null>,
  roles: Array<{ id: string; name: string; position?: number }>,
  access: BotRoleAccess | null,
): BlockedSeasonRole[] {
  const unique = [...new Set(roleIds.filter((id): id is string => !!id))];
  return unique.flatMap((roleId) => {
    const reason = seasonRoleRefusal(roleId, roles, access);
    return reason ? [{ roleId, name: roles.find((role) => role.id === roleId)?.name ?? roleId, reason }] : [];
  });
}
