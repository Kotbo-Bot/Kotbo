/**
 * Fenêtre de proposition, ouverte par le bouton du salon ou par `/suggest`
 * sans texte : un titre court facultatif, la catégorie quand le serveur en
 * propose, et le texte de la suggestion.
 */
import {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import { SUGGESTION_TITLE_MAX } from '@kotbo/shared';
import * as m from '../../lib/paraglide/messages.js';
import type { BotLocale } from '../../utils/i18n.js';

export const SUGGESTION_MODAL_ID = 'suggest_form_modal';
const TITLE_FIELD = 'suggestion_title';
const CATEGORY_FIELD = 'suggestion_category';
const CONTENT_FIELD = 'suggestion_content';

/** Bornes du texte saisi dans la fenêtre. */
const CONTENT_MIN = 10;
const CONTENT_MAX = 1000;

export function buildSuggestionModal(locale: BotLocale, categories: readonly string[] = []): ModalBuilder {
  const o = { locale };
  const modal = new ModalBuilder()
    .setCustomId(SUGGESTION_MODAL_ID)
    .setTitle(m.b5_suggest_modal_title({}, o));

  const title = new TextInputBuilder()
    .setCustomId(TITLE_FIELD)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(m.b5_suggest_modal_title_ph({}, o))
    .setRequired(false)
    .setMaxLength(SUGGESTION_TITLE_MAX);
  modal.addLabelComponents(new LabelBuilder().setLabel(m.b5_suggest_modal_title_label({}, o)).setTextInputComponent(title));

  if (categories.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(CATEGORY_FIELD)
      .setPlaceholder(m.b5_suggest_modal_category_ph({}, o))
      .setRequired(false)
      .setMinValues(0)
      .setMaxValues(1)
      .addOptions(categories.slice(0, 25).map((name) => ({ label: name, value: name })));
    modal.addLabelComponents(new LabelBuilder().setLabel(m.b5_suggest_modal_category_label({}, o)).setStringSelectMenuComponent(select));
  }

  const content = new TextInputBuilder()
    .setCustomId(CONTENT_FIELD)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(m.b5_suggest_modal_content_ph({}, o))
    .setRequired(true)
    .setMinLength(CONTENT_MIN)
    .setMaxLength(CONTENT_MAX);
  modal.addLabelComponents(new LabelBuilder().setLabel(m.b5_suggest_modal_content_label({}, o)).setTextInputComponent(content));

  return modal;
}

/** Champs saisis ; titre vide et catégorie non choisie deviennent `null`. */
export function readSuggestionModal(interaction: ModalSubmitInteraction): { title: string | null; category: string | null; content: string } {
  const { fields } = interaction;
  return {
    title: fields.fields.has(TITLE_FIELD) ? fields.getTextInputValue(TITLE_FIELD).trim() || null : null,
    category: fields.fields.has(CATEGORY_FIELD) ? fields.getStringSelectValues(CATEGORY_FIELD)[0] ?? null : null,
    content: fields.getTextInputValue(CONTENT_FIELD),
  };
}
