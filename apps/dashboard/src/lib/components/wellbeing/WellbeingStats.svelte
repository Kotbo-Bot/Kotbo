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
  /** Fiches : des nombres seulement, jamais de nom ni de contenu. */
  export interface WellbeingProfileStats {
    people: number;
    notes: number;
    sensitive: number;
    expiringSoon: number;
  }
  /** Dossiers actifs dans chaque étape ajoutée par la cellule. */
  export interface WellbeingStageCount {
    label: string;
    count: number;
  }
</script>

<script lang="ts">
  import Chart from '../charts/Chart.svelte';
  import { StatTile } from '../ui';
  import Papicon from '../Papicon.svelte';
  import { SERIES } from '../analytics/analyticsFormat';
  import { dateLocale, m } from '../../i18n';
  import { WB_CLOSE_REASONS, wbCloseReasonLabel } from '../../wellbeingLabels';
  import { wbCategories, wbCategoryName } from '../../wellbeingCustom';
  import { wbCustom } from '../../stores/wellbeingCustomization.svelte';
  import MemberName from '../MemberName.svelte';

  const {
    stats,
    load = [],
    profiles = null,
    stages = [],
    tags = [],
  }: {
    stats: WellbeingCellStats;
    load?: WellbeingReferentLoad[];
    profiles?: WellbeingProfileStats | null;
    stages?: WellbeingStageCount[];
    /** Dossiers actifs par étiquette de la cellule. */
    tags?: WellbeingStageCount[];
  } = $props();

  const loadMax = $derived(Math.max(1, ...load.map((entry) => entry.active)));

  const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(dateLocale(), { month: 'short', timeZone: 'UTC' });
  const chartData = $derived({
    labels: stats.months.map((entry) => monthLabel(entry.month)),
    datasets: [
      { label: m.wb_stats_opened(), data: stats.months.map((entry) => entry.opened), backgroundColor: SERIES[0], borderRadius: 4, borderSkipped: false, maxBarThickness: 28 },
      { label: m.wb_stats_closed(), data: stats.months.map((entry) => entry.closed), backgroundColor: SERIES[1], borderRadius: 4, borderSkipped: false, maxBarThickness: 28 },
    ],
  });
  const categoryMax = $derived(Math.max(1, ...Object.values(stats.activeByCategory)));
  /** Catégories de la cellule, puis celles retirées qui ont encore des dossiers actifs. */
  const statCategories = $derived.by(() => {
    const ids = wbCategories(wbCustom.value).map((category) => category.id);
    return [...ids, ...Object.keys(stats.activeByCategory).filter((id) => !ids.includes(id))];
  });
  const reasons = $derived([...WB_CLOSE_REASONS, 'UNSPECIFIED'].map((code) => ({ code, count: stats.closedByReason?.[code] ?? 0 })).filter((entry) => entry.count > 0));
  const reasonMax = $derived(Math.max(1, ...reasons.map((entry) => entry.count)));
</script>

{#snippet countBars(icon: string, title: string, entries: WellbeingStageCount[])}
  {@const max = Math.max(1, ...entries.map((entry) => entry.count))}
  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
    <h3 class="text-base font-semibold flex items-center gap-2"><Papicon {icon} size={16} /> {title}</h3>
    <ul class="space-y-3">
      {#each entries as entry (entry.label)}
        <li class="space-y-1">
          <div class="flex justify-between text-xs">
            <span class="text-on-surface">{entry.label}</span>
            <span class="font-semibold text-on-surface">{entry.count}</span>
          </div>
          <div class="h-2 bg-surface-container-high rounded-full overflow-hidden" aria-hidden="true">
            <div class="h-2 rounded-full bg-primary transition-all duration-500" style="width: {(entry.count / max) * 100}%"></div>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/snippet}

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
        {#each statCategories as category (category)}
          {@const count = stats.activeByCategory[category] ?? 0}
          <li class="space-y-1">
            <div class="flex justify-between text-xs">
              <span class="text-on-surface">{wbCategoryName(wbCustom.value, category)}</span>
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

  {#if (profiles && profiles.notes > 0) || stages.length > 0 || tags.length > 0}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {#if profiles && profiles.notes > 0}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="StickyNote" size={16} /> {m.wb_stats_profiles()}</h3>
          <div class="grid grid-cols-2 gap-4">
            <StatTile icon="Users" tone="bg-primary/10 text-primary" value={profiles.people} label={m.wb_stats_profiles_people()} />
            <StatTile icon="StickyNote" tone="bg-surface-container-high/60 text-on-surface" value={profiles.notes} label={m.wb_stats_profiles_notes()} />
            <StatTile icon="eye" tone="bg-warning/10 text-on-warning-container" value={profiles.sensitive} label={m.wb_stats_profiles_sensitive()} />
            <StatTile icon="Clock" tone="bg-error/10 text-on-error-container" value={profiles.expiringSoon} label={m.wb_stats_profiles_expiring()} />
          </div>
        </section>
      {/if}
      {#if stages.length > 0}
        {@render countBars('Columns', m.wb_stats_stages(), stages)}
      {/if}
      {#if tags.length > 0}
        {@render countBars('Tag', m.wb_stats_by_tag(), tags)}
      {/if}
    </div>
  {/if}

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


  <p class="text-xs text-on-surface-variant flex items-center gap-1.5"><Papicon icon="lock" size={12} /> {m.wb_stats_privacy()}</p>
</div>
