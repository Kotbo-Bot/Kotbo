import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig, registerGambleAttempt, takeBet, creditBalance } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const CHOICES = ['pierre', 'feuille', 'ciseaux'];

function choiceLabel(choice: string, locale: 'fr' | 'en'): string {
  if (choice === 'pierre') return m.b2_rps_rock({}, { locale });
  if (choice === 'feuille') return m.b2_rps_paper({}, { locale });
  return m.b2_rps_scissors({}, { locale });
}

const meta = getCommandMetadata('b2_rps');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption(option =>
    option
      .setName('choix')
      .setDescription(m.b2_rps_opt_choix({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b2_rps_opt_choix({}, { locale: 'fr' }) })
      .setRequired(true)
      .addChoices(
        {
          name: m.b2_rps_choice_pierre({}, { locale: 'en' }),
          name_localizations: { fr: m.b2_rps_choice_pierre({}, { locale: 'fr' }) },
          value: 'pierre',
        },
        {
          name: m.b2_rps_choice_feuille({}, { locale: 'en' }),
          name_localizations: { fr: m.b2_rps_choice_feuille({}, { locale: 'fr' }) },
          value: 'feuille',
        },
        {
          name: m.b2_rps_choice_ciseaux({}, { locale: 'en' }),
          name_localizations: { fr: m.b2_rps_choice_ciseaux({}, { locale: 'fr' }) },
          value: 'ciseaux',
        },
      )
  )
  .addIntegerOption(option =>
    option
      .setName('mise')
      .setDescription(m.b2_rps_opt_mise({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b2_rps_opt_mise({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMinValue(1)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const userChoice = interaction.options.getString('choix', true);
  const bet = interaction.options.getInteger('mise', true);
  const locale = await getEffectiveLocale(interaction);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    if (!config.enabled) {
      await interaction.reply({
        embeds: [errorEmbed(m.b2_economy_disabled_title({}, { locale }), m.b2_economy_disabled_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const profile = await getOrCreateRpgProfile(guildId, userId);
    if (profile.balance < bet) {
      await interaction.reply({
        embeds: [errorEmbed(m.b2_insufficient_balance_title({}, { locale }), m.b2_rps_insufficient_desc({ bet, balance: profile.balance }, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    await registerGambleAttempt(guildId, userId, bet);

    // Mise prise d'avance par une écriture conditionnelle, gain versé par incrément : voir takeBet.
    if (!(await takeBet(profile.id, bet))) {
      await interaction.reply({
        embeds: [errorEmbed(m.b2_insufficient_balance_title({}, { locale }), m.b2_rps_insufficient_desc({ bet, balance: profile.balance }, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    // Bot choice
    const botChoice = CHOICES[Math.floor(Math.random() * CHOICES.length)]!;

    let result = ''; // 'win', 'lose', 'draw'
    if (userChoice === botChoice) {
      result = 'draw';
    } else if (
      (userChoice === 'pierre' && botChoice === 'ciseaux') ||
      (userChoice === 'feuille' && botChoice === 'pierre') ||
      (userChoice === 'ciseaux' && botChoice === 'feuille')
    ) {
      result = 'win';
    } else {
      result = 'lose';
    }

    let multiplier = 0;
    let resultMessage = '';
    let embedColor = COLORS.info;

    if (result === 'win') {
      multiplier = 2;
      resultMessage = m.b2_rps_win({}, { locale });
      embedColor = COLORS.success;
    } else if (result === 'draw') {
      multiplier = 1;
      resultMessage = m.b2_rps_draw({}, { locale });
      embedColor = COLORS.info;
    } else {
      multiplier = 0;
      resultMessage = m.b2_rps_lose({}, { locale });
      embedColor = COLORS.danger;
    }

    const payout = Math.floor(bet * multiplier);
    const netGain = payout - bet;
    const newBalance = await creditBalance(profile.id, payout);

    const embed = new EmbedBuilder()
      .setTitle(m.b2_rps_embed_title({}, { locale }))
      .setDescription(
        m.b2_rps_embed_desc({
          bet,
          emoji: config.currencyEmoji,
          userChoice: choiceLabel(userChoice, locale),
          botChoice: choiceLabel(botChoice, locale),
          result: resultMessage,
          netGain: `${netGain >= 0 ? '+' : ''}${netGain}`,
          newBalance,
        }, { locale })
      )
      .setColor(embedColor)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), publicErrorMessage(err, m.b2_rps_error({}, { locale })))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const rpsCommand = { data, execute } satisfies SlashCommandDefinition;
