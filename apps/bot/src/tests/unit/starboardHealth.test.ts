import { describe, expect, test } from 'bun:test';
import { PermissionFlagsBits, type Client } from 'discord.js';
import { starboardChannelHealth } from '../../services/features/starboardHealth.js';

const GUILD = '999999999999999999';
const CHANNEL = '333333333333333333';

function clientWith(options: { guild?: boolean; channel?: boolean; granted?: bigint[] }): Client {
  const granted = new Set(options.granted ?? []);
  const channel = { id: CHANNEL };
  const guild = {
    channels: { cache: new Map(options.channel === false ? [] : [[CHANNEL, channel]]) },
    members: { me: { permissionsIn: () => ({ has: (flag: bigint) => granted.has(flag) }) } },
  };
  return { guilds: { cache: new Map(options.guild === false ? [] : [[GUILD, guild]]) } } as unknown as Client;
}

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
];

describe('starboardChannelHealth', () => {
  test('sans salon configuré : rien à vérifier', () => {
    expect(starboardChannelHealth(clientWith({ granted: ALL }), GUILD, null, true))
      .toEqual({ channelFound: null, missingPermissions: [] });
  });

  test('serveur absent du cache : invérifiable', () => {
    expect(starboardChannelHealth(clientWith({ guild: false }), GUILD, CHANNEL, true))
      .toEqual({ channelFound: null, missingPermissions: [] });
  });

  test('salon supprimé', () => {
    expect(starboardChannelHealth(clientWith({ channel: false }), GUILD, CHANNEL, true))
      .toEqual({ channelFound: false, missingPermissions: [] });
  });

  test('toutes les permissions : rien ne manque', () => {
    expect(starboardChannelHealth(clientWith({ granted: ALL }), GUILD, CHANNEL, true))
      .toEqual({ channelFound: true, missingPermissions: [] });
  });

  test('liste ce qui manque, réactions seulement si le bot amorce les votes', () => {
    const granted = [PermissionFlagsBits.ViewChannel];
    expect(starboardChannelHealth(clientWith({ granted }), GUILD, CHANNEL, true).missingPermissions)
      .toEqual(['SendMessages', 'EmbedLinks', 'AddReactions']);
    expect(starboardChannelHealth(clientWith({ granted }), GUILD, CHANNEL, false).missingPermissions)
      .toEqual(['SendMessages', 'EmbedLinks']);
  });
});
