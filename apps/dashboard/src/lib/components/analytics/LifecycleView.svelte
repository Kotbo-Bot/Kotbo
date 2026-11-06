<!--
  Cycle de vie des membres présents : nouveaux, réguliers, occasionnels,
  réactivés, en baisse, dormants, silencieux. Une barre montre la
  répartition, les tuiles l'écart avec la fin de la période d'avant, les
  transitions disent qui a changé de case, et les listes donnent les membres
  à relancer (les plus présents d'avant en premier).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, FilterPills, SectionCard } from '../ui';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchLifecycle, type LifecycleAnalytics, type LifecycleMember, type LifecycleSegment } from '../../api';
  import { memberAvatarSrc } from '../../discordMedia';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters } from './analyticsFilters.svelte';
  import { daysSince, fmtNumber, fmtPct, shortDate, SERIES, SERIES_NEUTRAL } from './analyticsFormat';

  const { onOpenMember }: { onOpenMember?: (userId: string, name: string) => void } = $props();

  let data = $state<LifecycleAnalytics | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const query = filters.query;
    const id = ++requestId;
    untrack(() => {
      loading = true;
      error = '';
    });
    fetchLifecycle(query)
      .then((res) => {
        if (id !== requestId) return;
        data = res;
        analyticsExport.lifecycle = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const ORDER: LifecycleSegment[] = ['new', 'regular', 'casual', 'reactivated', 'declining', 'dormant', 'silent'];
  const COLOR: Record<LifecycleSegment, string> = {
    new: SERIES[0]!,
    regular: SERIES[2]!,
    casual: SERIES[3]!,
    reactivated: SERIES[6]!,
    declining: SERIES[1]!,
    dormant: SERIES[4]!,
    silent: SERIES_NEUTRAL,
  };

  function label(seg: LifecycleSegment): string {
    return {
      new: m.anx_seg_new(), regular: m.anx_seg_regular(), casual: m.anx_seg_casual(), reactivated: m.anx_seg_reactivated(),
      declining: m.anx_seg_declining(), dormant: m.anx_seg_dormant(), silent: m.anx_seg_silent(),
    }[seg];
  }

  function hint(seg: LifecycleSegment): string {
    return {
      new: m.anx_seg_new_hint(), regular: m.anx_seg_regular_hint(), casual: m.anx_seg_casual_hint(), reactivated: m.anx_seg_reactivated_hint(),
      declining: m.anx_seg_declining_hint(), dormant: m.anx_seg_dormant_hint(), silent: m.anx_seg_silent_hint(),
    }[seg];
  }

  const total = $derived(data ? ORDER.reduce((s, seg) => s + data!.counts[seg], 0) : 0);

  type ListKey = 'declining' | 'dormant' | 'reactivated' | 'new';
  let list = $state<ListKey>('declining');
  const members: LifecycleMember[] = $derived(data?.lists[list] ?? []);
  const listOptions = $derived(
    (['declining', 'dormant', 'reactivated', 'new'] as ListKey[]).map((seg) => ({ value: seg, label: label(seg), count: data?.counts[seg] ?? 0 })),
  );

  function delta(seg: LifecycleSegment): number | null {
    if (!data) return null;
    return data.counts[seg] - data.prevCounts[seg];
  }
</script>

{#if loading && !data}
  <AnalyticsSkeleton />
{:else if error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loading}>
    {#if data.channelIgnored}
      <Callout variant="info">{m.anx_channel_filter_ignored()}</Callout>
    {/if}

    <SectionCard title={m.anx_seg_title()} description={m.anx_seg_desc({ date: shortDate(data.asOf), total: fmtNumber(total) })}>
      <div class="seg-bar" role="img" aria-label={ORDER.map((seg) => `${label(seg)} ${fmtNumber(data!.counts[seg])}`).join(', ')}>
        {#each ORDER as seg (seg)}
          {#if data.counts[seg] > 0}
            <span class="seg-bar__part" style="flex-grow: {data.counts[seg]}; background: {COLOR[seg]};" title={`${label(seg)} : ${fmtNumber(data.counts[seg])}`}></span>
          {/if}
        {/each}
      </div>
      <ul class="seg-tiles">
        {#each ORDER as seg (seg)}
          {@const d = delta(seg)}
          <li class="seg-tile" title={hint(seg)}>
            <span class="seg-tile__label"><span class="seg-dot" style="background: {COLOR[seg]};"></span>{label(seg)}</span>
            <span class="seg-tile__value">{fmtNumber(data.counts[seg])}</span>
            <span class="seg-tile__sub">
              {fmtPct(total > 0 ? (data.counts[seg] / total) * 100 : 0)}
              {#if filters.compare && d !== null && d !== 0}
                · <span class={(d > 0) === (seg !== 'declining' && seg !== 'dormant' && seg !== 'silent') ? 'text-success' : 'text-error'}>{d > 0 ? '+' : '−'}{fmtNumber(Math.abs(d))}</span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    </SectionCard>

    <div class="lifecycle-grid">
      <SectionCard title={m.anx_seg_members_title()} description={hint(list)}>
        <div class="flex flex-col gap-3">
          <FilterPills label={m.anx_seg_members_title()} options={listOptions} value={list} onchange={(v) => (list = v)} />
          {#if members.length === 0}
            <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_seg_members_empty()}</p>
          {:else}
            <ul class="seg-members">
              {#each members as member (member.userId)}
                <li>
                  <button type="button" disabled={!onOpenMember} class="seg-member" onclick={() => onOpenMember?.(member.userId, member.name ?? '')}>
                    <img class="seg-member__avatar" src={memberAvatarSrc(member.avatarUrl, member.name, member.userId)} alt="" width="28" height="28" loading="lazy" />
                    <span class="seg-member__name">{member.name ?? m.an_member_fallback()}</span>
                    <span class="seg-member__meta">
                      {#if list === 'new' && member.joinedAt}
                        {m.anx_seg_joined({ date: shortDate(member.joinedAt.slice(0, 10)) })}
                      {:else if member.lastActive}
                        {m.anx_seg_last_seen({ days: fmtNumber(daysSince(member.lastActive) ?? 0) })}
                      {:else}
                        {m.anx_seg_never_seen()}
                      {/if}
                    </span>
                    {#if list !== 'new'}
                      <span class="seg-member__days" title={m.anx_seg_days_hint()}>{fmtNumber(member.previousDays)} → {fmtNumber(member.recentDays)} j</span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </SectionCard>

      <SectionCard title={m.anx_seg_transitions_title()} description={m.anx_seg_transitions_desc({ date: shortDate(data.prevAsOf) })}>
        {#if data.transitions.length === 0}
          <p class="py-6 text-center text-body-sm text-on-surface-variant">{m.anx_seg_transitions_empty()}</p>
        {:else}
          <ul class="transitions">
            {#each data.transitions as t (t.from + t.to)}
              <li class="transition">
                <span class="transition__seg"><span class="seg-dot" style="background: {COLOR[t.from]};"></span>{label(t.from)}</span>
                <span aria-hidden="true" class="text-on-surface-variant">→</span>
                <span class="sr-only">{m.anx_seg_to()}</span>
                <span class="transition__seg"><span class="seg-dot" style="background: {COLOR[t.to]};"></span>{label(t.to)}</span>
                <span class="transition__count">{fmtNumber(t.count)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </SectionCard>
    </div>
  </div>
{/if}

<style>
  .seg-bar {
    display: flex;
    gap: 2px;
    height: 0.875rem;
    margin-top: 0.5rem;
    border-radius: 999px;
    overflow: hidden;
  }

  .seg-bar__part {
    flex-basis: 0;
    min-width: 4px;
  }

  .seg-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
    gap: 0.75rem 1.25rem;
    margin-top: 1rem;
  }

  .seg-tile {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .seg-tile__label {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .seg-tile__value {
    font-family: var(--font-headline);
    font-size: 1.375rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .seg-tile__sub {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .seg-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    flex-shrink: 0;
    border-radius: 999px;
  }

  .lifecycle-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    align-items: start;
  }

  .seg-members {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    max-height: 26rem;
    overflow-y: auto;
  }

  .seg-member {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
  }

  .seg-member:hover:not(:disabled) {
    background: var(--color-surface-container);
  }

  .seg-member:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .seg-member__avatar {
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    border-radius: 999px;
    object-fit: cover;
  }

  .seg-member__name {
    min-width: 0;
    flex: 1;
    font-size: 0.875rem;
    color: var(--color-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .seg-member__meta {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .seg-member__days {
    flex-shrink: 0;
    min-width: 4.5rem;
    text-align: right;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface-variant);
  }

  .transitions {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .transition {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--color-on-surface);
  }

  .transition__seg {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .transition__count {
    margin-left: auto;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
