<!--
  Heures de pointe : moyenne par créneau jour × heure sur la période, dans le
  fuseau du lecteur. Une seule teinte du clair au foncé ; pour le solde
  d'arrivées et pour l'écart avec la période d'avant, deux teintes opposées
  autour d'un gris neutre. Totaux par jour à droite, par heure en bas, et
  les meilleurs créneaux pour publier une annonce ou lancer un événement.
-->
<script lang="ts">
  import { Callout, FilterPills, SectionCard } from '../ui';
  import MetricTabs, { type MetricTab } from './MetricTabs.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchHeatmapComparison, type HeatmapCell, type HeatmapComparison, type HeatmapGrid } from '../../api';
  import { m } from '../../i18n';
  import { analyticsLoader } from './analyticsLoader.svelte';
  import { analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { fmtDelta, fmtNumber, fmtPct, SERIES } from './analyticsFormat';

  type Metric = keyof HeatmapCell;

  const loader = analyticsLoader(() => {
    const p = filters.periodQuery;
    return fetchHeatmapComparison(p.startDate ? { startDate: p.startDate, endDate: p.endDate } : { days: p.period });
  }, 'heatmap');
  const data = $derived(loader.data as HeatmapComparison | null);

  let metric = $state<Metric>('messages');
  let view = $state<'period' | 'change'>('period');
  let showValues = $state(false);

  // Lundi en premier ; la grille du bot est indexée 0 = dimanche.
  const ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DAYS = $derived([m.anx_rep_day_0(), m.anx_rep_day_1(), m.anx_rep_day_2(), m.anx_rep_day_3(), m.anx_rep_day_4(), m.anx_rep_day_5(), m.anx_rep_day_6()]);
  const SHORT = $derived([m.anx_day_sun(), m.anx_day_mon(), m.anx_day_tue(), m.anx_day_wed(), m.anx_day_thu(), m.anx_day_fri(), m.anx_day_sat()]);
  const HOURS = Array.from({ length: 24 }, (_, h) => h);

  const read = (grid: HeatmapGrid | undefined, dow: number, hour: number) => grid?.[dow]?.[hour]?.[metric] ?? 0;
  const diverging = $derived(view === 'change' || metric === 'net');
  const cellValue = (dow: number, hour: number) =>
    view === 'change' ? read(data?.current, dow, hour) - read(data?.previous, dow, hour) : read(data?.current, dow, hour);

  const cells = $derived(ORDER.flatMap((dow) => HOURS.map((hour) => ({ dow, hour, value: cellValue(dow, hour) }))));
  const maxAbs = $derived(Math.max(0.0001, ...cells.map((c) => Math.abs(c.value))));
  const dayTotals = $derived(ORDER.map((dow) => HOURS.reduce((s, h) => s + cellValue(dow, h), 0)));
  const hourTotals = $derived(HOURS.map((h) => ORDER.reduce((s, dow) => s + cellValue(dow, h), 0)));
  const maxDay = $derived(Math.max(0.0001, ...dayTotals.map(Math.abs)));
  const maxHour = $derived(Math.max(0.0001, ...hourTotals.map(Math.abs)));

  function cellStyle(value: number): string {
    if (Math.abs(value) < 0.05) return '';
    const t = Math.min(1, Math.abs(value) / maxAbs);
    const strength = Math.round(10 + t * 80);
    const hue = diverging && value < 0 ? 'var(--series-2)' : 'var(--series-1)';
    return `background: color-mix(in srgb, ${hue} ${strength}%, var(--color-surface-container-lowest, var(--color-surface)));${strength > 55 ? ' color: #fff;' : ''}`;
  }

  const fmt = (v: number) => (Math.abs(v) < 10 ? fmtNumber(Math.round(v * 10) / 10) : fmtNumber(Math.round(v)));
  const signed = (v: number) => `${v > 0 ? '+' : ''}${fmt(v)}`;

  // ── Lecture ────────────────────────────────────────────────────────────────
  const periodCells = $derived(ORDER.flatMap((dow) => HOURS.map((hour) => ({ dow, hour, value: read(data?.current, dow, hour) }))));
  const best = $derived([...periodCells].sort((a, b) => b.value - a.value).filter((c) => c.value > 0).slice(0, 3));
  const quiet = $derived(
    [...periodCells].filter((c) => c.hour >= 10 && c.hour <= 22).sort((a, b) => a.value - b.value)[0] ?? null,
  );
  const bestHour = $derived.by(() => {
    const totals = HOURS.map((h) => ORDER.reduce((s, dow) => s + read(data?.current, dow, h), 0));
    const max = Math.max(...totals);
    return max > 0 ? totals.indexOf(max) : null;
  });
  const weekendShare = $derived.by(() => {
    const total = periodCells.reduce((s, c) => s + Math.max(0, c.value), 0);
    const weekend = periodCells.filter((c) => c.dow === 0 || c.dow === 6).reduce((s, c) => s + Math.max(0, c.value), 0);
    return total > 0 ? (weekend / total) * 100 : null;
  });
  const weekTotal = $derived(periodCells.reduce((s, c) => s + c.value, 0));
  const prevWeekTotal = $derived(ORDER.reduce((s, dow) => s + HOURS.reduce((t, h) => t + read(data?.previous, dow, h), 0), 0));

  const metricLabel = (k: Metric) =>
    ({ messages: m.anx_metric_messages(), voice: m.anx_alert_m_voice(), active: m.anx_alert_m_active(), joins: m.anx_live_joins(), leaves: m.anx_growth_left(), net: m.anx_metric_net_joins() })[k];

  const tiles: MetricTab[] = $derived(
    data
      ? [
          { id: 'week', label: m.anx_hm_week_total(), hint: m.anx_hm_week_total_hint(), value: fmt(weekTotal), delta: relativeDelta(weekTotal, prevWeekTotal), color: SERIES[0] },
          { id: 'best', label: m.anx_hm_best_slot(), value: best[0] ? `${SHORT[best[0].dow]} ${best[0].hour} h` : '–', hint: best[0] ? `${fmt(best[0].value)} ${metricLabel(metric).toLowerCase()}` : undefined, color: SERIES[0] },
          { id: 'hour', label: m.anx_hm_best_hour(), value: bestHour === null ? '–' : `${bestHour} h`, color: SERIES[0] },
          { id: 'weekend', label: m.anx_hm_weekend(), hint: m.anx_hm_weekend_hint(), value: weekendShare === null ? '–' : fmtPct(weekendShare, 0), color: SERIES[0] },
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
    <MetricTabs metrics={tiles} active="" onchange={() => {}} compare={filters.compare} label={m.an_tab_heatmap()} interactive={false} />

    <SectionCard title={m.anx_hm_title({ metric: metricLabel(metric) })} description={m.anx_hm_desc({ tz: data.timezone })}>
      <div class="flex flex-col gap-4">
        <div class="hm-toolbar">
          <FilterPills
            label={m.anx_alert_f_metric()}
            options={(['messages', 'active', 'voice', 'joins', 'leaves', 'net'] as Metric[]).map((k) => ({ value: k, label: metricLabel(k) }))}
            value={metric}
            onchange={(v) => (metric = v)}
          />
          <div class="flex flex-wrap gap-1.5">
            <button type="button" class="filter-pill" aria-pressed={view === 'change'} onclick={() => (view = view === 'change' ? 'period' : 'change')}>{m.anx_hm_change()}</button>
            <button type="button" class="filter-pill" aria-pressed={showValues} onclick={() => (showValues = !showValues)}>{m.anx_hm_values()}</button>
          </div>
        </div>

        <div class="hm-wrap">
          <table class="hm">
            <caption class="sr-only">{m.anx_hm_caption()}</caption>
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">{m.anx_staff_day()}</span></th>
                {#each HOURS as h (h)}<th scope="col" class="hm__hour">{h % 3 === 0 ? `${h}h` : ''}</th>{/each}
                <th scope="col" class="hm__total-head">{m.anx_fact_total()}</th>
              </tr>
            </thead>
            <tbody>
              {#each ORDER as dow, row (dow)}
                <tr>
                  <th scope="row" class="hm__day">{SHORT[dow]}</th>
                  {#each HOURS as hour (hour)}
                    {@const v = cellValue(dow, hour)}
                    <td class="hm__cell" style={cellStyle(v)} title={`${DAYS[dow]} ${hour} h – ${hour + 1} h : ${view === 'change' || metric === 'net' ? signed(v) : fmt(v)}`}>
                      {#if showValues && Math.abs(v) >= 0.5}{view === 'change' || metric === 'net' ? signed(v) : fmt(v)}{/if}
                    </td>
                  {/each}
                  <td class="hm__total">
                    <span class="hm__bar" style="width: {Math.round((Math.abs(dayTotals[row] ?? 0) / maxDay) * 100)}%; background: {(dayTotals[row] ?? 0) < 0 ? 'var(--series-2)' : 'var(--series-1)'};"></span>
                    <span class="hm__total-value">{diverging ? signed(dayTotals[row] ?? 0) : fmt(dayTotals[row] ?? 0)}</span>
                  </td>
                </tr>
              {/each}
              <tr>
                <th scope="row" class="hm__day">{m.anx_fact_total()}</th>
                {#each HOURS as h (h)}
                  <td class="hm__col-total" title={`${h} h : ${fmt(hourTotals[h] ?? 0)}`}>
                    <span class="hm__colbar" style="height: {Math.max(2, Math.round((Math.abs(hourTotals[h] ?? 0) / maxHour) * 28))}px; background: {(hourTotals[h] ?? 0) < 0 ? 'var(--series-2)' : 'var(--series-1)'};"></span>
                  </td>
                {/each}
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="hm-legend">
          {#if diverging}
            <span><span class="hm-swatch" style="background: var(--series-2);"></span>{view === 'change' ? m.anx_hm_less() : m.anx_hm_net_loss()}</span>
            <span><span class="hm-swatch" style="background: var(--color-surface-container);"></span>{m.anx_hm_neutral()}</span>
            <span><span class="hm-swatch" style="background: var(--series-1);"></span>{view === 'change' ? m.anx_hm_more() : m.anx_hm_net_gain()}</span>
          {:else}
            <span>{m.anx_hm_low()}</span>
            <span class="hm-ramp" aria-hidden="true"></span>
            <span>{m.anx_hm_high()}</span>
          {/if}
          {#if view === 'change'}
            <span class="text-on-surface-variant">· {m.anx_hm_change_vs({ start: data.range.prevStart, end: data.range.prevEnd })}</span>
          {/if}
        </div>
      </div>
    </SectionCard>

    {#if best.length > 0 && metric !== 'leaves' && metric !== 'net'}
      <Callout variant="info" title={m.anx_hm_advice_title()}>
        {m.anx_hm_advice({ slots: best.map((c) => `${DAYS[c.dow]} ${c.hour} h`).join(', ') })}
        {#if quiet && quiet.value >= 0}<br />{m.anx_hm_quiet({ slot: `${DAYS[quiet.dow]} ${quiet.hour} h` })}{/if}
        {#if filters.compare && prevWeekTotal > 0}<br />{m.anx_hm_vs_previous({ change: fmtDelta(relativeDelta(weekTotal, prevWeekTotal), 'pct') })}{/if}
      </Callout>
    {/if}
  </div>
{/if}

<style>
  .hm-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }

  .hm-wrap {
    overflow-x: auto;
  }

  .hm {
    width: 100%;
    min-width: 40rem;
    border-collapse: separate;
    border-spacing: 2px;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }

  .hm__hour {
    font-weight: 400;
    text-align: left;
    color: var(--color-on-surface-variant);
  }

  .hm__day {
    padding-right: 0.5rem;
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    color: var(--color-on-surface-variant);
  }

  .hm__cell {
    height: 1.75rem;
    border-radius: 0.25rem;
    background: var(--color-surface-container);
    text-align: center;
    color: var(--color-on-surface);
  }

  .hm__total-head {
    font-weight: 400;
    text-align: left;
    color: var(--color-on-surface-variant);
  }

  .hm__total {
    position: relative;
    width: 5.5rem;
    min-width: 5.5rem;
    padding-left: 0.375rem;
  }

  .hm__bar {
    position: absolute;
    left: 0.375rem;
    top: 50%;
    height: 0.375rem;
    max-width: calc(100% - 0.375rem);
    border-radius: 999px;
    transform: translateY(-50%);
    opacity: 0.35;
  }

  .hm__total-value {
    position: relative;
    color: var(--color-on-surface);
  }

  .hm__col-total {
    height: 2rem;
    vertical-align: bottom;
    text-align: center;
  }

  .hm__colbar {
    display: inline-block;
    width: 70%;
    border-radius: 2px 2px 0 0;
    opacity: 0.6;
  }

  .hm-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .hm-legend > span {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .hm-swatch {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 0.1875rem;
  }

  .hm-ramp {
    display: inline-block;
    width: 6rem;
    height: 0.5rem;
    border-radius: 999px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--series-1) 10%, var(--color-surface)), var(--series-1));
  }
</style>
