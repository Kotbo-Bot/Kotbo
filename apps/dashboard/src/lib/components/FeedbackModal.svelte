<script lang="ts">
  import { explainDisabled } from '../actions/explainDisabled';
  import Papicon from './Papicon.svelte';
  import FormSelect from './FormSelect.svelte';
  import FormTextarea from './FormTextarea.svelte';
  import ActionButton from './ActionButton.svelte';
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

  $effect(() => {
    if (isOpen) {
      type = 'retour';
      message = '';
      view = 'send';
    }
  });

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
  <!-- Premium background mesh glow -->
  <div class="absolute inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.05] overflow-hidden">
    <div class="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-primary rounded-full blur-[100px]"></div>
    <div class="absolute bottom-[20%] right-[-10%] w-[50%] h-[50%] bg-secondary rounded-full blur-none hidden"></div>
  </div>

  <div class="flex gap-1 px-6 pt-4 relative z-10" role="tablist">
    {#each [['send', m.d1_fb_tab_send()], ['mine', m.d1_fb_tab_mine()]] as [id, label] (id)}
      <button
        type="button"
        role="tab"
        aria-selected={view === id}
        onclick={() => (view = id as 'send' | 'mine')}
        class="rounded-full border px-3 h-7 text-xs font-semibold transition
          {view === id ? 'border-primary bg-primary/12 text-primary' : 'border-outline-variant/30 text-on-surface-variant hover:border-primary/40'}"
      >{label}</button>
    {/each}
  </div>

  {#if view === 'mine'}
    <MyFeedbacks />
  {:else}
  <!-- Form Content -->
    <form onsubmit={handleSubmit} class="p-6 space-y-5 relative z-10">
      <!-- Type Selection -->
      <div class="space-y-2">
        <label for="feedback-type" class="text-body-sm font-medium text-on-surface-variant">{m.d1_fb_type_label()}</label>
        <FormSelect id="feedback-type" bind:value={type} className="w-full rounded-lg border border-field-border bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-hidden focus:border-primary/40 focus:ring-4 focus:ring-primary/10 transition-all duration-300">
          <option value="retour">{m.d1_fb_opt_feedback()}</option>
          <option value="bloquage">{m.d1_fb_opt_bug()}</option>
          <option value="suggestion">{m.d1_fb_opt_suggestion()}</option>
          <option value="autre">{m.d1_fb_opt_other()}</option>
        </FormSelect>
      </div>

        <!-- Description Textarea (original) -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <label for="feedback-message" class="text-body-sm font-medium text-on-surface-variant">{m.d1_fb_field_message()}</label>
            <span class="text-2xs font-bold {message.length > 1900 ? 'text-error' : 'text-on-surface-variant'}">
              {message.length} / 2000
            </span>
          </div>
          <FormTextarea
            id="feedback-message"
            bind:value={message}
            rows={5}
            placeholder={m.d1_fb_ph_message()}
            disabled={isSending}
            className="w-full rounded-lg border border-field-border bg-surface-container-low px-4 py-3 text-sm text-on-surface outline-hidden focus:border-primary/40 focus:ring-4 focus:ring-primary/10 transition-all duration-300 resize-none font-medium leading-relaxed placeholder:text-on-surface-variant/40"
          />
        </div>

      <!-- Actions -->
      <div class="flex items-center gap-3 justify-end pt-3 border-t border-outline-variant/20">
        <ActionButton
          label={m.d1_fb_cancel()}
          variant="muted"
          size="md"
          onClick={closeModal}
          disabled={isSending}
        />
        <button
          type="submit"
          disabled={isSending}
          use:explainDisabled={!message.trim() ? m.common_reason_fill_field() : ''}
          class="px-5 py-2.5 text-xs rounded-xl font-semibold bg-primary text-on-primary border border-primary hover:bg-primary-container active:scale-95 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 flex items-center gap-2"
        >
          {#if isSending}
            <div class="w-4 h-4 border-2 border-on-primary border-t-transparent rounded-full animate-spin"></div>
            <span>{m.d1_fb_sending()}</span>
          {:else}
            <Papicon icon="send" size={12} />
            <span>{m.d1_fb_submit()}</span>
          {/if}
        </button>
      </div>
    </form>
  {/if}
</Modal>
