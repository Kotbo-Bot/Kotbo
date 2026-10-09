<!--
  Cette semaine (ou ce mois) face à une période de référence. Par défaut la
  comparaison est « à date » : lundi→mercredi contre lundi→mercredi, pour ne
  pas annoncer une baisse simplement parce que la semaine n'est pas finie.
  Les tuiles choisissent la mesure de la courbe, qui superpose les deux
  périodes jour par jour (en cumulé pour comparer le rythme).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout, FilterPills, SectionCard } from '../ui';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import TimeSeriesChart from './TimeSeriesChart.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchWeeklyComparison, type PeriodComparison, type PeriodDay } from '../../api';
  import { m, dateLocale } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDelta, fmtMinutes, fmtNumber, SERIES } from './analyticsFormat';

  type Key = 'messages' | 'activeMembers' | 'voiceMinutes' | 'joins' | 'leaves' | 'sanctions';

  let mode = $state<'week' | 'month'>('week');
  let offset = $state(1);
  let toDate = $state(true);
  let cumulative = $state(true);
  let active = $state<Key>('messages');

  let data = $state<PeriodComparison | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const opts = { mode, offset };
    const id = ++requestId;
    untrack(() => {
      loading = true;
      error = '';
    });
    fetchWeeklyComparison(opts)
      .then((res) => {
        if (id !== requestId) return;
        data = res as PeriodComparison;
        analyticsExport.periodComparison = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const formatOf = (k: Key) => (k === 'voiceMinutes' ? fmtMinutes : fmtNumber);
  const labelOf = (k: Key) =>
    ({ messages: m.anx_metric_messages(), activeMembers: m.anx_alert_m_active(), voiceMinutes: m.anx_metric_voice(), joins: m.anx_live_joins(), leaves: m.anx_growth_left(), sanctions: m.anx_fact_sanctions() })[k];
  const KEYS: Key[] = ['messages', 'activeMembers', 'voiceMinutes', 'joins', 'leaves', 'sanctions'];

  function current(k: Key): number {
    if (!data) return 0;
    return k === 'activeMembers' ? data.activeMembers.current : data.thisWeek[k];
  }

  function reference(k: Key): number {
    if (!data) return 0;
    if (k === 'activeMembers') return data.activeMembers.previousToDate;
    return toDate ? data.lastWeekToDate[k] : data.lastWeek[k];
  }

  const tiles: MetricTab[] = $derived(
    KEYS.map((k, i) => ({
      id: k,
      label: labelOf(k),
      value: formatOf(k)(current(k)),
      delta: relativeDelta(current(k), reference(k)),
      invert: k === 'leaves' || k === 'sanctions',
      color: SERIES[i]!,
      hint: k === 'activeMembers' ? m.anx_pc_active_hint() : undefined,
    })),
  );

  const DAYS = $derived([m.anx_day_mon(), m.anx_day_tue(), m.anx_day_wed(), m.anx_day_thu(), m.anx_day_fri(), m.anx_day_sat(), m.anx_day_sun()]);
  const labels = $derived((data?.daily ?? []).map((d) => (mode === 'week' ? (DAYS[d.index] ?? '') : String(d.index + 1))));

  /** Valeurs jour par jour d'une période ; `null` pour un jour encore à venir. */
  function seriesOf(pick: (d: PeriodComparison['daily'][number]) => PeriodDay | null): (number | null)[] {
    const values = (data?.daily ?? []).map((d) => pick(d)?.[active] ?? null);
    // Le cumul d'un effectif du jour (membres actifs) n'a pas de sens : on garde le jour.
    if (!cumulative || active === 'activeMembers') return values;
    let acc = 0;
    return values.map((v) => (v === null ? null : (acc += v)));
  }

  const date = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
  const currentLabel = $derived(data ? (mode === 'week' ? m.anx_pc_this_week() : m.anx_pc_this_month()) : '');
  const referenceLabel = $derived(
    data
      ? mode === 'week'
        ? offset === 1 ? m.anx_pc_last_week() : m.anx_pc_weeks_ago({ n: String(offset) })
        : offset === 1 ? m.anx_pc_last_month() : m.anx_pc_months_ago({ n: String(offset) })
      : '',
  );

  const lines = $derived(
    data
      ? [
          { label: `${currentLabel} (${date(data.ranges.current.start)} – ${date(data.ranges.current.end)})`, color: SERIES[0]!, values: seriesOf((d) => d.current) },
          { label: `${referenceLabel} (${date(data.ranges.previous.start)} – ${date(data.ranges.previous.end)})`, color: 'var(--series-neutral)', values: seriesOf((d) => d.previous) },
        ]
      : [],
  );

  const headline = $derived.by(() => {
    if (!data) return '';
    const d = relativeDelta(current(active), reference(active));
    return m.anx_pc_headline({
      metric: labelOf(active).toLowerCase(),
      change: fmtDelta(d, 'pct'),
      reference: referenceLabel.toLowerCase(),
      scope: toDate ? m.anx_pc_scope_to_date({ days: String(data.ranges.current.elapsedDays) }) : m.anx_pc_scope_full(),
    });
  });
</script>

<div class="flex flex-col gap-4">
  <div class="pc-toolbar">
    <FilterPills label={m.anx_pc_mode()} options={[{ value: 'week', label: m.anx_pc_week() }, { value: 'month', label: m.anx_pc_month() }]} value={mode} onchange={(v) => { mode = v; offset = 1; }} />
    <FilterPills
      label={m.anx_pc_reference()}
      options={[1, 2, 3, 4, 5].map((n) => ({
        value: String(n),
        label: mode === 'week' ? (n === 1 ? m.anx_pc_last_week() : m.anx_pc_weeks_ago({ n: String(n) })) : n === 1 ? m.anx_pc_last_month() : m.anx_pc_months_ago({ n: String(n) }),
      }))}
      value={String(offset)}
      onchange={(v) => (offset = Number(v))}
    />
    <div class="flex flex-wrap gap-1.5">
      <button type="button" class="filter-pill" aria-pressed={toDate} onclick={() => (toDate = !toDate)} title={m.anx_pc_to_date_hint()}>{m.anx_pc_to_date()}</button>
      <button type="button" class="filter-pill" aria-pressed={cumulative} onclick={() => (cumulative = !cumulative)}>{m.anx_pc_cumulative()}</button>
    </div>
  </div>

  {#if loading && !data}
    <AnalyticsSkeleton />
  {:else if error && !data}
    <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
  {:else if data}
    <div class="flex flex-col gap-4" class:opacity-60={loading}>
      <MetricTabs metrics={tiles} {active} onchange={(id) => (active = id as Key)} compare label={m.anx_pc_title()} />
      <SectionCard title={headline} description={toDate ? m.anx_pc_to_date_desc({ end: date(data.ranges.previous.toDateEnd) }) : m.anx_pc_full_desc()}>
        <TimeSeriesChart {labels} mode="lines" stacks={lines} format={formatOf(active)} height={260} />
      </SectionCard>
      <SectionCard title={m.anx_cmp_table()} flush>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">{m.anx_cmp_metric()}</th>
                <th scope="col" class="num">{currentLabel}</th>
                <th scope="col" class="num">{m.anx_pc_ref_to_date()}</th>
                <th scope="col" class="num">{m.anx_pc_ref_full()}</th>
                <th scope="col" class="num">{m.anx_table_delta()}</th>
              </tr>
            </thead>
            <tbody>
              {#each KEYS as k (k)}
                <tr>
                  <th scope="row">{labelOf(k)}</th>
                  <td class="num">{formatOf(k)(current(k))}</td>
                  <td class="num">{formatOf(k)(k === 'activeMembers' ? data.activeMembers.previousToDate : data.lastWeekToDate[k])}</td>
                  <td class="num">{k === 'activeMembers' ? '–' : formatOf(k)(data.lastWeek[k])}</td>
                  <td class="num">{fmtDelta(relativeDelta(current(k), reference(k)), 'pct')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  {/if}
</div>

<style>
  .pc-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }

  .table-wrap {
    overflow-x: auto;
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
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }

  .data-table tbody th {
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
