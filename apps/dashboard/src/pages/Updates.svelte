<script lang="ts">
  import { onMount } from 'svelte';
  import { apiRequest } from '../lib/api/client';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import {
    Avatar,
    MessageComponents,
    MessageFrame,
    MessageHeader,
    type ContainerChild,
    type MessageAuthor,
    type MessageComponent,
    type MessageEntities,
  } from '@arcscord/discord-ui-svelte';
  import DiscordScope from '../lib/components/discord/DiscordScope.svelte';
  import { mergeEntities, toPreviewMarkdown } from '../lib/components/discord/previewEntities.svelte';
  import { Button } from '../lib/components/ui';

  const KOTBO_AUTHOR: MessageAuthor = {
    id: 'kotbo',
    displayName: 'Kotbo',
    avatarUrl: '/favicon.svg',
    bot: true,
  };

  function toIsoTimestamp(value: string): string {
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : new Date().toISOString();
  }

  function buildUpdateView(entry: UpdateEntry): {
    components: MessageComponent[];
    entities: MessageEntities;
    timestamp: string;
  } {
    const timestamp = toIsoTimestamp(entry.finishedAt ?? entry.createdAt);
    const unix = Math.floor(new Date(timestamp).getTime() / 1000);
    const children: ContainerChild[] = [];

    if (entry.thumbnailUrl) {
      children.push({
        id: `${entry.id}-header`,
        kind: 'section',
        components: [{ id: `${entry.id}-title`, kind: 'text-display', content: `## ${entry.title}` }],
        accessory: {
          id: `${entry.id}-thumb`,
          kind: 'thumbnail',
          media: { id: `${entry.id}-thumb-media`, url: entry.thumbnailUrl, alt: '' },
        },
      });
    } else {
      children.push({ id: `${entry.id}-title`, kind: 'text-display', content: `## ${entry.title}` });
    }

    children.push({ id: `${entry.id}-sep`, kind: 'separator', divider: true, spacing: 'small' });
    children.push({ id: `${entry.id}-body`, kind: 'text-display', content: entry.message });

    if (entry.imageUrl) {
      children.push({
        id: `${entry.id}-img`,
        kind: 'media-gallery',
        items: [{ id: `${entry.id}-img-media`, url: entry.imageUrl, alt: '' }],
      });
    }

    if (entry.footerText) {
      children.push({ id: `${entry.id}-fsep`, kind: 'separator', divider: false, spacing: 'small' });
      children.push({
        id: `${entry.id}-footer`,
        kind: 'text-display',
        content: `-# ${entry.footerText} • <t:${unix}:d>`,
      });
    }

    const entities = mergeEntities(
      [entry.title, entry.message, entry.footerText ?? '']
        .filter(Boolean)
        .map((text) => toPreviewMarkdown(text, { mentions: false }).entities),
    );

    return {
      timestamp,
      entities,
      components: [
        {
          id: `${entry.id}-container`,
          kind: 'container',
          accentColor: entry.color || '#5865F2',
          components: children,
        },
      ],
    };
  }

  interface PollResults {
    options: { label: string; votes: number }[];
    total: number;
    closesAt: string | null;
  }

  interface UpdateEntry {
    id: string;
    title: string;
    message: string;
    color: string;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string | null;
    pollOptions: string[];
    pollClosesAt: string | null;
    feedbackLabel: string | null;
    pollResults: PollResults | null;
    myVote: number | null;
    myFeedbackCount: number;
    createdAt: string;
    finishedAt: string | null;
  }

  let updates = $state<UpdateEntry[]>([]);
  let loading = $state(true);
  let votingId = $state<string | null>(null);
  let sendingFeedbackId = $state<string | null>(null);
  let feedbackDrafts = $state<Record<string, string>>({});
  let highlightedId = $state<string | null>(null);

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    highlightedId = params.get('id');
    void loadUpdates();
  });

  async function loadUpdates() {
    loading = true;
    try {
      const res = await apiRequest<{ updates: UpdateEntry[] }>('/api/dashboard/updates');
      updates = res.updates ?? [];
      if (highlightedId) {
        setTimeout(() => {
          document.getElementById(`update-${highlightedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_error());
    } finally {
      loading = false;
    }
  }

  function isClosed(entry: UpdateEntry): boolean {
    return Boolean(entry.pollClosesAt && new Date(entry.pollClosesAt).getTime() <= Date.now());
  }

  async function vote(entry: UpdateEntry, optionIndex: number) {
    if (isClosed(entry) || votingId) return;
    votingId = entry.id;
    try {
      const res = await apiRequest<{ ok: boolean; myVote: number; pollResults: PollResults | null }>(
        `/api/dashboard/updates/${entry.id}/vote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            optionIndex,
            guildId: authStore.selectedGuildId || undefined,
          }),
        },
      );
      updates = updates.map((item) =>
        item.id === entry.id
          ? { ...item, myVote: res.myVote, pollResults: res.pollResults ?? item.pollResults }
          : item,
      );
      toast.success(m.upd_poll_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_error());
    } finally {
      votingId = null;
    }
  }

  async function submitFeedback(entry: UpdateEntry) {
    const content = (feedbackDrafts[entry.id] ?? '').trim();
    if (content.length < 5) {
      toast.error(m.upd_feedback_too_short());
      return;
    }
    sendingFeedbackId = entry.id;
    try {
      await apiRequest<{ ok: boolean }>(`/api/dashboard/updates/${entry.id}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          guildId: authStore.selectedGuildId || undefined,
        }),
      });
      feedbackDrafts = { ...feedbackDrafts, [entry.id]: '' };
      updates = updates.map((item) =>
        item.id === entry.id ? { ...item, myFeedbackCount: item.myFeedbackCount + 1 } : item,
      );
      toast.success(m.upd_feedback_sent());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.common_error());
    } finally {
      sendingFeedbackId = null;
    }
  }
</script>

<ModulePage title={m.upd_title()} description={m.upd_subtitle()} icon="megaphone">
  {#snippet actions()}
    <RefreshButton {loading} onclick={loadUpdates} />
  {/snippet}

  {#if loading}
    <div class="space-y-4">
      <Skeleton class="h-44 rounded-2xl" />
      <Skeleton class="h-44 rounded-2xl" />
    </div>
  {:else if updates.length === 0}
    <SectionCard>
      <EmptyState icon="megaphone" title={m.upd_empty_title()} description={m.upd_empty_desc()} reason="accumulating" />
    </SectionCard>
  {:else}
    <div class="space-y-4">
      {#each updates as entry (entry.id)}
        {@const closed = isClosed(entry)}
        {@const isHighlighted = highlightedId === entry.id}
        {@const view = buildUpdateView(entry)}
        <article
          id="update-{entry.id}"
          class="rounded-2xl border bg-surface-container-low overflow-hidden transition {isHighlighted ? 'border-primary ring-2 ring-primary/25' : 'border-outline-variant/25'}"
        >
          <DiscordScope class="updates-discord-message" entities={view.entities}>
            <MessageFrame>
              {#snippet avatar()}<Avatar author={KOTBO_AUTHOR} />{/snippet}
              {#snippet header()}<MessageHeader author={KOTBO_AUTHOR} timestamp={view.timestamp} />{/snippet}
              <MessageComponents components={view.components} />
            </MessageFrame>
          </DiscordScope>

          {#if (entry.pollOptions.length > 0 && entry.pollResults) || entry.feedbackLabel}
            <div class="p-4 sm:p-5 space-y-4 border-t border-outline-variant/20">
              {#if entry.pollOptions.length > 0 && entry.pollResults}
                <div class="rounded-xl border border-outline-variant/25 bg-surface-container-lowest p-4 space-y-3">
                  <div class="flex items-center justify-between gap-2 flex-wrap">
                    <div class="flex items-center gap-2 text-xs font-semibold text-on-surface">
                      <Papicon icon="BarChart3" size={14} />
                      <span>{m.upd_poll_title()}</span>
                      <span class="text-on-surface-variant font-normal">· {m.upd_poll_votes({ count: entry.pollResults.total })}</span>
                    </div>
                    {#if closed}
                      <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-error/12 text-on-error-container">
                        {m.upd_poll_closed()}
                      </span>
                    {:else if entry.pollClosesAt}
                      <span class="text-2xs text-on-surface-variant">
                        {m.upd_poll_closes_at({ date: new Date(entry.pollClosesAt).toLocaleString(dateLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })}
                      </span>
                    {/if}
                  </div>

                  <div class="space-y-2">
                    {#each entry.pollResults.options as opt, idx}
                      {@const pct = entry.pollResults.total > 0 ? Math.round((opt.votes / entry.pollResults.total) * 100) : 0}
                      {@const selected = entry.myVote === idx}
                      <button
                        type="button"
                        disabled={closed || votingId === entry.id}
                        onclick={() => vote(entry, idx)}
                        class="w-full text-left relative overflow-hidden rounded-xl border px-3.5 py-2.5 transition disabled:opacity-65 disabled:cursor-not-allowed {selected ? 'border-primary bg-primary/8' : 'border-outline-variant/25 hover:border-primary/50 bg-surface-container-low/50'}"
                      >
                        <div
                          class="absolute inset-y-0 left-0 transition-all duration-300 {selected ? 'bg-primary/15' : 'bg-on-surface/5'}"
                          style="width: {pct}%"
                        ></div>
                        <div class="relative flex items-center justify-between gap-3 text-xs">
                          <span class="font-semibold text-on-surface flex items-center gap-2">
                            <span>{opt.label}</span>
                            {#if selected}
                              <span class="text-2xs px-1.5 py-0.5 rounded bg-primary/15 text-primary font-semibold">
                                {m.upd_poll_your_vote()}
                              </span>
                            {/if}
                          </span>
                          <span class="tabular-nums text-on-surface-variant font-medium">
                            {opt.votes} ({pct}%)
                          </span>
                        </div>
                      </button>
                    {/each}
                  </div>
                </div>
              {/if}

              {#if entry.feedbackLabel}
                <div class="rounded-xl border border-outline-variant/25 bg-surface-container-lowest p-4 space-y-2.5">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs font-semibold text-on-surface flex items-center gap-1.5">
                      <Papicon icon="MessageSquare" size={14} />
                      <span>{m.upd_feedback_title()}</span>
                    </span>
                    {#if entry.myFeedbackCount > 0}
                      <span class="text-2xs text-success font-medium">
                        {m.upd_feedback_count({ count: entry.myFeedbackCount })}
                      </span>
                    {/if}
                  </div>
                  {#if closed}
                    <p class="text-xs text-error">{m.upd_feedback_closed()}</p>
                  {:else}
                    <textarea
                      rows={3}
                      maxlength={1500}
                      aria-label={m.upd_feedback_title()}
                      placeholder={m.upd_feedback_placeholder()}
                      value={feedbackDrafts[entry.id] ?? ''}
                      oninput={(e) => (feedbackDrafts = { ...feedbackDrafts, [entry.id]: (e.currentTarget as HTMLTextAreaElement).value })}
                      class="w-full rounded-xl bg-surface-container-low border border-field-border px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/60 resize-y"
                    ></textarea>
                    <div class="flex justify-end">
                      <Button
                        size="sm"
                        loading={sendingFeedbackId === entry.id}
                        disabled={(feedbackDrafts[entry.id] ?? '').trim().length < 5}
                        onclick={() => submitFeedback(entry)}
                      >
                        {entry.feedbackLabel}
                      </Button>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</ModulePage>

<style>
  :global(.arcscord-discord-ui.updates-discord-message) {
    padding: 0.75rem 0.25rem;
  }
</style>
