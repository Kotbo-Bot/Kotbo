/**
 * État du salon des messages à la une, lu dans le cache de ce shard : le
 * dashboard prévient avant que la publication n'échoue en silence.
 */
import { PermissionFlagsBits, type Client } from 'discord.js';

export interface StarboardChannelHealth {
  /** `null` : rien à vérifier (pas de salon) ou serveur hors du cache de ce shard. */
  channelFound: boolean | null;
  /** Noms des permissions manquantes, au format de `PermissionFlagsBits`. */
  missingPermissions: string[];
}

/** Ce que `postHighlight` exige ; les réactions seulement quand le bot amorce le vote. */
const REQUIRED = ['ViewChannel', 'SendMessages', 'EmbedLinks'] as const;

export function starboardChannelHealth(
  client: Client,
  guildId: string,
  channelId: string | null,
  autoReactEmbed: boolean,
): StarboardChannelHealth {
  const unknown = { channelFound: null, missingPermissions: [] };
  if (!channelId) return unknown;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return unknown;

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return { channelFound: false, missingPermissions: [] };

  const me = guild.members.me;
  if (!me) return { channelFound: true, missingPermissions: [] };
  const permissions = me.permissionsIn(channel);
  const required: Array<keyof typeof PermissionFlagsBits> = [...REQUIRED, ...(autoReactEmbed ? ['AddReactions' as const] : [])];
  return {
    channelFound: true,
    missingPermissions: required.filter((name) => !permissions.has(PermissionFlagsBits[name])),
  };
}
