<script lang="ts">
  import DiscordPreview from '../onboarding/DiscordPreview.svelte';
  import DiscordEmbed from '../onboarding/DiscordEmbed.svelte';
  import type { MessagePreview } from '../../workflowReplay';

  /** Message d'automatisation rendu comme dans Discord, texte ou encadré. */
  const { message }: { message: MessagePreview } = $props();
</script>

{#if message.embed}
  <DiscordPreview channel={message.channel}>
    <DiscordEmbed
      color={message.embed.color}
      title={message.embed.title || undefined}
      description={message.embed.description || undefined}
    />
  </DiscordPreview>
{:else}
  <DiscordPreview channel={message.channel} content={message.content} />
{/if}
