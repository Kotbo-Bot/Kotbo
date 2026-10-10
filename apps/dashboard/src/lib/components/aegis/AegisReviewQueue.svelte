<!--
  Détections du module, à vérifier d'abord. Chaque carte dit qui, où, quel
  score, quelle émotion et ce que le bot a fait ; le staff confirme, déclare
  un faux positif (ce que le bot a fait seul est défait) ou lève un mode lent.
  Les mêmes gestes existent sur les cartes Discord.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Callout, EmptyState, FilterPills } from '../ui';
  import Papicon from '../Papicon.svelte';
  import { m, getLocale } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { memberAvatarSrc } from '../../discordMedia';
  import {
    decideAegisDetection,
    fetchAegisDetections,
    type AegisDetection,
    type AegisDetectionStatus,
  } from '../../api';
  import {
    actionLabel,
    EMOTION_COLORS,
    emotionLabel,
    formatDateTime,
    kindLabel,
    points,
    statusLabel,
    zoneOf,
    ZONE_TONE,
  } from './aegisFormat';

  const {
    canReview,
    review,
    auto,
    onchange = () => {},
  }: {
    canReview: boolean;
    review: number;
    auto: number;
    /** Après une décision : la page recompte les détections en attente. */
    onchange?: () => void;
  } = $props();

  type Filter = AegisDetectionStatus | 'ALL';
  let filter = $state<Filter>('PENDING');
  let items = $state<AegisDetection[]>([]);
  let hasMore = $state(false);
  let loading = $state(false);
  let error = $state('');
  let deciding = $state<string | null>(null);

  const filterOptions = $derived<Array<{ value: Filter; label: string }>>([
    { value: 'PENDING', label: m.aegis_filter_pending() },
    { value: 'AUTO', label: m.aegis_filter_auto() },
    { value: 'CONFIRMED', label: m.aegis_filter_confirmed() },
    { value: 'DISMISSED', label: m.aegis_filter_dismissed() },
    { value: 'ALL', label: m.aegis_filter_all() },
  ]);

  async function load(append = false) {
    loading = true;
    error = '';
    try {
      const before = append ? items.at(-1)?.createdAt ?? null : null;
      const res = await fetchAegisDetections({ status: filter === 'ALL' ? null : filter, before });
      items = append ? [...items, ...res.detections] : res.detections;
      hasMore = res.hasMore;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void filter;
    untrack(() => load());
  });

  const DONE: Record<'confirm' | 'dismiss' | 'unslow', () => string> = {
    confirm: () => m.aegis_decided_confirm(),
    dismiss: () => m.aegis_decided_dismiss(),
    unslow: () => m.aegis_decided_unslow(),
  };

  async function decide(item: AegisDetection, decision: 'confirm' | 'dismiss' | 'unslow') {
    deciding = `${item.id}:${decision}`;
    try {
      const { detection } = await decideAegisDetection(item.id, decision);
      // Une carte qui ne correspond plus au filtre sort de la liste.
      items = filter === 'ALL' || detection.status === filter
        ? items.map((d) => (d.id === item.id ? { ...d, ...detection } : d))
        : items.filter((d) => d.id !== item.id);
      toast.success(DONE[decision]());
      onchange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      deciding = null;
    }
  }

  const messageUrl = (d: AegisDetection) => `https://discord.com/channels/${d.guildId}/${d.channelId}/${d.messageId}`;
  const canUnslow = (d: AegisDetection) => d.kind === 'CONFLICT' && d.action === 'SLOWMODE' && !d.restoredAt && d.status !== 'DISMISSED';
  const locale = $derived(getLocale());
</script>

