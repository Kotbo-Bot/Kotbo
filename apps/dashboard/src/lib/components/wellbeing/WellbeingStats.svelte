<!--
  Bilan de la cellule de suivi : des chiffres, jamais de contenu de dossier.
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
  /** Dossiers actifs de chaque membre de la cellule (le bot signale la surcharge). */
  export interface WellbeingReferentLoad {
    userId: string;
    active: number;
    critical: number;
    overloaded: boolean;
  }
  /** Météo du staff : une moyenne seulement à partir de cinq réponses. */
  export interface WellbeingPulseWeek {
    week: string;
    responses: number;
    average: number | null;
  }
</script>

<script lang="ts">
  import Chart from '../charts/Chart.svelte';
  import { StatTile } from '../ui';
  import Papicon from '../Papicon.svelte';
  import { SERIES } from '../analytics/analyticsFormat';
  import { dateLocale, m } from '../../i18n';
  import { WB_CATEGORIES, WB_CLOSE_REASONS, wbCategoryLabel, wbCloseReasonLabel } from '../../wellbeingLabels';
  import MemberName from '../MemberName.svelte';

  const { stats, load = [], pulse = null }: { stats: WellbeingCellStats; load?: WellbeingReferentLoad[]; pulse?: WellbeingPulseWeek[] | null } = $props();

  const loadMax = $derived(Math.max(1, ...load.map((entry) => entry.active)));
  const pulseChart = $derived(pulse ? {
    labels: pulse.map((entry) => entry.week.slice(5)),
    datasets: [
      { label: m.wb_pulse_average(), data: pulse.map((entry) => entry.average), backgroundColor: SERIES[0], borderRadius: 4, borderSkipped: false, maxBarThickness: 28 },
    ],
  } : null);

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

  {#if load.length > 0}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
      <div>
        <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="Users" size={16} /> {m.wb_load_title()}</h3>
        <p class="text-xs text-on-surface-variant mt-1">{m.wb_load_desc()}</p>
      </div>
      <ul class="space-y-3">
        {#each load as entry (entry.userId)}
          <li class="space-y-1">
            <div class="flex justify-between gap-2 text-xs">
              <span class="flex items-center gap-1.5 text-on-surface">
                <MemberName userId={entry.userId} />
                {#if entry.overloaded}<span class="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-warning/10 text-on-warning-container">{m.wb_load_overloaded()}</span>{/if}
              </span>
              <span class="font-semibold text-on-surface">{m.wb_load_counts({ active: entry.active, critical: entry.critical })}</span>
            </div>
            <div class="h-2 bg-surface-container-high rounded-full overflow-hidden" aria-hidden="true">
              <div class="h-2 rounded-full transition-all duration-500 {entry.overloaded ? 'bg-warning' : 'bg-primary'}" style="width: {(entry.active / loadMax) * 100}%"></div>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if pulse && pulseChart}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
      <div>
        <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="Sun" size={16} /> {m.wb_pulse_title()}</h3>
        <p class="text-xs text-on-surface-variant mt-1">{m.wb_pulse_desc()}</p>
      </div>
      {#if pulse.some((entry) => entry.average !== null)}
        <div role="img" aria-label={m.wb_pulse_title()}>
          <Chart type="bar" data={pulseChart} height={200} />
        </div>
      {:else}
        <p class="text-sm text-on-surface-variant">{m.wb_pulse_not_enough()}</p>
      {/if}
      <table class="sr-only">
        <caption>{m.wb_pulse_title()}</caption>
        <thead><tr><th scope="col">{m.wb_pulse_week()}</th><th scope="col">{m.wb_pulse_average()}</th><th scope="col">{m.wb_pulse_responses()}</th></tr></thead>
        <tbody>
          {#each pulse as entry (entry.week)}
            <tr><th scope="row">{entry.week}</th><td>{entry.average ?? '-'}</td><td>{entry.responses}</td></tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  <p class="text-xs text-on-surface-variant flex items-center gap-1.5"><Papicon icon="lock" size={12} /> {m.wb_stats_privacy()}</p>
</div>
