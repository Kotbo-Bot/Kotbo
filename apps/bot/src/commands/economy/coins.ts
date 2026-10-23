import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorContainer, kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('b3_coins');
const membreMeta = getCommandMetadata('b3_coins_membre');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption(option =>
    option
      .setName(membreMeta.name)
      .setNameLocalizations(membreMeta.nameLocalizations)
      .setDescription(membreMeta.description)
      .setDescriptionLocalizations(membreMeta.descriptionLocalizations)
      .setRequired(false)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const targetUser = interaction.options.getUser(membreMeta.name) ?? interaction.user;
  const locale = await getEffectiveLocale(interaction);

  if (targetUser.bot) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.b3_error_title({}, { locale }), m.b3_coins_bot_error({}, { locale })),
    ));
    return;
  }

  try {
    const profile = await getOrCreateRpgProfile(guildId, targetUser.id);
    const config = await getOrCreateEconomyConfig(guildId);

    await interaction.reply(v2Message(
      kotboContainer({
        color: 'primary',
        title: m.b3_coins_title({ coins: E.coins, name: targetUser.displayName }, { locale }),
        titleThumbnail: { url: targetUser.displayAvatarURL({ size: 128 }) },
        fields: [
          m.b3_coins_balance({ userId: targetUser.id, balance: profile.balance, currencyEmoji: config.currencyEmoji, currencyName: config.currencyName }, { locale }),
        ],
      }),
    ));
  } catch (err: unknown) {
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer(m.b3_error_title({}, { locale }), publicErrorMessage(err, m.b3_coins_error_desc({}, { locale }))),
    ));
  }
}

export const coinsCommand = { data, execute } satisfies SlashCommandDefinition;
