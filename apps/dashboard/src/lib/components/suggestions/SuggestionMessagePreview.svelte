<script lang="ts">
  /**
   * Message public d'une suggestion, tel qu'il tombera dans le salon.
   *
   * Les textes sont ceux du bot dans la langue du serveur (gabarits renvoyés
   * par la route) ; seuls le statut et les votes viennent de la page.
   */
  import { SUGGESTION_STATUS_COLORS, isSuggestionVotingOpen, type SuggestionStatus } from '@kotbo/shared';
  import { m } from '../../i18n';
  import DiscordEmbedPreview from '../DiscordEmbedPreview.svelte';
  import { fillDropTemplate } from '../../dropPreview';
  import type { SuggestionMessageLabels } from '../../api';

  const {
    labels,
    status,
    voteWhileApproved,
  }: {
    labels: SuggestionMessageLabels;
    status: SuggestionStatus;
    voteWhileApproved: boolean;
  } = $props();

  /** Votes d'exemple : de quoi lire les compteurs sans ressembler à un vrai score. */
  const UP = 12;
  const DOWN = 3;

  const votingOpen = $derived(isSuggestionVotingOpen(status, voteWhileApproved));

  const body = $derived([
    m.suggestions_preview_content(),
    '',
    `**${labels.statusField}** : ${labels.status[status]}`,
    `**${votingOpen ? labels.votesField : labels.finalVotesField}** : ${fillDropTemplate(labels.votesValue, { up: String(UP), down: String(DOWN) })}`,
    ...(status === 'PENDING' ? [] : [`**${labels.responseField}** : ${m.suggestions_preview_response()}`]),
  ].join('\n'));
</script>

<DiscordEmbedPreview title={m.suggestions_preview_title()} {body} color={SUGGESTION_STATUS_COLORS[status]}>
  <div class="buttons" aria-hidden="true">
    <span class="button" class:disabled={!votingOpen}>{labels.voteUp} · {UP}</span>
    <span class="button" class:disabled={!votingOpen}>{labels.voteDown} · {DOWN}</span>
  </div>
</DiscordEmbedPreview>

<style>
  .buttons {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  /* Bouton secondaire de Discord, dans le fond sombre de l'aperçu. */
  .button {
    background: #4e5058;
    color: #ffffff;
    border-radius: 0.1875rem;
    padding: 0.125rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    line-height: 1.75rem;
  }

  .button.disabled {
    opacity: 0.5;
  }
</style>
