import {
  Client,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { DiscordPort, SendEmbedParams, DiscordMember, GuildInfo } from '@kotbo/core';

const BUTTON_STYLE_MAP = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  link: ButtonStyle.Link,
} as const;

export class DiscordAdapter implements DiscordPort {
  constructor(private readonly client: Client) {}

  async sendEmbed(params: SendEmbedParams): Promise<{ messageId: string } | null> {
    // Résolu depuis le serveur de la requête : un salon d'un autre serveur n'y est pas trouvé.
    const guild = this.client.guilds.cache.get(params.guildId);
    const channel = await guild?.channels.fetch(params.channelId).catch(() => null);
    if (!channel?.isTextBased()) return null;

    const embed = new EmbedBuilder()
      .setTitle(params.title)
      .setDescription(params.description)
      .setColor(params.color as `#${string}`);

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (params.components?.length) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const comp of params.components) {
        const btn = new ButtonBuilder()
          .setLabel(comp.label)
          .setStyle(BUTTON_STYLE_MAP[comp.style]);
        if (comp.url) btn.setURL(comp.url);
        if (comp.customId) btn.setCustomId(comp.customId);
        row.addComponents(btn);
      }
      components.push(row);
    }

    if (!('send' in channel)) return null;
    const msg = await channel
      .send({ embeds: [embed], components })
      .catch(() => null);
    return msg ? { messageId: msg.id } : null;
  }

  async fetchMember(guildId: string, userId: string): Promise<DiscordMember | null> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return null;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;
    return {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName,
      permissions: member.permissions.toArray(),
      roles: member.roles.cache.map((r) => r.id),
    };
  }

  async addRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return false;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    return member.roles
      .add(roleId)
      .then(() => true)
      .catch(() => false);
  }

  async removeRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return false;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    return member.roles
      .remove(roleId)
      .then(() => true)
      .catch(() => false);
  }

  async getGuildInfo(guildId: string): Promise<GuildInfo | null> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;
    return {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL({ size: 128 }),
      memberCount: guild.memberCount,
    };
  }
}
