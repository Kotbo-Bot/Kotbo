<script lang="ts">
  import { onMount } from 'svelte';
  import { ChannelHeader, MessageList } from '@arcscord/discord-ui-svelte';
  import { API_BASE_URL } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import DiscordScope from '../lib/components/discord/DiscordScope.svelte';
  import { conversationOf, conversationViews, type DiscordConversation } from '../lib/discordConversation';
  import { dateLocale, m } from '../lib/i18n';

  const { transcriptId } = $props<{ transcriptId: string }>();

  /** Transcription JSON (`TranscriptDataV1`), telle que servie par l'API. */
  type TranscriptData = DiscordConversation & {
    channel: { id: string; name: string; topic: string | null };
    generatedAt: string;
    deletedMessageIds?: string[];
  };

  /** Messages ajoutés à chaque tranche : un gros salon s'affiche sans bloquer la page. */
  const PAGE_SIZE = 200;

  let iframeUrl = $state('');
  let transcript = $state<TranscriptData | null>(null);
  let error = $state('');
  let needsLogin = $state(false);
  let visibleCount = $state(PAGE_SIZE);
  let sentinel = $state<HTMLElement | null>(null);

  const loginUrl = $derived(
    `${API_BASE_URL}/api/auth/discord/login?returnTo=${encodeURIComponent(`/transcripts/${transcriptId}`)}`
  );

  const conversation = $derived(transcript ? conversationOf(transcript) : null);
  // Messages supprimés relus dans le journal : signalés à côté du nom de l'auteur.
  const deletedIds = $derived(new Set(transcript?.deletedMessageIds ?? []));
  const views = $derived(
    (conversation ? conversationViews(conversation) : []).map((view) =>
      deletedIds.has(view.id) ? { ...view, author: { ...view.author, tag: { text: m.sev_deleted_badge() } } } : view
    )
  );
  const visibleViews = $derived(views.slice(0, visibleCount));
  const remaining = $derived(Math.max(0, views.length - visibleCount));
  const summary = $derived(transcript
    ? m.d7_ts_summary({
      count: views.length,
      date: new Date(transcript.generatedAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' }),
    })
    : '');

  function showMore() {
    visibleCount += PAGE_SIZE;
  }

  // La tranche suivante se charge quand le bas de la liste approche.
  $effect(() => {
    if (!sentinel || remaining === 0) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMore();
    }, { rootMargin: '800px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  onMount(async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/public/transcripts/${transcriptId}/access`,
        { credentials: 'include' },
      );
      if (response.status === 401) {
        needsLogin = true;
      } else if (response.status === 403) {
        error = m.d7_ts_no_access();
      } else if (response.status === 404) {
        error = m.d7_ts_not_found();
      } else if (response.ok) {
        const data = await response.json() as { format?: string; signedUrl: string };
        const url = `${API_BASE_URL}${data.signedUrl}`;
        if (data.format === 'json') {
          // Transcription JSON : rendue ici par @arcscord/discord-ui. L'historique reste en HTML, en iframe.
          const content = await fetch(url);
          if (!content.ok) throw new Error(String(content.status));
          transcript = await content.json() as TranscriptData;
        } else {
          iframeUrl = url;
        }
      } else {
        error = m.d7_ts_load_fail();
      }
    } catch {
      error = m.d7_ts_load_error();
    }
  });
</script>

<div class="fixed inset-0 w-full h-full bg-[#313338] overflow-hidden flex flex-col">
  {#if needsLogin}
    <div class="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
      <p class="text-white/70 text-sm">
        {m.d7_ts_login_required()}
      </p>
      <a
        href={loginUrl}
        class="flex items-center justify-center gap-2.5 py-2.5 px-4 bg-primary text-on-primary rounded-lg font-medium text-sm hover:opacity-90 transition-opacity"
      >
        <Papicon icon="discord" size={18} />
        {m.d7_ts_login_discord()}
      </a>
    </div>
  {:else if error}
    <div class="flex items-center justify-center h-full text-white/50 text-sm">{error}</div>
  {:else if transcript && conversation}
    <DiscordScope class="transcript-view" entities={conversation.entities}>
      <!-- Colonne centrée, comme les transcriptions historiques et le salon Discord. -->
      <div class="transcript-column">
        <ChannelHeader name={transcript.channel.name} topic={transcript.channel.topic ?? undefined}>
          {#snippet actions()}
            <span class="transcript-summary">{summary}</span>
          {/snippet}
        </ChannelHeader>
        <div class="transcript-messages">
          <MessageList messages={visibleViews} showDateSeparators />
          {#if remaining > 0}
            <div bind:this={sentinel} class="transcript-more">
              <button type="button" onclick={showMore}>{m.d7_ts_show_more({ count: Math.min(PAGE_SIZE, remaining) })}</button>
            </div>
          {/if}
        </div>
      </div>
    </DiscordScope>
  {:else if iframeUrl}
    <iframe
      src={iframeUrl}
      title={m.d7_ts_iframe_title()}
      class="w-full h-full border-none"
    ></iframe>
  {:else}
    <div class="flex items-center justify-center h-full">
      <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
    </div>
  {/if}
</div>

<style>
  :global(.arcscord-discord-ui.transcript-view) {
    height: 100%;
    overflow-y: auto;
  }

  /* Mêmes mesures que l'ancienne page : 900 px de large, 24 px de marge. */
  .transcript-column {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px;
  }

  .transcript-messages {
    padding-top: 1rem;
  }

  .transcript-summary {
    font-size: 0.75rem;
    opacity: 0.7;
    white-space: nowrap;
  }

  .transcript-more {
    display: flex;
    justify-content: center;
    padding: 1rem;
  }

  .transcript-more button {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    font-size: 0.875rem;
  }

  .transcript-more button:hover {
    background: rgba(255, 255, 255, 0.14);
  }
</style>
