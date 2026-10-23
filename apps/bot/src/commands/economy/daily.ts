import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { claimDaily, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { dailyStreakLine } from '../../services/features/rpgPanelService.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';
import { isWhiteLabelInstance } from '../../utils/instanceContext.js';

const meta = getCommandMetadata('b2_daily');

/**
 * Le daily revient chaque jour et Top.gg compte un vote toutes les 12 h : c'est
 * le moment où un membre a le plus de chances de voter. Jamais en marque
 * blanche, où le serveur parle avec son propre bot et non avec Kotbo.
 */
const TOPGG_VOTE_URL = 'https://top.gg/bot/1481651387317354598/vote';

function voteRow(locale: Awaited<ReturnType<typeof getEffectiveLocale>>): ActionRowBuilder<ButtonBuilder>[] {
  if (isWhiteLabelInstance()) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(TOPGG_VOTE_URL).setLabel(m.b2_daily_vote_button({}, { locale })),
    ),
  ];
}

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const locale = await getEffectiveLocale(interaction);

  try {
    const result = await claimDaily(guildId, userId);
    const config = await getOrCreateEconomyConfig(guildId);

    if (!result.success) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            m.b2_daily_unavailable_title({}, { locale }),
            m.b2_daily_unavailable_desc({ hours: result.remainingHours ?? 0, minutes: result.remainingMinutes ?? 0 }, { locale })
          )
        ],
        components: voteRow(locale),
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(m.b2_daily_reward_title({}, { locale }))
      .setDescription(m.b2_daily_reward_desc({ reward: result.reward ?? 0, emoji: config.currencyEmoji, name: config.currencyName }, { locale }))
      .addFields(
        { name: m.b2_daily_new_balance({}, { locale }), value: `**${result.newBalance}** ${config.currencyEmoji}` },
        { name: m.rpg_daily_streak_name({}, { locale }), value: dailyStreakLine(result.streak ?? 1, locale) },
      )
      .setColor(COLORS.success)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], components: voteRow(locale) });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), publicErrorMessage(err, m.b2_daily_error({}, { locale })))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const dailyCommand = { data, execute } satisfies SlashCommandDefinition;
