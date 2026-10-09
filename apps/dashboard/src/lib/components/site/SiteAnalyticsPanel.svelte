<script lang="ts">
  /**
   * Fréquentation du site, sans cookie : vues et visiteurs par jour comparés à
   * la période précédente, pages les plus lues, sources, appareils. Les
   * visiteurs sont des visiteurs-jours (hash du jour, jamais suivis d'un jour à
   * l'autre). Affiché dans la page Site et dans Analytics.
   */
  import { onMount } from 'svelte';
  import { FilterPills, SectionCard, type FilterOption } from '../ui';
  import AnalyticsSkeleton from '../analytics/AnalyticsSkeleton.svelte';
  import MetricTabs, { type MetricTab } from '../analytics/MetricTabs.svelte';
  import TimeSeriesChart from '../analytics/TimeSeriesChart.svelte';
  import BarList from '../analytics/BarList.svelte';
  import { fmtNumber, shortDate, SERIES } from '../analytics/analyticsFormat';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import { fetchSiteAnalytics, type SiteAnalyticsReport } from '../../api/site';
  import { siteErrorMessage } from './siteErrors';

  let { guildId }: { guildId: string } = $props();

  let days = $state('30');
  let report = $state<SiteAnalyticsReport | null>(null);
  let loading = $state(true);
  let metric = $state<'views' | 'visitors'>('views');

  const periods: FilterOption[] = [
    { value: '7', label: m.ste_period_7() },
    { value: '30', label: m.ste_period_30() },
    { value: '90', label: m.ste_period_90() },
  ];

  async function load() {
    loading = true;
    try {
      report = (await fetchSiteAnalytics(Number(days), guildId)).report;
    } catch (err) {
      toast.error(siteErrorMessage(err));
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function pct(now: number, before: number): number | null {
    return before > 0 ? ((now - before) / before) * 100 : null;
  }

  const tiles: MetricTab[] = $derived(
    report
      ? [
          { id: 'views', label: m.ste_views(), value: fmtNumber(report.totals.views), delta: pct(report.totals.views, report.previous.views), color: SERIES[0], spark: report.daily.map((d) => d.views) },
          { id: 'visitors', label: m.ste_visitors(), value: fmtNumber(report.totals.visitors), delta: pct(report.totals.visitors, report.previous.visitors), color: SERIES[1], spark: report.daily.map((d) => d.visitors), hint: m.ste_visitors_hint() },
        ]
      : [],
  );

  const DEVICE_LABELS: Record<string, () => string> = { mobile: () => m.ste_device_mobile(), tablet: () => m.ste_device_tablet(), desktop: () => m.ste_device_desktop() };
</script>

<div class="space-y-4">
  <div class="flex justify-end">
    <FilterPills label={m.ste_period()} options={periods} value={days} onchange={(value) => { days = value; void load(); }} />
  </div>

  {#if loading && !report}
    <AnalyticsSkeleton />
  {:else if report}
    <MetricTabs metrics={tiles} active={metric} onchange={(id) => (metric = id as 'views' | 'visitors')} label={m.ste_traffic()} />
    <SectionCard>
      <div class="p-4">
        <TimeSeriesChart
          labels={report.daily.map((d) => shortDate(d.date))}
          mode="bar"
          main={{ label: metric === 'views' ? m.ste_views() : m.ste_visitors(), values: report.daily.map((d) => d[metric]), color: metric === 'views' ? SERIES[0] : SERIES[1] }}
          format={fmtNumber}
          height={240}
        />
      </div>
    </SectionCard>

    <div class="grid gap-4 lg:grid-cols-3">
      <SectionCard title={m.ste_top_pages()} icon="file-text">
        <div class="px-5 pb-5">
          <BarList items={report.pages.map((p) => ({ id: p.path, label: p.path, value: p.views, sub: m.ste_visitors_count({ count: p.visitors }) }))} color={SERIES[0]} empty={m.ste_no_data()} />
        </div>
      </SectionCard>
      <SectionCard title={m.ste_referrers()} icon="link">
        <div class="px-5 pb-5">
          <BarList items={report.referrers.map((r) => ({ id: r.host, label: r.host === 'direct' ? m.ste_referrer_direct() : r.host, value: r.views }))} color={SERIES[2]} empty={m.ste_no_data()} />
        </div>
      </SectionCard>
      <SectionCard title={m.ste_devices()} icon="monitor">
        <div class="px-5 pb-5">
          <BarList items={report.devices.map((d) => ({ id: d.device, label: DEVICE_LABELS[d.device]?.() ?? d.device, value: d.views }))} color={SERIES[3]} empty={m.ste_no_data()} />
        </div>
      </SectionCard>
    </div>
  {/if}
</div>
