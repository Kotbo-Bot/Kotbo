<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs } from '../lib/components/ui';
  import { fetchPulseData, refreshPulse, fetchPredictions } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';

  type TabId = 'sante' | 'predictions' | 'apercu';

  interface PulseAlert {
    type: string;
    code?: string;
    severity: string;
    message: string;
    params?: Record<string, number | string>;
  }

  interface PulseSnapshot {
    dateKey: string;
    score: number;
    activityScore: number;
    moderationScore: number;
    growthScore: number;
    engagementScore: number;
    healthScore: number;
    trend: string;
    trendDelta: number;
    alerts: PulseAlert[];
    partial: boolean;
  }

  interface PulseMetrics {
    totalMessages: number;
    totalVoiceMinutes: number;
    activeMembers: number;
    totalMembers: number;
    membersJoined: number;
    membersLeft: number;
    sanctionsCount: number;
    ticketsResolved: number;
    ticketsOpen: number;
    channelsHealthy: number;
    channelsUnhealthy: number;
  }

  interface BumpStatus {
    provider: string;
    providerLabel: string;
    lastBumpAt: string;
    lastBumpUserId: string | null;
    nextBumpAt: string;
    overdue: boolean;
    overdueMinutes: number;
    reminderChannelId: string;
  }

  interface PulsePayload {
    hasData: boolean;
    current: PulseSnapshot;
    today: (PulseSnapshot & { metrics: PulseMetrics }) | null;
    history: Array<Pick<PulseSnapshot, 'dateKey' | 'score' | 'activityScore' | 'moderationScore' | 'growthScore' | 'engagementScore' | 'healthScore'>>;
    metrics: PulseMetrics;
    bumpStatus: BumpStatus | null;
  }

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
  let period = $state(30);

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/pulse', pulseTabs, 'apercu') as TabId;
  });

  /**
   * Le diagnostic porte toujours sur la dernière journée **complète** : score,
   * sous-scores, tendance et alertes ne sont comparables qu'entre jours entiers.
   * La journée en cours est affichée à part, comme simple indicateur provisoire.
   */
  const displayed = $derived<PulseSnapshot | null>(pulseData?.hasData ? pulseData.current : null);
  const displayedMetrics = $derived<PulseMetrics | null>(pulseData?.hasData ? pulseData.metrics : null);
  const today = $derived(pulseData?.today ?? null);

  async function load() {
    loading = true;
    try {
      const [pulse, pred] = await Promise.all([fetchPulseData(), fetchPredictions(period)]);
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
      // Le recalcul invalide le cache serveur des prévisions : on les relit.
      predData = (await fetchPredictions(period)) as PredictionPayload;
      toast.success(m.pulse_recomputed({ days: pulse.recomputedDays ?? 7 }));
    } catch {
      toast.error(m.pulse_refresh_error());
    } finally {
      refreshing = false;
    }
  }

  async function changePeriod(p: number) {
    if (p === period || predictionsLoading) return;
    period = p;
    predictionsLoading = true;
    try {
      predData = (await fetchPredictions(period)) as PredictionPayload;
    } catch {
      toast.error(m.pulse_load_error());
    } finally {
      predictionsLoading = false;
    }
  }

  // ---- Helpers de présentation ----

  function scoreColor(score: number): string {
    if (score >= 80) return '#10b981';
    if (score >= 60) return 'var(--primary-color)';
    if (score >= 40) return '#f59e0b';
    return '#f43f5e';
  }

  function scoreLabel(score: number): string {
    if (score >= 80) return m.pulse_score_excellent();
    if (score >= 60) return m.pulse_score_good();
    if (score >= 40) return m.pulse_score_average();
    if (score >= 20) return m.pulse_score_weak();
    return m.pulse_score_critical();
  }

  function trendIcon(trend: string): string {
    if (trend === 'UP') return 'trending-up';
    if (trend === 'DOWN') return 'trending-down';
    return 'minus';
  }

  function trendClass(trend: string): string {
    if (trend === 'UP') return 'text-success';
    if (trend === 'DOWN') return 'text-error';
    return 'text-on-surface-variant';
  }

  function severityClasses(severity: string): string {
    if (severity === 'danger') return 'bg-error/10 text-error border border-error/15';
    if (severity === 'warning') return 'bg-warning/10 text-warning border border-warning/15';
    if (severity === 'success') return 'bg-success/10 text-success border border-success/15';
    return 'bg-primary/10 text-primary border border-primary/15';
  }

  function severityIcon(severity: string): string {
    if (severity === 'success') return 'check-circle';
    if (severity === 'danger') return 'alert-circle';
    if (severity === 'info') return 'info';
    return 'alert-triangle';
  }

  /**
   * Les alertes sont produites par le bot avec un `code` stable et ses paramètres.
   * `message` n'est qu'un rendu français figé : on ne s'en sert que pour les
   * snapshots antérieurs à l'introduction des codes.
   */
  function alertText(alert: PulseAlert): string {
    const n = (key: string) => Number(alert.params?.[key] ?? 0);
    switch (alert.code) {
      case 'insufficient_data': return m.pulse_alert_insufficient_data();
      case 'activity_critical': return m.pulse_alert_activity_critical();
      case 'activity_low': return m.pulse_alert_activity_low();
      case 'moderation_critical': return m.pulse_alert_moderation_critical({ count: n('count') });
      case 'growth_critical': return m.pulse_alert_growth_critical({ left: n('left') });
      case 'growth_stagnant': return m.pulse_alert_growth_stagnant();
      case 'growth_churn': return m.pulse_alert_growth_churn({ left: n('left'), joined: n('joined') });
      case 'engagement_low': return m.pulse_alert_engagement_low();
      case 'tickets_backlog': return m.pulse_alert_tickets_backlog({ count: n('count') });
      case 'channels_unhealthy': return m.pulse_alert_channels_unhealthy({ count: n('count') });
      case 'excellent': return m.pulse_alert_excellent();
      default: return alert.message;
    }
  }

  function minutesUntil(iso: string): number {
    return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  }

  const METRIC_LABELS: Record<string, () => string> = {
    messages: () => m.pulse_metric_name_messages(),
    voice: () => m.pulse_metric_name_voice(),
    leaves: () => m.pulse_metric_name_leaves(),
  };

  function anomalyText(a: Anomaly): string {
    const metric = METRIC_LABELS[a.metric]?.() ?? a.metric;
    const expected = Math.round((a.expectedRange.min + a.expectedRange.max) / 2);
    const args = { metric, date: a.dateKey, value: a.value, expected };
    return a.type === 'spike' ? m.pulse_anomaly_spike(args) : m.pulse_anomaly_drop(args);
  }

  const DAY_KEYS = [
    () => m.pulse_day_0(), () => m.pulse_day_1(), () => m.pulse_day_2(), () => m.pulse_day_3(),
    () => m.pulse_day_4(), () => m.pulse_day_5(), () => m.pulse_day_6(),
  ];

  /** Le backend renvoie le nom français ; on le retraduit via son index. */
  const FR_DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  function dayName(value: string): string {
    const index = FR_DAYS.indexOf(value);
    return index >= 0 ? DAY_KEYS[index]() : value;
  }

  function subScores(snapshot: PulseSnapshot) {
    return [
      { label: m.pulse_sub_activity(), value: snapshot.activityScore, icon: 'message-circle' },
      { label: m.pulse_sub_engagement(), value: snapshot.engagementScore, icon: 'users' },
      { label: m.pulse_sub_growth(), value: snapshot.growthScore, icon: 'trending-up' },
      { label: m.pulse_sub_moderation(), value: snapshot.moderationScore, icon: 'shield' },
      { label: m.pulse_sub_health(), value: snapshot.healthScore, icon: 'activity' },
    ];
  }

  const trendSeries = $derived(
    predData
      ? [
          { key: 'members', title: m.pulse_trend_members(), data: predData.membersTrend, color: 'var(--primary-color)' },
          { key: 'messages', title: m.pulse_trend_messages(), data: predData.messagesTrend, color: '#10b981' },
          { key: 'voice', title: m.pulse_trend_voice(), data: predData.voiceTrend, color: '#f59e0b' },
        ]
      : [],
  );

  /** Échelle du profil horaire, recalculée avec les prévisions. */
  const maxHourly = $derived(Math.max(...(predData?.seasonality.hourlyAverages ?? [0]), 1));

  /** Hauteur relative d'une barre, bornée pour rester visible même à zéro. */
  function barHeight(value: number, max: number): number {
    if (!(max > 0)) return 2;
    return Math.max(2, (value / max) * 100);
  }

  onMount(load);
