<!--
  Activité, un sous-onglet à la fois : messages, vocal, heures de pointe,
  records, comparaison hebdomadaire ou mensuelle, commandes, Algo du jour.
  Messages et vocal (ActivityTrafficView) suivent tous les filtres ; le reste
  suit la période.
-->
<script lang="ts" module>
  export type ActivityView = 'messages' | 'voice' | 'heatmap' | 'pulse' | 'weekly' | 'commands' | 'algo';
</script>

<script lang="ts">
  import { EmptyState, SectionCard } from '../ui';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import ActivityTrafficView from './ActivityTrafficView.svelte';
  import HeatmapView from './HeatmapView.svelte';
  import PeriodComparisonView from './PeriodComparisonView.svelte';
  import CommandsView from './CommandsView.svelte';
  import DailyAlgoAnalyticsCard from './DailyAlgoAnalyticsCard.svelte';
  import AdvancedAnalyticsPanel from './AdvancedAnalyticsPanel.svelte';
  import { fetchDailyAlgoAnalytics } from '../../api';
  import { m } from '../../i18n';
  import { analyticsFilters as filters } from './analyticsFilters.svelte';

  const {
    view,
    legacy,
    legacyLoading,
    onOpenMember,
  }: {
    view: ActivityView;
    /** Réponse de l'ancien /analytics, pour les sessions vocales. */
    legacy: any;
    legacyLoading: boolean;
    onOpenMember: (userId: string, name: string) => void;
  } = $props();

  let algo = $state<any>(null);

  $effect(() => {
    if (view !== 'algo') return;
    const period = filters.periodQuery;
    const range = period.startDate ? { startDate: period.startDate, endDate: period.endDate } : { days: period.period };
    fetchDailyAlgoAnalytics(range).then((res) => (algo = res)).catch(() => (algo = null));
  });
</script>

{#if view === 'messages' || view === 'voice'}
  {#key view}
    <ActivityTrafficView kind={view} {legacy} {legacyLoading} {onOpenMember} />
  {/key}
{:else if view === 'heatmap'}
  <HeatmapView />
{:else if view === 'pulse'}
  <AdvancedAnalyticsPanel section="activity" {onOpenMember} />
{:else if view === 'weekly'}
  <PeriodComparisonView />
{:else if view === 'commands'}
  <CommandsView {onOpenMember} />
{:else if view === 'algo'}
  {#if !algo}
    <AnalyticsSkeleton />
  {:else if (algo?.metrics?.totalRuns ?? 0) > 0}
    <DailyAlgoAnalyticsCard data={algo} />
  {:else}
    <SectionCard>
      <EmptyState icon="Code" title={m.anx_algo_empty_title()} description={m.anx_algo_empty_desc()} reason="accumulating" />
    </SectionCard>
  {/if}
{/if}
