<!--
  Carte de courbe façon Google Analytics / Cloudflare : les tuiles du haut
  choisissent la mesure, la barre d'outils règle le pas (heure, jour,
  semaine, mois), l'affichage (courbe, barres, empilé par salon ou par
  catégorie, tableau) et les calques (lissage, période précédente,
  prévision). Sous la courbe : les chiffres de la période et les repères
  (notes de l'équipe, jours inhabituels).

  Les réglages d'affichage sont retenus dans le navigateur, par confort.
-->
<script lang="ts" module>
  import type { Aggregate } from './timeSeries';
  import type { ActivityHourPoint, ActivityMetricKind } from '../../api';

  export interface ChartMetric {
    id: string;
    label: string;
    color: string;
    format: (value: number) => string;
    /** Valeur affichée dans la tuile (total ou moyenne de la période). */
    value: string;
    delta?: number | null;
    /** Valeur de la période d'avant, affichée à la place de l'écart en %. */
    previous?: string;
    invert?: boolean;
    hint?: string;
    aggregate: Aggregate;
    daily: number[];
    prevDaily: number[];
    hourly?: (point: ActivityHourPoint) => number;
    /** Mesure à ventiler par salon pour l'aire empilée. */
    breakdown?: ActivityMetricKind;
    anomalyKey?: 'messages' | 'voiceMinutes';
    forecast?: boolean;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Callout, FilterPills } from '../ui';
  import Papicon from '../Papicon.svelte';
  import MetricTabs from './MetricTabs.svelte';
  import TimeSeriesChart, { type ChartMarker, type ChartMode } from './TimeSeriesChart.svelte';
  import { m, dateLocale } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import { errorMessage } from '@kotbo/shared';
  import type { ActivityAnomaly, ActivityBreakdown, ActivityHourly, AnalyticsAnnotation } from '../../api';
  import { fmtDelta, fmtNumber, shortDate, SERIES, SERIES_NEUTRAL } from './analyticsFormat';
  import {
    aggregate,
    bucketDays,
    daysLeftInMonth,
    forecast,
    FORECAST_MIN_DAYS,
    movingAverage,
    resolveGranularity,
    smoothingWindow,
    trendPct,
    type Granularity,
    type ResolvedGranularity,
  } from './timeSeries';

  type View = 'line' | 'bar' | 'stack-channel' | 'stack-category' | 'table';

  const {
    metrics,
    active,
    onchange,
    dates,
    days,
    compare,
    onToggleCompare,
    hourlyPossible = false,
    loadHourly,
    loadBreakdown,
    reloadKey,
    anomalies = [],
    annotations = [],
    onAnnotate,
    onDeleteAnnotation,
    canDeleteAnnotation = () => false,
    busy = false,
    forecastAllowed = true,
  }: {
    metrics: ChartMetric[];
    active: string;
    onchange: (id: string) => void;
    /** Clés des jours de la période, alignées sur `daily`. */
    dates: string[];
    days: number;
    compare: boolean;
    onToggleCompare: () => void;
    /** Le pas horaire peut exister (période courte, sans filtre de périmètre). */
    hourlyPossible?: boolean;
    loadHourly: () => Promise<ActivityHourly | null>;
    loadBreakdown: (metric: ActivityMetricKind, dimension: 'channel' | 'category') => Promise<ActivityBreakdown | null>;
    /** Change avec les filtres : vide les données chargées à la demande. */
    reloadKey: string;
    anomalies?: ActivityAnomaly[];
    annotations?: AnalyticsAnnotation[];
    onAnnotate?: (dateKey: string, label: string) => Promise<void>;
    onDeleteAnnotation?: (id: string) => Promise<void>;
    canDeleteAnnotation?: (annotation: AnalyticsAnnotation) => boolean;
    busy?: boolean;
    /** La période se termine aujourd'hui : une prévision a un sens. */
    forecastAllowed?: boolean;
  } = $props();

  // ── Réglages retenus ───────────────────────────────────────────────────────
  const PREFS_KEY = 'kotbo.analytics.chart';

  function readPrefs(): { granularity?: Granularity; view?: View; smooth?: boolean; forecast?: boolean } {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  const stored = typeof window === 'undefined' ? {} : readPrefs();
  let granularity = $state<Granularity>(stored.granularity ?? 'auto');
  let view = $state<View>(stored.view ?? 'line');
  let smooth = $state(stored.smooth ?? false);
  let showForecast = $state(stored.forecast ?? false);

  $effect(() => {
    const prefs = { granularity, view, smooth, forecast: showForecast };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* stockage indisponible : réglages gardés pour la visite */
    }
  });

  const metric = $derived(metrics.find((mt) => mt.id === active) ?? metrics[0]!);
  const stacked = $derived(view === 'stack-channel' || view === 'stack-category');

  // ── Données chargées à la demande ──────────────────────────────────────────
  let hourly = $state<ActivityHourly | null>(null);
  let hourlyKey = '';
  let breakdown = $state<ActivityBreakdown | null>(null);
  let breakdownKey = $state('');
  let breakdownLoading = $state(false);

  const wantsHour = $derived(
    !stacked && hourlyPossible && resolveGranularity(granularity, days, true) === 'hour',
  );

  $effect(() => {
    if (!wantsHour) return;
    const key = reloadKey;
    untrack(() => {
      if (key === hourlyKey && hourly) return;
      hourlyKey = key;
      loadHourly()
        .then((res) => {
          if (hourlyKey === key) hourly = res;
        })
        .catch(() => {
          if (hourlyKey === key) hourly = null;
        });
    });
  });

  $effect(() => {
    if (!stacked || !metric.breakdown) return;
    const dimension = view === 'stack-category' ? 'category' : 'channel';
    const key = `${reloadKey}|${metric.breakdown}|${dimension}`;
    const kind = metric.breakdown;
    untrack(() => {
      if (key === breakdownKey && breakdown) return;
      breakdownKey = key;
      breakdownLoading = true;
      loadBreakdown(kind, dimension)
        .then((res) => {
          if (breakdownKey === key) breakdown = res;
        })
        .catch(() => {
          if (breakdownKey === key) breakdown = null;
        })
        .finally(() => {
          if (breakdownKey === key) breakdownLoading = false;
        });
    });
  });

  const hourlyReady = $derived(Boolean(hourly?.available && hourlyKey === reloadKey && hourly.points.length > 0));
  const resolved: ResolvedGranularity = $derived(
    stacked ? (granularity === 'week' || granularity === 'month' ? granularity : 'day') : resolveGranularity(granularity, days, hourlyReady),
  );

  // ── Construction de la série affichée ──────────────────────────────────────
  function hourLabel(key: string): string {
    const [day, hour] = key.split(' ');
    const h = `${Number(hour)} h`;
    return days > 1 ? `${shortDate(day!)} ${h}` : h;
  }

  function bucketLabel(key: string, g: ResolvedGranularity): string {
    if (g === 'week') return m.anx_week_of({ date: shortDate(key) });
    if (g === 'month') {
      const d = new Date(`${key}T12:00:00Z`);
      return d.toLocaleDateString(dateLocale(), { month: 'short', year: '2-digit' });
    }
    return shortDate(key);
  }

  const shaped = $derived.by(() => {
    if (resolved === 'hour' && hourly?.available && metric.hourly) {
      const read = metric.hourly;
      return {
        keys: hourly.points.map((p) => p.key),
        labels: hourly.points.map((p) => hourLabel(p.key)),
        values: hourly.points.map(read),
        previous: hourly.prev.map(read),
        dayOf: (dateKey: string) => hourly!.points.findIndex((p) => p.key.startsWith(dateKey)),
      };
    }
    const g = resolved === 'hour' ? 'day' : resolved;
    const buckets = bucketDays(dates, g);
    const indexOfDay = new Map<number, number>();
    buckets.forEach((b, bi) => b.indices.forEach((i) => indexOfDay.set(i, bi)));
    const dateIndex = new Map(dates.map((d, i) => [d, i]));
    return {
      keys: buckets.map((b) => b.key),
      labels: buckets.map((b) => bucketLabel(b.key, g)),
      values: aggregate(metric.daily, buckets, metric.aggregate),
      previous: aggregate(metric.prevDaily, buckets, metric.aggregate),
      dayOf: (dateKey: string) => {
        const i = dateIndex.get(dateKey);
        return i === undefined ? -1 : (indexOfDay.get(i) ?? -1);
      },
    };
  });

  const canForecast = $derived(
    forecastAllowed && Boolean(metric.forecast) && resolved === 'day' && dates.length >= FORECAST_MIN_DAYS && !stacked,
  );

  const projection = $derived.by(() => {
    if (!showForecast || !canForecast) return null;
    const fc = forecast(metric.daily, dates, 7);
    if (!fc) return null;
    return fc;
  });

  const labels = $derived(projection ? [...shaped.labels, ...projection.dates.map((d) => shortDate(d))] : shaped.labels);
  const pad = (n: number) => new Array<null>(n).fill(null);

  const chartMain = $derived({
    label: metric.label,
    color: metric.color,
    values: projection ? [...shaped.values, ...pad(projection.values.length)] : shaped.values,
  });

  const chartPrevious = $derived(
    compare && !stacked
      ? { label: m.anx_trend_previous(), values: projection ? [...shaped.previous, ...pad(projection.values.length)] : shaped.previous }
      : null,
  );

  const chartSmoothed = $derived(
    smooth && !stacked
      ? {
          label: m.anx_series_smoothed(),
          values: [...movingAverage(shaped.values, smoothingWindow(resolved)), ...(projection ? pad(projection.values.length) : [])],
        }
      : null,
  );

  const chartProjection = $derived.by(() => {
    if (!projection) return null;
    const last = shaped.values[shaped.values.length - 1] ?? 0;
    const lead = pad(shaped.values.length - 1);
    return {
      label: m.anx_series_forecast(),
      values: [...lead, last, ...projection.values],
      low: [...lead, last, ...projection.low],
      high: [...lead, last, ...projection.high],
    };
  });

  const stacks = $derived.by(() => {
    if (!stacked || !breakdown?.available) return [];
    const g = resolved === 'hour' ? 'day' : resolved;
    const buckets = bucketDays(breakdown.dates, g);
    const name = (group: { id: string | null; name: string | null }) =>
      group.id === null
        ? m.anx_breakdown_no_category()
        : group.name
          ? (view === 'stack-channel' ? `#${group.name}` : group.name)
          : m.anx_channel_deleted();
    return [
      ...breakdown.groups.map((group, i) => ({ label: name(group), values: aggregate(group.values, buckets, 'sum'), color: SERIES[i]! })),
      ...(breakdown.other.some((v) => v > 0)
        ? [{ label: m.anx_breakdown_other(), values: aggregate(breakdown.other, buckets, 'sum'), color: SERIES_NEUTRAL }]
        : []),
    ];
  });

  const stackLabels = $derived.by(() => {
    if (!breakdown?.available) return [];
    const g = resolved === 'hour' ? 'day' : resolved;
    return bucketDays(breakdown.dates, g).map((b) => bucketLabel(b.key, g));
  });

  // ── Repères ────────────────────────────────────────────────────────────────
  const visibleAnomalies = $derived(anomalies.filter((a) => a.metric === metric.anomalyKey));

  function anomalyText(a: ActivityAnomaly): string {
    const base = a.direction === 'up'
      ? m.anx_anomaly_up({ value: metric.format(a.value), expected: metric.format(a.expected) })
      : m.anx_anomaly_down({ value: metric.format(a.value), expected: metric.format(a.expected) });
    if (!a.driver) return base;
    return `${base}, ${m.anx_anomaly_driver({ channel: a.driver.name ?? m.anx_channel_deleted(), share: `${fmtNumber(a.driver.share)} %` })}`;
  }

  const markers: ChartMarker[] = $derived(
    stacked
      ? []
      : [
          ...annotations
            .map((a) => ({ index: shaped.dayOf(a.dateKey), tone: 'note' as const, text: m.anx_note_marker({ label: a.label }) }))
            .filter((mk) => mk.index >= 0),
          ...visibleAnomalies
            .map((a) => ({ index: shaped.dayOf(a.dateKey), tone: a.direction, text: anomalyText(a) }))
            .filter((mk) => mk.index >= 0),
        ],
  );

  // ── Chiffres de la période ─────────────────────────────────────────────────
  const facts = $derived.by(() => {
    const values = shaped.values;
    const total = values.reduce((s, v) => s + v, 0);
    let peak = 0;
    let low = 0;
    values.forEach((v, i) => {
      if (v > (values[peak] ?? 0)) peak = i;
      if (v < (values[low] ?? 0)) low = i;
    });
    return {
      total,
      avg: values.length > 0 ? total / values.length : 0,
      peakValue: values[peak] ?? 0,
      peakLabel: shaped.labels[peak] ?? '',
      lowValue: values[low] ?? 0,
      lowLabel: shaped.labels[low] ?? '',
      trend: trendPct(values),
    };
  });

  const avgLabel = $derived(
    { hour: m.anx_fact_avg_hour(), day: m.anx_fact_avg_day(), week: m.anx_fact_avg_week(), month: m.anx_fact_avg_month() }[resolved],
  );

  /** « À ce rythme, ~X d'ici la fin du mois », si la période couvre le début du mois. */
  const monthOutlook = $derived.by(() => {
    if (!canForecast || metric.aggregate !== 'sum') return null;
    const last = dates[dates.length - 1];
    if (!last) return null;
    const monthStart = `${last.slice(0, 7)}-01`;
    const startIndex = dates.indexOf(monthStart);
    if (startIndex < 0) return null;
    const left = daysLeftInMonth(last);
    const done = metric.daily.slice(startIndex).reduce((s, v) => s + v, 0);
    if (left === 0) return null;
    const fc = forecast(metric.daily, dates, left);
    return fc ? done + fc.values.reduce((s, v) => s + v, 0) : null;
  });

  // ── Notes ──────────────────────────────────────────────────────────────────
  let noteOpen = $state(false);
  let noteDate = $state('');
  let noteLabel = $state('');
  let noteSaving = $state(false);

  function openNote(dateKey?: string) {
    noteDate = dateKey ?? dates[dates.length - 1] ?? '';
    noteLabel = '';
    noteOpen = true;
  }

  function onChartSelect(index: number) {
    if (!noteOpen) return;
    const key = shaped.keys[index];
    if (key) noteDate = key.slice(0, 10);
  }

  async function saveNote(event: SubmitEvent) {
    event.preventDefault();
    if (!onAnnotate || !noteDate || !noteLabel.trim()) return;
    noteSaving = true;
    try {
      await onAnnotate(noteDate, noteLabel.trim());
      noteOpen = false;
    } catch (e) {
      toast.error(errorMessage(e) || m.anx_note_error());
    } finally {
      noteSaving = false;
    }
  }

  async function removeNote(id: string) {
    if (!onDeleteAnnotation) return;
    try {
      await onDeleteAnnotation(id);
    } catch (e) {
      toast.error(errorMessage(e) || m.anx_note_error());
    }
  }

  // ── Options de la barre d'outils ───────────────────────────────────────────
  const granularityOptions = $derived([
    { value: 'auto' as Granularity, label: m.anx_gran_auto() },
    ...(hourlyPossible && !stacked ? [{ value: 'hour' as Granularity, label: m.anx_gran_hour() }] : []),
    { value: 'day' as Granularity, label: m.anx_gran_day() },
    { value: 'week' as Granularity, label: m.anx_gran_week() },
    { value: 'month' as Granularity, label: m.anx_gran_month() },
  ]);

  const viewOptions: Array<{ id: View; icon: string; label: () => string }> = [
    { id: 'line', icon: 'line-chart', label: () => m.anx_view_line() },
    { id: 'bar', icon: 'bar-chart-2', label: () => m.anx_view_bar() },
    { id: 'stack-channel', icon: 'area-chart', label: () => m.anx_view_stack_channel() },
    { id: 'stack-category', icon: 'layers', label: () => m.anx_view_stack_category() },
    { id: 'table', icon: 'table', label: () => m.anx_view_table() },
  ];

  const chartMode: ChartMode = $derived(view === 'bar' ? 'bar' : stacked ? 'stacked' : 'line');
  const hourFallback = $derived(granularity === 'hour' && !hourlyReady && hourly !== null && hourlyKey === reloadKey && !hourly.available);
</script>

<section class="chart-card" aria-busy={busy}>
  <MetricTabs {metrics} {active} {onchange} {compare} label={m.anx_metrics_label()} />

  <div class="chart-card__toolbar">
    <FilterPills
      label={m.anx_gran_label()}
      options={granularityOptions}
      value={granularity}
      onchange={(v) => (granularity = v)}
    />
    <div class="chart-card__tools">
      <div class="icon-group" role="group" aria-label={m.anx_view_label()}>
        {#each viewOptions as option (option.id)}
          <button
            type="button"
            class="icon-group__btn"
            aria-pressed={view === option.id}
            aria-label={option.label()}
            title={option.label()}
            disabled={(option.id === 'stack-channel' || option.id === 'stack-category') && !metric.breakdown}
            onclick={() => (view = option.id)}
          >
            <Papicon icon={option.icon} size={16} />
          </button>
        {/each}
      </div>
    </div>
  </div>

  <div class="chart-card__layers">
    <button type="button" class="filter-pill" aria-pressed={smooth} disabled={stacked} onclick={() => (smooth = !smooth)}>
      {m.anx_opt_smooth()}
    </button>
    <button type="button" class="filter-pill" aria-pressed={compare} disabled={stacked} onclick={onToggleCompare}>
      {m.anx_opt_previous()}
    </button>
    {#if metric.forecast}
      <button
        type="button"
        class="filter-pill"
        aria-pressed={showForecast && canForecast}
        disabled={!canForecast}
        title={canForecast ? undefined : m.anx_forecast_unavailable()}
        onclick={() => (showForecast = !showForecast)}
      >
        {m.anx_opt_forecast()}
      </button>
    {/if}
    {#if onAnnotate}
      <span class="ml-auto">
        <Button size="sm" variant="ghost" icon="plus" onclick={() => (noteOpen ? (noteOpen = false) : openNote())}>
          {m.anx_note_add()}
        </Button>
      </span>
    {/if}
  </div>

  {#if noteOpen}
    <form class="note-form" onsubmit={saveNote}>
      <label class="note-form__field">
        <span>{m.anx_note_date()}</span>
        <input type="date" class="input" bind:value={noteDate} min={dates[0]} max={dates[dates.length - 1]} required />
      </label>
      <label class="note-form__field note-form__field--grow">
        <span>{m.anx_note_label()}</span>
        <input type="text" class="input" bind:value={noteLabel} maxlength="80" placeholder={m.anx_note_placeholder()} required />
      </label>
      <div class="flex items-end gap-2">
        <Button size="sm" variant="ghost" onclick={() => (noteOpen = false)}>{m.anx_note_cancel()}</Button>
        <Button size="sm" variant="primary" type="submit" loading={noteSaving}>{m.anx_note_save()}</Button>
      </div>
      <p class="note-form__hint">{m.anx_note_hint()}</p>
    </form>
  {/if}

  {#if hourFallback}
    <Callout variant="info">{m.anx_hourly_unavailable()}</Callout>
  {/if}

  <div class="chart-card__plot" class:chart-card__plot--busy={busy || breakdownLoading}>
    {#if view === 'table'}
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">{m.anx_table_period()}</th>
              <th scope="col" class="num">{metric.label}</th>
              {#if compare}
                <th scope="col" class="num">{m.anx_table_previous()}</th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each shaped.labels as label, i (shaped.keys[i])}
              <tr>
                <th scope="row">{label}</th>
                <td class="num">{metric.format(shaped.values[i] ?? 0)}</td>
                {#if compare}
                  <td class="num text-on-surface-variant">{metric.format(shaped.previous[i] ?? 0)}</td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if stacked}
      {#if breakdown && !breakdown.available}
        <Callout variant="info">{m.anx_breakdown_unavailable()}</Callout>
      {:else if stacks.length > 0}
        <TimeSeriesChart labels={stackLabels} mode="stacked" {stacks} format={metric.format} height={300} />
      {:else if breakdown && !breakdownLoading}
        <p class="py-10 text-center text-body-sm text-on-surface-variant">{m.anx_breakdown_empty()}</p>
      {:else}
        <div class="chart-card__placeholder" aria-hidden="true"></div>
      {/if}
    {:else}
      <TimeSeriesChart
        {labels}
        mode={chartMode}
        main={chartMain}
        previous={chartPrevious}
        smoothed={chartSmoothed}
        projection={chartProjection}
        {markers}
        format={metric.format}
        onselect={onChartSelect}
      />
    {/if}
  </div>

  <dl class="facts">
    <div class="facts__item">
      <dt>{metric.aggregate === 'sum' ? m.anx_fact_total() : m.anx_fact_average()}</dt>
      <dd>{metric.format(metric.aggregate === 'sum' ? facts.total : facts.avg)}</dd>
    </div>
    {#if metric.aggregate === 'sum'}
      <div class="facts__item">
        <dt>{avgLabel}</dt>
        <dd>{metric.format(Math.round(facts.avg * 10) / 10)}</dd>
      </div>
    {/if}
    <div class="facts__item">
      <dt>{m.anx_fact_peak()}</dt>
      <dd>{metric.format(facts.peakValue)} <span class="facts__sub">{facts.peakLabel}</span></dd>
    </div>
    {#if metric.aggregate === 'avg'}
      <div class="facts__item">
        <dt>{m.anx_fact_min()}</dt>
        <dd>{metric.format(facts.lowValue)} <span class="facts__sub">{facts.lowLabel}</span></dd>
      </div>
    {/if}
    <div class="facts__item">
      <dt title={m.anx_trend_vs_start()}>{m.anx_fact_trend()}</dt>
      <dd class={facts.trend === null || Math.abs(facts.trend) < 0.05 ? '' : (facts.trend > 0) !== Boolean(metric.invert) ? 'text-success' : 'text-error'}>
        {fmtDelta(facts.trend, 'pct')}
        <span class="facts__sub">{m.anx_trend_vs_start()}</span>
      </dd>
    </div>
    {#if monthOutlook !== null && showForecast}
      <div class="facts__item facts__item--wide">
        <dt>{m.anx_opt_forecast()}</dt>
        <dd class="facts__outlook">{m.anx_forecast_month({ value: metric.format(Math.round(monthOutlook)) })}</dd>
      </div>
    {/if}
  </dl>

  {#if !stacked && (annotations.length > 0 || visibleAnomalies.length > 0)}
    <div class="markers">
      <h4 class="markers__title">{m.anx_markers_title()}</h4>
      <ul class="markers__list">
        {#each visibleAnomalies as anomaly (anomaly.dateKey + anomaly.metric)}
          <li class="marker">
            <span class="marker__icon" aria-hidden="true">
              <Papicon icon={anomaly.direction === 'up' ? 'trending-up' : 'trending-down'} size={14} />
            </span>
            <span class="marker__date">{shortDate(anomaly.dateKey)}</span>
            <span class="marker__text">{anomalyText(anomaly)}</span>
          </li>
        {/each}
        {#each annotations as note (note.id)}
          <li class="marker">
            <span class="marker__icon marker__icon--note" aria-hidden="true"><Papicon icon="sticky-note" size={14} /></span>
            <span class="marker__date">{shortDate(note.dateKey)}</span>
            <span class="marker__text">
              {note.label}
              {#if note.authorName}<span class="marker__author">{m.anx_note_by({ name: note.authorName })}</span>{/if}
            </span>
            {#if canDeleteAnnotation(note)}
              <button type="button" class="marker__remove" aria-label={m.anx_note_delete()} title={m.anx_note_delete()} onclick={() => removeNote(note.id)}>
                <Papicon icon="x" size={14} />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .chart-card {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    min-width: 0;
    padding: 1rem;
    border-radius: 0.875rem;
    border: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-lowest, var(--color-surface));
  }

  .chart-card__toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }

  .chart-card__tools {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .chart-card__layers {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .icon-group {
    display: inline-flex;
    padding: 0.125rem;
    gap: 0.125rem;
    border-radius: 0.5rem;
    border: 1px solid var(--color-outline-variant);
  }

  .icon-group__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    color: var(--color-on-surface-variant);
  }

  .icon-group__btn:hover:not(:disabled) {
    background: var(--color-surface-container);
    color: var(--color-on-surface);
  }

  .icon-group__btn[aria-pressed='true'] {
    background: var(--color-surface-container-high);
    color: var(--color-on-surface);
  }

  .icon-group__btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .icon-group__btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .chart-card__plot {
    min-width: 0;
    transition: opacity 150ms ease;
  }

  .chart-card__plot--busy {
    opacity: 0.55;
  }

  .chart-card__placeholder {
    height: 300px;
  }

  .note-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem;
    padding: 0.75rem;
    border-radius: 0.625rem;
    background: var(--color-surface-container-low);
  }

  .note-form__field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .note-form__field--grow {
    flex: 1 1 14rem;
  }

  .note-form__hint {
    flex-basis: 100%;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .table-wrap {
    max-height: 22rem;
    overflow: auto;
    border-radius: 0.5rem;
    border: 1px solid var(--color-outline-variant);
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .data-table th,
  .data-table td {
    padding: 0.4375rem 0.75rem;
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

  .data-table tbody th {
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.5rem 1.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-outline-variant);
  }

  .facts__item {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .facts__item--wide {
    grid-column: 1 / -1;
  }

  .facts__item dt {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  .facts__item dd {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-on-surface);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .facts__sub {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--color-on-surface-variant);
  }

  .facts__outlook {
    white-space: normal;
  }

  .markers {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .markers__title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .markers__list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 12rem;
    overflow-y: auto;
  }

  .marker {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.25rem 0.375rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
  }

  .marker:hover {
    background: var(--color-surface-container-low);
  }

  .marker__icon {
    align-self: center;
    color: var(--color-on-surface-variant);
  }

  .marker__icon--note {
    color: var(--color-primary);
  }

  .marker__date {
    flex-shrink: 0;
    width: 4.5rem;
    color: var(--color-on-surface-variant);
    font-variant-numeric: tabular-nums;
  }

  .marker__text {
    min-width: 0;
    flex: 1;
    color: var(--color-on-surface);
  }

  .marker__author {
    margin-left: 0.375rem;
    color: var(--color-on-surface-variant);
  }

  .marker__remove {
    align-self: center;
    display: inline-flex;
    padding: 0.125rem;
    border-radius: 0.25rem;
    color: var(--color-on-surface-variant);
  }

  .marker__remove:hover {
    color: var(--color-error);
    background: var(--color-surface-container);
  }
</style>