</script>

<ModulePage title={m.pulse_title()} description={m.pulse_desc()} icon="activity" featureKey="dashboard">
  {#snippet actions()}
    <button
      class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
      onclick={handleRefresh}
      disabled={refreshing}
    >
      <Papicon icon="refresh-cw" size={16} />
      {refreshing ? m.pulse_recomputing() : m.pulse_recompute()}
    </button>
    {#if activeTab === 'predictions' || activeTab === 'apercu'}
      <div class="flex gap-1">
        {#each [7, 14, 30, 60, 90] as p (p)}
          <button
            class="px-3 py-1.5 text-xs font-bold rounded-lg transition-all disabled:opacity-50 {period === p ? 'bg-primary text-on-primary shadow-sm' : 'bg-surface-container-high/40 text-on-surface-variant hover:bg-surface-container-high/60'}"
            onclick={() => changePeriod(p)}
            disabled={predictionsLoading}
          >{p}j</button>
        {/each}
      </div>
    {/if}
  {/snippet}

  <!-- ======================== TABS ======================== -->
  <Tabs
    label={m.pulse_title()}
    class="mb-6"
    tabs={pageTabItems('/pulse')}
    active={activeTab}
    onchange={(id) => gotoTab('/pulse', id, 'apercu')}
  />

  {#if loading}
    <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/50 gap-4">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      <p class="text-sm">{m.pulse_loading()}</p>
    </div>

  <!-- ==================== TAB: SANTE ==================== -->
  {:else if activeTab === 'sante'}
    {#if displayed && displayedMetrics}
      <div class="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <!-- Score principal -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 flex flex-col items-center justify-center gap-3">
          <div class="w-36 h-36 rounded-full border-[6px] flex flex-col items-center justify-center" style="border-color: {scoreColor(displayed.score)}">
            <span class="text-5xl font-bold text-on-surface leading-none">{displayed.score}</span>
            <span class="text-sm text-on-surface-variant/60">/100</span>
          </div>
          <div class="text-base font-semibold text-on-surface">{scoreLabel(displayed.score)}</div>
          <div class="flex items-center gap-1 text-sm {trendClass(displayed.trend)}">
            <Papicon icon={trendIcon(displayed.trend)} size={16} />
            {#if displayed.trendDelta !== 0}
              <span>{displayed.trendDelta > 0 ? '+' : ''}{displayed.trendDelta} {m.pulse_points()}</span>
            {:else}
              <span>{m.pulse_stable()}</span>
            {/if}
          </div>
          <p class="text-xs text-on-surface-variant/60 text-center">
            {m.pulse_day_of({ date: displayed.dateKey })}
          </p>

          {#if today}
            <!-- Indicateur provisoire : la journée en cours n'est pas comparable
                 à une journée entière, on l'affiche sans tendance ni alertes. -->
            <div class="w-full pt-3 mt-1 border-t border-outline-variant/10 flex flex-col items-center gap-0.5">
              <span class="text-2xs text-on-surface-variant/60">{m.pulse_today_partial()}</span>
              <span class="text-xl font-bold" style="color: {scoreColor(today.score)}">{today.score}<span class="text-xs text-on-surface-variant/50">/100</span></span>
              <span class="text-2xs text-warning text-center leading-tight">{m.pulse_partial_hint()}</span>
            </div>
          {/if}
        </div>

        <!-- Sous-scores -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="bar-chart-2" size={18} />
            {m.pulse_score_detail()}
          </h3>
          <div class="space-y-3">
            {#each subScores(displayed) as sub (sub.label)}
              <div class="pulse-score-row grid grid-cols-[120px_1fr_40px] items-center gap-3">
                <div class="flex items-center gap-2 text-sm text-on-surface-variant">
                  <Papicon icon={sub.icon} size={14} />
                  <span>{sub.label}</span>
                </div>
                <div class="h-2 bg-surface-container-high rounded-full overflow-hidden">
                  <div class="h-2 rounded-full transition-all duration-500" style="width: {sub.value}%; background: {scoreColor(sub.value)}"></div>
                </div>
                <span class="text-sm font-semibold text-right">{sub.value}</span>
              </div>
            {/each}
          </div>
        </div>

        <!-- Métriques -->
        <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="activity" size={18} />
            {m.pulse_metrics_title()}
          </h3>
          <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{displayedMetrics.totalMessages.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_metric_messages()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{Math.round(displayedMetrics.totalVoiceMinutes / 60)}h</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_metric_voice()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{displayedMetrics.activeMembers}/{displayedMetrics.totalMembers}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_metric_active()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold {displayedMetrics.membersJoined > displayedMetrics.membersLeft ? 'text-success' : ''}">
                +{displayedMetrics.membersJoined} / -{displayedMetrics.membersLeft}
              </div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_metric_flow()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{displayedMetrics.sanctionsCount}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_metric_sanctions()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{displayedMetrics.ticketsResolved}/{displayedMetrics.ticketsOpen + displayedMetrics.ticketsResolved}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_metric_tickets()}</div>
            </div>
          </div>
        </div>

        <!-- Rappel de bump -->
        {#if pulseData?.bumpStatus}
          {@const bump = pulseData.bumpStatus}
          <div class="lg:col-span-2 flex items-center gap-3 px-4 py-3 rounded-xl text-sm {bump.overdue ? severityClasses('success') : severityClasses('info')}">
            <Papicon icon="arrow-up-circle" size={16} />
            <span>
              {bump.overdue
                ? m.pulse_bump_available({ provider: bump.providerLabel })
                : m.pulse_bump_next_in({ provider: bump.providerLabel, minutes: minutesUntil(bump.nextBumpAt) })}
            </span>
          </div>
        {/if}

        <!-- Alertes -->
        {#if displayed.alerts.length > 0}
          <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="alert-triangle" size={18} />
              {m.pulse_alerts_title()}
            </h3>
            <div class="space-y-2">
              {#each displayed.alerts as alert, i (alert.code ?? i)}
                <div class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm {severityClasses(alert.severity)}">
                  <Papicon icon={severityIcon(alert.severity)} size={16} />
                  <span>{alertText(alert)}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Historique -->
        {#if pulseData && pulseData.history.length > 1}
          <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="bar-chart" size={18} />
              {m.pulse_history_title()}
            </h3>
            <div class="flex items-end gap-0.5 h-[120px]">
              {#each pulseData.history as point (point.dateKey)}
                <div
                  class="flex-1 min-w-1 rounded-t transition-all duration-300 hover:opacity-100 opacity-80"
                  style="height: {barHeight(point.score, 100)}%; background: {scoreColor(point.score)}"
                  title="{point.dateKey}: {point.score}/100"
                ></div>
              {/each}
            </div>
            <div class="flex justify-between text-xs font-medium text-on-surface-variant/60">
              <span>{pulseData.history[0]?.dateKey?.slice(5)}</span>
              <span>{pulseData.history[pulseData.history.length - 1]?.dateKey?.slice(5)}</span>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <EmptyState icon="heart" title={m.pulse_empty_title()} description={m.pulse_empty_desc()} />
    {/if}

  <!-- ==================== TAB: PREDICTIONS ==================== -->
  {:else if activeTab === 'predictions'}
    {#if predData?.hasData}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6" class:opacity-60={predictionsLoading}>
        <!-- Prévision de croissance -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="trending-up" size={18} />
            {m.pulse_forecast_title()}
          </h3>
          <div class="grid grid-cols-3 gap-4">
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{predData.growthForecast.predicted7d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_forecast_7d()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{predData.growthForecast.predicted30d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_forecast_30d()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{predData.growthForecast.confidence}%</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">{m.pulse_forecast_confidence()}</div>
            </div>
          </div>
          <p class="text-sm text-on-surface-variant">
            {m.pulse_forecast_daily({ value: predData.growthForecast.dailyNet })}
            <span class="text-on-surface-variant/60"> · {m.pulse_observed_days({ days: predData.observedDays })}</span>
          </p>
          {#if predData.growthForecast.confidence < 50}
            <p class="text-xs text-warning flex items-center gap-1.5">
              <Papicon icon="alert-triangle" size={13} />
              {m.pulse_confidence_low()}
            </p>
          {/if}
        </div>

        <!-- Saisonnalité -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="clock" size={18} />
            {m.pulse_seasonality_title()}
            <span class="text-xs font-normal text-on-surface-variant/50">({m.pulse_utc_note()})</span>
          </h3>
          <div class="space-y-3">
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="arrow-up-circle" size={16} />
              <span>{m.pulse_busiest_day()}: <strong class="text-on-surface">{dayName(predData.seasonality.busiestDay)}</strong></span>
            </div>
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="arrow-down-circle" size={16} />
              <span>{m.pulse_quietest_day()}: <strong class="text-on-surface">{dayName(predData.seasonality.quietestDay)}</strong></span>
            </div>
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="clock" size={16} />
              <span>{m.pulse_busiest_hour()}: <strong class="text-on-surface">{predData.seasonality.busiestHour}h</strong></span>
            </div>
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="moon" size={16} />
              <span>{m.pulse_quietest_hour()}: <strong class="text-on-surface">{predData.seasonality.quietestHour}h</strong></span>
            </div>
          </div>

          <!-- Profil horaire -->
          <div class="flex items-end gap-0.5 h-[60px] pt-2">
            {#each predData.seasonality.hourlyAverages as value, hour (hour)}
              <div
                class="flex-1 rounded-t transition-all duration-300 {hour === predData.seasonality.busiestHour ? 'bg-primary' : 'bg-primary/30'}"
                style="height: {barHeight(value, maxHourly)}%"
                title="{hour}h UTC · {value}"
              ></div>
            {/each}
          </div>

          {#if predData.seasonality.lowConfidence}
            <p class="text-xs text-warning flex items-center gap-1.5">
              <Papicon icon="alert-triangle" size={13} />
              {m.pulse_seasonality_low()}
            </p>
          {/if}
        </div>

        <!-- Séries -->
        {#each trendSeries as trend (trend.key)}
          {#if trend.data.length > 0}
            {@const maxVal = Math.max(...trend.data.map((p) => p.upper ?? p.value), 1)}
            <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
              <h3 class="text-base font-semibold flex items-center gap-2.5">
                <Papicon icon="bar-chart-2" size={18} />
                {trend.title}
              </h3>
              <div class="flex items-end gap-0.5 h-[100px]">
                {#each trend.data as point (point.dateKey)}
                  {#if point.predicted}
                    <!--
                      Point prédit : la zone claire couvre l'intervalle à 80 %, le
                      trait pointillé marque la valeur centrale. Les deux hauteurs
                      sont exprimées dans le même repère que les barres observées.
                    -->
                    <div
                      class="flex-1 min-w-1 self-stretch relative"
                      title="{point.dateKey}: {point.value} ({point.lower} – {point.upper})"
                    >
                      <div
                        class="absolute bottom-0 left-0 right-0 rounded-t"
                        style="height: {barHeight(point.upper ?? point.value, maxVal)}%; background: {trend.color}; opacity: 0.18"
                      ></div>
                      <div
                        class="absolute left-0 right-0 border-t-2 border-dashed"
                        style="bottom: {barHeight(point.value, maxVal)}%; border-color: {trend.color}"
                      ></div>
                    </div>
                  {:else}
                    <div
                      class="flex-1 min-w-1 rounded-t transition-all duration-300 opacity-80 hover:opacity-100"
                      style="height: {barHeight(point.value, maxVal)}%; background: {trend.color}"
                      title="{point.dateKey}: {point.value}"
                    ></div>
                  {/if}
                {/each}
              </div>
              <div class="flex flex-wrap gap-4 text-xs font-medium text-on-surface-variant/60">
                <span class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-sm" style="background: {trend.color}"></span>
                  {m.pulse_legend_actual()}
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="w-3 h-0 border-t-2 border-dashed" style="border-color: {trend.color}"></span>
                  {m.pulse_legend_predicted()}
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-sm opacity-20" style="background: {trend.color}"></span>
                  {m.pulse_legend_interval()}
                </span>
              </div>
            </div>
          {/if}
        {/each}

        <!-- Anomalies -->
        {#if predData.anomalies.length > 0}
          <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="alert-triangle" size={18} />
              {m.pulse_anomalies_title()}
            </h3>
            <div class="space-y-2">
              {#each predData.anomalies as anomaly (anomaly.metric + anomaly.dateKey)}
                <div class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm {severityClasses(anomaly.severity)}">
                  <Papicon icon={anomaly.type === 'spike' ? 'arrow-up' : 'arrow-down'} size={16} />
                  <span class="flex-1">{anomalyText(anomaly)}</span>
                  <span class="text-xs text-on-surface-variant/60 whitespace-nowrap">
                    {m.pulse_anomaly_expected()}: {anomaly.expectedRange.min}&ndash;{anomaly.expectedRange.max}
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <EmptyState icon="trending-up" title={m.pulse_pred_empty_title()} description={m.pulse_pred_empty_desc()} />
    {/if}

  <!-- ==================== TAB: APERCU ==================== -->
  {:else if activeTab === 'apercu'}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Résumé Pulse -->
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="heart" size={18} />
          {m.pulse_server_health()}
        </h3>
        {#if displayed}
          <div class="flex items-center gap-4">
            <div class="w-20 h-20 rounded-full border-[5px] flex flex-col items-center justify-center shrink-0" style="border-color: {scoreColor(displayed.score)}">
              <span class="text-2xl font-bold text-on-surface leading-none">{displayed.score}</span>
              <span class="text-2xs text-on-surface-variant/60">/100</span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-base font-semibold">{scoreLabel(displayed.score)}</span>
              <div class="flex items-center gap-1 text-sm {trendClass(displayed.trend)}">
                <Papicon icon={trendIcon(displayed.trend)} size={14} />
                {#if displayed.trendDelta !== 0}
                  <span>{displayed.trendDelta > 0 ? '+' : ''}{displayed.trendDelta} {m.pulse_points()}</span>
                {:else}
                  <span>{m.pulse_stable()}</span>
                {/if}
              </div>
              <span class="text-xs text-on-surface-variant/60">
                {m.pulse_day_of({ date: displayed.dateKey })}
                {#if today}
                  · {m.pulse_today_partial()}: {today.score}
                {/if}
              </span>
            </div>
          </div>

          <div class="space-y-2">
            {#each subScores(displayed) as sub (sub.label)}
              <div class="pulse-score-row grid grid-cols-[90px_1fr_30px] items-center gap-2">
                <span class="text-xs text-on-surface-variant/60">{sub.label}</span>
                <div class="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div class="h-1.5 rounded-full transition-all duration-500" style="width: {sub.value}%; background: {scoreColor(sub.value)}"></div>
                </div>
                <span class="text-xs font-semibold text-right">{sub.value}</span>
              </div>
            {/each}
          </div>

          {#if displayed.alerts.length > 0}
            <div class="space-y-1.5 pt-2 border-t border-outline-variant/10">
              <h4 class="text-body-sm font-medium text-on-surface-variant/60">{m.pulse_alerts()}</h4>
              {#each displayed.alerts.slice(0, 3) as alert, i (alert.code ?? i)}
                <div class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs {severityClasses(alert.severity)}">
                  <Papicon icon={severityIcon(alert.severity)} size={14} />
                  <span>{alertText(alert)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <EmptyState icon="heart" title={m.pulse_empty_title()} description={m.pulse_empty_desc()} />
        {/if}
      </div>

      <!-- Résumé prédictions -->
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="trending-up" size={18} />
          {m.pulse_tab_predictions()}
        </h3>
        {#if predData?.hasData}
          <div class="grid grid-cols-3 gap-3">
            <div class="bg-surface-container-high/30 rounded-xl p-3 text-center">
              <div class="text-lg font-bold">{predData.growthForecast.predicted7d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-0.5">{m.pulse_forecast_7d()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-3 text-center">
              <div class="text-lg font-bold">{predData.growthForecast.predicted30d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-0.5">{m.pulse_forecast_30d()}</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-3 text-center">
              <div class="text-lg font-bold">{predData.growthForecast.confidence}%</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-0.5">{m.pulse_forecast_confidence()}</div>
            </div>
          </div>
          <div class="space-y-2 text-sm text-on-surface-variant">
            <span class="flex items-center gap-2">
              <Papicon icon="arrow-up-circle" size={14} />
              {m.pulse_busiest_day()}: <strong class="text-on-surface">{dayName(predData.seasonality.busiestDay)}</strong>
              · <strong class="text-on-surface">{predData.seasonality.busiestHour}h</strong>
            </span>
            <span class="flex items-center gap-2">
              <Papicon icon="arrow-down-circle" size={14} />
              {m.pulse_quietest_day()}: <strong class="text-on-surface">{dayName(predData.seasonality.quietestDay)}</strong>
              · <strong class="text-on-surface">{predData.seasonality.quietestHour}h</strong>
            </span>
          </div>
          {#if predData.anomalies.length > 0}
            <div class="space-y-1.5 pt-2 border-t border-outline-variant/10">
              <h4 class="text-body-sm font-medium text-on-surface-variant/60">{m.pulse_anomalies_title()}</h4>
              {#each predData.anomalies.slice(0, 3) as anomaly (anomaly.metric + anomaly.dateKey)}
                <div class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs {severityClasses(anomaly.severity)}">
                  <Papicon icon={anomaly.type === 'spike' ? 'arrow-up' : 'arrow-down'} size={14} />
                  <span>{anomalyText(anomaly)}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <EmptyState icon="trending-up" title={m.pulse_pred_empty_title()} description={m.pulse_pred_empty_desc()} />
        {/if}
      </div>
    </div>
  {/if}
</ModulePage>

<style>
  /* The label column is sized for desktop wording; narrow it and let the
     meter keep whatever is left. */
  @media (max-width: 767px) {
    .pulse-score-row {
      gap: 0.5rem;
      grid-template-columns: minmax(5rem, auto) minmax(3rem, 1fr) 2rem;
    }
  }
</style>
