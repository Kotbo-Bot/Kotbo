<!--
  Comparaison des saisons terminées, de la plus ancienne à la plus récente :
  une mesure à la fois (les échelles ne se comparent pas entre elles), choisie
  par les tuiles du haut, comme sur les pages d'analyse.
-->
<script lang="ts">
  import type { SeasonStats } from '@kotbo/shared';
  import Chart from '../charts/Chart.svelte';
  import MetricTabs, { type MetricTab } from '../analytics/MetricTabs.svelte';
  import { fmtNumber, SERIES } from '../analytics/analyticsFormat';
  import { m } from '../../i18n';

  const { seasons }: { seasons: Array<{ number: number; name: string; stats: SeasonStats }> } = $props();

  type MetricId = keyof SeasonStats;
  let active = $state<MetricId>('participants');

  const LABELS: Record<MetricId, () => string> = {
    participants: () => m.sea_stats_participants(),
    totalXp: () => m.sea_stats_total_xp(),
    topXp: () => m.sea_stats_top_xp(),
  };

  const last = $derived(seasons[seasons.length - 1]);
  const tabs = $derived<MetricTab[]>((Object.keys(LABELS) as MetricId[]).map((id) => ({
    id,
    label: LABELS[id](),
    value: fmtNumber(last?.stats[id] ?? 0),
    hint: m.sea_stats_last_hint(),
    color: SERIES[0],
    spark: seasons.map((season) => season.stats[id]),
  })));

  const chartData = $derived({
    labels: seasons.map((season) => m.sea_stats_season_label({ number: season.number })),
    datasets: [{
      label: LABELS[active](),
      data: seasons.map((season) => season.stats[active]),
      backgroundColor: SERIES[0],
      borderRadius: 4,
      borderSkipped: false,
      maxBarThickness: 36,
    }],
  });
</script>

<div class="space-y-4">
  <MetricTabs metrics={tabs} {active} onchange={(id) => active = id as MetricId} label={m.sea_stats_tabs_label()} />
  <div role="img" aria-label={`${m.sea_stats_heading()} · ${LABELS[active]()}`}>
    <Chart type="bar" data={chartData} height={220} />
  </div>
</div>
