import type { Client } from 'discord.js';

/** L'utilisateur administre ce serveur (Administrateur ou Gérer le serveur). */
export async function canManageGuild(client: Client, guildId: string, userId: string): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;
  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  return member.permissions.has('Administrator') || member.permissions.has('ManageGuild');
}
