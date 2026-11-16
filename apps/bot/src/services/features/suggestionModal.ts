/**
 * Fenêtre de proposition, ouverte par le bouton du salon ou par `/suggest`
 * sans texte : un titre court facultatif et le texte de la suggestion.
 */
import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type ModalSubmitInteraction } from 'discord.js';
import { SUGGESTION_TITLE_MAX } from '@kotbo/shared';
import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';

export const SUGGESTION_MODAL_ID = 'suggest_form_modal';
const TITLE_FIELD = 'suggestion_title';
const CONTENT_FIELD = 'suggestion_content';

/** Bornes du texte saisi dans la fenêtre. */
const CONTENT_MIN = 10;
const CONTENT_MAX = 1000;

export function buildSuggestionModal(locale: BotLocale): ModalBuilder {
  const o = { locale };
  const title = new TextInputBuilder()
    .setCustomId(TITLE_FIELD)
    .setLabel(m.b5_suggest_modal_title_label({}, o))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(m.b5_suggest_modal_title_ph({}, o))
    .setRequired(false)
    .setMaxLength(SUGGESTION_TITLE_MAX);

  const content = new TextInputBuilder()
    .setCustomId(CONTENT_FIELD)
    .setLabel(m.b5_suggest_modal_content_label({}, o))
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(m.b5_suggest_modal_content_ph({}, o))
    .setRequired(true)
    .setMinLength(CONTENT_MIN)
    .setMaxLength(CONTENT_MAX);

  return new ModalBuilder()
    .setCustomId(SUGGESTION_MODAL_ID)
    .setTitle(m.b5_suggest_modal_title({}, o))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(title),
      new ActionRowBuilder<TextInputBuilder>().addComponents(content),
    );
}

/** Champs saisis ; le titre vide devient `null`. */
export function readSuggestionModal(interaction: ModalSubmitInteraction): { title: string | null; content: string } {
  return {
    title: interaction.fields.getTextInputValue(TITLE_FIELD).trim() || null,
    content: interaction.fields.getTextInputValue(CONTENT_FIELD),
  };
}
