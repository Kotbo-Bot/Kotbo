<!--
  Santé des salons texte : statut (mort, en déclin, saturé, calme, sain, en
  croissance), score sur 100 et suggestion d'action. Le tableau se filtre par
  statut et se trie par score, les plus fragiles en premier.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, FilterPills, SectionCard } from '../ui';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchChannelHealthReport, type ChannelHealthRow, type ChannelHealthStatus } from '../../api';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDelta, fmtDuration, fmtNumber, fmtPct } from './analyticsFormat';

  let rows = $state<ChannelHealthRow[] | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const query = filters.periodQuery;
    const id = ++requestId;
    untrack(() => {
      loading = true;
      error = '';
    });
    fetchChannelHealthReport(query)
      .then((res) => {
        if (id !== requestId) return;
        rows = res?.channels ?? [];
        analyticsExport.channelHealth = rows;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const STATUSES: ChannelHealthStatus[] = ['dead', 'declining', 'saturated', 'quiet', 'healthy', 'growing'];
  const statusLabel = (s: ChannelHealthStatus) =>
    ({ dead: m.anx_ch_dead(), declining: m.anx_ch_declining(), saturated: m.anx_ch_saturated(), quiet: m.anx_ch_quiet(), healthy: m.anx_ch_healthy(), growing: m.anx_ch_growing() })[s];
  const statusTone = (s: ChannelHealthStatus) =>
    s === 'dead' || s === 'declining' ? 'tone-error' : s === 'saturated' || s === 'quiet' ? 'tone-warning' : 'tone-success';
  const suggestionText = (s: ChannelHealthRow['suggestion']) =>
    s === 'archive' ? m.anx_ch_suggest_archive() : s === 'revive' ? m.anx_ch_suggest_revive() : s === 'split' ? m.anx_ch_suggest_split() : s === 'merge' ? m.anx_ch_suggest_merge() : '';

  let filter = $state<ChannelHealthStatus | 'all'>('all');
  const options = $derived([
    { value: 'all' as const, label: m.anx_ch_all(), count: rows?.length ?? 0 },
    ...STATUSES.map((s) => ({ value: s, label: statusLabel(s), count: rows?.filter((r) => r.status === s).length ?? 0 })).filter((o) => o.count > 0),
  ]);
  const visible = $derived((rows ?? []).filter((r) => filter === 'all' || r.status === filter));
</script>

{#if loading && !rows}
  <AnalyticsSkeleton />
{:else if error && !rows}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if rows}
  <SectionCard title={m.anx_ch_title()} description={m.anx_ch_desc()} flush>
    <div class="flex flex-col gap-3 px-5 pt-4" class:opacity-60={loading}>
      <FilterPills label={m.anx_ch_title()} {options} value={filter} onchange={(v) => (filter = v)} />
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">{m.anx_top_channel()}</th>
            <th scope="col">{m.anx_ch_status()}</th>
            <th scope="col" class="num">{m.anx_ch_score()}</th>
            <th scope="col" class="num">{m.anx_ch_per_day()}</th>
            <th scope="col" class="num">{m.anx_table_delta()}</th>
            <th scope="col" class="num">{m.anx_ch_authors()}</th>
            <th scope="col" class="num">{m.anx_resp_median()}</th>
            <th scope="col" class="num">{m.anx_resp_unanswered()}</th>
            <th scope="col">{m.anx_ch_suggestion()}</th>
          </tr>
        </thead>
        <tbody>
          {#each visible as row (row.channelId)}
            <tr>
              <th scope="row">
                <button type="button" class="row-link" onclick={() => channelDetailsModal.show(row.channelId, `#${row.name}`)}>#{row.name}</button>
                {#if row.categoryName}<span class="row-sub">{row.categoryName}</span>{/if}
              </th>
              <td><span class="status {statusTone(row.status)}">{statusLabel(row.status)}</span></td>
              <td class="num">
                <span class="score" title={`${row.score} / 100`}>
                  <span class="score__track" aria-hidden="true"><span class="score__fill" style="width: {row.score}%;"></span></span>
                  {row.score}
                </span>
              </td>
              <td class="num">{fmtNumber(Math.round((row.messages / Math.max(1, row.days)) * 10) / 10)}</td>
              <td class="num">{fmtDelta(relativeDelta(row.messages, row.prevMessages), 'pct')}</td>
              <td class="num">{fmtNumber(row.authors)}</td>
              <td class="num">{fmtDuration(row.medianResponseSec)}</td>
              <td class="num">{row.unansweredRate === null ? '–' : fmtPct(row.unansweredRate)}</td>
              <td class="suggestion">
                {#if row.status === 'dead' && row.lastActiveDaysAgo !== null}
                  {m.anx_ch_last_active({ days: fmtNumber(row.lastActiveDaysAgo) })}.
                {/if}
                {suggestionText(row.suggestion)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </SectionCard>
{/if}

<style>
  .table-wrap {
    max-height: 32rem;
    overflow: auto;
    margin-top: 0.75rem;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .data-table th,
  .data-table td {
    padding: 0.5rem 0.875rem;
    text-align: left;
    border-bottom: 1px solid var(--color-outline-variant);
    white-space: nowrap;
    vertical-align: middle;
  }

  .data-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-surface-container-low);
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .row-link {
    display: block;
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .row-link:hover {
    color: var(--color-primary);
  }

  .row-sub {
    display: block;
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--color-on-surface-variant);
  }

  .status {
    display: inline-flex;
    padding: 0.0625rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .tone-error {
    background: color-mix(in srgb, var(--color-error) 14%, transparent);
    color: var(--color-error);
  }

  .tone-warning {
    background: color-mix(in srgb, var(--color-warning) 16%, transparent);
    color: var(--color-warning);
  }

  .tone-success {
    background: color-mix(in srgb, var(--color-success) 14%, transparent);
    color: var(--color-success);
  }

  .score {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .score__track {
    width: 3.5rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .score__fill {
    display: block;
    height: 100%;
    background: var(--series-1);
  }

  .suggestion {
    white-space: normal !important;
    min-width: 14rem;
    color: var(--color-on-surface-variant);
  }
</style>
