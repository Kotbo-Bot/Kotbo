/**
 * Rôles Discord de la cellule bien-être et de sa direction. Seul le
 * propriétaire du serveur les distribue (voir events/wellbeingRoleWatch.ts) :
 * les outils de Kotbo refusent d'y toucher.
 */
import type { Client, Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import type { WellbeingActor } from './wellbeingPolicy.js';

export const CELL_ROLE_REFUSAL =
  'Ce rôle donne accès à la cellule bien-être : seul le propriétaire du serveur peut le donner ou le retirer, depuis Discord.';

export async function cellRoleIds(guildId: string): Promise<Set<string>> {
  const config = await prisma.wellbeingConfig.findUnique({
    where: { guildId },
    select: { teamRoleIds: true, directorRoleIds: true },
  });
  return new Set([...(config?.teamRoleIds ?? []), ...(config?.directorRoleIds ?? [])]);
}

/** Serveur Discord, depuis le cache ou l'API ; null si le bot n'y est plus. */
export async function discordGuildOf(client: Client, guildId: string): Promise<Guild | null> {
  return client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
}

/** Une personne telle que la cellule de ce serveur la voit : ses rôles, et si elle en est propriétaire. */
export async function cellActorOf(discordGuild: Guild | null, userId: string): Promise<WellbeingActor> {
  const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
  return {
    userId,
    roleIds: new Set(member ? member.roles.cache.map((r) => r.id) : []),
    isOwner: discordGuild?.ownerId === userId,
  };
}
