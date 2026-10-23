import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, type AutocompleteInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import prisma from '../../utils/db.js';
import { adminSpawnItem } from '../../services/features/economyService.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('b3_spawnitem');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription(m.b3_spawnitem_opt_membre({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b3_spawnitem_opt_membre({}, { locale: 'fr' }) })
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('objet')
      .setDescription(m.b3_spawnitem_opt_objet({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b3_spawnitem_opt_objet({}, { locale: 'fr' }) })
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption(option =>
    option
      .setName('quantite')
      .setDescription(m.b3_spawnitem_opt_quantite({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b3_spawnitem_opt_quantite({}, { locale: 'fr' }) })
      .setRequired(false)
      .setMinValue(1)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId!;

  try {
    const items = await prisma.rpgItem.findMany({
      where: {
        OR: [
          { guildId: null },
          { guildId }
        ]
      }
    });

    const choices = items
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
  const targetUser = interaction.options.getUser('membre', true);
  const itemId = interaction.options.getString('objet', true);
  const quantity = interaction.options.getInteger('quantite') ?? 1;
  const locale = await getEffectiveLocale(interaction);

  if (targetUser.bot) {
    await interaction.reply({
      embeds: [errorEmbed(m.b3_error_title({}, { locale }), m.b3_spawnitem_bot_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    const result = await adminSpawnItem(guildId, targetUser.id, itemId, quantity);

    await interaction.reply({
      embeds: [
        successEmbed(
          m.b3_spawnitem_success_title({}, { locale }),
          m.b3_spawnitem_success_desc({ quantity, itemEmoji: result.itemEmoji, itemName: result.itemName, userId: targetUser.id }, { locale })
        )
      ]
    });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b3_error_title({}, { locale }), publicErrorMessage(err, m.b3_spawnitem_error_desc({}, { locale })))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const spawnItemCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
