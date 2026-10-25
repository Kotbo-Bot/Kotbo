import type { SlashCommandDefinition } from '../../commands.js';
import { InteractionContextType, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getCachedGuild } from '../../utils/cache.js';
import { errorEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import { buildCountingStatsEmbed } from '../../services/features/countingStatsService.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b2_counting_stats');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setContexts(InteractionContextType.Guild);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const locale = await getEffectiveLocale(interaction);
  const guild = await getCachedGuild(interaction.guildId);

  if (!guild?.funEnabled || !guild.funCountingChannelId) {
    await interaction.reply({
      embeds: [errorEmbed(m.counting_stats_title({}, { locale }), m.counting_stats_disabled({}, { locale }))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = await buildCountingStatsEmbed(interaction.guild, interaction.user.id, guild.funCountingChannelId, locale);
  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

export const countingStatsCommand = { data, execute } satisfies SlashCommandDefinition;
