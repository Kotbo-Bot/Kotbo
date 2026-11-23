import type { Guild } from 'discord.js';

type GuildRoles = Pick<Guild, 'roles'>;

/**
 * Un rôle géré par Discord (bot, intégration, booster) ne porte aucun droit sur
 * le dashboard : l'interface ne l'affiche pas, une règle posée dessus ne
 * pourrait plus être retirée, et un humain qui l'obtiendrait en hériterait.
 */
export function isManagedRole(guild: GuildRoles | null | undefined, roleId: string): boolean {
  return guild?.roles.cache.get(roleId)?.managed === true;
}

export function withoutManagedRoles<T extends { roleId: string }>(guild: GuildRoles | null | undefined, rules: T[]): T[] {
  return rules.filter((rule) => !isManagedRole(guild, rule.roleId));
}
