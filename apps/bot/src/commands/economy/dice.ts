import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig, registerGambleAttempt, takeBet, creditBalance } from '../../services/features/economyService.js';
import { COLORS_RAW, errorContainer, kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const DICE_EMOJIS = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

const meta = getCommandMetadata('b3_dice');
const miseMeta = getCommandMetadata('b3_dice_mise');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addIntegerOption(option =>
    option
      .setName(miseMeta.name)
      .setNameLocalizations(miseMeta.nameLocalizations)
      .setDescription(miseMeta.description)
      .setDescriptionLocalizations(miseMeta.descriptionLocalizations)
      .setRequired(true)
      .setMinValue(1)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const bet = interaction.options.getInteger(miseMeta.name, true);
  const locale = await getEffectiveLocale(interaction);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    if (!config.enabled) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.b3_module_disabled_title({}, { locale }), m.b3_economy_disabled_desc({}, { locale })),
      ));
      return;
    }

    const profile = await getOrCreateRpgProfile(guildId, userId);
    if (profile.balance < bet) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.b3_dice_insufficient_title({}, { locale }), m.b3_dice_insufficient_desc({ bet, balance: profile.balance, coins: E.coins }, { locale })),
      ));
      return;
    }

    await registerGambleAttempt(guildId, userId, bet);

    // Mise prise d'avance, par une écriture conditionnelle : le solde lu plus haut a pu
    // bouger depuis, et le gain est ensuite versé par incrément.
    if (!(await takeBet(profile.id, bet))) {
      await interaction.reply(v2Message(
        { flags: MessageFlags.Ephemeral },
        errorContainer(m.b3_dice_insufficient_title({}, { locale }), m.b3_dice_insufficient_desc({ bet, balance: profile.balance, coins: E.coins }, { locale })),
      ));
      return;
    }

    // Roll two dice (1 to 6)
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;

    const emoji1 = DICE_EMOJIS[d1 - 1];
    const emoji2 = DICE_EMOJIS[d2 - 1];

    let multiplier = 0;
    let resultMessage = '';
    let isWin = false;
    let isDraw = false;

    if (d1 === 6 && d2 === 6) {
      multiplier = 3;
      resultMessage = m.b3_dice_double_six({ trophy: E.trophy }, { locale });
      isWin = true;
    } else if (d1 === d2) {
      multiplier = 2;
      resultMessage = m.b3_dice_double({ star: E.star, value: d1 }, { locale });
      isWin = true;
    } else if (sum >= 8) {
      // ×1,4 et non ×1,5 : à ×1,5 le jeu rendait en moyenne 37/36 de la mise, soit un
      // gain garanti sur la durée. À ×1,4 il reste légèrement en faveur de la banque.
      multiplier = 1.4;
      resultMessage = m.b3_dice_win({ success: E.success, sum }, { locale });
      isWin = true;
    } else if (sum === 7) {
      multiplier = 1;
      resultMessage = m.b3_dice_draw({ info: E.info }, { locale });
      isDraw = true;
    } else {
      multiplier = 0;
      resultMessage = m.b3_dice_loss({ error: E.error, sum }, { locale });
    }

    const payout = Math.floor(bet * multiplier);
    const netGain = payout - bet;
    const newBalance = await creditBalance(profile.id, payout);

    let accentColor = COLORS_RAW.danger;
    if (isWin) accentColor = COLORS_RAW.success;
    else if (isDraw) accentColor = COLORS_RAW.info;

    await interaction.reply(v2Message(
      kotboContainer({
        color: accentColor,
        title: m.b3_dice_title({ coins: E.coins }, { locale }),
        fields: [
          m.b3_dice_result_body({ bet, currency: config.currencyEmoji, emoji1, emoji2, sum, result: resultMessage }, { locale }),
          separator({ divider: true, spacing: 'small' }),
          m.b3_dice_gain_body({ arrow: E.arrow, gain: `${netGain >= 0 ? '+' : ''}${netGain}`, currency: config.currencyEmoji, newBalance }, { locale }),
        ],
      }),
    ));
  } catch (err: unknown) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.b3_error_title({}, { locale }), publicErrorMessage(err, m.b3_dice_error_desc({}, { locale }))),
    ));
  }
}

export const diceCommand = { data, execute } satisfies SlashCommandDefinition;
