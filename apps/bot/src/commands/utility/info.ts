import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, ChannelType, MessageFlags } from 'discord.js';
import { MODULE_REGISTRY } from '@kotbo/contracts';
import { errorEmbed, COLORS, baseEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import { getModuleStates } from '../../services/core/moduleGate.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c6_info');
const FIELD_MAX = 1024;

/** Joint les éléments tant qu'ils tiennent dans `max` caractères, puis ajoute « et N autres ». */
export function joinWithin(items: string[], separator: string, max: number, more: (count: number) => string): string {
  let out = '';
  for (let i = 0; i < items.length; i += 1) {
    const next = out ? `${out}${separator}${items[i]}` : items[i]!;
    const left = items.length - i - 1;
    // Place gardée pour la mention « et N autres » si la liste ne tient pas en entier.
    if (next.length + (left > 0 ? more(left).length + separator.length : 0) > max) {
      const suffix = more(items.length - i);
      return out ? `${out}${separator}${suffix}` : suffix;
    }
    out = next;
  }
  return out;
}

const timestamp = (ms: number, style: 'D' | 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      embeds: [errorEmbed(m.c6_info_no_guild_title({}, { locale }), m.c6_info_no_guild_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  // Guild#fetch passe par l'API avec les compteurs approximatifs : seul moyen fiable d'avoir le nombre en ligne.
  const [guild, states] = await Promise.all([
    interaction.guild.fetch().catch(() => interaction.guild),
    getModuleStates(interaction.guildId),
  ]);
  const more = (count: number) => m.c6_info_and_more({ count }, { locale });

  const channels = guild.channels.cache;
  const countType = (...types: ChannelType[]) => channels.filter((c) => types.includes(c.type)).size;
  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => role.toString());
  const emojis = guild.emojis.cache.map((emoji) => emoji.toString());
  // Le cache des membres n'est complet que s'il a été chargé en entier : sinon le nombre de bots serait faux.
  const bots = guild.members.cache.size >= guild.memberCount
    ? guild.members.cache.filter((member) => member.user.bot).size
    : null;

  const activeModules = MODULE_REGISTRY
    .filter((mod) => !mod.core && states[mod.key] !== false)
    .map((mod) => mod.name);

  const summary = [
    guild.description,
    [
      m.c6_info_members({ count: guild.memberCount }, { locale }),
      guild.approximatePresenceCount != null ? m.c6_info_online({ count: guild.approximatePresenceCount }, { locale }) : null,
      bots != null ? m.c6_info_bots({ count: bots }, { locale }) : null,
    ].filter(Boolean).join(' · '),
    m.c6_info_created({ date: timestamp(guild.createdTimestamp, 'D'), ago: timestamp(guild.createdTimestamp, 'R') }, { locale }),
  ].filter(Boolean).join('\n');

  const stats = [
    m.c6_info_stat_roles({ count: roles.length }, { locale }),
    m.c6_info_stat_channels({
      text: countType(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia),
      voice: countType(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
      categories: countType(ChannelType.GuildCategory),
    }, { locale }),
    m.c6_info_stat_threads({ count: channels.filter((c) => c.isThread()).size }, { locale }),
    m.c6_info_stat_emojis({ emojis: emojis.length, stickers: guild.stickers.cache.size }, { locale }),
    guild.rulesChannelId ? m.c6_info_stat_rules({ channel: `<#${guild.rulesChannelId}>` }, { locale }) : null,
  ].filter(Boolean).join('\n');

  const embed = baseEmbed(COLORS.info, { user: interaction.user })
    .setTitle(guild.name)
    .setDescription(summary)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .setImage(guild.bannerURL({ size: 1024 }))
    .addFields(
      {
        name: m.c6_info_details_title({}, { locale }),
        value: m.c6_info_details_body({
          owner: `<@${guild.ownerId}>`,
          ownerId: guild.ownerId,
          tier: guild.premiumTier,
          boosts: guild.premiumSubscriptionCount ?? 0,
          id: guild.id,
        }, { locale }),
        inline: true,
      },
      { name: m.c6_info_stats_title({}, { locale }), value: stats, inline: true },
      {
        name: m.c6_info_roles_title({ count: roles.length }, { locale }),
        value: roles.length ? joinWithin(roles, ', ', FIELD_MAX, more) : m.c6_info_none({}, { locale }),
      },
      {
        name: m.c6_info_emojis_title({ count: emojis.length }, { locale }),
        value: emojis.length ? joinWithin(emojis, ' ', FIELD_MAX, more) : m.c6_info_none({}, { locale }),
      },
      {
        name: m.c6_info_kotbo_since({}, { locale }),
        value: guild.members.me?.joinedTimestamp ? timestamp(guild.members.me.joinedTimestamp, 'D') : m.c6_info_unknown({}, { locale }),
        inline: true,
      },
      {
        name: m.c6_info_field_modules_title({ count: activeModules.length }, { locale }),
        value: activeModules.length ? joinWithin(activeModules, ' • ', FIELD_MAX, more) : m.c6_info_no_modules({}, { locale }),
        inline: true,
      },
    );

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

export const infoCommand = { data, execute } satisfies SlashCommandDefinition;
