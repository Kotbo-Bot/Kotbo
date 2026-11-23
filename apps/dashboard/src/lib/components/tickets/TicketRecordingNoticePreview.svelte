<script lang="ts">
  /**
   * Avis d'enregistrement tel que le membre le voit, lui seul (message
   * éphémère), avant la création de son ticket.
   */
  import { Message, type MessageView } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../discord/DiscordScope.svelte';
  import { m } from '../../i18n';

  const { text, seconds }: { text: string; seconds: number } = $props();

  const message = $derived<MessageView>({
    id: 'recording-notice',
    author: { id: 'kotbo', displayName: 'Kotbo', avatarUrl: '/favicon.svg', bot: true },
    timestamp: new Date().toISOString(),
    ephemeral: true,
    body: { kind: 'markdown', content: '' },
    embeds: [{
      id: 'notice',
      color: '#5865f2',
      title: `ℹ️ ${m.tn_preview_title()}`,
      description: `${text}\n\n⏳ ${m.tn_preview_countdown({ seconds })}`,
    }],
  });
</script>

<DiscordScope class="tn-preview">
  <Message {message} />
</DiscordScope>

<style>
  :global(.arcscord-discord-ui.tn-preview) {
    border-radius: 0.75rem;
    padding: 0.5rem 0;
  }
</style>