<div class="queue">
  <div class="queue__toolbar">
    <FilterPills label={m.aegis_filter_label()} options={filterOptions} value={filter} onchange={(v) => (filter = v)} />
    <Button size="sm" variant="ghost" icon="refresh-cw" loading={loading} onclick={() => load()} aria-label={m.common_refresh()} />
  </div>

  {#if error}
    <Callout variant="danger">{error}</Callout>
  {:else if !loading && items.length === 0}
    {#if filter === 'PENDING'}
      <EmptyState icon="check-circle" title={m.aegis_empty_pending_title()} description={m.aegis_empty_pending_desc()} />
    {:else}
      <EmptyState icon="inbox" title={m.aegis_empty_title()} description={m.aegis_empty_desc()} />
    {/if}
  {:else}
    <ul class="queue__list" class:opacity-60={loading}>
      {#each items as d (d.id)}
        {@const score = d.toxicity === null ? null : points(d.toxicity)}
        <li class="card">
          <div class="card__head">
            <img class="card__avatar" src={memberAvatarSrc(d.authorAvatar, d.authorName, d.authorId)} alt="" width="32" height="32" loading="lazy" />
            <div class="card__who">
              <p class="card__name">{d.authorName ?? d.authorId}</p>
              <p class="card__meta">
                <span class="badge badge--{d.kind.toLowerCase()}">{kindLabel(d.kind)}</span>
                {#if d.source === 'EDIT'}<span>· {m.aegis_source_EDIT()}</span>{/if}
                {#if d.source === 'NICKNAME'}<span>· {m.aegis_source_NICKNAME()}</span>{:else}<span>· #{d.channelName ?? m.aegis_unknown_channel()}</span>{/if}
                <span>· {formatDateTime(d.createdAt, locale)}</span>
              </p>
            </div>
            <span class="card__status">{statusLabel(d.status)}{d.action !== 'NONE' && d.action !== 'REVIEW' ? ` · ${actionLabel(d.action)}` : ''}</span>
          </div>

          <div class="card__facts">
            {#if score !== null}
              <span class="fact">
                <span class="fact__label">{m.aegis_test_toxicity()}</span>
                <span class="fact__bar" aria-hidden="true"><span style="width: {score}%;" class="fact__fill fact__fill--{zoneOf(score, review, auto)}"></span></span>
                <span class="fact__value tabular-nums {ZONE_TONE[zoneOf(score, review, auto)]}">{score}</span>
              </span>
            {:else if d.kind === 'TOXIC'}
              <span class="fact fact__note">{m.aegis_fallback()}</span>
            {/if}
            {#if d.emotion}
              <span class="fact">
                <span class="emotion-dot" style="background: {EMOTION_COLORS[d.emotion]};" aria-hidden="true"></span>
                {emotionLabel(d.emotion)}{#if d.emotionScore !== null}<span class="text-on-surface-variant tabular-nums"> · {points(d.emotionScore)} %</span>{/if}
              </span>
            {/if}
            {#if d.targetUserId}
              <span class="fact">{m.aegis_target({ name: d.targetName ?? d.targetUserId })}</span>
            {/if}
            {#if d.late}
              <span class="fact text-warning"><Papicon icon="clock" size={13} /> {m.aegis_late()}</span>
            {/if}
          </div>

          {#if d.excerpt}
            <blockquote class="card__excerpt">{d.excerpt}</blockquote>
          {:else if d.kind !== 'CONFLICT'}
            <p class="card__excerpt-missing">{canReview ? m.aegis_excerpt_expired() : m.aegis_excerpt_hidden()}</p>
          {/if}

          {#if canReview && (d.status === 'PENDING' || d.status === 'AUTO' || canUnslow(d))}
            <div class="card__actions">
              {#if d.status === 'PENDING'}
                <Button
                  size="sm"
                  variant={d.kind === 'TOXIC' ? 'danger' : 'primary'}
                  loading={deciding === `${d.id}:confirm`}
                  disabled={deciding !== null}
                  onclick={() => decide(d, 'confirm')}
                >{d.kind === 'TOXIC' ? m.aegis_confirm_toxic() : m.aegis_confirm()}</Button>
              {/if}
              {#if canUnslow(d)}
                <Button size="sm" variant="secondary" loading={deciding === `${d.id}:unslow`} disabled={deciding !== null} onclick={() => decide(d, 'unslow')}>{m.aegis_unslow()}</Button>
              {/if}
              {#if d.status === 'PENDING' || d.status === 'AUTO'}
                <Button size="sm" variant="secondary" loading={deciding === `${d.id}:dismiss`} disabled={deciding !== null} onclick={() => decide(d, 'dismiss')}>
                  {d.kind === 'DISTRESS' ? m.aegis_dismiss_distress() : m.aegis_dismiss()}
                </Button>
              {/if}
              {#if d.messageId && d.status !== 'AUTO' && d.source !== 'NICKNAME'}
                <Button size="sm" variant="ghost" iconRight="external-link" href={messageUrl(d)} target="_blank">{m.aegis_open_message()}</Button>
              {/if}
              {#if d.evidenceUrl}
                <Button size="sm" variant="ghost" icon="file-text" href={d.evidenceUrl} target="_blank">{m.aegis_evidence()}</Button>
              {/if}
            </div>
          {:else if d.evidenceUrl}
            <div class="card__actions">
              <Button size="sm" variant="ghost" icon="file-text" href={d.evidenceUrl} target="_blank">{m.aegis_evidence()}</Button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if hasMore}
      <div class="flex justify-center">
        <Button variant="ghost" loading={loading} onclick={() => load(true)}>{m.aegis_load_more()}</Button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .queue {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .queue__toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .queue__list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container-lowest);
  }

  .card__head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .card__avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .card__who {
    flex: 1;
    min-width: 0;
  }

  .card__name {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-on-surface);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin: 0.125rem 0 0;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .card__status {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .badge {
    display: inline-flex;
    padding: 0.0625rem 0.5rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    background: var(--color-surface-container);
    color: var(--color-on-surface);
  }

  .badge--toxic,
  .badge--harassment {
    background: color-mix(in srgb, var(--color-error) 14%, transparent);
    color: var(--color-error);
  }

  .badge--conflict {
    background: color-mix(in srgb, var(--color-warning) 18%, transparent);
    color: var(--color-on-surface);
  }

  .badge--distress {
    background: color-mix(in srgb, var(--series-1) 16%, transparent);
    color: var(--color-on-surface);
  }

  .card__facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface);
  }

  .fact {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .fact__label {
    color: var(--color-on-surface-variant);
  }

  .fact__note {
    color: var(--color-on-surface-variant);
  }

  .fact__bar {
    position: relative;
    width: 5rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .fact__fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 999px;
  }

  .fact__fill--none { background: var(--color-success); }
  .fact__fill--review { background: var(--color-warning); }
  .fact__fill--auto { background: var(--color-error); }

  .fact__value {
    font-weight: 600;
  }

  .emotion-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
  }

  .card__excerpt {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-left: 3px solid var(--color-outline-variant);
    border-radius: 0 0.375rem 0.375rem 0;
    background: var(--color-surface-container-low);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--color-on-surface);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .card__excerpt-missing {
    margin: 0;
    font-size: 0.75rem;
    font-style: italic;
    color: var(--color-on-surface-variant);
  }

  .card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  @media (max-width: 40rem) {
    .card__head {
      flex-wrap: wrap;
    }

    .card__status {
      width: 100%;
    }
  }
</style>
