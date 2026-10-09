<!--
  Vues Messages et Vocal d'Activité. En haut, la carte de courbe : ses tuiles
  choisissent la mesure (volume, membres actifs, volume par actif, arrivées),
  sa barre d'outils le pas et l'affichage. Dessous, les deux classements Top N
  (membres et salons), côte à côte quand la place le permet.

  Tout suit les filtres de la page ; les notes posées sur la courbe suivent
  la période.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout } from '../ui';
  import ActivityChartCard from './ActivityChartCard.svelte';
  import TopList from './TopList.svelte';
  import KpiTile from './KpiTile.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import {
    fetchActivityAnalytics,
    fetchActivityBreakdown,
    fetchActivityHourly,
    fetchActivityRankings,
    type ActivityAnalytics,
  } from '../../api';
  import { buildActivityMetrics } from './activityMetrics';
  import { analyticsAnnotations } from './annotations.svelte';
  import { channelDetailsModal } from '../../stores/channelDetailsModal.svelte';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters } from './analyticsFilters.svelte';
  import { fmtMinutes, fmtNumber, SERIES } from './analyticsFormat';

  const {
    kind,
    legacy,
    legacyLoading,
    onOpenMember,
  }: {
    kind: 'messages' | 'voice';
    /** Réponse de l'ancien /analytics : sessions vocales et affluence. */
    legacy: any;
    legacyLoading: boolean;
    onOpenMember: (userId: string, name: string) => void;
  } = $props();

  // ── Données ────────────────────────────────────────────────────────────────
  let activity = $state<ActivityAnalytics | null>(null);
  let loading = $state(true);
  let error = $state('');
  let requestId = 0;

  $effect(() => {
    const query = filters.query;
    const id = ++requestId;
    untrack(() => {
      loading = true;
      error = '';
    });
    fetchActivityAnalytics(query)
      .then((res) => {
        if (id !== requestId) return;
        activity = res;
        analyticsExport.activity = res;
      })
      .catch((e) => {
        if (id === requestId) error = errorMessage(e) || m.an_error_generic();
      })
      .finally(() => {
        if (id === requestId) loading = false;
      });
  });

  $effect(() => {
    const period = filters.periodQuery;
    untrack(() => analyticsAnnotations.load(period));
  });

  // ── Mesures ────────────────────────────────────────────────────────────────
  let active = $state<string>(untrack(() => kind));

  const dates = $derived(activity?.series.map((d) => d.dateKey) ?? []);
  const k = $derived(activity?.kpis);
  const metrics = $derived(
    activity ? buildActivityMetrics(activity, kind === 'messages' ? ['messages', 'active', 'per-active', 'net-joins'] : ['voice', 'active', 'voice-per-active']) : [],
  );

  const hourlyPossible = $derived(filters.days <= 14 && !filters.channel && !filters.role && !filters.excludeStaff);
  const format = $derived(kind === 'messages' ? fmtNumber : fmtMinutes);

  // Sessions et affluence : seule l'ancienne réponse les porte (période seule).
  const voiceSessions = $derived((legacy?.dailyTrend ?? []).reduce((s: number, d: any) => s + (d.voiceSessions ?? 0), 0));
  const peakVoice = $derived(Math.max(0, ...(legacy?.dailyTrend ?? []).map((d: any) => d.peakVoice ?? 0)));
</script>

{#if loading && !activity}
  <AnalyticsSkeleton />
{:else if error && !activity}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if activity && k}
  {#if kind === 'voice' && !activity.voiceAvailable}
    <Callout variant="info">{m.anx_voice_unavailable()}</Callout>
  {:else}
    <div class="flex flex-col gap-4">
      <ActivityChartCard
        {metrics}
        {active}
        onchange={(id) => (active = id)}
        {dates}
        days={filters.days}
        compare={filters.compare}
        onToggleCompare={() => filters.toggleCompare()}
        {hourlyPossible}
        loadHourly={() => fetchActivityHourly(filters.query)}
        loadBreakdown={(metric, dimension) => fetchActivityBreakdown(filters.query, metric, dimension)}
        reloadKey={filters.key}
        anomalies={activity.anomalies ?? []}
        annotations={analyticsAnnotations.items}
        onAnnotate={(dateKey, label) => analyticsAnnotations.add(dateKey, label, filters.periodQuery)}
        onDeleteAnnotation={(id) => analyticsAnnotations.remove(id)}
        canDeleteAnnotation={(a) => analyticsAnnotations.canDelete(a)}
        busy={loading}
        forecastAllowed={!filters.isCustom}
      />

      {#if kind === 'voice'}
        <div class="kpi-grid" style="--kpi-cols: 2;">
          <KpiTile label={m.anx_kpi_voice_sessions()} value={legacy ? fmtNumber(voiceSessions) : legacyLoading ? '…' : '–'} hint={m.anx_period_only_note()} />
          <KpiTile label={m.anx_kpi_peak_voice()} value={legacy ? fmtNumber(peakVoice) : legacyLoading ? '…' : '–'} hint={m.anx_kpi_peak_voice_hint()} />
        </div>
      {/if}

      <div class="top-grid">
        <TopList
          title={kind === 'messages' ? m.anx_top_members_messages() : m.anx_top_members_voice()}
          description={m.anx_top_follows_filters()}
          icon={kind === 'messages' ? 'UsersFour' : 'Microphone'}
          kind="members"
          load={(limit) => fetchActivityRankings(filters.query, kind, 'members', limit)}
          reloadKey={`${filters.key}|${kind}`}
          {format}
          compare={filters.compare}
          color={kind === 'messages' ? SERIES[0] : SERIES[2]}
          onselect={(item) => onOpenMember(item.id, item.name ?? '')}
          exportName={kind === 'messages' ? 'top_membres_messages' : 'top_membres_vocal'}
        />
        <TopList
          title={kind === 'messages' ? m.anx_top_channels_messages() : m.anx_top_channels_voice()}
          description={m.anx_top_follows_filters()}
          icon={kind === 'messages' ? 'ChatBubbles' : 'Microphone'}
          kind="channels"
          load={(limit) => fetchActivityRankings(filters.query, kind, 'channels', limit)}
          reloadKey={`${filters.key}|${kind}`}
          {format}
          compare={filters.compare}
          color={kind === 'messages' ? SERIES[0] : SERIES[2]}
          onselect={(item) => channelDetailsModal.show(item.id, item.name ? `#${item.name}` : m.anx_channel_deleted())}
          exportName={kind === 'messages' ? 'top_salons_messages' : 'top_salons_vocal'}
        />
      </div>
    </div>
  {/if}
{/if}

<style>
  .top-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    align-items: start;
  }
</style>
