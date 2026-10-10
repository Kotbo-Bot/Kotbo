<!--
  D'où viennent les arrivées et quand partent les membres : arrivées par
  source jour par jour (empilées), départs selon l'ancienneté, et part des
  arrivés repartis en moins de 24 heures (souvent des comptes venus voir et
  déçus par l'accueil, ou des robots).
-->
<script lang="ts">
  import { Callout, SectionCard } from '../ui';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import TimeSeriesChart from './TimeSeriesChart.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchGrowthInsights, type GrowthInsights } from '../../api';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtNumber, fmtPct, shortDate, SERIES, SERIES_NEUTRAL } from './analyticsFormat';

  const loader = analyticsLoader(() => fetchGrowthInsights(filters.periodQuery), 'growthInsights');
  const data = $derived(loader.data as GrowthInsights | null);

  const sourceLabel = (g: GrowthInsights['sources']['groups'][number]) =>
    g.kind === 'unknown' ? m.anx_funnel_source_unknown() : g.kind === 'vanity' ? m.anx_funnel_source_vanity({ code: g.label ?? '' }) : (g.label ?? g.key);

  const stacks = $derived(
    data
      ? [
          ...data.sources.groups.map((g, i) => ({ label: sourceLabel(g), values: g.values, color: SERIES[i]! })),
          ...(data.sources.other.some((v) => v > 0) ? [{ label: m.anx_breakdown_other(), values: data.sources.other, color: SERIES_NEUTRAL }] : []),
        ]
      : [],
  );

  const tenureLabel = (key: string) =>
    ({ under1d: m.anx_tenure_1d(), under7d: m.anx_tenure_7d(), under30d: m.anx_tenure_30d(), under180d: m.anx_tenure_180d(), over180d: m.anx_tenure_more() })[key] ?? key;
  const maxTenure = $derived(Math.max(1, ...(data?.departures.byTenure.map((b) => b.count) ?? [1])));

  const tiles: MetricTab[] = $derived(
    data
      ? [
          { id: 'joined', label: m.anx_funnel_joined(), value: fmtNumber(data.quickLeave.joined), color: SERIES[0] },
          { id: 'left', label: m.anx_growth_left(), value: fmtNumber(data.departures.total), color: SERIES[0] },
          {
            id: 'quick',
            label: m.anx_growth_quick_leave(),
            hint: m.anx_growth_quick_leave_hint(),
            value: data.quickLeave.rate === null ? '—' : fmtPct(data.quickLeave.rate),
            delta: data.quickLeave.rate !== null && data.quickLeave.previousRate ? relativeDelta(data.quickLeave.rate, data.quickLeave.previousRate) : undefined,
            invert: true,
            color: SERIES[0],
          },
        ]
      : [],
  );
</script>

{#if loader.loading && !data}
  <AnalyticsSkeleton />
{:else if loader.error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{loader.error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4" class:opacity-60={loader.loading}>
    <MetricTabs metrics={tiles} active="" onchange={() => {}} compare={filters.compare} label={m.anx_growth_insights_title()} interactive={false} />
    <div class="growth-grid">
      <SectionCard title={m.anx_growth_sources_title()} description={m.anx_growth_sources_desc()}>
        {#if stacks.length === 0}
          <p class="py-8 text-center text-body-sm text-on-surface-variant">{m.anx_funnel_empty()}</p>
        {:else}
          <TimeSeriesChart labels={data.sources.dates.map(shortDate)} mode="stacked" {stacks} format={fmtNumber} height={260} />
        {/if}
      </SectionCard>
      <SectionCard title={m.anx_growth_tenure_title()} description={m.anx_growth_tenure_desc()}>
        <ul class="tenure">
          {#each data.departures.byTenure as bucket (bucket.key)}
            <li class="tenure__row">
              <span class="tenure__label">{tenureLabel(bucket.key)}</span>
              <span class="tenure__track" aria-hidden="true"><span class="tenure__fill" style="width: {Math.max(1, (bucket.count / maxTenure) * 100)}%;"></span></span>
              <span class="tenure__value">{fmtNumber(bucket.count)}</span>
            </li>
          {/each}
        </ul>
        {#if data.departures.unknownTenure > 0}
          <p class="mt-3 text-2xs text-on-surface-variant">{m.anx_growth_tenure_unknown({ count: fmtNumber(data.departures.unknownTenure) })}</p>
        {/if}
      </SectionCard>
    </div>
  </div>
{/if}

<style>
  .growth-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
    align-items: start;
  }

  .tenure {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin-top: 0.5rem;
  }

  .tenure__row {
    display: grid;
    grid-template-columns: 8rem minmax(0, 1fr) 3rem;
    gap: 0.75rem;
    align-items: center;
    font-size: 0.8125rem;
  }

  .tenure__label {
    color: var(--color-on-surface-variant);
  }

  .tenure__track {
    height: 0.5rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .tenure__fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--series-4);
  }

  .tenure__value {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }
</style>
