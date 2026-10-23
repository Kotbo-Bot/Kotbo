<!--
  Suivi d'activite du staff : qui decroche cette semaine, qui progresse. Les
  baisses passent en tete ; un clic ouvre la fiche du membre.
-->
<script lang="ts">
  import Chart from '../charts/Chart.svelte';
  import Papicon from '../Papicon.svelte';
  import EmptyState from '../EmptyState.svelte';
  import { Callout, FilterPills } from '../ui';
  import StaffAvatar from './StaffAvatar.svelte';
  import GradeChip from './GradeChip.svelte';
  import { staff, staffName, type LeadershipMetric } from './staffStore.svelte';

  const { openCase }: { openCase?: (userId: string, name: string) => void } = $props();
  import { weekTrend } from './format';
  import { m } from '../../i18n';

  type Sort = 'alerts' | 'score' | 'activity';
  let sort = $state<Sort>('alerts');

  const rows = $derived.by(() => {
    const list = staff.leadership.map((metric) => ({ metric, member: staff.memberByUserId(metric.staffUserId), trend: weekTrend(metric.avg7d, metric.avg30d) }));
    return list.sort((a, b) => {
      if (sort === 'score') return b.metric.progressionScore - a.metric.progressionScore;
      if (sort === 'activity') return b.metric.avg30d - a.metric.avg30d;
      return Number(b.metric.hasInactivityAlert) - Number(a.metric.hasInactivityAlert) || (a.trend ?? 0) - (b.trend ?? 0);
    });
  });

  const alerts = $derived(rows.filter((row) => row.metric.hasInactivityAlert));
  const avgScore = $derived(rows.length ? Math.round(rows.reduce((s, r) => s + r.metric.progressionScore, 0) / rows.length) : 0);
  const teamTrend = $derived.by(() => {
    const week = staff.leadership.reduce((s, x) => s + x.avg7d, 0);
    const month = staff.leadership.reduce((s, x) => s + x.avg30d, 0);
    return weekTrend(week, month);
  });

  function label(metric: LeadershipMetric) {
    const member = staff.memberByUserId(metric.staffUserId);
    return member ? staffName(member) : metric.staffUserId;
  }

  const activityChart = $derived({
    labels: staff.leadership.map(label),
    datasets: [
      { label: m.sm_chart_label_avg30(), data: staff.leadership.map((x) => x.avg30d), backgroundColor: 'rgba(148, 155, 164, 0.45)', borderRadius: 4, barPercentage: 0.7 },
      { label: m.sm_chart_label_avg7(), data: staff.leadership.map((x) => x.avg7d), backgroundColor: 'rgba(99, 102, 241, 0.85)', borderRadius: 4, barPercentage: 0.7 },
    ],
  });
</script>

