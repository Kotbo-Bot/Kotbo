import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { SUGGESTION_TITLE_MAX } from '@kotbo/shared';
import { createSuggestion } from '../../services/features/suggestionService.js';
import { buildSuggestionModal } from '../../services/features/suggestionModal.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const meta = getCommandMetadata('b5_suggest');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  // Sans texte, la fenêtre de proposition s'ouvre : plus de place qu'une option.
  .addStringOption((o) =>
    o
      .setName('suggestion')
      .setDescription(m.b5_suggest_option_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_suggest_option_desc({}, { locale: 'fr' }) })
      .setRequired(false)
  )
  .addStringOption((o) =>
    o
      .setName('title')
      .setNameLocalizations({ fr: 'titre' })
      .setDescription(m.b5_suggest_opt_title_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_suggest_opt_title_desc({}, { locale: 'fr' }) })
      .setMaxLength(SUGGESTION_TITLE_MAX)
      .setRequired(false)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: m.b5_guild_only({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const content = interaction.options.getString('suggestion');
  if (!content?.trim()) {
    await interaction.showModal(buildSuggestionModal(locale));
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const suggestion = await createSuggestion(
      guildId,
      interaction.user.id,
      interaction.user.username,
      content,
      interaction.client,
      { title: interaction.options.getString('title') },
    );
    await interaction.editReply(m.b5_suggest_success({ id: suggestion.id }, { locale }));
  } catch (err: unknown) {
    await interaction.editReply(m.b5_suggest_error({ error: publicErrorMessage(err, m.b5_unknown_error({}, { locale })) }, { locale }));
  }
}

export const suggestCommand = { data, execute } satisfies SlashCommandDefinition;
