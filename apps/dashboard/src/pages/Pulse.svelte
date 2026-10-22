<!--
  Pulse : la note de santé du serveur.

  - Aperçu : la note du dernier jour complet, pourquoi elle est là (facteurs en
    points, chacun avec la page où agir), le rang parmi les serveurs de même
    taille, la courbe de la note et de ses cinq sous-notes (un clic sur un jour
    en donne le détail), les conseils du jour et l'alerte de chute.
  - Santé : chaque sous-note décomposée en facteurs, et les chiffres du jour.
  - Prévisions : membres, messages et vocal projetés, rythme de la semaine.

  Le diagnostic porte toujours sur une journée **complète** : notes, tendance
  et alertes ne se comparent qu'entre jours entiers. La journée en cours n'est
  affichée qu'en indicateur provisoire.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Button, Callout, FilterPills, SectionCard, Tabs } from '../lib/components/ui';
  import { fetchPulseData, refreshPulse, fetchPredictions } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import MetricTabs, { type MetricTab } from '../lib/components/analytics/MetricTabs.svelte';
  import TimeSeriesChart, { type ChartMarker } from '../lib/components/analytics/TimeSeriesChart.svelte';
  import KpiTile from '../lib/components/analytics/KpiTile.svelte';
  import { movingAverage } from '../lib/components/analytics/timeSeries';
  import { fmtDelta, fmtMinutes, fmtNumber, fmtPct, shortDate, SERIES } from '../lib/components/analytics/analyticsFormat';
  import PulseWatchCard from '../lib/components/pulse/PulseWatchCard.svelte';
  import {
    DIMENSIONS,
    alertHref,
    alertText,
    alertVariant,
    confidenceLabel,
    dayLabel,
    dayName,
    factorDetail,
    factorHref,
    factorLabel,
    scoreLabel,
    scoreTone,
    type PulseFactor,
    type PulseHistoryPoint,
    type PulseMetrics,
    type PulsePayload,
    type PulseScores,
  } from '../lib/components/pulse/pulseFormat';

  type TabId = 'sante' | 'predictions' | 'apercu';

  interface TrendPoint {
    dateKey: string;
    value: number;
    predicted?: boolean;
    lower?: number;
    upper?: number;
  }

  interface Anomaly {
    type: 'spike' | 'drop';
    metric: string;
    message: string;
    severity: string;
    dateKey: string;
    value: number;
    expectedRange: { min: number; max: number };
    deviation: number;
  }

  interface PredictionPayload {
    hasData: boolean;
    observedDays: number;
    membersTrend: TrendPoint[];
    messagesTrend: TrendPoint[];
    voiceTrend: TrendPoint[];
    growthForecast: { predicted7d: number; predicted30d: number; confidence: number; dailyNet: number };
    anomalies: Anomaly[];
    seasonality: {
      busiestDay: string;
      quietestDay: string;
      busiestHour: number;
      quietestHour: number;
      weekdayAverages: number[];
      hourlyAverages: number[];
      lowConfidence: boolean;
    };
  }

  let loading = $state(true);
  let refreshing = $state(false);
  let predictionsLoading = $state(false);
  let pulseData: PulsePayload | null = $state(null);
  let predData: PredictionPayload | null = $state(null);

  const pulseTabs = ['apercu', 'sante', 'predictions'] as const;
  let activeTab: TabId = $state('apercu');
  let period = $state('30');
  let historyMetric = $state('score');
  let selectedDay = $state<number | null>(null);
  let forecastMetric = $state('messages');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/pulse', pulseTabs, 'apercu') as TabId;
  });

  const current = $derived(pulseData?.hasData ? pulseData.current : null);
  const metrics = $derived<PulseMetrics | null>(pulseData?.hasData ? pulseData.metrics : null);
  const today = $derived(pulseData?.today ?? null);
  const factors = $derived<PulseFactor[]>(current?.factors ?? []);

  async function load() {
    loading = true;
    try {
      const [pulse, pred] = await Promise.all([fetchPulseData(), fetchPredictions(Number(period))]);
      pulseData = pulse as PulsePayload;
      predData = pred as PredictionPayload;
    } catch {
      toast.error(m.pulse_load_error());
    } finally {
      loading = false;
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const pulse = (await refreshPulse()) as PulsePayload & { recomputedDays?: number };
      pulseData = pulse;
      selectedDay = null;
      // Le recalcul invalide le cache serveur des prévisions : on les relit.
      predData = (await fetchPredictions(Number(period))) as PredictionPayload;
      toast.success(m.pulse_recomputed({ days: pulse.recomputedDays ?? 7 }));
    } catch {
      toast.error(m.pulse_refresh_error());
    } finally {
      refreshing = false;
    }
  }

  async function changePeriod(p: string) {
    if (p === period || predictionsLoading) return;
    period = p;
    predictionsLoading = true;
    try {
      predData = (await fetchPredictions(Number(p))) as PredictionPayload;
    } catch {
      toast.error(m.pulse_load_error());
    } finally {
      predictionsLoading = false;
    }
  }

  // ---- Aperçu : pourquoi ce score ----

  const lifting = $derived(factors.filter((f) => f.impact >= 0.5).sort((a, b) => b.impact - a.impact).slice(0, 4));
  const dragging = $derived(factors.filter((f) => f.impact <= -0.5).sort((a, b) => a.impact - b.impact).slice(0, 4));

  // ---- Aperçu : historique ----

  /**
   * L'historique stocké, dont le dernier jour est remplacé par le calcul à la
   * volée (`current`) : courbe, onglets et facteurs disent la même chose.
   */
  const points = $derived.by<PulseHistoryPoint[]>(() => {
    const history = pulseData?.history ?? [];
    if (!current || !metrics) return history;
    const live: PulseHistoryPoint = { ...current, ...metrics, dateKey: current.dateKey, alerts: current.alerts };
    const last = history[history.length - 1];
    if (last?.dateKey === current.dateKey) return [...history.slice(0, -1), live];
    if (!last || last.dateKey < current.dateKey) return [...history, live];
    return history;
  });

  const SCORE_SERIES: Array<{ id: string; field: keyof PulseScores; label: () => string; color: string }> = [
    { id: 'score', field: 'score', label: () => m.pulse_series_score(), color: SERIES[0] },
    ...DIMENSIONS.map((d, i) => ({ id: d.id, field: d.field, label: d.label, color: SERIES[i + 1] })),
  ];

  const historyTabs = $derived<MetricTab[]>(
    SCORE_SERIES.map((s) => {
      const values = points.map((p) => p[s.field]);
      const last = values[values.length - 1];
      // Écart face au même jour de la semaine précédente.
      const weekAgo = values.length >= 8 ? values[values.length - 8] : undefined;
      return {
        id: s.id,
        label: s.label(),
        value: last === undefined ? '–' : String(last),
        delta: last !== undefined && weekAgo !== undefined ? last - weekAgo : null,
        spark: values.slice(-14),
        color: s.color,
      };
    }),
  );

  const activeSeries = $derived(SCORE_SERIES.find((s) => s.id === historyMetric) ?? SCORE_SERIES[0]);
  const historyValues = $derived(points.map((p) => p[activeSeries.field]));

  const historyMarkers = $derived.by<ChartMarker[]>(() =>
    points.flatMap((p, index): ChartMarker[] => {
      const alerts = p.alerts ?? [];
      const danger = alerts.find((a) => a.severity === 'danger');
      if (danger) return [{ index, tone: 'down' as const, text: alertText(danger) }];
      const great = alerts.find((a) => a.code === 'excellent');
      return great ? [{ index, tone: 'up' as const, text: alertText(great) }] : [];
    }),
  );

  const dayIndex = $derived(selectedDay !== null && selectedDay < points.length ? selectedDay : points.length - 1);
  const day = $derived(points[dayIndex] ?? null);
  const dayBefore = $derived(dayIndex > 0 ? points[dayIndex - 1] : null);

  /** Écart en % d'un chiffre face à la veille, `null` sans base. */
  function pctChange(now: number, before: number | undefined): number | null {
    if (before === undefined || !(before > 0)) return null;
    return ((now - before) / before) * 100;
  }

  // ---- Santé ----

  const factorsByDimension = $derived(
    Object.fromEntries(DIMENSIONS.map((d) => [d.id, factors.filter((f) => f.dimension === d.id)])) as Record<string, PulseFactor[]>,
  );

  // ---- Prévisions ----

  const FORECAST_SERIES = [
    { id: 'members', label: () => m.pulse_trend_members(), color: SERIES[0], pick: (p: PredictionPayload) => p.membersTrend, format: (v: number) => fmtNumber(Math.round(v)) },
    { id: 'messages', label: () => m.pulse_trend_messages(), color: SERIES[1], pick: (p: PredictionPayload) => p.messagesTrend, format: (v: number) => fmtNumber(Math.round(v)) },
    { id: 'voice', label: () => m.pulse_trend_voice(), color: SERIES[2], pick: (p: PredictionPayload) => p.voiceTrend, format: (v: number) => fmtMinutes(v) },
  ];

  const forecastTabs = $derived<MetricTab[]>(
    predData
      ? FORECAST_SERIES.map((s) => {
          const observed = s.pick(predData!).filter((p) => !p.predicted);
          const last = observed[observed.length - 1];
          return { id: s.id, label: s.label(), value: last ? s.format(last.value) : '–', spark: observed.map((p) => p.value).slice(-21), color: s.color };
        })
      : [],
  );

  const forecastChart = $derived.by(() => {
    if (!predData) return null;
    const series = FORECAST_SERIES.find((s) => s.id === forecastMetric) ?? FORECAST_SERIES[0];
    const data = series.pick(predData);
    const lastObserved = data.findLastIndex((p) => !p.predicted);
    // La projection part du dernier point observé pour que les deux traits se rejoignent.
    const onProjection = (p: TrendPoint, i: number) => p.predicted || i === lastObserved;
    return {
      series,
      labels: data.map((p) => shortDate(p.dateKey)),
      main: data.map((p) => (p.predicted ? null : p.value)),
      projection: {
        label: m.pulse_legend_predicted(),
        values: data.map((p, i) => (onProjection(p, i) ? p.value : null)),
        low: data.map((p, i) => (onProjection(p, i) ? (p.lower ?? p.value) : null)),
        high: data.map((p, i) => (onProjection(p, i) ? (p.upper ?? p.value) : null)),
      },
      hasProjection: data.some((p) => p.predicted),
    };
  });

  /** Semaine du lundi au dimanche ; le bot indexe à partir du dimanche. */
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  const METRIC_LABELS: Record<string, () => string> = {
    messages: () => m.pulse_metric_name_messages(),
    voice: () => m.pulse_metric_name_voice(),
    leaves: () => m.pulse_metric_name_leaves(),
  };

  function anomalyText(a: Anomaly): string {
    const metric = METRIC_LABELS[a.metric]?.() ?? a.metric;
    const expected = Math.round((a.expectedRange.min + a.expectedRange.max) / 2);
    const args = { metric, date: shortDate(a.dateKey), value: fmtNumber(a.value), expected: fmtNumber(expected) };
    return a.type === 'spike' ? m.pulse_anomaly_spike(args) : m.pulse_anomaly_drop(args);
  }

  function minutesUntil(iso: string): number {
    return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  }

  const RING = 2 * Math.PI * 52;

  onMount(load);
