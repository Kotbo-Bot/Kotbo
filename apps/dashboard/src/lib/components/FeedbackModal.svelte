<script lang="ts">
  import Papicon from './Papicon.svelte';
  import FormTextarea from './FormTextarea.svelte';
  import Button from './ui/Button.svelte';
  import Segmented from './ui/Segmented.svelte';
  import Modal from './Modal.svelte';
  import MyFeedbacks from './MyFeedbacks.svelte';
  import { feedbackModal } from '../stores/feedbackModal.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { toast } from '../stores/toast.svelte';
  import { reportFeedback } from '../api';
  import { m } from '../i18n';

  import { errorMessage } from '@kotbo/shared';
  let type = $state<'retour' | 'bloquage' | 'suggestion' | 'autre'>('retour');
  let message = $state('');
  let isSending = $state(false);
  let view = $state<'send' | 'mine'>('send');

  const isOpen = $derived(feedbackModal.open);

  // Le brouillon survit à une fermeture accidentelle : il ne part qu'après envoi.
  $effect(() => {
    if (isOpen) view = 'send';
  });

  const TYPES = [
    { id: 'retour', icon: 'MessageCircle', label: m.d1_fb_opt_feedback },
    { id: 'bloquage', icon: 'bug_report', label: m.d1_fb_opt_bug },
    { id: 'suggestion', icon: 'lightbulb', label: m.d1_fb_opt_suggestion },
    { id: 'autre', icon: 'more-horizontal', label: m.d1_fb_opt_other },
  ] as const;

  function closeModal() {
    feedbackModal.close();
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();

    if (!message.trim()) {
      toast.warning(m.d1_fb_warn_message());
      return;
    }
    if (message.length > 2000) {
      toast.warning(m.d1_fb_warn_message_length());
      return;
    }

    isSending = true;
    try {
      await reportFeedback({
        type,
        message: message.trim(),
        url: window.location.href,
        guildId: authStore.selectedGuildId
      });
      toast.success(m.d1_fb_feedback_sent());
      type = 'retour';
      message = '';
      closeModal();
    } catch (err) {
      toast.error(errorMessage(err) || m.d1_fb_send_feedback_failed());
    } finally {
      isSending = false;
    }
  }
</script>

<Modal flush
  open={isOpen}
  onClose={closeModal}
  title={m.d1_fb_title_feedback()}
  subtitle={m.d1_fb_subtitle_feedback()}
  size="md"
>
  <div class="px-6 pt-4">
    <Segmented
      stretch
      label={m.d1_fb_title_feedback()}
      options={[
        { value: 'send', label: m.d1_fb_tab_send() },
        { value: 'mine', label: m.d1_fb_tab_mine() },
      ]}
      value={view}
      onchange={(next) => (view = next)}
    />
  </div>

  {#if view === 'mine'}
    <MyFeedbacks onwrite={() => (view = 'send')} />
  {:else}
    <form onsubmit={handleSubmit} class="p-6 space-y-5">
      <fieldset>
        <legend class="text-body-sm font-semibold text-on-surface mb-2">{m.d1_fb_type_label()}</legend>
        <div class="grid grid-cols-2 gap-2">
          {#each TYPES as option (option.id)}
            <label
              class="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-2xl border px-3 py-2 text-sm font-medium text-on-surface transition-colors has-focus-visible:outline-2 has-focus-visible:outline-primary
                {type === option.id ? 'border-primary bg-primary/10' : 'border-outline-variant hover:bg-surface-hover'}"
            >
              <input type="radio" name="feedback-type" value={option.id} bind:group={type} class="sr-only" />
              <Papicon icon={option.icon} size={16} class="shrink-0" />
              <span>{option.label()}</span>
            </label>
          {/each}
        </div>
      </fieldset>

      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <label for="feedback-message" class="text-body-sm font-semibold text-on-surface">{m.d1_fb_field_message()}</label>
          <span class="text-2xs tabular-nums {message.length > 1900 ? 'text-error' : 'text-on-surface-variant'}">
            {message.length} / 2000
          </span>
        </div>
        <FormTextarea
          id="feedback-message"
          bind:value={message}
          rows={5}
          placeholder={m.d1_fb_ph_message()}
          disabled={isSending}
          className="input w-full resize-none text-sm leading-relaxed"
        />
      </div>

      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" onclick={closeModal} disabled={isSending}>{m.d1_fb_cancel()}</Button>
        <Button
          type="submit"
          variant="primary"
          icon="send"
          loading={isSending}
          disabled={!message.trim()}
          disabledReason={m.common_reason_fill_field()}
        >
          {m.d1_fb_submit()}
        </Button>
      </div>
    </form>
  {/if}
</Modal>
