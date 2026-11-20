/**
 * Message de panneau tenu a jour par le bot : edite s'il existe encore, poste
 * sinon. Partage par les panneaux de recrutement et la liste du staff.
 */
import type { Client, MessageCreateOptions, MessageEditOptions } from 'discord.js';
import { getClient } from './client.js';
import { UserFacingError } from './userFacingError.js';

/** Rend l'identifiant du message, nouveau si l'ancien a disparu. */
export async function upsertPanelMessage(
  channelId: string,
  messageId: string | null,
  payload: MessageCreateOptions & MessageEditOptions,
): Promise<string> {
  const channel = await getClient().channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    throw new UserFacingError('Salon introuvable, ou le bot ne peut pas y écrire.');
  }

  if (messageId) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) {
      await message.edit(payload);
      return message.id;
    }
  }
  return (await channel.send(payload)).id;
}

export async function deletePanelMessage(channelId: string, messageId: string | null): Promise<void> {
  if (!messageId) return;
  const channel = await getClient().channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) await channel.messages.delete(messageId).catch(() => null);
}

/** Le salon existe-t-il sur ce serveur ? Valide un salon choisi au dashboard. */
export async function isGuildChannel(guildId: string, channelId: string): Promise<boolean> {
  if (!/^\d{15,25}$/.test(channelId)) return false;
  const channel = await getClient().channels.fetch(channelId).catch(() => null);
  return !!channel && 'guildId' in channel && channel.guildId === guildId;
}

/**
 * Salon d'un serveur précis, ou `null`. Résolu depuis le serveur et non par `client.channels` :
 * un identifiant de salon venu d'un réglage ne doit jamais atteindre un autre serveur.
 */
export async function fetchGuildChannel(client: Client, guildId: string, channelId: string | null | undefined) {
  if (!channelId) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  return guild.channels.fetch(channelId).catch(() => null);
}
