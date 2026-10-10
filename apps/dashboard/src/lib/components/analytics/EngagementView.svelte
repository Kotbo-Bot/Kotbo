<!--
  Engagement : membres actifs par jour (DAU), sur 7 jours glissants (WAU) et
  sur 30 jours glissants (MAU), et l'adhérence DAU/MAU — la part des actifs
  du mois qui reviennent un jour donné. Même carte de courbe que Messages.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Callout } from '../ui';
  import ActivityChartCard, { type ChartMetric } from './ActivityChartCard.svelte';
  import AnalyticsSkeleton from './AnalyticsSkeleton.svelte';
  import { fetchEngagement, type EngagementAnalytics } from '../../api';
  import { m } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import { analyticsExport, analyticsFilters as filters, relativeDelta } from './analyticsFilters.svelte';
  import { analyticsAnnotations } from './annotations.svelte';
  import { fmtNumber, fmtPct, SERIES } from './analyticsFormat';

  let data = $state<EngagementAnalytics | null>(null);
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
    fetchEngagement(query)
      .then((res) => {
        if (id !== requestId) return;
        data = res;
        analyticsExport.engagement = res;
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

  let active = $state('dau');

  const avg = (values: number[]) => (values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0);
  const stick = (dau: number, mau: number) => (mau > 0 ? Math.round((dau / mau) * 1000) / 10 : 0);
  const fmtAvg = (v: number) => fmtNumber(Math.round(v * 10) / 10);
  const fmtStick = (v: number) => fmtPct(v);

  const metrics: ChartMetric[] = $derived.by(() => {
    const points = data?.points ?? [];
    const pick = (key: 'dau' | 'wau' | 'mau' | 'prevDau' | 'prevWau' | 'prevMau') => points.map((p) => p[key]);
    const tile = (id: string, label: string, hint: string, now: number[], prev: number[], color: string): ChartMetric => ({
      id,
      label,
      hint,
      color,
      format: fmtAvg,
      value: fmtAvg(avg(now)),
      delta: relativeDelta(avg(now), avg(prev)),
      aggregate: 'avg',
      daily: now,
      prevDaily: prev,
    });
    const stickNow = points.map((p) => stick(p.dau, p.mau));
    const stickPrev = points.map((p) => stick(p.prevDau, p.prevMau));
    return [
      tile('dau', m.anx_eng_dau(), m.anx_eng_dau_hint(), pick('dau'), pick('prevDau'), SERIES[0]!),
      tile('wau', m.anx_eng_wau(), m.anx_eng_wau_hint(), pick('wau'), pick('prevWau'), SERIES[6]!),
      tile('mau', m.anx_eng_mau(), m.anx_eng_mau_hint(), pick('mau'), pick('prevMau'), SERIES[2]!),
      {
        id: 'stickiness',
        label: m.anx_eng_stickiness(),
        hint: m.anx_eng_stickiness_hint(),
        color: SERIES[4]!,
        format: fmtStick,
        value: fmtStick(avg(stickNow)),
        delta: relativeDelta(avg(stickNow), avg(stickPrev)),
        aggregate: 'avg',
        daily: stickNow,
        prevDaily: stickPrev,
      },
    ];
  });

  const stickiness = $derived(metrics[3] ? avg(metrics[3].daily) : 0);
  const verdict = $derived(stickiness >= 25 ? m.anx_eng_verdict_high() : stickiness >= 12 ? m.anx_eng_verdict_mid() : m.anx_eng_verdict_low());
</script>

{#if loading && !data}
  <AnalyticsSkeleton />
{:else if error && !data}
  <Callout variant="danger" title={m.an_error_generic()}>{error}</Callout>
{:else if data}
  <div class="flex flex-col gap-4">
    {#if data.channelIgnored}
      <Callout variant="info">{m.anx_channel_filter_ignored()}</Callout>
    {/if}
    <ActivityChartCard
      {metrics}
      {active}
      onchange={(id) => (active = id)}
      dates={data.points.map((p) => p.dateKey)}
      days={filters.days}
      compare={filters.compare}
      onToggleCompare={() => filters.toggleCompare()}
      loadHourly={async () => null}
      loadBreakdown={async () => null}
      reloadKey={filters.key}
      annotations={analyticsAnnotations.items}
      onAnnotate={(dateKey, label) => analyticsAnnotations.add(dateKey, label, filters.periodQuery)}
      onDeleteAnnotation={(id) => analyticsAnnotations.remove(id)}
      canDeleteAnnotation={(a) => analyticsAnnotations.canDelete(a)}
      busy={loading}
      forecastAllowed={false}
    />
    <Callout variant="info" title={m.anx_eng_reading_title({ value: fmtStick(stickiness) })}>
      {verdict}
      {#if data.step > 1}<br />{m.anx_eng_weekly_points()}{/if}
    </Callout>
  </div>
{/if}
