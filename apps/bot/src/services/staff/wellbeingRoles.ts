/**
 * Rôles Discord de la cellule de suivi et de sa direction. Seul le
 * propriétaire du serveur les distribue (voir events/wellbeingRoleWatch.ts) :
 * les outils de Kotbo refusent d'y toucher.
 */
import type { Client, Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { shouldLoadAllMembers, type WellbeingActor } from './wellbeingAccessPolicy.js';

export const CELL_ROLE_REFUSAL =
  'Ce rôle donne accès à la cellule de suivi : seul le propriétaire du serveur peut le donner ou le retirer, depuis Discord.';

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

/** Dernier chargement complet des membres, par serveur. */
const membersLoadedAt = new Map<string, number>();

/**
 * Complète le cache des membres quand la cellule passe par des rôles : sans
 * cela, un membre de la cellule absent du cache ne serait proposé nulle part.
 * Un échec laisse le cache tel quel.
 */
export async function loadCellMembers(guild: Guild | null, teamRoleIds: readonly string[]): Promise<void> {
  if (!guild) return;
  const now = Date.now();
  if (!shouldLoadAllMembers({ teamRoleIds, cacheSize: guild.members.cache.size, memberCount: guild.memberCount, lastLoadedAt: membersLoadedAt.get(guild.id), now })) return;
  membersLoadedAt.set(guild.id, now);
  await guild.members.fetch().catch((error) => logger.warn('Wellbeing', `Membres de ${guild.id} non chargés :`, error));
}
