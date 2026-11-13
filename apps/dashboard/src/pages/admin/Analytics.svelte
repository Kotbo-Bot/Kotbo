<script lang="ts">
  /**
   * Analytics commerciales de la console admin : acquisition, revenus,
   * segments, retention, usage du dashboard, modules et seuils d'alerte.
   *
   * Chaque vue est une entree de l'espace Analytics (`/admin/analytics/<vue>`),
   * au meme niveau que l'activite et les abonnements : plus de rangee d'onglets
   * propre a la page. Les blocs reprennent ceux des analytics d'un serveur
   * (chiffres cles `MetricTabs`, classements `BarList`).
   */
  import { m } from '../../lib/i18n';
  import { router } from 'tinro';
  import { onMount } from 'svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import DashboardUsageTab from '../../lib/components/admin/analytics/DashboardUsageTab.svelte';
  import ModulesTab from '../../lib/components/admin/analytics/ModulesTab.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import MetricTabs from '../../lib/components/analytics/MetricTabs.svelte';
  import BarList from '../../lib/components/analytics/BarList.svelte';
  import TimeSeriesChart from '../../lib/components/analytics/TimeSeriesChart.svelte';
  import { SERIES, shortDate } from '../../lib/components/analytics/analyticsFormat';
  import { Button, Callout, EmptyState, Field, FilterPills } from '../../lib/components/ui';
  import { moduleName } from '../../lib/moduleLabels';
  import { toast } from '../../lib/stores/toast.svelte';
  import type { AnalyticsDimension } from '@kotbo/contracts';
  import {
    fetchAdminFunnelStats,
    fetchAdminOnboardingFunnel,
    fetchAdminRevenueStats,
    fetchAdminRetentionCohorts,
    fetchAdminSegmentsStats,
    fetchAdminModuleCorrelations,
    fetchAdminAnalyticsGuilds,
    fetchAdminRisksSummary,
    fetchAdminAlertThresholds,
    saveAdminAlertThresholds,
    downloadAdminAnalyticsCsv,
    type FunnelStatsResult,
    type OnboardingFunnelResult,
    type RevenueStatsResult,
    type CohortRow,
    type SegmentsStatsResult,
    type ModuleCorrelationsResult,
    type RisksSummaryResult,
    type AlertThresholds,
    type GuildExplorerItem,
  } from '../../lib/api';

  const { tab = '' }: { tab?: string } = $props();

  // ── Vue affichee et filtres ────────────────────────────────────────────────
  type TabKey = 'funnel' | 'revenue' | 'segments' | 'retention' | 'alerts' | 'usage' | 'modules';
  const TAB_KEYS: readonly TabKey[] = ['funnel', 'revenue', 'segments', 'retention', 'alerts', 'usage', 'modules'];
  const activeTab = $derived<TabKey>(TAB_KEYS.includes(tab as TabKey) ? (tab as TabKey) : 'funnel');

  // Les vues autonomes chargent elles-memes leurs donnees.
  const SELF_LOADED_TABS = new Set<TabKey>(['usage', 'modules']);

  const TITLES: Record<TabKey, string> = {
    funnel: 'Acquisition',
    revenue: 'Revenus',
    segments: 'Segments',
    retention: 'Rétention',
    alerts: 'Alertes',
    usage: 'Usage du dashboard',
    modules: 'Modules',
  };
  const DESCRIPTIONS: Record<TabKey, string> = {
    funnel: 'De la visite du site au premier paiement : où les serveurs arrivent, et où ils décrochent.',
    revenue: 'Revenu récurrent, ce qui le fait bouger, et les dernières factures.',
    segments: 'Les serveurs regroupés par taille, provenance ou type, avec leur conversion.',
    retention: 'Qui reste, qui risque de partir, et quels modules font la différence.',
    alerts: 'Les seuils qui déclenchent une alerte sur le salon de supervision.',
    usage: 'Les pages du dashboard réellement consultées.',
    modules: 'L’adoption et l’usage de chaque module sur l’ensemble des serveurs.',
  };

  type PeriodPreset = '7d' | '30d' | '90d' | '12m';
  let periodPreset = $state<PeriodPreset>('30d');
  let comparePrevious = $state(false);

  let loading = $state(true);
  let error = $state<string | null>(null);

  // ── Donnees des vues ───────────────────────────────────────────────────────
  let funnelData = $state<FunnelStatsResult | null>(null);
  let onboardingData = $state<OnboardingFunnelResult | null>(null);
  let revenueData = $state<RevenueStatsResult | null>(null);
  let cohortsData = $state<CohortRow[]>([]);
  let segmentsData = $state<SegmentsStatsResult | null>(null);
  let modulesData = $state<ModuleCorrelationsResult | null>(null);
  let risksData = $state<RisksSummaryResult | null>(null);
  let alertThresholds = $state<AlertThresholds | null>(null);
  let recentAlerts = $state<Array<{ key: string; lastFiredAt: string; lastValue: number | null }>>([]);

  let selectedDimension = $state<AnalyticsDimension>('size');

  // ── Panneau lateral : les serveurs derriere un chiffre ─────────────────────
  let drawerOpen = $state(false);
  let drawerTitle = $state('Détail des serveurs');
  let drawerSubtitle = $state('');
  let drawerFilter = $state<string | undefined>(undefined);
  let drawerDimension = $state<AnalyticsDimension | undefined>(undefined);
  let drawerBucket = $state<string | undefined>(undefined);
  let drawerGuilds = $state<GuildExplorerItem[]>([]);
  let drawerPage = $state(1);
  let drawerTotalPages = $state(1);
  let drawerTotalCount = $state(0);
  let drawerLoading = $state(false);

  function getQueryDates() {
    const now = new Date();
    const fromDate = new Date();
    if (periodPreset === '7d') fromDate.setDate(now.getDate() - 7);
    else if (periodPreset === '30d') fromDate.setDate(now.getDate() - 30);
    else if (periodPreset === '90d') fromDate.setDate(now.getDate() - 90);
    else fromDate.setFullYear(now.getFullYear() - 1);
    return { from: fromDate.toISOString(), to: now.toISOString() };
  }

  async function loadAll() {
    if (SELF_LOADED_TABS.has(activeTab)) {
      loading = false;
      return;
    }
    loading = true;
    error = null;
    const { from, to } = getQueryDates();

    try {
      if (activeTab === 'funnel') {
        const [funnel, onboarding] = await Promise.all([
          fetchAdminFunnelStats({ from, to, compare: comparePrevious }),
          fetchAdminOnboardingFunnel({ from, to }),
        ]);
        funnelData = funnel;
        onboardingData = onboarding;
      } else if (activeTab === 'revenue') {
        revenueData = await fetchAdminRevenueStats({ from, to, compare: comparePrevious });
      } else if (activeTab === 'segments') {
        segmentsData = await fetchAdminSegmentsStats({ dimension: selectedDimension, from, to });
      } else if (activeTab === 'retention') {
        const [cohortsRes, modulesRes, risksRes] = await Promise.all([
          fetchAdminRetentionCohorts(),
          fetchAdminModuleCorrelations(),
          fetchAdminRisksSummary(),
        ]);
        cohortsData = cohortsRes?.cohorts ?? [];
        modulesData = modulesRes;
        risksData = risksRes;
      } else if (activeTab === 'alerts') {
        const alertsRes = await fetchAdminAlertThresholds();
        alertThresholds = alertsRes.thresholds;
        recentAlerts = alertsRes?.recentAlerts ?? [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur de chargement des statistiques';
    } finally {
      loading = false;
    }
  }

  // Recharge a chaque changement de vue ou de filtre.
  $effect(() => {
    void activeTab;
    void periodPreset;
    void comparePrevious;
    void selectedDimension;
    void loadAll();
  });

  // Anciens liens `?tab=usage` (palette, favoris) : meme vue, nouvelle adresse.
  onMount(() => {
    const legacy = new URLSearchParams(window.location.search).get('tab');
    if (!tab && TAB_KEYS.includes(legacy as TabKey) && legacy !== 'funnel') router.goto(`/admin/analytics/${legacy}`, true);
  });

  async function openDrawer(params: { title: string; subtitle?: string; filter?: string; dimension?: AnalyticsDimension; bucket?: string }) {
    drawerTitle = params.title;
    drawerSubtitle = params.subtitle ?? '';
    drawerFilter = params.filter;
    drawerDimension = params.dimension;
    drawerBucket = params.bucket;
    drawerPage = 1;
    drawerOpen = true;
    await loadDrawerGuilds();
  }

  async function loadDrawerGuilds() {
    drawerLoading = true;
    try {
      const res = await fetchAdminAnalyticsGuilds({ page: drawerPage, limit: 20, filter: drawerFilter, dimension: drawerDimension, bucket: drawerBucket });
      drawerGuilds = res?.guilds ?? [];
      drawerTotalPages = res?.pagination?.totalPages ?? 1;
      drawerTotalCount = res?.pagination?.total ?? 0;
    } catch {
      toast.error(m.aana_servers_load_error());
    } finally {
      drawerLoading = false;
    }
  }

  function changeDrawerPage(nextPage: number) {
    if (nextPage < 1 || nextPage > drawerTotalPages) return;
    drawerPage = nextPage;
    void loadDrawerGuilds();
  }

  let savingAlerts = $state(false);
  async function handleSaveAlerts() {
    if (!alertThresholds) return;
    savingAlerts = true;
    try {
      await saveAdminAlertThresholds(alertThresholds);
      toast.success(m.aana_thresholds_saved());
    } catch {
      toast.error(m.aana_save_error());
    } finally {
      savingAlerts = false;
    }
  }

  let exportingCsv = $state(false);
  async function handleExportCsv() {
    exportingCsv = true;
    const { from, to } = getQueryDates();
    try {
      await downloadAdminAnalyticsCsv(activeTab, { from, to, dimension: selectedDimension, filter: drawerFilter });
      toast.success(m.aana_csv_exported());
    } catch {
      toast.error(m.aana_csv_export_failed());
    } finally {
      exportingCsv = false;
    }
  }

  // ── Formatage ──────────────────────────────────────────────────────────────
  const nf = new Intl.NumberFormat('fr-FR');

  function formatEuros(cents: number | null | undefined): string {
    return ((cents ?? 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  }

  function formatPercent(value: number | null | undefined): string {
    return `${(value ?? 0).toFixed(1).replace('.', ',')} %`;
  }

  function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) return '–';
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  // ── Acquisition ────────────────────────────────────────────────────────────
  const steps = $derived(funnelData?.steps ?? []);
  const prevSteps = $derived(funnelData?.previousSteps ?? []);
  const stepRate = (step: (typeof steps)[number] | undefined) => step?.conversionFromFirst ?? step?.conversionTop;
  const joinedStep = $derived(steps.find((step) => step.step === 'bot_joined'));
  const paidStep = $derived(steps.find((step) => step.step === 'first_payment'));

  function pctDelta(cur: number, prev: number | undefined): number | null {
    if (!comparePrevious || prev === undefined || prev === 0) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }

  const funnelKpis = $derived([
    { id: 'visits', label: 'Visites uniques', value: nf.format(steps[0]?.count ?? 0), delta: pctDelta(steps[0]?.count ?? 0, prevSteps[0]?.count), hint: 'sur le site', color: SERIES[0] },
    { id: 'joins', label: 'Installations du bot', value: nf.format(joinedStep?.count ?? 0), delta: pctDelta(joinedStep?.count ?? 0, prevSteps.find((s) => s.step === 'bot_joined')?.count), hint: `${formatPercent(stepRate(joinedStep))} des visites`, color: SERIES[1] },
    { id: 'onboarding', label: 'Configurations terminées', value: nf.format(onboardingData?.totalCompleted ?? 0), hint: `${formatPercent(onboardingData?.completionRate)} de celles commencées`, color: SERIES[2] },
    { id: 'paid', label: 'Clients payants', value: nf.format(paidStep?.count ?? 0), delta: pctDelta(paidStep?.count ?? 0, prevSteps.find((s) => s.step === 'first_payment')?.count), hint: `${formatPercent(stepRate(paidStep))} des visites`, color: SERIES[3] },
  ]);

  const stepItems = $derived(
    steps.map((step, index) => ({
      id: step.step,
      label: step.name ?? step.label ?? step.step,
      value: step.count,
      display: nf.format(step.count),
      sub: [
        index > 0 ? `${formatPercent(step.conversionFromPrev ?? step.conversionPrevious)} de l’étape d’avant` : '',
        step.medianDurationSeconds !== null ? `délai médian ${formatDuration(step.medianDurationSeconds)}` : '',
      ].filter(Boolean).join(' · '),
    })),
  );

  const sourceItems = $derived(
    Object.entries(funnelData?.sources ?? {})
      .map(([key, value]) => ({ id: key, label: key.charAt(0).toUpperCase() + key.slice(1), value: value.visits, sub: `${value.joins} installations · ${value.paid} clients` }))
      .sort((a, b) => b.value - a.value),
  );
  const contentItems = $derived(
    Object.entries(funnelData?.contents ?? {})
      .map(([key, value]) => ({ id: key, label: key, value: value.clicks, sub: `${value.joins} installations · ${value.paid} clients` }))
      .sort((a, b) => b.value - a.value),
  );
  const dropItems = $derived(
    (onboardingData?.stepDropOffs ?? []).map((drop) => ({ id: drop.step, label: drop.step, value: drop.count, display: `${nf.format(drop.count)} · ${formatPercent(drop.dropOffRate)}` })),
  );

  // ── Revenus ────────────────────────────────────────────────────────────────
  let revMetric = $state<'mrr' | 'collected' | 'paying'>('mrr');
  let revChartMode = $state<'line' | 'bar'>('line');
  const revSeries = $derived(revenueData?.series ?? []);
  const revLabels = $derived(revSeries.map((d) => shortDate(d.dateKey)));

  const revenueKpis = $derived(
    !revenueData
      ? []
      : [
          {
            id: 'mrr',
            label: 'Revenu récurrent mensuel',
            value: formatEuros(revenueData.mrrCents),
            spark: revSeries.map((d) => Math.round(d.mrrCents / 100)),
            hint: `${formatEuros(revenueData.arrCents)} sur un an`,
            color: SERIES[0],
          },
          {
            id: 'collected',
            label: 'Encaissé sur la période',
            value: formatEuros(revenueData.collectedCents),
            spark: revSeries.map((d) => Math.round(d.collectedCents / 100)),
            hint: 'factures payées',
            color: SERIES[1],
          },
          {
            id: 'paying',
            label: 'Revenu par serveur',
            value: formatEuros(revenueData.arpaCents),
            spark: revSeries.map((d) => d.payingCount),
            hint: `${revenueData.payingGuilds} serveurs payants`,
            color: SERIES[2],
          },
          {
            id: 'net',
            label: 'Variation du récurrent',
            value: formatEuros((revenueData.waterfall?.mrrEndCents ?? 0) - (revenueData.waterfall?.mrrStartCents ?? 0)),
            hint: 'entre le début et la fin',
            color: SERIES[3],
          },
        ],
  );

  const waterfallMax = $derived(
    !revenueData?.waterfall
      ? 1
      : Math.max(
          1,
          revenueData.waterfall.mrrStartCents,
          revenueData.waterfall.mrrEndCents,
          revenueData.waterfall.newCents,
          revenueData.waterfall.expansionCents,
          revenueData.waterfall.contractionCents,
          revenueData.waterfall.churnCents,
        ),
  );

  const waterfall = $derived(
    !revenueData?.waterfall
      ? []
      : [
          { label: 'Au début', cents: revenueData.waterfall.mrrStartCents, value: formatEuros(revenueData.waterfall.mrrStartCents), tone: '', bar: 'bg-on-surface/35' },
          { label: 'Nouveaux', cents: revenueData.waterfall.newCents, value: `+${formatEuros(revenueData.waterfall.newCents)}`, tone: 'text-success', bar: 'bg-success' },
          { label: 'Montées en offre', cents: revenueData.waterfall.expansionCents, value: `+${formatEuros(revenueData.waterfall.expansionCents)}`, tone: 'text-success', bar: 'bg-success' },
          { label: 'Baisses d’offre', cents: revenueData.waterfall.contractionCents, value: `−${formatEuros(revenueData.waterfall.contractionCents)}`, tone: 'text-error', bar: 'bg-error' },
          { label: 'Résiliations', cents: revenueData.waterfall.churnCents, value: `−${formatEuros(revenueData.waterfall.churnCents)}`, tone: 'text-error', bar: 'bg-error' },
          { label: 'À la fin', cents: revenueData.waterfall.mrrEndCents, value: formatEuros(revenueData.waterfall.mrrEndCents), tone: '', bar: 'bg-primary' },
        ],
  );

  const planItems = $derived(
    Object.entries(revenueData?.byPlan ?? {})
      .map(([plan, item]) => ({ id: plan, label: plan, value: item.mrrCents, display: formatEuros(item.mrrCents), sub: `${item.count} serveur${item.count > 1 ? 's' : ''}` }))
      .sort((a, b) => b.value - a.value),
  );
  const intervalItems = $derived(
    !revenueData
      ? []
      : [
          { id: 'month', label: 'Au mois', value: revenueData.byInterval.month.mrrCents, display: formatEuros(revenueData.byInterval.month.mrrCents), sub: `${revenueData.byInterval.month.count} abonnements` },
          { id: 'year', label: 'À l’année', value: revenueData.byInterval.year.mrrCents, display: formatEuros(revenueData.byInterval.year.mrrCents), sub: `${revenueData.byInterval.year.count} abonnements` },
        ],
  );

  const invoiceColumns: AdminTableColumn[] = [
    { key: 'date', label: 'Date' },
    { key: 'guild', label: 'Serveur' },
    { key: 'plan', label: 'Offre' },
    { key: 'interval', label: 'Rythme', hideBelow: 'sm' },
    { key: 'amount', label: 'Montant TTC', align: 'right' },
    { key: 'status', label: 'Statut', align: 'right' },
  ];

  // ── Segments ───────────────────────────────────────────────────────────────
  const DIMENSIONS: { value: AnalyticsDimension; label: string }[] = [
    { value: 'size', label: 'Taille' },
    { value: 'source', label: 'Provenance' },
    { value: 'instance', label: 'Instance' },
    { value: 'locale', label: 'Langue' },
    { value: 'kind', label: 'Type de communauté' },
  ];
  const segmentColumns: AdminTableColumn[] = [
    { key: 'bucket', label: 'Segment' },
    { key: 'total', label: 'Serveurs', align: 'right' },
    { key: 'paying', label: 'Payants', align: 'right' },
    { key: 'trial', label: 'Essais', align: 'right', hideBelow: 'sm' },
    { key: 'conversion', label: 'Conversion', align: 'right' },
    { key: 'mrr', label: 'Récurrent', align: 'right', hideBelow: 'md' },
    { key: 'ltv', label: 'Valeur moyenne', align: 'right', hideBelow: 'lg' },
  ];
  const tierColumns: AdminTableColumn[] = [
    { key: 'guild', label: 'Serveur' },
    { key: 'members', label: 'Membres', align: 'right' },
    { key: 'current', label: 'Offre actuelle' },
    { key: 'recommended', label: 'Offre adaptée' },
    { key: 'mrr', label: 'Récurrent', align: 'right', hideBelow: 'md' },
  ];

  // ── Retention ──────────────────────────────────────────────────────────────
  const riskKpis = $derived(
    !risksData
      ? []
      : [
          { id: 'inactive', label: 'Payants inactifs depuis 14 jours', value: nf.format(risksData.summary.inactivePayingCount), hint: 'aucune activité du bot' },
          { id: 'declining', label: 'Usage divisé par deux', value: nf.format(risksData.summary.decliningUsageCount), hint: 'd’une semaine à l’autre' },
          { id: 'trials', label: 'Essais finissant sous 48 h', value: nf.format(risksData.summary.expiringTrials48hCount), hint: 'à convertir en priorité' },
          { id: 'mrr', label: 'Revenu récurrent en jeu', value: formatEuros(risksData.summary.atRiskMrrCents), hint: 'total de ces serveurs' },
        ],
  );

  const moduleLabel = (key: string) => moduleName(key, key);
  const adoptionItems = $derived(
    (modulesData?.moduleAdoption ?? []).slice(0, 10).map((entry) => ({
      id: entry.module,
      label: moduleLabel(entry.module),
      value: entry.paidAdoptionRate,
      display: formatPercent(entry.paidAdoptionRate),
      sub: `${formatPercent(entry.freeAdoptionRate)} en gratuit`,
    })),
  );
  const churnItems = $derived(
    (modulesData?.churnDropOffModules ?? []).map((entry) => ({ id: entry.module, label: moduleLabel(entry.module), value: entry.dropOffCount })),
  );

  const first = $derived(loading && !funnelData && !revenueData && !segmentsData && !risksData && !alertThresholds);
</script>

<AdminShell title={TITLES[activeTab]} description={DESCRIPTIONS[activeTab]}>
  {#snippet actions()}
    {#if activeTab !== 'alerts' && activeTab !== 'retention'}
      <FilterPills
        label="Période"
        value={periodPreset}
        onchange={(value) => (periodPreset = value)}
        options={[
          { value: '7d', label: '7 jours' },
          { value: '30d', label: '30 jours' },
          { value: '90d', label: '90 jours' },
          { value: '12m', label: '1 an' },
        ]}
      />
    {/if}
    {#if activeTab === 'funnel' || activeTab === 'revenue' || activeTab === 'usage' || activeTab === 'modules'}
      <Button icon="GitCompare" variant={comparePrevious ? 'primary' : 'secondary'} aria-pressed={comparePrevious} onclick={() => (comparePrevious = !comparePrevious)}>
        Comparer
      </Button>
    {/if}
    {#if !SELF_LOADED_TABS.has(activeTab)}
      <Button icon="Download" loading={exportingCsv} onclick={handleExportCsv}>Export CSV</Button>
      <Button icon="RefreshCw" {loading} aria-label="Actualiser" title="Actualiser" onclick={loadAll} />
    {/if}
  {/snippet}

  {#if activeTab === 'usage' || activeTab === 'modules'}
    {@const range = getQueryDates()}
    {#if activeTab === 'usage'}
      <DashboardUsageTab from={range.from} to={range.to} compare={comparePrevious} />
    {:else}
      <ModulesTab from={range.from} to={range.to} compare={comparePrevious} />
    {/if}
  {:else}
    {#if error}
      <Callout variant="danger">
        {error}
        {#snippet actions()}
          <Button size="sm" icon="RefreshCw" onclick={loadAll}>Réessayer</Button>
        {/snippet}
      </Callout>
    {/if}

    {#if first}
      <div class="h-72 admin-surface animate-pulse"></div>

    <!-- ── Acquisition ─────────────────────────────────────────────────────── -->
    {:else if activeTab === 'funnel' && funnelData}
      <MetricTabs metrics={funnelKpis} active="" onchange={() => {}} interactive={false} label="Chiffres clés de l’acquisition" />

      <AdminCard title="Le tunnel, étape par étape" description="Combien passent d’une étape à la suivante, et en combien de temps">
        <BarList items={stepItems} empty="Aucun événement d’acquisition sur la période." />
      </AdminCard>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <AdminCard title="D’où viennent les visites" description="Discord, moteurs de recherche, accès direct">
          <BarList items={sourceItems} empty="Aucune visite mesurée sur la période." />
        </AdminCard>
        <AdminCard title="Boutons qui amènent des installations" description="Clics par bouton d’invitation du site">
          <BarList items={contentItems} empty="Aucun clic mesuré sur la période." />
        </AdminCard>
      </div>

      {#if onboardingData}
        <AdminCard title="Parcours de configuration" description="Où les nouveaux serveurs s’arrêtent avant d’avoir fini">
          <dl class="grid grid-cols-3 gap-4 mb-5">
            {#each [
              { label: 'Commencés', value: nf.format(onboardingData.totalStarted) },
              { label: 'Terminés', value: nf.format(onboardingData.totalCompleted) },
              { label: 'Durée médiane', value: formatDuration(onboardingData.medianDurationSeconds) },
            ] as entry (entry.label)}
              <div>
                <dt class="text-xs text-on-surface-variant">{entry.label}</dt>
                <dd class="font-headline text-2xl font-bold tabular-nums">{entry.value}</dd>
              </div>
            {/each}
          </dl>
          <p class="text-xs font-semibold text-on-surface-variant mb-2">Abandons par étape</p>
          <BarList items={dropItems} color="var(--error-color)" empty="Aucun abandon sur la période." />
        </AdminCard>
      {/if}

    <!-- ── Revenus ─────────────────────────────────────────────────────────── -->
    {:else if activeTab === 'revenue' && revenueData}
      <MetricTabs
        metrics={revenueKpis}
        active={revMetric}
        onchange={(id) => {
          if (id === 'mrr' || id === 'collected' || id === 'paying') revMetric = id;
        }}
        label="Chiffres clés des revenus"
      />

      {#if revSeries.length > 0}
        <AdminCard
          title={revMetric === 'mrr' ? 'Évolution du MRR' : revMetric === 'collected' ? 'Montants encaissés par jour' : 'Serveurs payants'}
          description="Clique sur un compteur au-dessus pour changer la courbe affichée"
        >
          {#snippet actions()}
            <FilterPills
              label="Mode du graphique"
              value={revChartMode}
              onchange={(v) => (revChartMode = v)}
              options={[
                { value: 'line', label: 'Courbe' },
                { value: 'bar', label: 'Barres' },
              ]}
            />
          {/snippet}
          <TimeSeriesChart
            labels={revLabels}
            mode={revChartMode}
            main={revMetric === 'mrr'
              ? { label: 'MRR (€)', values: revSeries.map((d) => Math.round(d.mrrCents / 100)), color: SERIES[0] }
              : revMetric === 'collected'
                ? { label: 'Encaissé (€)', values: revSeries.map((d) => Math.round(d.collectedCents / 100)), color: SERIES[1] }
                : { label: 'Serveurs payants', values: revSeries.map((d) => d.payingCount), color: SERIES[2] }}
            format={(v) => (revMetric === 'paying' ? nf.format(v) : `${nf.format(v)} €`)}
          />
        </AdminCard>
      {/if}

      <AdminCard title="Ce qui a fait bouger le revenu récurrent" description="Du montant de départ au montant d’arrivée">
        <dl class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-5">
          {#each waterfall as cell (cell.label)}
            <div class="space-y-1.5">
              <dt class="text-xs text-on-surface-variant">{cell.label}</dt>
              <dd class="font-headline text-xl font-bold tabular-nums {cell.tone}">{cell.value}</dd>
              <div class="h-1.5 w-full rounded-full bg-surface-container-high overflow-hidden">
                <div
                  class="h-full rounded-full {cell.bar}"
                  style="width: {Math.max(4, Math.min(100, Math.round((Math.abs(cell.cents) / waterfallMax) * 100)))}%"
                ></div>
              </div>
            </div>
          {/each}
        </dl>
      </AdminCard>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <AdminCard title="Par offre">
          <BarList items={planItems} empty="Aucun abonnement actif." />
        </AdminCard>
        <AdminCard title="Au mois ou à l’année" description="Revenu ramené au mois">
          <BarList items={intervalItems} />
        </AdminCard>
      </div>

      <AdminTable
        columns={invoiceColumns}
        rows={revenueData.recentInvoices ?? []}
        emptyIcon="CreditCard"
        emptyTitle="Aucune facture sur la période"
        emptyHint="Les factures payées arrivent ici dès que Stripe les confirme."
      >
        {#snippet row(item, _index)}
          {@const invoice = item as RevenueStatsResult['recentInvoices'][number]}
          <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
            <td class="px-4 py-3 text-body-sm text-on-surface-variant tabular-nums">{invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString('fr-FR') : '–'}</td>
            <td class="px-4 py-3">
              {#if invoice.guildId}
                <a href="/admin/servers/{invoice.guildId}" class="text-body-sm font-mono font-semibold text-on-surface hover:text-primary hover:underline">{invoice.guildId}</a>
              {:else}
                <span class="text-body-sm text-on-surface-variant">Inconnu</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-body-sm font-semibold">{invoice.plan}</td>
            <td class="px-4 py-3 text-body-sm text-on-surface-variant hidden sm:table-cell">{invoice.interval === 'year' ? 'À l’année' : 'Au mois'}</td>
            <td class="px-4 py-3 text-right text-sm font-semibold tabular-nums">{formatEuros(invoice.amountPaidCents)}</td>
            <td class="px-4 py-3 text-right"><AdminBadge size="sm" label={invoice.status} tone="success" /></td>
          </tr>
        {/snippet}
      </AdminTable>

    <!-- ── Segments ────────────────────────────────────────────────────────── -->
    {:else if activeTab === 'segments' && segmentsData}
      <FilterPills label="Regrouper les serveurs par" value={selectedDimension} onchange={(value) => (selectedDimension = value)} options={DIMENSIONS} />

      <AdminTable columns={segmentColumns} rows={segmentsData.distribution ?? []} emptyTitle="Aucun serveur à regrouper" emptyHint="Change d’axe ou de période.">
        {#snippet row(item, _index)}
          {@const segment = item as SegmentsStatsResult['distribution'][number]}
          <tr
            class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors cursor-pointer"
            onclick={() => openDrawer({ title: `Serveurs du segment ${segment.bucket || 'non renseigné'}`, dimension: selectedDimension, bucket: segment.bucket })}
          >
            <td class="px-4 py-3">
              <!-- Le bouton porte l'accès clavier ; le clic sur la ligne n'est qu'un confort à la souris. -->
              <button
                type="button"
                class="text-sm font-semibold text-on-surface hover:text-primary rounded focus-visible:outline-2 focus-visible:outline-primary"
                onclick={(event) => { event.stopPropagation(); void openDrawer({ title: `Serveurs du segment ${segment.bucket || 'non renseigné'}`, dimension: selectedDimension, bucket: segment.bucket }); }}
              >
                {segment.bucket || 'Non renseigné'}
              </button>
            </td>
            <td class="px-4 py-3 text-right text-sm tabular-nums">{nf.format(segment.totalGuilds)}</td>
            <td class="px-4 py-3 text-right text-sm font-semibold tabular-nums">{nf.format(segment.payingGuilds)}</td>
            <td class="px-4 py-3 text-right text-sm tabular-nums text-on-surface-variant hidden sm:table-cell">{nf.format(segment.trialGuilds)}</td>
            <td class="px-4 py-3 text-right text-sm font-semibold tabular-nums">{formatPercent(segment.conversionRate)}</td>
            <td class="px-4 py-3 text-right text-sm tabular-nums hidden md:table-cell">{formatEuros(segment.mrrCents)}</td>
            <td class="px-4 py-3 text-right text-sm tabular-nums text-on-surface-variant hidden lg:table-cell">{formatEuros(segment.avgLtvCents)}</td>
          </tr>
        {/snippet}
      </AdminTable>

      <div>
        <h2 class="font-headline text-xl font-bold tracking-tight">Serveurs trop grands pour leur offre</h2>
        <p class="text-body-sm text-on-surface-variant mt-1 mb-4">Leur nombre de membres dépasse le plafond de l’offre : autant d’occasions de proposer la suivante.</p>
        <AdminTable
          columns={tierColumns}
          rows={segmentsData.outOfTierMatrix ?? []}
          emptyIcon="Check"
          emptyTitle="Aucun serveur hors palier"
          emptyHint="Tous les serveurs sont sur une offre adaptée à leur taille."
        >
          {#snippet row(item, _index)}
            {@const guild = item as SegmentsStatsResult['outOfTierMatrix'][number]}
            <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
              <td class="px-4 py-3">
                <a href="/admin/servers/{guild.guildId}" class="text-sm font-semibold text-on-surface hover:text-primary hover:underline">{guild.guildName}</a>
              </td>
              <td class="px-4 py-3 text-right text-sm font-semibold tabular-nums">{nf.format(guild.memberCount)}</td>
              <td class="px-4 py-3"><AdminBadge size="sm" label={guild.currentPlan} tone="neutral" /></td>
              <td class="px-4 py-3"><AdminBadge size="sm" label={guild.recommendedPlan} tone="primary" /></td>
              <td class="px-4 py-3 text-right text-sm tabular-nums hidden md:table-cell">{formatEuros(guild.mrrCents)}</td>
            </tr>
          {/snippet}
        </AdminTable>
      </div>

    <!-- ── Retention ───────────────────────────────────────────────────────── -->
    {:else if activeTab === 'retention'}
      {#if risksData}
        <MetricTabs metrics={riskKpis} active="" onchange={() => {}} interactive={false} label="Serveurs à risque" />
      {/if}

      <AdminCard title="Qui reste, mois après mois" description="Part des serveurs payants encore abonnés, par mois d’arrivée (M0 = le mois de l’abonnement)">
        {#if cohortsData.length === 0}
          <EmptyState icon="Clock" title="Pas encore assez d’historique" description="Les cohortes apparaissent après le premier mois d’abonnements." reason="accumulating" />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full min-w-max text-center text-xs border-separate border-spacing-1">
              <thead>
                <tr class="text-on-surface-variant font-semibold">
                  <th scope="col" class="py-2 pr-3 text-left">Arrivés en</th>
                  <th scope="col" class="py-2 px-2 text-right">Serveurs</th>
                  {#each Array(13) as _, index (index)}
                    <th scope="col" class="py-2 w-11">M{index}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each cohortsData as cohort (cohort.cohortMonth)}
                  <tr>
                    <th scope="row" class="py-1 pr-3 text-left font-mono font-semibold text-on-surface">{cohort.cohortMonth}</th>
                    <td class="py-1 px-2 text-right tabular-nums text-on-surface-variant">{cohort.initialGuilds}</td>
                    {#each Array(13) as _, offset (offset)}
                      {@const period = cohort.periods?.find((entry) => entry.periodIndex === offset) ?? cohort.periods?.[offset]}
                      {@const rate = period?.retentionRate ?? period?.retainedPct}
                      <td>
                        {#if rate !== null && rate !== undefined}
                          <!-- Une seule teinte, plus dense quand la retention est forte. -->
                          <span
                            class="block py-1.5 rounded-md font-semibold tabular-nums {rate >= 60 ? 'text-on-primary' : 'text-on-surface'}"
                            style="background: color-mix(in srgb, var(--primary-color) {Math.round(8 + rate * 0.92)}%, var(--surface-container))"
                          >
                            {Math.round(rate)}
                          </span>
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="text-xs text-on-surface-variant mt-3">Valeurs en %.</p>
        {/if}
      </AdminCard>

      {#if modulesData}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          <AdminCard title="Modules des serveurs payants" description="Part des serveurs payants qui l’ont activé, comparée aux gratuits">
            <BarList items={adoptionItems} max={100} empty="Pas encore de mesure d’adoption." />
          </AdminCard>
          <AdminCard title="Derniers modules coupés avant de partir" description="Ce qui est désactivé juste avant une résiliation">
            <BarList items={churnItems} color="var(--error-color)" empty="Aucune résiliation à analyser." />
          </AdminCard>
        </div>
      {/if}

    <!-- ── Alertes ─────────────────────────────────────────────────────────── -->
    {:else if activeTab === 'alerts'}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <AdminCard title="Seuils" description="Au-delà, une alerte part sur le salon Discord de supervision">
          {#if alertThresholds}
            <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void handleSaveAlerts(); }}>
              <Field label="Résiliations sur une semaine (%)" hint="Alerte si le taux hebdomadaire dépasse ce seuil. Par défaut : 5 %.">
                {#snippet children(id, describedBy)}
                  <input {id} aria-describedby={describedBy} type="number" step="0.5" bind:value={alertThresholds.churnRateWeeklyPercent} class="input" />
                {/snippet}
              </Field>
              <Field label="Chute de la conversion des essais (%)" hint="Alerte si la conversion en fin d’essai baisse de plus que ça. Par défaut : 20 %.">
                {#snippet children(id, describedBy)}
                  <input {id} aria-describedby={describedBy} type="number" step="1" bind:value={alertThresholds.trialConversionDropPercent} class="input" />
                {/snippet}
              </Field>
              <Field label="Configurations terminées, minimum (%)" hint="Alerte si moins de serveurs que ça vont au bout du parcours. Par défaut : 40 %.">
                {#snippet children(id, describedBy)}
                  <input {id} aria-describedby={describedBy} type="number" step="1" bind:value={alertThresholds.onboardingCompletionMinPercent} class="input" />
                {/snippet}
              </Field>
              <Field label="Serveurs hors palier tolérés" hint="Alerte quand ce nombre de serveurs dépasse le plafond de leur offre. Par défaut : 10.">
                {#snippet children(id, describedBy)}
                  <input {id} aria-describedby={describedBy} type="number" step="1" bind:value={alertThresholds.outOfTierMaxCount} class="input" />
                {/snippet}
              </Field>
              <Button type="submit" variant="primary" loading={savingAlerts}>Enregistrer les seuils</Button>
            </form>
          {/if}
        </AdminCard>

        <AdminCard title="Dernières alertes envoyées">
          {#if recentAlerts.length === 0}
            <p class="text-body-sm text-on-surface-variant">Aucune alerte récente : tout est resté sous les seuils.</p>
          {:else}
            <ul class="divide-y divide-outline-variant">
              {#each recentAlerts as alert (alert.key)}
                <li class="py-3 flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-sm font-semibold text-on-surface truncate">{alert.key}</p>
                    <p class="text-xs text-on-surface-variant">Valeur mesurée : {alert.lastValue ?? 'inconnue'}</p>
                  </div>
                  <span class="text-xs text-on-surface-variant tabular-nums shrink-0">{new Date(alert.lastFiredAt).toLocaleString('fr-FR')}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </AdminCard>
      </div>
    {/if}
  {/if}
</AdminShell>

<AdminDrawer bind:open={drawerOpen} title={drawerTitle} subtitle={drawerSubtitle} width="lg">
  {#if drawerLoading}
    <div class="space-y-3">
      {#each Array(5) as _, index (index)}
        <div class="h-16 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/each}
    </div>
  {:else if drawerGuilds.length === 0}
    <EmptyState icon="Server" title="Aucun serveur dans cette sélection" reason="nothing-matches" />
  {:else}
    <p class="text-xs font-semibold text-on-surface-variant mb-3">{drawerTotalCount} serveur{drawerTotalCount > 1 ? 's' : ''}</p>
    <ul class="divide-y divide-outline-variant">
      {#each drawerGuilds as guild (guild.guildId)}
        <li>
          <a href="/admin/servers/{guild.guildId}" class="flex items-center gap-3 py-3 rounded-lg hover:bg-on-surface/3 focus-visible:outline-2 focus-visible:outline-primary">
            <span class="w-10 h-10 shrink-0 rounded-xl bg-surface-container overflow-hidden flex items-center justify-center text-sm font-bold text-on-surface-variant">
              {#if guild.icon}
                <img src={guild.icon} alt="" class="w-full h-full object-cover" loading="lazy" />
              {:else}
                {(guild.name || guild.guildId).charAt(0).toUpperCase()}
              {/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-on-surface truncate">{guild.name || guild.guildId}</span>
              <span class="block text-xs text-on-surface-variant truncate">
                {nf.format(guild.memberCount)} membres{guild.source ? ` · ${guild.source}` : ''}{guild.firstPaidAt ? ` · client depuis le ${new Date(guild.firstPaidAt).toLocaleDateString('fr-FR')}` : ''}
              </span>
              {#if guild.riskReasons && guild.riskReasons.length > 0}
                <span class="flex flex-wrap gap-1 mt-1.5">
                  {#each guild.riskReasons as reason (reason)}
                    <AdminBadge size="sm" label={reason} tone="danger" />
                  {/each}
                </span>
              {/if}
            </span>
            <span class="shrink-0 text-right">
              <AdminBadge size="sm" label={guild.plan} tone={guild.plan === 'FREE' ? 'neutral' : 'primary'} />
              <span class="block text-xs font-semibold tabular-nums mt-1">{formatEuros(guild.mrrCents)} / mois</span>
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#snippet footer()}
    {#if drawerTotalPages > 1}
      <div class="flex items-center justify-between gap-3">
        <Button size="sm" icon="ChevronLeft" disabled={drawerPage <= 1} onclick={() => changeDrawerPage(drawerPage - 1)}>Précédent</Button>
        <span class="text-xs text-on-surface-variant tabular-nums">Page {drawerPage} sur {drawerTotalPages}</span>
        <Button size="sm" iconRight="ChevronRight" disabled={drawerPage >= drawerTotalPages} onclick={() => changeDrawerPage(drawerPage + 1)}>Suivant</Button>
      </div>
    {/if}
  {/snippet}
</AdminDrawer>
