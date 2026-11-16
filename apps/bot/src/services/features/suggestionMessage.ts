/**
 * Message public d'une suggestion : un seul constructeur pour la publication,
 * chaque vote et chaque décision, dans la langue du serveur.
 *
 * Aucune lecture ici : les textes arrivent tout faits (voir
 * `suggestionMessageLabels`), pour que le dashboard puisse en montrer l'aperçu
 * avec les mêmes gabarits.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ColorResolvable } from 'discord.js';
import { SUGGESTION_STATUS_COLORS, type SuggestionDecision, type SuggestionStatus } from '@kotbo/shared';
import { resolveEmojiShortcodes } from '../../utils/emojis.js';

/** Gabarits du message ; `votesValue` porte `{up}` et `{down}`, `footer` porte `{id}`. */
export interface SuggestionMessageLabels {
  locale: string;
  title: string;
  statusField: string;
  votesField: string;
  finalVotesField: string;
  votesValue: string;
  responseField: string;
  noResponse: string;
  voteUp: string;
  voteDown: string;
  footer: string;
  status: Record<SuggestionStatus, string>;
}

export interface SuggestionMessageView {
  id: string;
  /** Titre saisi par l'auteur ; sans lui, le titre générique. */
  title: string | null;
  authorName: string;
  authorAvatarUrl: string | null;
  content: string;
  status: SuggestionStatus;
  upvotes: number;
  downvotes: number;
  responseText: string | null;
  votingOpen: boolean;
}

export function fillSuggestionTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (hole, key: string) => (key in values ? String(values[key]) : hole));
}

function voteButton(view: SuggestionMessageView, side: 'up' | 'down', label: string, count: number): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(view.votingOpen ? `suggest_vote:${view.id}:${side}` : `suggest_vote_disabled_${side}:${view.id}`)
    .setLabel(`${label} · ${count}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!view.votingOpen);
}

export function buildSuggestionMessage(view: SuggestionMessageView, labels: SuggestionMessageLabels) {
  const votes = fillSuggestionTemplate(labels.votesValue, { up: view.upvotes, down: view.downvotes });
  const embed = new EmbedBuilder()
    .setTitle(view.title?.trim() || labels.title)
    .setDescription(resolveEmojiShortcodes(view.content))
    .setAuthor(view.authorAvatarUrl ? { name: view.authorName, iconURL: view.authorAvatarUrl } : { name: view.authorName })
    .setColor(SUGGESTION_STATUS_COLORS[view.status] as ColorResolvable)
    .setFooter({ text: fillSuggestionTemplate(labels.footer, { id: view.id }) })
    .setFields(
      { name: labels.statusField, value: labels.status[view.status], inline: true },
      { name: view.votingOpen ? labels.votesField : labels.finalVotesField, value: votes, inline: true },
      ...(view.status === 'PENDING'
        ? []
        : [{ name: labels.responseField, value: view.responseText?.trim() || labels.noResponse, inline: false }]),
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    voteButton(view, 'up', labels.voteUp, view.upvotes),
    voteButton(view, 'down', labels.voteDown, view.downvotes),
  );

  return { embeds: [embed], components: [row] };
}

/** Gabarits de l'avis envoyé à l'auteur ; `title` porte `{server}`. */
export interface SuggestionNoticeLabels {
  title: string;
  contentField: string;
  responseField: string;
  decided: Record<SuggestionDecision, string>;
}

export interface SuggestionNoticeView {
  guildName: string;
  status: SuggestionDecision;
  title: string | null;
  content: string;
  responseText: string | null;
  messageUrl: string | null;
}

/** Valeur d'un champ d'embed : 1 024 caractères au plus. */
const FIELD_MAX = 1024;

function fieldValue(text: string): string {
  return text.length <= FIELD_MAX ? text : `${text.slice(0, FIELD_MAX - 1)}…`;
}

/**
 * Avis de décision pour l'auteur, en message privé ou dans le fil de la
 * suggestion : ce qui a été décidé, sur quelle idée, et pourquoi.
 */
export function buildSuggestionNotice(view: SuggestionNoticeView, labels: SuggestionNoticeLabels): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(fillSuggestionTemplate(labels.title, { server: view.guildName }))
    .setDescription(labels.decided[view.status])
    .setColor(SUGGESTION_STATUS_COLORS[view.status] as ColorResolvable)
    .setFields(
      { name: labels.contentField, value: fieldValue(view.title?.trim() || resolveEmojiShortcodes(view.content)), inline: false },
      ...(view.responseText?.trim()
        ? [{ name: labels.responseField, value: fieldValue(view.responseText.trim()), inline: false }]
        : []),
    );
  if (view.messageUrl) embed.setURL(view.messageUrl);
  return embed;
}

/**
 * Message public de cette suggestion : par le pied de l'embed, ou par les
 * composants quand le message est passé en Components V2 (voir
 * `utils/patchV2.ts`, `message.embeds` y est vide). L'identifiant figure dans
 * les deux, quelle que soit la langue du serveur.
 */
export function isSuggestionMessageFor(
  message: { embeds: ReadonlyArray<{ footer?: { text?: string } | null }>; components: unknown },
  suggestionId: string,
): boolean {
  return message.embeds.some((embed) => embed.footer?.text?.includes(suggestionId))
    || JSON.stringify(message.components).includes(suggestionId);
}