<div class="space-y-4">
  {#if staff.loading.leadership && staff.leadership.length === 0}
    <div class="section-card h-64 animate-pulse" aria-busy="true"></div>
  {:else if staff.leadership.length === 0}
    <div class="section-card">
      <EmptyState
        icon="activity"
        title={m.sx_leadership_empty_title()}
        description={m.sx_leadership_empty_desc()}
        actionLabel={m.sx_see_directory()}
        actionIcon="users"
        actionHref="/staff-management"
      />
    </div>
  {:else}
    {#if alerts.length > 0}
      <Callout variant="warning" icon="trending-down" title={m.sx_inactive_title({ n: alerts.length })}>
        {m.sx_inactive_desc({ names: alerts.slice(0, 3).map((a) => (a.member ? staffName(a.member) : a.metric.staffUserId)).join(', ') })}
      </Callout>
    {/if}

    <!-- Synthese et graphique -->
    <section class="section-card" aria-labelledby="lead-summary">
      <header class="px-5 pt-5">
        <h3 id="lead-summary" class="text-sm font-semibold text-on-surface">{m.sm_chart_activity_comparison()}</h3>
        <p class="text-xs text-on-surface-variant">{m.sx_lead_chart_desc()}</p>
      </header>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-4 px-5 pt-4 sm:grid-cols-4">
        {#each [
          { label: m.sx_avg_score(), value: `${avgScore}`, suffix: '/100', tone: '' },
          { label: m.sx_week_vs_month(), value: teamTrend === null ? '-' : `${teamTrend > 0 ? '+' : ''}${teamTrend} %`, suffix: '', tone: teamTrend !== null && teamTrend < -20 ? 'text-warning' : '' },
          { label: m.sx_tracked(), value: String(rows.length), suffix: '', tone: '' },
          { label: m.sx_in_decline(), value: String(alerts.length), suffix: '', tone: alerts.length ? 'text-warning' : '' },
        ] as stat (stat.label)}
          <div class="min-w-0 sm:border-l sm:border-outline-variant sm:pl-5 sm:first:border-l-0 sm:first:pl-0">
            <dt class="text-xs text-on-surface-variant">{stat.label}</dt>
            <dd class="mt-0.5 text-xl font-semibold tabular-nums tracking-tight text-on-surface {stat.tone}">
              {stat.value}{#if stat.suffix}<span class="text-sm font-normal text-on-surface-variant">{stat.suffix}</span>{/if}
            </dd>
          </div>
        {/each}
      </dl>
      <div class="p-5 pt-4">
        <Chart data={activityChart} type="bar" height={Math.max(160, staff.leadership.length * 30)} options={{ indexAxis: 'y', scales: { x: { beginAtZero: true } } }} />
      </div>
    </section>

    <!-- Classement -->
    <section class="section-card overflow-hidden" aria-labelledby="lead-table">
      <header class="flex flex-col gap-3 border-b border-outline-variant px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <h3 id="lead-table" class="text-sm font-semibold text-on-surface">{m.sx_lead_table_title()}</h3>
        <FilterPills
          label={m.sx_sort_label()}
          value={sort}
          onchange={(v) => (sort = v)}
          options={[
            { value: 'alerts', label: m.sx_sort_alerts() },
            { value: 'score', label: m.sx_sort_score() },
            { value: 'activity', label: m.sx_sort_activity() },
          ]}
        />
      </header>
      <ul class="divide-y divide-outline-variant">
        {#each rows as { metric, member, trend } (metric.staffUserId)}
          <li>
            <button type="button" class="lead-row" onclick={() => openCase?.(metric.staffUserId, label(metric))} disabled={!openCase}>
              <span class="flex min-w-0 items-center gap-3 sm:w-56 sm:shrink-0">
                <StaffAvatar url={member?.avatarUrl} name={label(metric)} userId={metric.staffUserId} size={32} />
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium text-on-surface">{label(metric)}</span>
                  {#if member}<GradeChip small name={member.grade} color={staff.gradeColor(member.grade)} />{/if}
                </span>
              </span>
              <span class="flex min-w-0 flex-1 items-center gap-3">
                <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-container-high sm:max-w-48">
                  <span class="block h-full rounded-full bg-primary" style="width: {Math.min(100, metric.progressionScore)}%"></span>
                </span>
                <span class="w-12 text-right text-sm tabular-nums text-on-surface">{metric.progressionScore}</span>
              </span>
              <span class="flex shrink-0 items-center justify-end gap-4 text-sm sm:w-48">
                <span class="inline-flex items-center gap-1 tabular-nums text-on-surface-variant" title="{m.sm_chart_label_avg30()} / {m.sm_chart_label_avg7()}">{metric.avg30d}<Papicon icon="arrow-right" size={11} /><span class="text-on-surface">{metric.avg7d}</span></span>
                {#if metric.hasInactivityAlert}
                  <span class="badge badge-warning"><Papicon icon="trending-down" size={12} />{trend !== null ? `${trend} %` : m.sm_inactivity_detected()}</span>
                {:else if trend !== null && trend > 10}
                  <span class="badge badge-success"><Papicon icon="trending-up" size={12} />+{trend} %</span>
                {:else}
                  <span class="badge badge-neutral">{m.sx_steady()}</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .lead-row {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    text-align: left;
    transition: background-color 0.12s ease;
  }
  .lead-row:not(:disabled):hover {
    background: var(--surface-hover);
  }
  @media (min-width: 640px) {
    .lead-row {
      flex-direction: row;
      align-items: center;
      gap: 1.5rem;
    }
  }
</style>