</script>

<ModulePage title={m.pulse_title()} description={m.pulse_desc()} icon="activity" featureKey="dashboard">
  {#snippet actions()}
    <Button variant="primary" icon="refresh-cw" loading={refreshing} onclick={handleRefresh}>
      {refreshing ? m.pulse_recomputing() : m.pulse_recompute()}
    </Button>
  {/snippet}

  <Tabs
    label={m.pulse_title()}
    class="mb-6"
    tabs={pageTabItems('/pulse')}
    active={activeTab}
    onchange={(id) => gotoTab('/pulse', id, 'apercu')}
  />

  {#if loading}
    <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-4">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      <p class="text-sm">{m.pulse_loading()}</p>
    </div>

  <!-- ==================== APERÇU ==================== -->
  {:else if activeTab === 'apercu'}
    {#if current && metrics}
      <div class="flex flex-col gap-6">
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-6">
          <!-- Note du jour -->
          <section class="section-card p-5 flex flex-col gap-4">
            <div class="flex items-center gap-5">
              <svg class="pulse-ring shrink-0" viewBox="0 0 120 120" width="112" height="112" role="img" aria-label={m.pulse_score_aria({ score: current.score })}>
                <circle cx="60" cy="60" r="52" class="pulse-ring__track" />
                <circle
                  cx="60" cy="60" r="52"
                  class="pulse-ring__value"
                  style="stroke: {scoreTone(current.score)}; stroke-dasharray: {(current.score / 100) * RING} {RING};"
                />
                <text x="60" y="58" text-anchor="middle" class="pulse-ring__score">{current.score}</text>
                <text x="60" y="78" text-anchor="middle" class="pulse-ring__max">/100</text>
              </svg>
              <div class="flex flex-col gap-1 min-w-0">
                <span class="text-lg font-semibold text-on-surface">{scoreLabel(current.score)}</span>
                <span class="flex items-center gap-1 text-body-sm {current.trend === 'UP' ? 'text-success' : current.trend === 'DOWN' ? 'text-error' : 'text-on-surface-variant'}">
                  <Papicon icon={current.trend === 'UP' ? 'trending-up' : current.trend === 'DOWN' ? 'trending-down' : 'minus'} size={14} />
                  {current.trendDelta !== 0 ? m.pulse_trend_vs_week({ delta: fmtDelta(current.trendDelta, 'pts') }) : m.pulse_stable()}
                </span>
                <span class="text-body-sm text-on-surface-variant">{m.pulse_day_of({ date: shortDate(current.dateKey) })}</span>
                {#if current.confidence !== null && current.confidence !== undefined}
                  <span class="text-body-sm text-on-surface-variant" title={m.pulse_confidence_hint()}>
                    {confidenceLabel(current.confidence)}
                  </span>
                {/if}
              </div>
            </div>

            {#if pulseData?.benchmark}
              {@const b = pulseData.benchmark}
              <div class="pulse-benchmark" title={m.pulse_benchmark_hint({ peers: b.peers })}>
                <div class="flex items-baseline justify-between gap-2">
                  <span class="text-body-sm text-on-surface">{m.pulse_benchmark({ pct: b.percentile, min: fmtNumber(b.minMembers), max: fmtNumber(b.maxMembers) })}</span>
                </div>
                <div class="pulse-benchmark__bar" aria-hidden="true">
                  <span style="left: {b.percentile}%;"></span>
                </div>
              </div>
            {:else}
              <p class="text-body-sm text-on-surface-variant">{m.pulse_benchmark_none()}</p>
            {/if}

            {#if today}
              <!-- Indicateur provisoire : la journée en cours n'est pas comparable à une journée entière. -->
              <div class="pt-3 border-t border-outline-variant flex items-center justify-between gap-3">
                <span class="text-body-sm text-on-surface-variant" title={m.pulse_partial_hint()}>{m.pulse_today_partial()}</span>
                <span class="text-base font-semibold" style="color: {scoreTone(today.score)}">{today.score}<span class="text-body-sm text-on-surface-variant">/100</span></span>
              </div>
            {/if}
          </section>

          <!-- Pourquoi ce score -->
          <SectionCard title={m.pulse_why_title()} description={m.pulse_why_desc()} icon="help-circle">
            {#if factors.length === 0}
              <p class="text-body-sm text-on-surface-variant">{m.pulse_factors_unavailable()}</p>
            {:else}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                {#each [{ title: m.pulse_why_up(), list: lifting, tone: 'text-success' }, { title: m.pulse_why_down(), list: dragging, tone: 'text-error' }] as group (group.title)}
                  <div class="flex flex-col gap-2">
                    <h4 class="text-body-sm font-medium text-on-surface-variant">{group.title}</h4>
                    {#if group.list.length === 0}
                      <p class="text-body-sm text-on-surface-variant">{m.pulse_why_none()}</p>
                    {:else}
                      <ul class="flex flex-col gap-1">
                        {#each group.list as factor (factor.key)}
                          <li>
                            <a class="pulse-factor" href={factorHref(factor)}>
                              <span class="min-w-0 flex flex-col">
                                <span class="text-body-sm font-medium text-on-surface truncate">{factorLabel(factor)}</span>
                                <span class="text-2xs text-on-surface-variant truncate">{factorDetail(factor)}</span>
                              </span>
                              <span class="text-body-sm font-semibold tabular-nums shrink-0 {group.tone}">{fmtDelta(factor.impact, 'pts')}</span>
                              <Papicon icon="chevron-right" size={14} />
                            </a>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </SectionCard>
        </div>

        <!-- Historique -->
        {#if points.length > 1}
          <div class="flex flex-col gap-3">
            <MetricTabs
              metrics={historyTabs}
              active={historyMetric}
              onchange={(id) => (historyMetric = id)}
              compare
              deltaUnit="pts"
              label={m.pulse_metrics_label()}
            />
            <SectionCard title={m.pulse_history_title()} description={m.pulse_history_desc()} icon="bar-chart-2">
              <TimeSeriesChart
                labels={points.map((p) => shortDate(p.dateKey))}
                mode="line"
                main={{ label: activeSeries.label(), values: historyValues, color: activeSeries.color }}
                smoothed={points.length >= 10 ? { label: m.pulse_smoothed(), values: movingAverage(historyValues, 7) } : null}
                markers={historyMarkers}
                format={(v) => String(Math.round(v))}
                height={260}
                onselect={(i) => (selectedDay = i)}
              />

              {#if day}
                <div class="mt-5 pt-4 border-t border-outline-variant flex flex-col gap-3">
                  <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <h4 class="text-sm font-semibold text-on-surface">{m.pulse_day_of({ date: shortDate(day.dateKey) })}</h4>
                    <span class="text-body-sm text-on-surface-variant">
                      {SCORE_SERIES.map((s) => `${s.label()} ${day[s.field]}`).join(' · ')}
                    </span>
                  </div>
                  <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                    <KpiTile label={m.pulse_metric_messages()} value={fmtNumber(day.totalMessages)} compare={Boolean(dayBefore)} delta={pctChange(day.totalMessages, dayBefore?.totalMessages)} />
                    <KpiTile label={m.pulse_metric_voice()} value={fmtMinutes(day.totalVoiceMinutes)} compare={Boolean(dayBefore)} delta={pctChange(day.totalVoiceMinutes, dayBefore?.totalVoiceMinutes)} />
                    <KpiTile label={m.pulse_metric_active()} value={fmtNumber(day.activeMembers)} compare={Boolean(dayBefore)} delta={pctChange(day.activeMembers, dayBefore?.activeMembers)} />
                    <KpiTile label={m.pulse_metric_flow()} value="+{fmtNumber(day.membersJoined)} / −{fmtNumber(day.membersLeft)}" />
                    <KpiTile label={m.pulse_metric_sanctions()} value={fmtNumber(day.sanctionsCount)} />
                    <KpiTile label={m.pulse_metric_tickets()} value="{fmtNumber(day.ticketsResolved)} / {fmtNumber(day.ticketsResolved + day.ticketsOpen)}" />
                  </div>
                  {#if dayIndex !== points.length - 1 && (day.alerts?.length ?? 0) > 0}
                    <ul class="flex flex-col gap-1">
                      {#each day.alerts ?? [] as alert, i (alert.code ?? i)}
                        <li class="text-body-sm text-on-surface-variant">· {alertText(alert)}</li>
                      {/each}
                    </ul>
                  {/if}
                  <p class="text-2xs text-on-surface-variant">{m.pulse_day_hint()}</p>
                </div>
              {/if}
            </SectionCard>
          </div>
        {/if}

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <!-- Conseils -->
          <SectionCard title={m.pulse_alerts_title()} icon="lightbulb">
            <div class="flex flex-col gap-2">
              {#if pulseData?.bumpStatus}
                {@const bump = pulseData.bumpStatus}
                <Callout variant={bump.overdue ? 'success' : 'info'} icon="arrow-up-circle">
                  {bump.overdue
                    ? m.pulse_bump_available({ provider: bump.providerLabel })
                    : m.pulse_bump_next_in({ provider: bump.providerLabel, minutes: minutesUntil(bump.nextBumpAt) })}
                </Callout>
              {/if}
              {#each current.alerts as alert, i (alert.code ?? i)}
                {@const href = alertHref(alert)}
                <Callout variant={alertVariant(alert.severity)}>
                  {alertText(alert)}
                  {#snippet actions()}
                    {#if href}<Button variant="ghost" size="sm" {href} iconRight="arrow-right">{m.pulse_act()}</Button>{/if}
                  {/snippet}
                </Callout>
              {:else}
                <p class="text-body-sm text-on-surface-variant">{m.pulse_alerts_none()}</p>
              {/each}
            </div>
          </SectionCard>

          <PulseWatchCard />
        </div>
      </div>
    {:else}
      <EmptyState icon="heart" title={m.pulse_empty_title()} description={m.pulse_empty_desc()} actionLabel={m.pulse_recompute()} actionIcon="RefreshCw" onAction={handleRefresh} />
    {/if}

  <!-- ==================== SANTÉ ==================== -->
  {:else if activeTab === 'sante'}
    {#if current && metrics}
      {@const previous = points.length > 1 ? points[points.length - 2] : null}
      <div class="flex flex-col gap-6">
        <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          <KpiTile label={m.pulse_metric_messages()} value={fmtNumber(metrics.totalMessages)} compare={Boolean(previous)} delta={pctChange(metrics.totalMessages, previous?.totalMessages)} />
          <KpiTile label={m.pulse_metric_voice()} value={fmtMinutes(metrics.totalVoiceMinutes)} compare={Boolean(previous)} delta={pctChange(metrics.totalVoiceMinutes, previous?.totalVoiceMinutes)} />
          <KpiTile label={m.pulse_metric_active()} value="{fmtNumber(metrics.activeMembers)} / {fmtNumber(metrics.totalMembers)}" compare={Boolean(previous)} delta={pctChange(metrics.activeMembers, previous?.activeMembers)} />
          <KpiTile label={m.pulse_metric_flow()} value="+{fmtNumber(metrics.membersJoined)} / −{fmtNumber(metrics.membersLeft)}" />
          <KpiTile label={m.pulse_metric_sanctions()} value={fmtNumber(metrics.sanctionsCount)} />
          <KpiTile label={m.pulse_metric_tickets()} value="{fmtNumber(metrics.ticketsResolved)} / {fmtNumber(metrics.ticketsResolved + metrics.ticketsOpen)}" />
        </div>

        {#if factors.length === 0}
          <Callout variant="info">{m.pulse_factors_unavailable()}</Callout>
        {/if}

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
          {#each DIMENSIONS as dim (dim.id)}
            {@const score = current[dim.field]}
            <SectionCard title={dim.label()} description={dim.desc()} icon={dim.icon}>
              {#snippet actions()}
                <span class="flex flex-col items-end">
                  <span class="text-xl font-semibold tabular-nums" style="color: {scoreTone(score)}">{score}</span>
                  <span class="text-2xs text-on-surface-variant">{m.pulse_dim_weight({ pct: Math.round(dim.weight * 100) })}</span>
                </span>
              {/snippet}
              {#if factorsByDimension[dim.id].length === 0}
                <p class="text-body-sm text-on-surface-variant">{factors.length === 0 ? m.pulse_factors_unavailable() : m.pulse_dim_no_factor()}</p>
              {:else}
                <ul class="flex flex-col gap-3">
                  {#each factorsByDimension[dim.id] as factor (factor.key)}
                    <li class="pulse-factor-row">
                      <div class="flex items-baseline justify-between gap-3">
                        <a class="text-body-sm font-medium text-on-surface hover:underline truncate" href={factorHref(factor)}>{factorLabel(factor)}</a>
                        <span class="text-body-sm tabular-nums shrink-0 {factor.impact > 0 ? 'text-success' : factor.impact < 0 ? 'text-error' : 'text-on-surface-variant'}">
                          {fmtDelta(factor.impact, 'pts')}
                        </span>
                      </div>
                      <div class="pulse-meter" aria-hidden="true">
                        <span style="width: {factor.score}%; background: {scoreTone(factor.score)};"></span>
                      </div>
                      <div class="flex items-baseline justify-between gap-3 text-2xs text-on-surface-variant">
                        <span class="truncate">{factorDetail(factor)}</span>
                        <span class="shrink-0">{m.pulse_factor_weight({ score: factor.score, pct: Math.round(factor.weight * 100) })}</span>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </SectionCard>
          {/each}
        </div>
      </div>
    {:else}
      <EmptyState icon="heart" title={m.pulse_empty_title()} description={m.pulse_empty_desc()} actionLabel={m.pulse_recompute()} actionIcon="RefreshCw" onAction={handleRefresh} />
    {/if}

  <!-- ==================== PRÉVISIONS ==================== -->
  {:else if activeTab === 'predictions'}
    <div class="flex flex-col gap-6" class:opacity-60={predictionsLoading}>
      <FilterPills
        label={m.pulse_period_label()}
        options={['7', '14', '30', '60', '90'].map((p) => ({ value: p, label: m.pulse_days_short({ n: p }) }))}
        value={period}
        onchange={changePeriod}
        disabled={predictionsLoading}
      />

      {#if predData?.hasData && forecastChart}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiTile label={m.pulse_forecast_7d()} value={fmtNumber(predData.growthForecast.predicted7d)} />
          <KpiTile label={m.pulse_forecast_30d()} value={fmtNumber(predData.growthForecast.predicted30d)} />
          <KpiTile label={m.pulse_forecast_per_day()} value="{predData.growthForecast.dailyNet > 0 ? '+' : ''}{fmtNumber(predData.growthForecast.dailyNet)}" />
          <KpiTile label={m.pulse_forecast_confidence()} value={fmtPct(predData.growthForecast.confidence, 0)} hint={m.pulse_observed_days({ days: predData.observedDays })} />
        </div>
        {#if predData.growthForecast.confidence < 50}
          <Callout variant="warning">{m.pulse_confidence_low()}</Callout>
        {/if}

        <div class="flex flex-col gap-3">
          <MetricTabs metrics={forecastTabs} active={forecastMetric} onchange={(id) => (forecastMetric = id)} label={m.pulse_forecast_label()} />
          <SectionCard title={forecastChart.series.label()} description={m.pulse_forecast_desc()} icon="trending-up">
            <TimeSeriesChart
              labels={forecastChart.labels}
              mode="line"
              main={{ label: m.pulse_legend_actual(), values: forecastChart.main, color: forecastChart.series.color }}
              projection={forecastChart.hasProjection ? forecastChart.projection : null}
              format={forecastChart.series.format}
              height={260}
            />
          </SectionCard>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SectionCard title={m.pulse_weekday_title()} description={m.pulse_weekday_desc({ busiest: dayName(predData.seasonality.busiestDay), quietest: dayName(predData.seasonality.quietestDay) })} icon="calendar">
            <TimeSeriesChart
              labels={WEEK_ORDER.map((d) => dayLabel(d))}
              mode="bar"
              main={{ label: m.pulse_trend_messages(), values: WEEK_ORDER.map((d) => predData!.seasonality.weekdayAverages[d] ?? 0), color: SERIES[1] }}
              format={(v) => fmtNumber(Math.round(v))}
              height={200}
            />
          </SectionCard>
          <SectionCard title={m.pulse_hourly_title()} description={m.pulse_hourly_desc({ busiest: predData.seasonality.busiestHour, quietest: predData.seasonality.quietestHour })} icon="clock">
            <TimeSeriesChart
              labels={predData.seasonality.hourlyAverages.map((_, h) => `${h}h`)}
              mode="bar"
              main={{ label: m.pulse_trend_messages(), values: predData.seasonality.hourlyAverages, color: SERIES[1] }}
              format={(v) => fmtNumber(Math.round(v))}
              height={200}
            />
          </SectionCard>
        </div>
        {#if predData.seasonality.lowConfidence}
          <Callout variant="warning">{m.pulse_seasonality_low()}</Callout>
        {/if}

        {#if predData.anomalies.length > 0}
          <SectionCard title={m.pulse_anomalies_title()} description={m.pulse_anomalies_desc()} icon="alert-triangle">
            <div class="flex flex-col gap-2">
              {#each predData.anomalies as anomaly (anomaly.metric + anomaly.dateKey)}
                <Callout variant={anomaly.severity === 'danger' ? 'danger' : 'warning'} icon={anomaly.type === 'spike' ? 'arrow-up' : 'arrow-down'}>
                  {anomalyText(anomaly)}
                </Callout>
              {/each}
            </div>
          </SectionCard>
        {/if}
      {:else}
        <EmptyState icon="trending-up" title={m.pulse_pred_empty_title()} description={m.pulse_pred_empty_desc()} reason="accumulating" />
      {/if}
    </div>
  {/if}
</ModulePage>

<style>
  .pulse-ring__track {
    fill: none;
    stroke: var(--color-surface-container-high);
    stroke-width: 9;
  }

  .pulse-ring__value {
    fill: none;
    stroke-width: 9;
    stroke-linecap: round;
    transform: rotate(-90deg);
    transform-origin: 60px 60px;
    transition: stroke-dasharray 0.6s ease;
  }

  .pulse-ring__score {
    font-family: var(--font-headline);
    font-size: 2.125rem;
    font-weight: 600;
    fill: var(--color-on-surface);
  }

  .pulse-ring__max {
    font-size: 0.75rem;
    fill: var(--color-on-surface-variant);
  }

  .pulse-benchmark {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .pulse-benchmark__bar {
    position: relative;
    height: 0.375rem;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--color-error), var(--color-warning), var(--color-success));
    opacity: 0.85;
  }

  .pulse-benchmark__bar span {
    position: absolute;
    top: 50%;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 999px;
    background: var(--color-on-surface);
    border: 2px solid var(--color-surface-container-low);
    transform: translate(-50%, -50%);
  }

  .pulse-factor {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.625rem;
    margin: 0 -0.625rem;
    border-radius: 0.5rem;
    color: var(--color-on-surface-variant);
    transition: background-color 0.15s ease;
  }

  .pulse-factor:hover,
  .pulse-factor:focus-visible {
    background: var(--color-surface-container);
  }

  .pulse-factor-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .pulse-meter {
    height: 0.375rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    overflow: hidden;
  }

  .pulse-meter span {
    display: block;
    height: 100%;
    border-radius: 999px;
    transition: width 0.4s ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse-ring__value,
    .pulse-meter span {
      transition: none;
    }
  }
</style>
