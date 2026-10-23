import type { SlashCommandDefinition } from '../../commands.js';
import { Collection, SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('b2_clear');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((option) =>
    option
      .setName('nombre')
      .setDescription(m.b2_clear_opt_nombre({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b2_clear_opt_nombre({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100),
  )
  .addUserOption((option) =>
    option
      .setName('membre')
      .setDescription(m.b2_clear_opt_membre({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b2_clear_opt_membre({}, { locale: 'fr' }) })
      .setRequired(false),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const amount = interaction.options.getInteger('nombre', true);
  const targetUser = interaction.options.getUser('membre');
  const channel = interaction.channel;
  const locale = await getEffectiveLocale(interaction);

  if (!channel || channel.isDMBased() || !('messages' in channel)) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_action_impossible({}, { locale }), m.b2_clear_text_channel_only({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    // Récupérer les messages (on en prend un peu plus si on filtre par utilisateur pour essayer de remplir le quota)
    const limit = targetUser ? Math.min(100, amount * 2) : amount;
    const fetchedMessages = await channel.messages.fetch({ limit });

    let messagesToDelete = fetchedMessages;

    // Filtrer par membre si spécifié
    if (targetUser) {
      // `.first(amount)` renvoie un tableau ; on reconstruit une Collection pour
      // conserver `.size` et bulkDelete plus bas.
      const filtered = fetchedMessages.filter((m) => m.author.id === targetUser.id);
      messagesToDelete = new Collection(filtered.first(amount).map((m) => [m.id, m] as const));
    }

    // Filtrer les messages de moins de 14 jours (limite de l'API de bulkDelete de Discord)
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const deletableMessages = messagesToDelete.filter((m) => m.createdTimestamp > fourteenDaysAgo);

    if (deletableMessages.size === 0) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            m.b2_clear_none_title({}, { locale }),
            m.b2_clear_none_desc({}, { locale }),
          ),
        ],
      });
      return;
    }

    const deleted = await channel.bulkDelete(deletableMessages, true);

    await interaction.editReply({
      embeds: [
        successEmbed(
          m.b2_clear_done_title({}, { locale }),
          targetUser
            ? m.b2_clear_done_desc_user({ count: deleted.size, user: targetUser.toString() }, { locale })
            : m.b2_clear_done_desc({ count: deleted.size }, { locale }),
        ),
      ],
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          m.b2_err_title({}, { locale }),
          m.b2_clear_error({ error: publicErrorMessage(error) }, { locale }),
        ),
      ],
    });
  }
}

export const clearCommand = { data, execute } satisfies SlashCommandDefinition;
