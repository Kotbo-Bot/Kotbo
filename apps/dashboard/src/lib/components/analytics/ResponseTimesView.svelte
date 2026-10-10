<!--
  Temps de réponse : combien de temps une prise de parole attend avant qu'un
  autre membre écrive dans le salon, et combien restent sans réponse (plus de
  6 heures). La courbe suit le délai médian ou la part sans réponse jour par
  jour ; dessous, la répartition des délais et le détail par salon.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, SectionCard } from '../ui';
  import ActivityChartCard, { type ChartMetric } from './ActivityChartCard.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchResponseTimes, type ResponseTimes } from '../../api';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { analyticsAnnotations } from './annotations.svelte';
  import { fmtDuration, fmtNumber, fmtPct, SERIES } from './analyticsFormat';

  let data = $state<ResponseTimes | null>(null);
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
    fetchResponseTimes(query)
      .then((res) => {
        if (id !== requestId) return;
        data = res;
        analyticsExport.responseTimes = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  $effect(() => {
    const period = filters.periodQuery;
    untrack(() => analyticsAnnotations.load(period));
  });

  let active = $state('median');

  const metrics: ChartMetric[] = $derived.by(() => {
    if (!data) return [];
    const t = data.total;
    const p = data.previous;
    // Un jour sans aucun tour n'a pas de médiane : il reprend la dernière connue
    // pour ne pas tracer de chute à zéro qui voudrait dire « réponse immédiate ».
    let last = 0;
    const medians = data.daily.map((d) => {
      if (d.medianSec !== null) last = d.medianSec;
      return last;
    });
    const rates = data.daily.map((d) => d.unansweredRate ?? 0);
    return [
      {
        id: 'median',
        label: m.anx_resp_median(),
        hint: m.anx_resp_median_hint(),
        color: SERIES[0]!,
        format: fmtDuration,
        value: fmtDuration(t.medianSec),
        delta: t.medianSec !== null && p.medianSec ? relativeDelta(t.medianSec, p.medianSec) : undefined,
        invert: true,
        aggregate: 'avg',
        daily: medians,
        prevDaily: [],
      },
      {
        id: 'unanswered',
        label: m.anx_resp_unanswered(),
        hint: m.anx_resp_unanswered_hint(),
        color: SERIES[1]!,
        format: (v) => fmtPct(v),
        value: t.unansweredRate === null ? '—' : fmtPct(t.unansweredRate),
        delta: t.unansweredRate !== null && p.unansweredRate ? relativeDelta(t.unansweredRate, p.unansweredRate) : undefined,
        invert: true,
        aggregate: 'avg',
        daily: rates,
        prevDaily: [],
      },
      {
        id: 'turns',
        label: m.anx_resp_turns(),
        hint: m.anx_resp_turns_hint(),
        color: SERIES[2]!,
        format: fmtNumber,
        value: fmtNumber(t.turns),
        delta: relativeDelta(t.turns, p.turns),
        aggregate: 'sum',
        daily: data.daily.map((d) => d.turns),
        prevDaily: [],
      },
    ];
  });

  const bucketLabel = (key: string) =>
    ({ under1m: m.anx_resp_b1(), under5m: m.anx_resp_b5(), under15m: m.anx_resp_b15(), under1h: m.anx_resp_b60(), under6h: m.anx_resp_b360() })[key] ?? key;

  const distribution = $derived.by(() => {
    if (!data) return [];
    const rows = [...data.total.buckets.map((b) => ({ key: b.key, label: bucketLabel(b.key), count: b.count })), { key: 'none', label: m.anx_resp_none(), count: data.total.unanswered }];
    const total = rows.reduce((s, r) => s + r.count, 0);
    return rows.map((r) => ({ ...r, share: total > 0 ? (r.count / total) * 100 : 0 }));
  });

  type SortKey = 'turns' | 'median' | 'unanswered';
  let sort = $state<SortKey>('turns');
  const channels = $derived(
    [...(data?.channels ?? [])].sort((a, b) =>
      sort === 'turns' ? b.turns - a.turns : sort === 'median' ? (b.medianSec ?? -1) - (a.medianSec ?? -1) : (b.unansweredRate ?? -1) - (a.unansweredRate ?? -1)),
  );
</script>

{#if loading && !data}
  <AnalyticsSkeleton />
{:else if error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4">
    {#if data.userIgnored}
      <Callout variant="info">{m.anx_resp_user_ignored()}</Callout>
    {/if}
    {#if data.total.turns === 0}
      <Callout variant="info" title={m.anx_resp_empty_title()}>{m.anx_resp_empty_desc()}</Callout>
    {:else}
      <ActivityChartCard
        {metrics}
        {active}
        onchange={(id) => (active = id)}
        dates={data.daily.map((d) => d.dateKey)}
        days={filters.days}
        compare={false}
        onToggleCompare={() => filters.toggleCompare()}
        loadHourly={async () => null}
        loadBreakdown={async () => null}
        reloadKey={filters.key}
        annotations={analyticsAnnotations.items}
        onAnnotate={(dateKey, label) => analyticsAnnotations.add(dateKey, label, filters.periodQuery)}
        onDeleteAnnotation={(id) => analyticsAnnotations.remove(id)}
        canDeleteAnnotation={(a) => analyticsAnnotations.canDelete(a)}
        busy={loading}
        forecastAllowed={false}
      />

      <div class="resp-grid">
        <SectionCard title={m.anx_resp_distribution()} description={m.anx_resp_distribution_desc()}>
          <ul class="dist">
            {#each distribution as row (row.key)}
              <li class="dist__row">
                <span class="dist__label">{row.label}</span>
                <span class="dist__track" aria-hidden="true">
                  <span class="dist__fill" style="width: {Math.max(1, row.share)}%; background: {row.key === 'none' ? 'var(--series-neutral)' : 'var(--series-1)'};"></span>
                </span>
                <span class="dist__value">{fmtPct(row.share, 0)}</span>
              </li>
            {/each}
          </ul>
        </SectionCard>

        <SectionCard title={m.anx_resp_channels()} description={m.anx_resp_channels_desc()} flush>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">{m.anx_top_channel()}</th>
                  <th scope="col" class="num" aria-sort={sort === 'turns' ? 'descending' : undefined}>
                    <button type="button" class="th-sort" onclick={() => (sort = 'turns')}>{m.anx_resp_turns()}</button>
                  </th>
                  <th scope="col" class="num" aria-sort={sort === 'median' ? 'descending' : undefined}>
                    <button type="button" class="th-sort" onclick={() => (sort = 'median')}>{m.anx_resp_median()}</button>
                  </th>
                  <th scope="col" class="num" aria-sort={sort === 'unanswered' ? 'descending' : undefined}>
                    <button type="button" class="th-sort" onclick={() => (sort = 'unanswered')}>{m.anx_resp_unanswered()}</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each channels as row (row.channelId)}
                  <tr>
                    <th scope="row">
                      <button type="button" class="row-link" onclick={() => channelDetailsModal.show(row.channelId, row.name ? `#${row.name}` : m.anx_channel_deleted())}>
                        {row.name ? `#${row.name}` : m.anx_channel_deleted()}
                      </button>
                    </th>
                    <td class="num">{fmtNumber(row.turns)}</td>
                    <td class="num">{fmtDuration(row.medianSec)}</td>
                    <td class="num">{row.unansweredRate === null ? '—' : fmtPct(row.unansweredRate)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>
    {/if}
  </div>
{/if}

<style>
  .resp-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    align-items: start;
  }

  .dist {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin-top: 0.5rem;
  }

  .dist__row {
    display: grid;
    grid-template-columns: 7.5rem minmax(0, 1fr) 3rem;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.8125rem;
  }

  .dist__label {
    color: var(--color-on-surface-variant);
  }

  .dist__track {
    height: 0.5rem;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .dist__fill {
    display: block;
    height: 100%;
    border-radius: 999px;
  }

  .dist__value {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-on-surface);
  }

  .table-wrap {
    max-height: 26rem;
    overflow: auto;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .data-table th,
  .data-table td {
    padding: 0.5rem 1rem;
    text-align: left;
    border-bottom: 1px solid var(--color-outline-variant);
    white-space: nowrap;
  }

  .data-table thead th {
    position: sticky;
    top: 0;
    background: var(--color-surface-container-low);
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .th-sort {
    color: inherit;
    font-weight: inherit;
  }

  .th-sort:hover,
  [aria-sort] .th-sort {
    color: var(--color-on-surface);
  }

  .row-link {
    font-weight: 500;
    color: var(--color-on-surface);
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-link:hover {
    color: var(--color-primary);
  }
</style>
