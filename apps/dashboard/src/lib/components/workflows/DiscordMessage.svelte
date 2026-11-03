<script lang="ts">
  import DiscordPreview from '../onboarding/DiscordPreview.svelte';
  import type { MessagePreview } from '../../workflowReplay';

  /** Message d'automatisation rendu comme dans Discord, texte ou encadré. */
  const { message }: { message: MessagePreview } = $props();
</script>

{#if message.embed}
  <DiscordPreview channel={message.channel}>
    <div class="mt-1 max-w-md rounded border-l-4 bg-[#2b2d31] px-3 py-2.5" style="border-left-color: {message.embed.color}">
      {#if message.embed.title}
        <p class="text-sm font-semibold text-[#f2f3f5] break-words">{message.embed.title}</p>
      {/if}
      {#if message.embed.description}
        <p class="mt-1 text-sm leading-[1.4] text-[#dbdee1] whitespace-pre-wrap break-words">{message.embed.description}</p>
      {/if}
    </div>
  </DiscordPreview>
{:else}
  <DiscordPreview channel={message.channel} content={message.content} />
{/if}
