<script lang="ts">
  import { m } from '../../i18n';
  import { Avatar, Markdown, MessageFrame, MessageHeader, type MessageAuthor } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../discord/DiscordScope.svelte';
  import { toPreviewMarkdown } from '../discord/previewEntities.svelte';

  interface Props {
    time: string;
    text: string;
    /** Carte image sous le message, comme celle que le bot génère. */
    card?: { imageUrl: string | null; title: string; subtitle: string } | null;
  }

  let { time, text, card = null }: Props = $props();

  const botAuthor: MessageAuthor = {
    id: 'kotbo',
    displayName: 'Kotbo',
    avatarUrl: '/favicon.svg',
    bot: true,
  };

  const timestamp = $derived.by(() => {
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return new Date().toISOString();
    const date = new Date();
    date.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return date.toISOString();
  });

  const prepared = $derived(toPreviewMarkdown(text));
</script>

<div class="space-y-1.5">
  <span class="text-xs font-semibold text-on-surface-variant ml-2">{m.announcements_discord_preview()}</span>
  <DiscordScope class="announcement-preview" entities={prepared.entities}>
    <MessageFrame>
      {#snippet avatar()}<Avatar author={botAuthor} />{/snippet}
      {#snippet header()}<MessageHeader author={botAuthor} {timestamp} />{/snippet}
      {#if prepared.markdown}
        <Markdown content={prepared.markdown} />
      {/if}
      {#if card}
        <div class="mt-2 w-full max-w-sm aspect-5/2 rounded-xl bg-[#0b0e14] flex items-center justify-center border border-[#5865f2]/30 relative overflow-hidden">
          {#if card.imageUrl}
            <img src={card.imageUrl} alt="" class="absolute inset-0 w-full h-full object-cover opacity-50" />
          {/if}
          <div class="relative flex flex-col items-center gap-1.5 z-10 p-4 text-center">
            <div class="w-12 h-12 rounded-full border border-primary/20 bg-surface-container/85 flex items-center justify-center text-sm font-semibold text-primary">JD</div>
            <span class="text-xs font-semibold text-white leading-none drop-shadow-sm">{card.title}</span>
            <span class="text-2xs font-bold text-[#57f287] leading-none font-sans">JEANDUPONT</span>
            <span class="text-xs text-[#b8bcc8] font-medium">{card.subtitle}</span>
          </div>
        </div>
      {/if}
    </MessageFrame>
  </DiscordScope>
</div>

<style>
  :global(.arcscord-discord-ui.announcement-preview) {
    border-radius: 0.75rem;
    padding: 0.5rem 0;
  }
</style>
