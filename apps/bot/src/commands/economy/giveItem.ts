import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, type AutocompleteInteraction, MessageFlags } from 'discord.js';
import { getOrCreateRpgProfile, giveInventoryItem } from '../../services/features/economyService.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

interface LocalRpgItem {
  id: string;
  name: string;
  emoji: string;
  type: string;
}

interface LocalInventoryEntry {
  itemId: string;
  quantity: number;
  item: LocalRpgItem;
}

const meta = getCommandMetadata('b2_giveitem');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription(m.b2_giveitem_opt_membre({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b2_giveitem_opt_membre({}, { locale: 'fr' }) })
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('objet')
      .setDescription(m.b2_giveitem_opt_objet({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b2_giveitem_opt_objet({}, { locale: 'fr' }) })
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption(option =>
    option
      .setName('quantite')
      .setDescription(m.b2_giveitem_opt_quantite({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b2_giveitem_opt_quantite({}, { locale: 'fr' }) })
      .setRequired(false)
      .setMinValue(1)
  );

async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  try {
    const profile = await getOrCreateRpgProfile(guildId, userId);
    const inventory = profile.inventory as unknown as LocalInventoryEntry[];

    const choices = inventory
      .map(entry => entry.item)
      .filter(item => item.name.toLowerCase().includes(focusedValue))
      .slice(0, 25)
      .map(item => ({
        name: `${item.emoji} ${item.name} (${item.type})`,
        value: item.id
      }));

    await interaction.respond(choices);
  } catch {
    await interaction.respond([]);
  }
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const senderId = interaction.user.id;
  const receiver = interaction.options.getUser('membre', true);
  const itemId = interaction.options.getString('objet', true);
  const quantity = interaction.options.getInteger('quantite') ?? 1;
  const locale = await getEffectiveLocale(interaction);

  if (receiver.bot) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), m.b2_giveitem_to_bot({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  if (receiver.id === senderId) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), m.b2_giveitem_to_self({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    const giftResult = await giveInventoryItem(guildId, senderId, receiver.id, itemId, quantity);

    await interaction.reply({
      embeds: [
        successEmbed(
          m.b2_giveitem_success_title({}, { locale }),
          m.b2_giveitem_success_desc({ quantity, emoji: giftResult.itemEmoji, name: giftResult.itemName, user: `<@${receiver.id}>` }, { locale })
        )
      ]
    });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_giveitem_failed_title({}, { locale }), publicErrorMessage(err, m.b2_giveitem_failed_desc({}, { locale })))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const giveItemCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
