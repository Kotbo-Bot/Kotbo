<script lang="ts">
  /**
   * Décision du staff sur une suggestion, posée ou révisée.
   *
   * Une seule fenêtre au lieu d'un formulaire sous chaque carte : le statut se
   * choisit, le commentaire public se rédige, et une suggestion déjà tranchée
   * peut changer d'avis ou être remise en attente.
   */
  import { SUGGESTION_RESPONSE_MAX, suggestionNeedsComment, type SuggestionStatus } from '@kotbo/shared';
  import { decideSuggestion, type SuggestionItem } from '../../api';
  import { m } from '../../i18n';
  import Modal from '../Modal.svelte';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import FilterPills from '../ui/FilterPills.svelte';
  import { suggestionStatusLabel } from './suggestionStatus';

  interface Props {
    open?: boolean;
    suggestion: SuggestionItem | null;
    requireComment: boolean;
    onDone?: (suggestion: SuggestionItem) => void;
  }

  let { open = $bindable(false), suggestion, requireComment, onDone }: Props = $props();

  let status = $state<SuggestionStatus>('APPROVED');
  let comment = $state('');
  let saving = $state(false);

  /** Rouvrir n'a de sens que pour une suggestion déjà tranchée. */
  const statusOptions = $derived(
    (['APPROVED', 'IMPLEMENTED', 'REJECTED', ...(suggestion && suggestion.status !== 'PENDING' ? ['PENDING'] : [])] as SuggestionStatus[])
      .map((value) => ({ value, label: value === 'PENDING' ? m.suggestions_decision_reopen() : suggestionStatusLabel(value) })),
  );

  const reopening = $derived(status === 'PENDING');
  const needsComment = $derived(suggestionNeedsComment(status, requireComment));
  const commentTooLong = $derived(comment.trim().length > SUGGESTION_RESPONSE_MAX);
  const commentMissing = $derived(needsComment && !comment.trim());
  const unchanged = $derived(
    !!suggestion && status === suggestion.status && comment.trim() === (suggestion.responseText ?? '').trim(),
  );
  const blocker = $derived(
    commentMissing ? m.suggestions_decision_comment_required()
      : commentTooLong ? m.suggestions_decision_comment_too_long({ max: SUGGESTION_RESPONSE_MAX })
        : unchanged ? m.suggestions_decision_unchanged()
          : '',
  );

  $effect(() => {
    if (open && suggestion) {
      status = suggestion.status === 'PENDING' ? 'APPROVED' : suggestion.status;
      comment = suggestion.responseText ?? '';
    }
  });

  async function submit() {
    if (!suggestion || blocker) return;
    saving = true;
    try {
      const result = await decideSuggestion(suggestion.id, {
        status,
        responseText: reopening ? null : comment.trim() || null,
      });
      if (!result) return;
      open = false;
      onDone?.(result.suggestion);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  bind:open
  onClose={() => open = false}
  title={suggestion?.status === 'PENDING' ? m.suggestions_decision_title() : m.suggestions_decision_revise_title()}
  subtitle={suggestion ? m.suggestions_decision_subtitle({ name: suggestion.username, up: suggestion.upvotes, down: suggestion.downvotes }) : ''}
  size="md"
>
  {#if suggestion}
    <div class="space-y-5">
      <blockquote class="text-sm leading-relaxed whitespace-pre-wrap bg-surface-container-high/20 border-l-2 border-outline-variant/40 rounded-r-lg px-4 py-3 max-h-48 overflow-y-auto">
        {suggestion.content}
      </blockquote>

      <FilterPills label={m.suggestions_decision_status_label()} options={statusOptions} value={status} onchange={(value) => status = value} />

      {#if reopening}
        <p class="text-xs text-on-surface-variant">{m.suggestions_decision_reopen_hint()}</p>
      {:else}
        <Field
          id="suggestion-decision-comment"
          label={m.suggestions_decision_comment_label()}
          hint={needsComment ? m.suggestions_decision_comment_hint_required() : m.suggestions_decision_comment_hint_optional()}
          error={commentTooLong ? m.suggestions_decision_comment_too_long({ max: SUGGESTION_RESPONSE_MAX }) : undefined}
        >
          {#snippet children(id, describedBy)}
            <textarea
              {id}
              class="input min-h-28 resize-y"
              maxlength={SUGGESTION_RESPONSE_MAX}
              placeholder={m.suggestions_decision_comment_placeholder()}
              bind:value={comment}
              aria-describedby={describedBy}
            ></textarea>
          {/snippet}
        </Field>
        <p class="text-2xs text-on-surface-variant text-right -mt-3">{comment.trim().length} / {SUGGESTION_RESPONSE_MAX}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => open = false}>{m.common_cancel()}</Button>
      <Button
        variant={status === 'REJECTED' ? 'danger' : 'primary'}
        icon={reopening ? 'RotateCcw' : 'Check'}
        loading={saving}
        disabled={!!blocker}
        disabledReason={blocker}
        onclick={submit}
      >
        {reopening ? m.suggestions_decision_submit_reopen() : m.suggestions_decision_submit()}
      </Button>
    </div>
  {/snippet}
</Modal>
