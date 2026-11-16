/**
 * Ce que le bot peut attribuer sur un serveur, et pourquoi un rôle donné lui
 * serait refusé. La règle vit dans les contrats (`roleBlocker`) : le dashboard
 * l'applique aussi, pour prévenir le staff avant que Discord ne refuse.
 */
import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from 'discord.js';
import { roleBlocker, type BotRoleAccess, type RoleBlocker } from '@kotbo/contracts';

export function botRoleAccessOf(me: GuildMember | null): BotRoleAccess {
  return {
    canManageRoles: me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
    topPosition: me?.roles.highest.position ?? 0,
  };
}

export async function botMember(guild: Guild): Promise<GuildMember | null> {
  return guild.members.me ?? await guild.members.fetchMe().catch(() => null);
}

/** Ce que le bot peut attribuer sur ce serveur : le dashboard en déduit les rôles bloqués. */
export async function getBotRoleAccess(guild: Guild): Promise<BotRoleAccess> {
  return botRoleAccessOf(await botMember(guild));
}

export function roleBlockerOf(role: Role | null | undefined, me: GuildMember | null): RoleBlocker | null {
  const access = botRoleAccessOf(me);
  return roleBlocker({
    exists: !!role,
    managed: role?.managed ?? false,
    botCanManageRoles: access.canManageRoles,
    rolePosition: role?.position ?? 0,
    botTopPosition: access.topPosition,
  });
}
