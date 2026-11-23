import type { Guild } from 'discord.js';

/** Noms des mentions et émojis d'un message, au format `MessageEntities` de @arcscord/discord-ui. */
export type MessageEntities = {
  users?: Record<string, { name: string }>;
  roles?: Record<string, { name: string; color?: string }>;
  channels?: Record<string, { name: string }>;
  emojis?: Record<string, { name: string; image: string }>;
};

/**
 * Résout les mentions (`<@id>`, `<@&id>`, `<#id>`) et émojis personnalisés
 * des textes d'un message depuis le cache de la guilde : le dashboard rend le
 * Markdown brut et n'a que les identifiants. Ce qui n'est pas en cache reste
 * absent, la mention s'affiche alors sans nom.
 */
export function msgMentionEntities(texts: Array<string | null | undefined>, guild: Guild | null): MessageEntities {
  const text = texts.filter(Boolean).join('\n');
  const entities: MessageEntities = {};
  if (!text) return entities;

  for (const [, id] of text.matchAll(/<@!?(\d{15,25})>/g)) {
    const name = guild?.members.cache.get(id)?.displayName ?? guild?.client.users.cache.get(id)?.displayName;
    if (name) (entities.users ??= {})[id] = { name };
  }
  for (const [, id] of text.matchAll(/<@&(\d{15,25})>/g)) {
    const role = guild?.roles.cache.get(id);
    if (role) (entities.roles ??= {})[id] = { name: role.name, color: role.color ? role.hexColor : undefined };
  }
  for (const [, id] of text.matchAll(/<#(\d{15,25})>/g)) {
    const channel = guild?.channels.cache.get(id);
    if (channel) (entities.channels ??= {})[id] = { name: channel.name };
  }
  for (const [, animated, name, id] of text.matchAll(/<(a?):(\w{2,32}):(\d{15,25})>/g)) {
    (entities.emojis ??= {})[id] = { name, image: `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=48` };
  }
  return entities;
}
