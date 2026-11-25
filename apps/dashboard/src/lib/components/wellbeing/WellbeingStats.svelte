<!--
  Bilan de la cellule bien-être : des chiffres, jamais de contenu de dossier.
  Lisible par la direction, qui y voit si la cellule tient la charge sans
  avoir besoin d'un accès d'urgence.
-->
<script lang="ts" module>
  export interface WellbeingCellStats {
    openedLast30: number;
    closedLast30: number;
    active: number;
    criticalUnassigned: number;
    activeByCategory: Record<string, number>;
    closedByReason: Record<string, number>;
    medianTriageHours: number | null;
    months: Array<{ month: string; opened: number; closed: number }>;
  }
</script>

<script lang="ts">
  import Chart from '../charts/Chart.svelte';
  import { StatTile } from '../ui';
  import Papicon from '../Papicon.svelte';
  import { SERIES } from '../analytics/analyticsFormat';
  import { dateLocale, m } from '../../i18n';
  import { WB_CATEGORIES, WB_CLOSE_REASONS, wbCategoryLabel, wbCloseReasonLabel } from '../../wellbeingLabels';

  const { stats }: { stats: WellbeingCellStats } = $props();

  const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(dateLocale(), { month: 'short', timeZone: 'UTC' });
  const chartData = $derived({
    labels: stats.months.map((entry) => monthLabel(entry.month)),
    datasets: [
      { label: m.wb_stats_opened(), data: stats.months.map((entry) => entry.opened), backgroundColor: SERIES[0], borderRadius: 4, borderSkipped: false, maxBarThickness: 28 },
      { label: m.wb_stats_closed(), data: stats.months.map((entry) => entry.closed), backgroundColor: SERIES[1], borderRadius: 4, borderSkipped: false, maxBarThickness: 28 },
    ],
  });
  const categoryMax = $derived(Math.max(1, ...Object.values(stats.activeByCategory)));
  const reasons = $derived([...WB_CLOSE_REASONS, 'UNSPECIFIED'].map((code) => ({ code, count: stats.closedByReason?.[code] ?? 0 })).filter((entry) => entry.count > 0));
  const reasonMax = $derived(Math.max(1, ...reasons.map((entry) => entry.count)));
</script>

<div class="space-y-6">
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    <StatTile icon="plus" tone="bg-primary/10 text-primary" value={stats.openedLast30} label={m.wb_stats_opened_30()} />
    <StatTile icon="Check" tone="bg-success/10 text-on-success-container" value={stats.closedLast30} label={m.wb_stats_closed_30()} />
    <StatTile icon="AlertTriangle" tone="bg-error/10 text-on-error-container" value={stats.criticalUnassigned} label={m.wb_stats_critical_unassigned()} />
    <StatTile icon="Clock" tone="bg-warning/10 text-on-warning-container"
      value={stats.medianTriageHours === null ? '-' : m.wb_stats_hours({ hours: stats.medianTriageHours })} label={m.wb_stats_triage()} />
  </div>

  <div class="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="BarChart3" size={16} /> {m.wb_stats_months()}</h3>
      <div role="img" aria-label={m.wb_stats_months()}>
        <Chart type="bar" data={chartData} height={240} />
      </div>
      <table class="sr-only">
        <caption>{m.wb_stats_months()}</caption>
        <thead><tr><th scope="col">{m.wb_stats_month()}</th><th scope="col">{m.wb_stats_opened()}</th><th scope="col">{m.wb_stats_closed()}</th></tr></thead>
        <tbody>
          {#each stats.months as entry (entry.month)}
            <tr><th scope="row">{monthLabel(entry.month)}</th><td>{entry.opened}</td><td>{entry.closed}</td></tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="folder" size={16} /> {m.wb_stats_by_category({ count: stats.active })}</h3>
      <ul class="space-y-3">
        {#each WB_CATEGORIES as category (category)}
          {@const count = stats.activeByCategory[category] ?? 0}
          <li class="space-y-1">
            <div class="flex justify-between text-xs">
              <span class="text-on-surface">{wbCategoryLabel(category)}</span>
              <span class="font-semibold text-on-surface">{count}</span>
            </div>
            <div class="h-2 bg-surface-container-high rounded-full overflow-hidden" aria-hidden="true">
              <div class="h-2 rounded-full bg-primary transition-all duration-500" style="width: {(count / categoryMax) * 100}%"></div>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  </div>

  {#if reasons.length > 0}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="Check" size={16} /> {m.wb_stats_by_reason()}</h3>
      <ul class="space-y-3">
        {#each reasons as entry (entry.code)}
          <li class="space-y-1">
            <div class="flex justify-between text-xs">
              <span class="text-on-surface">{wbCloseReasonLabel(entry.code)}</span>
              <span class="font-semibold text-on-surface">{entry.count}</span>
            </div>
            <div class="h-2 bg-surface-container-high rounded-full overflow-hidden" aria-hidden="true">
              <div class="h-2 rounded-full bg-success transition-all duration-500" style="width: {(entry.count / reasonMax) * 100}%"></div>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <p class="text-xs text-on-surface-variant flex items-center gap-1.5"><Papicon icon="lock" size={12} /> {m.wb_stats_privacy()}</p>
</div>
