<script lang="ts">
  import { m } from '../../i18n';
  import { parseMessageFilter } from '@kotbo/shared';

  /**
   * Messages et émojis écoutés par un déclencheur de réaction. Les deux sont
   * saisis en texte libre, relu par le bot : on signale une liste de messages
   * dont aucun identifiant n'est reconnu, qui bloquerait toutes les réactions.
   */
  const {
    messages,
    emojis,
    onChange,
  }: {
    messages: unknown;
    emojis: unknown;
    onChange: (key: 'messages' | 'emojis', value: string) => void;
  } = $props();

  const messageText = $derived(typeof messages === 'string' ? messages : '');
  const emojiText = $derived(typeof emojis === 'string' ? emojis : '');

  const messageUnreadable = $derived(messageText.trim() !== '' && parseMessageFilter(messageText).length === 0);
</script>

<div class="space-y-2">
  <label class="block space-y-1.5">
    <span class="block text-2xs font-medium text-on-surface-variant/80">{m.wf_message_filter_label()}</span>
    <input
      type="text"
      value={messageText}
      oninput={(e) => onChange('messages', e.currentTarget.value)}
      placeholder={m.wf_message_filter_placeholder()}
      class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-field-border text-2xs text-on-surface"
    />
    {#if messageUnreadable}
      <span class="block text-2xs text-warning">{m.wf_message_filter_unreadable()}</span>
    {/if}
  </label>

  <label class="block space-y-1.5">
    <span class="block text-2xs font-medium text-on-surface-variant/80">{m.wf_emoji_filter_label()}</span>
    <input
      type="text"
      value={emojiText}
      oninput={(e) => onChange('emojis', e.currentTarget.value)}
      placeholder={m.wf_emoji_filter_placeholder()}
      class="w-full px-2 py-1 rounded-lg bg-surface-container-highest border border-field-border text-2xs text-on-surface"
    />
  </label>
</div>
