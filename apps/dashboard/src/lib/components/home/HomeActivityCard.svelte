<!--
  Bloc « Activité » de l'accueil, dans l'interface d'Analytics : les tuiles
  choisissent la mesure et portent l'écart avec la période d'avant, la courbe
  montre la mesure choisie avec la période d'avant en pointillés. Les réglages
  fins (pas, empilement, notes) restent dans Analytics, à un clic.

  La mesure et la période choisies sont retenues dans le navigateur.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { FilterPills } from '../ui';
  import Papicon from '../Papicon.svelte';
  import MetricTabs from '../analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../analytics/TimeSeriesChart.svelte';
  import { buildActivityMetrics } from '../analytics/activityMetrics';
  import { shortDate } from '../analytics/analyticsFormat';
  import { fetchActivityAnalytics, type ActivityAnalytics } from '../../api';
  import { authStore } from '../../stores/auth.svelte';
  import { m } from '../../i18n';

  const {
    /** Hauteur de la courbe, suivant la hauteur du bloc dans la grille. */
    height = 170,
    /** Incrémenté par la page pour forcer un rechargement. */
    refreshKey = 0,
  }: { height?: number; refreshKey?: number } = $props();

  type Period = '7' | '30';
  const PREFS_KEY = 'kotbo.home.activity';

  function readPrefs(): { period?: Period; metric?: string } {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  const stored = typeof window === 'undefined' ? {} : readPrefs();
  let period = $state<Period>(stored.period === '30' ? '30' : '7');
  let active = $state(stored.metric ?? 'messages');

  $effect(() => {
    const prefs = { period, metric: active };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* stockage indisponible : choix gardés pour la visite */
    }
  });

  let activity = $state<ActivityAnalytics | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let requestId = 0;

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    const days = Number(period);
    void refreshKey;
    if (!guildId) return;
    const id = ++requestId;
    untrack(() => {
      loading = true;
      failed = false;
    });
    fetchActivityAnalytics({ period: days }, guildId)
      .then((res) => {
        if (id !== requestId) return;
        activity = res;
        failed = !res;
      })
      .catch(() => {
        if (id === requestId) failed = true;
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  const metrics = $derived(activity ? buildActivityMetrics(activity, ['messages', 'active', 'net-joins', 'voice']) : []);
  const metric = $derived(metrics.find((mt) => mt.id === active) ?? metrics[0]);
  const labels = $derived(activity?.series.map((d) => shortDate(d.dateKey)) ?? []);
</script>

<div class="flex flex-col gap-3 h-full min-w-0">
  <div class="flex items-center justify-between gap-2 shrink-0">
    <FilterPills
      label={m.anx_period_facts_title()}
      options={[
        { value: '7' as Period, label: m.an_period_7d() },
        { value: '30' as Period, label: m.an_period_30d() },
      ]}
      value={period}
      onchange={(v) => (period = v)}
    />
    <a href="/analytics" class="inline-flex items-center gap-1 text-xs text-primary hover:underline shrink-0">
      {m.home_details()}
      <Papicon icon="arrow-right" size={12} />
    </a>
  </div>

  {#if loading && !activity}
    <div class="flex flex-col gap-3" aria-busy="true">
      <div class="h-[5.25rem] rounded-xl bg-surface-container animate-pulse"></div>
      <div class="rounded-lg bg-surface-container animate-pulse" style:height="{height}px"></div>
    </div>
  {:else if failed && !activity}
    <p class="grow flex items-center justify-center py-6 text-xs text-on-surface-variant">{m.home_no_data()}</p>
  {:else if metric}
    <MetricTabs {metrics} active={metric.id} onchange={(id) => (active = id)} compare label={m.anx_metrics_label()} />
    <div class="min-w-0 transition-opacity" class:opacity-60={loading}>
      <TimeSeriesChart
        {labels}
        mode="line"
        main={{ label: metric.label, color: metric.color, values: metric.daily }}
        previous={{ label: m.anx_trend_previous(), values: metric.prevDaily }}
        format={metric.format}
        {height}
      />
    </div>
  {/if}
</div>
