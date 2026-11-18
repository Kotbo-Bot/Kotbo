<!--
  Activité, un sous-onglet à la fois : messages, vocal, heures de pointe,
  records, comparaison hebdomadaire ou mensuelle, commandes.
  Messages et vocal (ActivityTrafficView) suivent tous les filtres ; le reste
  suit la période.
-->
<script lang="ts" module>
  export type ActivityView = 'messages' | 'voice' | 'heatmap' | 'pulse' | 'weekly' | 'commands';
</script>

<script lang="ts">
  import ActivityTrafficView from './ActivityTrafficView.svelte';
  import HeatmapView from './HeatmapView.svelte';
  import PeriodComparisonView from './PeriodComparisonView.svelte';
  import CommandsView from './CommandsView.svelte';
  import AdvancedAnalyticsPanel from './AdvancedAnalyticsPanel.svelte';

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
    onOpenMember?: (userId: string, name: string) => void;
  } = $props();
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
{/if}
