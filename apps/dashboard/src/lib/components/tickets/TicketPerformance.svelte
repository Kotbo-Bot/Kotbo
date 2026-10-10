<!--
  Performance du support, présentée comme Analytics : des tuiles de chiffres
  clés qui pilotent la courbe du dessous (écart et mini-courbe dans chacune),
  la période d'avant en pointillés, puis les chiffres de la file, le tableau
  par membre du staff et les classements par type et par étiquette.
-->
<script lang="ts">
  import { Callout, FilterPills, SectionCard, type FilterOption } from '../ui';
  import AnalyticsSkeleton from '../analytics/AnalyticsSkeleton.svelte';
  import MetricTabs, { type MetricTab } from '../analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../analytics/TimeSeriesChart.svelte';
  import BarList from '../analytics/BarList.svelte';
  import { fmtDuration, fmtNumber, fmtPct, shortDate, SERIES } from '../analytics/analyticsFormat';
  import { relativeDelta } from '../analytics/analyticsFilters.svelte';
  import { m, dateLocale } from '../../i18n';
  import { fetchTicketStats, type TicketStats } from '../../api';

  type Period = '7' | '30' | '90';
  let period = $state<Period>('30');
  let compare = $state(true);
  let stats = $state<TicketStats | null>(null);
  let loading = $state(true);
  let error = $state('');

  const periodOptions: FilterOption<Period>[] = $derived([
    { value: '7', label: m.th_period_7() },
    { value: '30', label: m.th_period_30() },
    { value: '90', label: m.th_period_90() },
  ]);

  $effect(() => {
    const days = Number(period);
    loading = true;
    error = '';
    fetchTicketStats(days)
      .then((res) => { stats = res; })
      .catch((err) => { error = err instanceof Error ? err.message : m.th_stats_error(); })
      .finally(() => { loading = false; });
  });

  /** Minutes en durée lisible, à l'échelle utile. */
  const duration = (minutes: number | null) => (minutes === null ? '—' : fmtDuration(minutes * 60));
  const rating = (value: number | null) => (value === null ? '—' : `${value.toLocaleString(dateLocale(), { maximumFractionDigits: 1 })}/5`);
  const deltaOf = (value: number | null, previous: number | null) =>
    value === null || previous === null ? null : relativeDelta(value, previous);
  const spark = (values: (number | null)[]) => values.map((value) => value ?? 0);

  // ── Tuiles qui pilotent la courbe ─────────────────────
  type MetricId = 'created' | 'closed' | 'firstResponse' | 'resolution' | 'satisfaction';
  let active = $state<MetricId>('created');

  const tiles: MetricTab[] = $derived(stats ? [
    {
      id: 'created', label: m.th_kpi_created(), value: fmtNumber(stats.volume.created), color: SERIES[0],
      delta: relativeDelta(stats.volume.created, stats.previous.created), spark: stats.daily.current.created,
    },
    {
      id: 'closed', label: m.th_legend_closed(), value: fmtNumber(stats.volume.closed), color: SERIES[1],
      delta: relativeDelta(stats.volume.closed, stats.previous.closed), spark: stats.daily.current.closed,
    },
    {
      id: 'firstResponse', label: m.th_kpi_first_response(), value: duration(stats.firstResponse.median), color: SERIES[2],
      hint: stats.firstResponse.p90 !== null ? m.th_p90({ time: duration(stats.firstResponse.p90) }) : undefined,
      // Un délai qui monte est une mauvaise nouvelle.
      invert: true, delta: deltaOf(stats.firstResponse.median, stats.previous.firstResponseMedian), spark: spark(stats.daily.current.firstResponse),
    },
    {
      id: 'resolution', label: m.th_kpi_resolution(), value: duration(stats.resolution.median), color: SERIES[3],
      hint: stats.resolution.p90 !== null ? m.th_p90({ time: duration(stats.resolution.p90) }) : undefined,
      invert: true, delta: deltaOf(stats.resolution.median, stats.previous.resolutionMedian), spark: spark(stats.daily.current.resolution),
    },
    {
      id: 'satisfaction', label: m.th_kpi_csat(), value: rating(stats.satisfaction.average), color: SERIES[4],
      hint: m.th_kpi_csat_count({ count: stats.satisfaction.count }),
      delta: deltaOf(stats.satisfaction.average, stats.previous.satisfaction), spark: spark(stats.daily.current.satisfaction),
    },
  ] : []);

  const chart = $derived.by(() => {
    if (!stats) return null;
    const tile = tiles.find((t) => t.id === active);
    const current = stats.daily.current[active];
    const previous = stats.daily.previous[active];
    const isCount = active === 'created' || active === 'closed';
    return {
      labels: stats.daily.dates.map(shortDate),
      mode: isCount ? 'bar' as const : 'line' as const,
      main: { label: tile?.label ?? '', values: current, color: tile?.color ?? SERIES[0] },
      previous: compare ? { label: m.th_previous_period(), values: previous } : null,
      format: active === 'satisfaction'
        ? (value: number) => rating(value)
        : isCount ? fmtNumber : (value: number) => duration(value),
    };
  });

  // ── Chiffres de la file, sans courbe ──────────────────
  const queueTiles: MetricTab[] = $derived(stats ? [
    {
      id: 'sla', label: m.th_kpi_sla(), value: stats.sla.configured ? (stats.sla.firstResponseMet ?? stats.sla.resolutionMet) === null ? '—' : fmtPct(stats.sla.firstResponseMet ?? stats.sla.resolutionMet ?? 0) : '—',
      hint: stats.sla.configured
        ? m.th_kpi_sla_hint({ first: stats.sla.firstResponseMet === null ? '—' : fmtPct(stats.sla.firstResponseMet), resolution: stats.sla.resolutionMet === null ? '—' : fmtPct(stats.sla.resolutionMet) })
        : m.th_kpi_sla_none(),
    },
    { id: 'active', label: m.th_kpi_backlog(), value: fmtNumber(stats.backlog.active) },
    { id: 'unassigned', label: m.th_view_unassigned(), value: fmtNumber(stats.backlog.unassigned) },
    { id: 'waiting', label: m.th_view_waiting(), value: fmtNumber(stats.backlog.waitingStaff) },
    { id: 'breached', label: m.th_view_breached(), value: fmtNumber(stats.backlog.breached) },
    {
      id: 'oldest', label: m.th_kpi_oldest(),
      value: stats.backlog.oldestActiveAt ? duration((Date.now() - new Date(stats.backlog.oldestActiveAt).getTime()) / 60_000) : '—',
    },
  ] : []);

  // ── Tableau du staff ──────────────────────────────────
  type SortKey = 'handled' | 'closed' | 'firstResponse' | 'resolution' | 'rating' | 'openNow';
  let sort = $state<SortKey>('handled');
  const sortValue = (agent: TicketStats['agents'][number], key: SortKey): number => {
    switch (key) {
      case 'firstResponse': return -(agent.firstResponse.median ?? Number.POSITIVE_INFINITY);
      case 'resolution': return -(agent.resolution.median ?? Number.POSITIVE_INFINITY);
      case 'rating': return agent.rating ?? -1;
      default: return agent[key];
    }
  };
  const agents = $derived([...(stats?.agents ?? [])].sort((a, b) => sortValue(b, sort) - sortValue(a, sort)));
  const maxHandled = $derived(Math.max(1, ...(stats?.agents.map((agent) => agent.handled) ?? [1])));

  const columns: Array<{ key: SortKey; label: () => string }> = [
    { key: 'handled', label: () => m.th_col_handled() },
    { key: 'closed', label: () => m.th_col_closed() },
    { key: 'firstResponse', label: () => m.th_col_first_response() },
    { key: 'resolution', label: () => m.th_col_resolution() },
    { key: 'rating', label: () => m.th_col_csat() },
    { key: 'openNow', label: () => m.th_col_open() },
  ];
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-body-sm text-on-surface-variant">{m.th_stats_intro()}</p>
    <div class="flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-2 text-body-sm text-on-surface-variant">
        <input type="checkbox" bind:checked={compare} />
        {m.th_compare_previous()}
      </label>
      <FilterPills label={m.th_period()} options={periodOptions} value={period} onchange={(value) => (period = value)} />
    </div>
  </div>

  {#if loading && !stats}
    <AnalyticsSkeleton />
  {:else if error && !stats}
    <Callout variant="danger">{error}</Callout>
  {:else if stats}
    <div class="flex flex-col gap-4" class:opacity-60={loading}>
      <SectionCard>
        <div class="p-4 flex flex-col gap-4">
          <MetricTabs metrics={tiles} {active} onchange={(id) => (active = id as MetricId)} {compare} label={m.th_tab_performance()} />
          {#if chart}
            <TimeSeriesChart labels={chart.labels} mode={chart.mode} main={chart.main} previous={chart.previous} format={chart.format} height={260} />
          {/if}
        </div>
      </SectionCard>

      <MetricTabs metrics={queueTiles} active="" onchange={() => {}} label={m.th_kpi_backlog()} interactive={false} />

      {#if stats.backlog.unassigned > 0 || stats.backlog.waitingStaff > 0}
        <Callout variant={stats.backlog.breached > 0 ? 'warning' : 'info'}>
          {m.th_backlog_callout({ unassigned: stats.backlog.unassigned, waiting: stats.backlog.waitingStaff })}
        </Callout>
      {/if}

      <SectionCard title={m.th_agents_title()} description={m.th_agents_desc()} flush>
        {#if agents.length === 0}
          <p class="px-5 py-6 text-body-sm text-on-surface-variant">{m.th_agents_empty_desc()}</p>
        {:else}
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">{m.th_col_agent()}</th>
                  {#each columns as column (column.key)}
                    <th scope="col" class="num" aria-sort={sort === column.key ? 'descending' : undefined}>
                      <button type="button" class="th-sort" onclick={() => (sort = column.key)}>{column.label()}</button>
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each agents as agent (agent.userId)}
                  <tr>
                    <th scope="row">
                      <a class="agent-name" href={`/members/${agent.userId}`}>{agent.name}</a>
                      <span class="agent-bar" aria-hidden="true"><span style="width: {Math.max(2, (agent.handled / maxHandled) * 100)}%;"></span></span>
                    </th>
                    <td class="num">{fmtNumber(agent.handled)}</td>
                    <td class="num">{fmtNumber(agent.closed)}</td>
                    <td class="num">{duration(agent.firstResponse.median)}</td>
                    <td class="num">{duration(agent.resolution.median)}</td>
                    <td class="num {agent.rating !== null && agent.rating < 3.5 ? 'text-warning' : ''}">
                      {rating(agent.rating)}{#if agent.ratings} <span class="text-on-surface-variant">· {agent.ratings}</span>{/if}
                    </td>
                    <td class="num">{fmtNumber(agent.openNow)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </SectionCard>

      <div class="grid gap-4 lg:grid-cols-3">
        <SectionCard title={m.th_by_type()}>
          <BarList
            items={stats.byType.map((type) => ({ id: type.label, label: type.label, value: type.count, sub: type.resolution.median !== null ? m.th_type_resolution({ time: duration(type.resolution.median) }) : undefined }))}
            empty={m.th_none()}
          />
        </SectionCard>
        <SectionCard title={m.th_by_tag()}>
          <BarList items={stats.byTag.map((tag) => ({ id: tag.tag, label: `#${tag.tag}`, value: tag.count }))} color={SERIES[1]} empty={m.th_by_tag_empty()} />
        </SectionCard>
        <SectionCard title={m.th_csat_title()}>
          <BarList
            items={[5, 4, 3, 2, 1].map((score) => ({ id: String(score), label: `${score} ★`, value: stats!.satisfaction.distribution[score - 1] ?? 0 }))}
            color={SERIES[4]}
            empty={m.th_none()}
          />
        </SectionCard>
      </div>
    </div>
  {/if}
</div>

<style>
  .table-wrap {
    max-height: 30rem;
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
    vertical-align: middle;
  }

  .data-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-surface-container-low);
    font-weight: 500;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .data-table tbody tr:hover {
    background: var(--color-surface-container-low);
  }

  .th-sort {
    font: inherit;
    color: inherit;
  }

  .th-sort:hover {
    color: var(--color-on-surface);
  }

  .agent-name {
    display: block;
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .agent-name:hover {
    text-decoration: underline;
  }

  .agent-bar {
    display: block;
    width: 8rem;
    height: 3px;
    margin-top: 0.3rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    overflow: hidden;
  }

  .agent-bar span {
    display: block;
    height: 100%;
    background: var(--series-1);
  }
</style>
