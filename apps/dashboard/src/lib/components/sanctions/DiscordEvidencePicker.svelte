<script lang="ts">
  import Modal from '../Modal.svelte';
  import Papicon from '../Papicon.svelte';
  import DiscordMarkdownText from './DiscordMarkdownText.svelte';
  import DiscordEmbedPreview from './DiscordEmbedPreview.svelte';
  import { fetchSanctionDiscordMessages, generateSanctionDiscordTranscripts } from '../../api';
  import { m, dateLocale } from '../../i18n';

  import { errorMessage } from '@kotbo/shared';
  interface ParsedEmbed {
    color: string | null;
    authorName: string | null;
    authorIconUrl: string | null;
    authorUrl: string | null;
    title: string | null;
    url: string | null;
    description: string | null;
    fields: { name: string; value: string; inline: boolean }[];
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string | null;
    footerIconUrl: string | null;
  }

  interface EvidenceMessage {
    id: string;
    content: string;
    createdAt: string;
    attachments: { url: string; name: string; contentType: string | null; size: number; kind: 'image' | 'video' | 'file' }[];
    embeds: ParsedEmbed[];
    stickers: { id: string; name: string; url: string }[];
  }

  interface EvidenceChannelResult {
    channelId: string;
    channelName: string;
    messages: EvidenceMessage[];
    truncated?: boolean;
  }

  interface VisibleMessage extends EvidenceMessage {
    channelId: string;
    channelName: string;
  }

  let {
    open = $bindable(false),
    guildId,
    sanctionId,
    onImport
  } = $props<{
    open?: boolean;
    guildId: string;
    sanctionId: string;
    onImport: (urls: string[]) => void;
  }>();

  type Step = 'search' | 'messages' | 'generating' | 'done';

  let step = $state<Step>('search');
  let messageLimit = $state(50);
  let loadingMessages = $state(false);
  let messagesError = $state('');
  let targetTag = $state('');
  let channelResults = $state<EvidenceChannelResult[]>([]);
  let selectedMessageIds = $state<Record<string, string[]>>({});
  let activeChannelId = $state('all');
  let searchedChannelCount = $state(0);
  let failedChannelCount = $state(0);
  let truncatedChannelCount = $state(0);

  let generateErrors = $state<Array<{ channelId: string; error: string }>>([]);
  let generateSummary = $state('');

  const totalLoadedCount = $derived(
    channelResults.reduce((sum, channel) => sum + channel.messages.length, 0)
  );

  const totalSelectedCount = $derived(
    Object.values(selectedMessageIds).reduce((sum, ids) => sum + ids.length, 0)
  );

  const visibleMessages = $derived(
    channelResults
      .filter((channel) => activeChannelId === 'all' || channel.channelId === activeChannelId)
      .flatMap((channel) => channel.messages.map((message): VisibleMessage => ({
        ...message,
        channelId: channel.channelId,
        channelName: channel.channelName,
      })))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  );

  const allVisibleSelected = $derived(
    visibleMessages.length > 0
      && visibleMessages.every((message) => (selectedMessageIds[message.channelId] ?? []).includes(message.id))
  );

  $effect(() => {
    if (open) resetState();
  });

  function resetState() {
    step = 'search';
    messageLimit = 50;
    loadingMessages = false;
    messagesError = '';
    targetTag = '';
    channelResults = [];
    selectedMessageIds = {};
    activeChannelId = 'all';
    searchedChannelCount = 0;
    failedChannelCount = 0;
    truncatedChannelCount = 0;
    generateErrors = [];
    generateSummary = '';
  }

  async function loadMessages() {
    messageLimit = Math.min(Math.max(Math.trunc(Number(messageLimit) || 1), 1), 200);
    loadingMessages = true;
    messagesError = '';

    try {
      const data = await fetchSanctionDiscordMessages(sanctionId, messageLimit, guildId);
      targetTag = data?.targetTag ?? '';
      channelResults = data?.channels ?? [];
      searchedChannelCount = data?.searchedChannelCount ?? 0;
      failedChannelCount = data?.failedChannelCount ?? 0;
      truncatedChannelCount = data?.truncatedChannelCount ?? 0;
      selectedMessageIds = {};
      activeChannelId = 'all';
      step = 'messages';
    } catch (err) {
      messagesError = errorMessage(err) || m.sev_fetch_error();
    } finally {
      loadingMessages = false;
    }
  }

  function toggleMessage(channelId: string, messageId: string) {
    const current = selectedMessageIds[channelId] ?? [];
    const next = current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId];
    selectedMessageIds = { ...selectedMessageIds, [channelId]: next };
  }

  function toggleSelectVisible() {
    const next = { ...selectedMessageIds };

    for (const message of visibleMessages) {
      const current = next[message.channelId] ?? [];
      next[message.channelId] = allVisibleSelected
        ? current.filter((id) => id !== message.id)
        : [...new Set([...current, message.id])];
    }

    selectedMessageIds = next;
  }

  async function generateTranscripts() {
    const selections = Object.entries(selectedMessageIds)
      .filter(([, ids]) => ids.length > 0)
      .map(([channelId, messageIds]) => ({ channelId, messageIds }));

    if (selections.length === 0) return;

    step = 'generating';
    generateErrors = [];

    try {
      const data = await generateSanctionDiscordTranscripts(sanctionId, selections, guildId);
      const results = data?.results ?? [];
      generateErrors = data?.errors ?? [];

      if (results.length > 0) {
        onImport(results.map((result: any) => result.url));
      }

      generateSummary = results.length > 0
        ? (results.length > 1
            ? m.sev_transcripts_added_other({ count: results.length })
            : m.sev_transcripts_added_one({ count: results.length }))
        : '';
    } catch (err) {
      generateErrors = [{ channelId: '', error: errorMessage(err) || m.sev_generate_error() }];
    } finally {
      step = 'done';
    }
  }

  function formatTimestamp(iso: string) {
    return new Date(iso).toLocaleString(dateLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function closeModal() {
    open = false;
  }
</script>

<Modal flush bind:open title={m.sev_modal_title()} size="full">
  {#if step === 'search'}
    <form class="flex flex-col gap-6 p-6 sm:p-8" onsubmit={(event) => { event.preventDefault(); loadMessages(); }}>
      <div class="max-w-2xl">
        <p class="text-sm font-semibold text-on-surface">
          {m.sev_intro_title()}
        </p>
        <p class="mt-1.5 text-xs leading-relaxed text-on-surface-variant/65">
          {m.sev_intro_desc()}
        </p>
      </div>

      <div class="max-w-md rounded-xl bg-surface-container-high/25 p-5 ring-1 ring-outline-variant/10">
        <label for="evidence-message-limit" class="text-xs font-medium text-on-surface-variant/55">
          {m.sev_limit_label()}
        </label>
        <div class="mt-2 flex items-center gap-3">
          <input
            id="evidence-message-limit"
            type="number"
            min="1"
            max="200"
            step="1"
            bind:value={messageLimit}
            class="min-w-0 flex-1 rounded-lg border border-outline-variant/15 bg-surface-container-lowest px-4 py-3 text-lg font-semibold tabular-nums text-on-surface outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
          />
          <span class="shrink-0 text-xs font-medium text-on-surface-variant">{m.sev_limit_max()}</span>
        </div>
      </div>

      {#if loadingMessages}
        <div class="grid gap-3 sm:grid-cols-3" aria-label={m.sev_searching_aria()}>
          {#each Array(3) as _}
            <div class="h-20 animate-pulse rounded-xl bg-surface-container-high/35"></div>
          {/each}
        </div>
        <p class="text-xs font-medium text-on-surface-variant">
          {m.sev_searching_hint()}
        </p>
      {/if}

      {#if messagesError}
        <div class="rounded-lg border border-error/20 bg-error/10 p-4 text-xs font-semibold text-error" role="alert">
          {messagesError}
        </div>
      {/if}

      <div class="flex justify-end gap-3 pt-1">
        <button type="button" onclick={closeModal} class="rounded-lg px-6 py-3 text-xs font-semibold text-on-surface-variant transition-colors hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary">
          {m.common_cancel()}
        </button>
        <button
          type="submit"
          disabled={loadingMessages}
          class="inline-flex items-center gap-2 rounded-lg bg-primary px-7 py-3 text-xs font-semibold text-on-primary transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Papicon icon="search" size={14} />
          {m.sev_search_submit()}
        </button>
      </div>
    </form>

  {:else if step === 'messages'}
    <div class="flex min-h-[36rem] flex-col">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant/10 px-5 py-4">
        <div>
          <p class="text-sm font-semibold text-on-surface">
            {totalLoadedCount > 1
              ? m.sev_messages_from_other({ count: totalLoadedCount, target: targetTag || m.sev_target_fallback() })
              : m.sev_messages_from_one({ count: totalLoadedCount, target: targetTag || m.sev_target_fallback() })}
          </p>
          <p class="mt-0.5 text-xs text-on-surface-variant/55">
            {searchedChannelCount > 1
              ? m.sev_channels_scanned_other({ count: searchedChannelCount, withMessages: channelResults.length })
              : m.sev_channels_scanned_one({ count: searchedChannelCount, withMessages: channelResults.length })}
          </p>
        </div>
        <div class="rounded-lg bg-primary/8 px-3 py-2 text-xs font-semibold tabular-nums text-primary">
          {totalSelectedCount > 1 ? m.sev_selected_other({ count: totalSelectedCount }) : m.sev_selected_one({ count: totalSelectedCount })}
        </div>
      </div>

      {#if totalLoadedCount === 0}
        <div class="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-container-high/50 text-on-surface-variant/45">
            <Papicon icon="message-square" size={22} />
          </div>
          <p class="mt-4 text-sm font-semibold text-on-surface">{m.sev_no_recent_message()}</p>
          <p class="mt-1 max-w-md text-xs leading-relaxed text-on-surface-variant/55">
            {searchedChannelCount > 1 ? m.sev_empty_hint_other({ count: searchedChannelCount }) : m.sev_empty_hint_one({ count: searchedChannelCount })}
          </p>
          <button type="button" onclick={() => (step = 'search')} class="mt-6 rounded-lg bg-primary px-6 py-3 text-xs font-semibold text-on-primary active:scale-[0.98]">
            {m.sev_edit_search()}
          </button>
        </div>
      {:else}
        <div class="grid min-h-0 flex-1 md:grid-cols-[14rem_minmax(0,1fr)]">
          <aside class="border-b border-outline-variant/10 bg-surface-container-high/10 p-3 md:border-b-0 md:border-r">
            <p class="px-2 pb-2 pt-1 text-xs font-medium text-on-surface-variant/45">{m.sev_filter_by_channel()}</p>
            <nav class="flex gap-2 overflow-x-auto pb-1 md:max-h-[29rem] md:flex-col md:overflow-y-auto md:pr-1" aria-label={m.sev_channel_filters_aria()}>
              <button
                type="button"
                onclick={() => (activeChannelId = 'all')}
                class="flex min-w-max items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-primary {activeChannelId === 'all' ? 'bg-primary/10 text-primary' : 'text-on-surface-variant/65 hover:bg-surface-container-high/45 hover:text-on-surface'}"
              >
                <span>{m.sev_all_channels()}</span>
                <span class="tabular-nums opacity-65">{totalLoadedCount}</span>
              </button>
              {#each channelResults as channel (channel.channelId)}
                <button
                  type="button"
                  onclick={() => (activeChannelId = channel.channelId)}
                  class="flex min-w-max items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-primary {activeChannelId === channel.channelId ? 'bg-primary/10 text-primary' : 'text-on-surface-variant/65 hover:bg-surface-container-high/45 hover:text-on-surface'}"
                >
                  <span class="max-w-36 truncate"># {channel.channelName}</span>
                  <span class="tabular-nums opacity-65">{channel.messages.length}</span>
                </button>
              {/each}
            </nav>
          </aside>

          <section class="flex min-h-0 flex-col" aria-label={m.sev_messages_found_aria()}>
            <div class="flex items-center justify-between gap-3 border-b border-outline-variant/10 px-4 py-3">
              <p class="text-xs font-medium text-on-surface-variant">
                {visibleMessages.length > 1 ? m.sev_displayed_other({ count: visibleMessages.length }) : m.sev_displayed_one({ count: visibleMessages.length })}
              </p>
              <button type="button" onclick={toggleSelectVisible} class="rounded-md px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/8 focus-visible:outline-2 focus-visible:outline-primary">
                {allVisibleSelected ? m.sev_deselect_all() : m.sev_select_all()}
              </button>
            </div>

            <div class="max-h-[25rem] flex-1 overflow-y-auto">
              {#each visibleMessages as message (message.id)}
                {@const isChecked = (selectedMessageIds[message.channelId] ?? []).includes(message.id)}
                <article class="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-b border-outline-variant/8 p-4 transition-colors {isChecked ? 'bg-primary/5' : 'hover:bg-surface-container-high/15'}">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isChecked}
                    aria-label={isChecked ? m.sev_toggle_remove({ date: formatTimestamp(message.createdAt) }) : m.sev_toggle_include({ date: formatTimestamp(message.createdAt) })}
                    onclick={() => toggleMessage(message.channelId, message.id)}
                    class="mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary {isChecked ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant/35 hover:border-primary/55'}"
                  >
                    {#if isChecked}<Papicon icon="check" size={12} class="text-white" />{/if}
                  </button>

                  <div class="min-w-0">
                    <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span class="text-2xs font-semibold text-primary"># {message.channelName}</span>
                      <span class="text-2xs text-on-surface-variant/45">{formatTimestamp(message.createdAt)}</span>
                    </div>
                    <div class="discord-bubble">
                      {#if message.content}
                        <p class="discord-bubble-text"><DiscordMarkdownText text={message.content} /></p>
                      {:else if message.attachments.length === 0 && message.embeds.length === 0 && message.stickers.length === 0}
                        <p class="discord-bubble-text discord-bubble-empty">{m.sev_no_text()}</p>
                      {/if}

                      {#if message.attachments.length > 0}
                        <div class="mt-2 flex flex-wrap gap-2">
                          {#each message.attachments as attachment}
                            {#if attachment.kind === 'image'}
                              <img src={attachment.url} alt={attachment.name} class="discord-attachment-img" loading="lazy" />
                            {:else if attachment.kind === 'video'}
                              <!-- svelte-ignore a11y_media_has_caption -->
                              <video src={attachment.url} controls class="discord-attachment-video"></video>
                            {:else}
                              <span class="discord-attachment-file">📎 {attachment.name}</span>
                            {/if}
                          {/each}
                        </div>
                      {/if}

                      {#each message.embeds as embed, index (index)}
                        <DiscordEmbedPreview {embed} />
                      {/each}

                      {#if message.stickers.length > 0}
                        <div class="mt-2 flex flex-wrap gap-2">
                          {#each message.stickers as sticker (sticker.id)}
                            <img src={sticker.url} alt={sticker.name} title={sticker.name} class="discord-sticker" />
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          </section>
        </div>

        {#if failedChannelCount > 0 || truncatedChannelCount > 0}
          <div class="border-t border-warning/15 bg-warning/5 px-5 py-2.5 text-2xs font-medium text-warning">
            {#if failedChannelCount > 0}{failedChannelCount > 1 ? m.sev_failed_channels_other({ count: failedChannelCount }) : m.sev_failed_channels_one({ count: failedChannelCount })}{/if}
            {#if failedChannelCount > 0 && truncatedChannelCount > 0} · {/if}
            {#if truncatedChannelCount > 0}{truncatedChannelCount > 1 ? m.sev_truncated_other({ count: truncatedChannelCount }) : m.sev_truncated_one({ count: truncatedChannelCount })}{/if}
          </div>
        {/if}

        <div class="flex flex-wrap justify-end gap-3 border-t border-outline-variant/10 px-5 py-4">
          <p class="mr-auto self-center text-2xs text-on-surface-variant">
            {m.sev_one_transcript_per_channel()}
          </p>
          <button type="button" onclick={() => (step = 'search')} class="rounded-lg px-5 py-3 text-xs font-semibold text-on-surface-variant transition-colors hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary">
            {m.sev_edit_search()}
          </button>
          <button
            type="button"
            onclick={generateTranscripts}
            disabled={totalSelectedCount === 0}
            class="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-xs font-semibold text-on-primary transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Papicon icon="check-circle" size={14} />
            {m.sev_add_to_transcript({ count: totalSelectedCount })}
          </button>
        </div>
      {/if}
    </div>

  {:else if step === 'generating'}
    <div class="flex flex-col items-center justify-center gap-4 px-6 py-20">
      <div class="grid w-full max-w-lg gap-3" aria-label={m.sev_generating()}>
        <div class="h-14 animate-pulse rounded-xl bg-surface-container-high/40"></div>
        <div class="h-14 animate-pulse rounded-xl bg-surface-container-high/25"></div>
      </div>
      <p class="text-body-sm font-medium text-on-surface-variant">
        {m.sev_generating_transcript()}
      </p>
    </div>

  {:else if step === 'done'}
    <div class="flex flex-col gap-4 p-6 sm:p-8">
      {#if generateSummary}
        <div class="rounded-xl bg-success/10 p-4 text-xs font-semibold text-success">
          {generateSummary}
        </div>
      {/if}
      {#each generateErrors as error}
        <div class="rounded-xl bg-error/10 p-4 text-xs font-semibold text-error">
          {error.error}
        </div>
      {/each}
      <div class="flex justify-end pt-2">
        <button type="button" onclick={closeModal} class="rounded-lg bg-primary px-7 py-3 text-xs font-semibold text-on-primary active:scale-[0.98]">
          {m.sev_done()}
        </button>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .discord-bubble {
    background-color: #313338;
    color: #dbdee1;
    border-radius: 8px;
    padding: 10px 12px;
  }

  .discord-bubble-text {
    font-size: 13px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }

  .discord-bubble-empty {
    color: #80848e;
    font-style: italic;
  }

  .discord-attachment-img {
    height: 4rem;
    width: 4rem;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid #1e1f22;
  }

  .discord-attachment-video {
    max-width: 220px;
    max-height: 140px;
    border-radius: 8px;
  }

  .discord-attachment-file {
    font-size: 10px;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 6px;
    background-color: #2b2d31;
    color: #949ba4;
  }

  .discord-sticker {
    width: 80px;
    height: 80px;
    object-fit: contain;
  }
</style>
