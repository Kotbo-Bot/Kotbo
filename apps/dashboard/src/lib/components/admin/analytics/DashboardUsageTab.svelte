<!--
  Onglet « Usage du dashboard » de /admin/analytics : ce que les gestionnaires
  consultent, combien de temps, ce qu'ils y enregistrent, par où ils arrivent,
  et où le dashboard les fait attendre ou échoue.

  Les visiteurs se lisent en visiteurs-jours : la télémétrie ne garde qu'un
  hash du jour, une personne revenue trois jours compte trois fois.
-->
<script lang="ts">
  import AdminCard from '../AdminCard.svelte';
  import AdminTable from '../AdminTable.svelte';
  import AdminToolbar from '../AdminToolbar.svelte';
  import AdminBadge from '../AdminBadge.svelte';
  import type { AdminTableColumn } from '../types';
  import MetricTabs, { type MetricTab } from '../../analytics/MetricTabs.svelte';
  import BarList, { type BarListItem } from '../../analytics/BarList.svelte';
  import TimeSeriesChart from '../../analytics/TimeSeriesChart.svelte';
  import KpiTile from '../../analytics/KpiTile.svelte';
  import { SERIES, fmtNumber, fmtPct, shortDate } from '../../analytics/analyticsFormat';
  import { Button, Callout, FilterPills } from '../../ui';
  import { fetchAdminDashboardUsage, type DashboardUsageResult } from '../../../api';
  import { allPages } from '../../../config/pages';
  import { PAGE_TABS } from '../../../config/pageTabs';
  import { moduleName } from '../../../moduleLabels';
  import type { DashboardUsagePageRow } from '@kotbo/contracts';

  const { from, to, compare = false }: { from: string; to: string; compare?: boolean } = $props();

  let data = $state<DashboardUsageResult | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let guildFilter = $state('');
  let appliedGuild = $state('');

  $effect(() => {
    const params = { from, to, compare, guildId: appliedGuild || undefined };
    loading = true;
    error = null;
    fetchAdminDashboardUsage(params)
      .then((res) => { data = res; })
      .catch((err) => { error = err instanceof Error ? err.message : 'Chargement impossible'; })
      .finally(() => { loading = false; });
  });

  function applyGuildFilter(event: SubmitEvent) {
    event.preventDefault();
    const value = guildFilter.trim();
    if (value && !/^\d{17,20}$/.test(value)) {
      error = 'ID de serveur invalide';
      return;
    }
    appliedGuild = value;
  }

  // ── Libellés ─────────────────────────────────────────────────────────────
  const pageNames = new Map(allPages.map((p) => [p.href.split('?')[0], p.name]));
  pageNames.set('/servers', 'Mes serveurs');

  function pageLabel(page: string): string {
    return pageNames.get(page) ?? page;
  }

  function featureLabel(feature: string): string {
    if (!feature) return 'Sans module';
    const page = allPages.find((p) => p.featureKey === feature);
    return moduleName(feature, page?.name ?? feature);
  }

  function tabLabel(page: string, tab: string): string {
    const found = (PAGE_TABS[page] ?? []).find((t) => t.id.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === tab);
    return found ? found.label() : tab;
  }

  const DIMENSION_LABELS: Record<string, Record<string, string>> = {
    page_view: {
      entry: "Page d'entrée", sidebar: 'Barre latérale', favorite: 'Favoris', palette: 'Palette de commandes',
      history: 'Précédent / suivant', reload: 'Rechargement', redirect: 'Redirection', link: 'Lien dans une page',
    },
    session_start: { desktop: 'Ordinateur', tablet: 'Tablette', mobile: 'Mobile' },
    palette: { open: 'Ouvertures', search_hit: 'Recherches avec résultat', search_empty: 'Recherches sans résultat' },
    unsaved_prompt: { save: 'Enregistré', discard: 'Annulé', save_failed: 'Échec de l’enregistrement' },
    session_env: {
      'theme:dark': 'Thème sombre', 'theme:light': 'Thème clair', 'locale:fr': 'Français', 'locale:en': 'Anglais',
      'display:pwa': 'Application installée', 'display:browser': 'Navigateur', reduced_motion: 'Animations réduites',
      vw_lt640: 'Largeur < 640 px', vw_640_1024: '640 – 1024 px', vw_1024_1440: '1024 – 1440 px',
      vw_1440_1920: '1440 – 1920 px', vw_gte1920: '≥ 1920 px',
    },
  };

  function dimensionLabel(event: string, dimension: string): string {
    if (event === 'palette' && dimension.startsWith('select:')) return `Choix : ${dimension.slice(7)}`;
    return DIMENSION_LABELS[event]?.[dimension] ?? dimension;
  }

  function dimensionItems(event: string, filter?: (dimension: string) => boolean): BarListItem[] {
    const rows = (data?.dimensions ?? []).filter((d) => d.event === event && (!filter || filter(d.dimension)));
    const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;
    return rows.map((r) => ({
      id: `${r.event}:${r.dimension}`,
      label: dimensionLabel(r.event, r.dimension),
      value: r.count,
      display: `${fmtNumber(r.count)} · ${fmtPct((r.count / total) * 100)}`,
    }));
  }

  // ── Formats ──────────────────────────────────────────────────────────────
  function fmtDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '–';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const min = Math.floor(s / 60);
    if (min < 60) return `${min} min ${String(s % 60).padStart(2, '0')}`;
    return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  }

  function avgTime(row: { activeMs: number; timeSamples: number; views: number }): number {
    return row.views > 0 ? row.activeMs / row.views : 0;
  }

  function delta(current: number, previous: number | undefined): number | null {
    if (!compare || previous === undefined || previous === 0) return null;
    return ((current - previous) / previous) * 100;
  }

  // ── Tendance & MetricTabs ────────────────────────────────────────────────
  type TrendMetric = 'views' | 'visitorDays' | 'sessions' | 'saves';
  let trendMetric = $state<TrendMetric>('views');
  let chartMode = $state<'line' | 'bar'>('line');

  const daily = $derived(data?.daily ?? []);
  const labels = $derived(daily.map((d) => shortDate(d.dateKey)));

  const metricTabs = $derived.by<MetricTab[]>(() => {
    const t = data?.totals;
    if (!t) return [];
    const p = data?.previousTotals;
    return [
      {
        id: 'views',
        label: 'Pages vues',
        value: fmtNumber(t.views),
        delta: delta(t.views, p?.views),
        spark: daily.map((d) => d.views),
        color: SERIES[0],
        hint: `${fmtNumber(t.guilds)} serveurs actifs · ${fmtDuration(avgTime(t))} / vue`,
      },
      {
        id: 'visitorDays',
        label: 'Visiteurs-jours',
        value: fmtNumber(t.visitorDays),
        delta: delta(t.visitorDays, p?.visitorDays),
        spark: daily.map((d) => d.visitorDays),
        color: SERIES[1],
        hint: 'Visiteurs uniques cumulés jour par jour',
      },
      {
        id: 'sessions',
        label: 'Sessions',
        value: fmtNumber(t.sessions),
        delta: delta(t.sessions, p?.sessions),
        spark: daily.map((d) => d.sessions),
        color: SERIES[2],
        hint: t.sessions > 0 ? `${(t.views / t.sessions).toFixed(1)} pages par session` : undefined,
      },
      {
        id: 'saves',
        label: 'Enregistrements',
        value: fmtNumber(t.saves),
        delta: delta(t.saves, p?.saves),
        spark: daily.map((d) => d.saves),
        color: SERIES[3],
        hint: t.views > 0 ? `${fmtPct((t.saves / t.views) * 100)} des vues` : undefined,
      },
    ];
  });

  const activeMetricLabel = $derived(metricTabs.find((mt) => mt.id === trendMetric)?.label ?? 'Pages vues');
  const activeMetricColor = $derived(metricTabs.find((mt) => mt.id === trendMetric)?.color ?? SERIES[0]);

  // ── Tableau des pages ────────────────────────────────────────────────────
  let pageSearch = $state('');
  let sortKey = $state('views');
  let sortDir = $state<'asc' | 'desc'>('desc');
  let showAllPages = $state(false);

  const pageColumns: AdminTableColumn[] = [
    { key: 'page', label: 'Page' },
    { key: 'views', label: 'Vues', sortKey: 'views', align: 'right' },
    { key: 'visitorDays', label: 'Visiteurs', sortKey: 'visitorDays', align: 'right', hideBelow: 'sm' },
    { key: 'guilds', label: 'Serveurs', sortKey: 'guilds', align: 'right', hideBelow: 'md' },
    { key: 'avgTime', label: 'Temps / vue', sortKey: 'avgTime', align: 'right', hideBelow: 'md' },
    { key: 'saves', label: 'Enreg.', sortKey: 'saves', align: 'right', hideBelow: 'lg' },
    { key: 'saveRate', label: 'Taux d’enreg.', sortKey: 'saveRate', align: 'right', hideBelow: 'lg' },
    { key: 'errors', label: 'Erreurs', sortKey: 'errors', align: 'right' },
    { key: 'exits', label: 'Sorties', sortKey: 'exits', align: 'right', hideBelow: 'xl' },
  ];

  function sortValue(row: DashboardUsagePageRow, key: string): number {
    switch (key) {
      case 'avgTime': return avgTime(row);
      case 'saveRate': return row.views > 0 ? row.saves / row.views : 0;
      case 'errors': return row.apiErrors + row.saveErrors;
      case 'views':
      case 'visitorDays':
      case 'guilds':
      case 'saves':
      case 'exits':
        return row[key];
      default: return row.views;
    }
  }

  const filteredPages = $derived.by(() => {
    const q = pageSearch.trim().toLowerCase();
    const list = (data?.pages ?? []).filter((p) => {
      if (!q) return true;
      return (
        pageLabel(p.page).toLowerCase().includes(q)
        || p.page.toLowerCase().includes(q)
        || featureLabel(p.feature).toLowerCase().includes(q)
      );
    });
    const factor = sortDir === 'desc' ? -1 : 1;
    return list.sort((a, b) => (sortValue(a, sortKey) - sortValue(b, sortKey)) * factor);
  });

  const visiblePages = $derived(showAllPages ? filteredPages : filteredPages.slice(0, 15));

  const healthColumns: AdminTableColumn[] = [
    { key: 'page', label: 'Page' },
    { key: 'samples', label: 'Lectures', align: 'right', hideBelow: 'sm' },
    { key: 'latency', label: 'Latence moy.', align: 'right' },
    { key: 'slow', label: '> 3 s', align: 'right' },
    { key: 'apiErrors', label: 'Erreurs API', align: 'right' },
    { key: 'jsErrors', label: 'Erreurs JS', align: 'right', hideBelow: 'sm' },
    { key: 'routeLoad', label: 'Chargement moy.', align: 'right', hideBelow: 'md' },
  ];

  const featureItems = $derived<BarListItem[]>((data?.features ?? []).slice(0, 15).map((f) => ({
    id: f.feature,
    label: featureLabel(f.feature),
    value: f.views,
    display: fmtNumber(f.views),
    sub: `${fmtNumber(f.visitorDays)} visiteurs · ${fmtNumber(f.guilds)} serveurs · ${fmtDuration(avgTime(f))} / vue · ${fmtNumber(f.saves)} enregistrements`,
  })));

  const leastFeatures = $derived<BarListItem[]>([...(data?.features ?? [])].reverse().slice(0, 8).map((f) => ({
    id: `least:${f.feature}`,
    label: featureLabel(f.feature),
    value: f.views,
    display: fmtNumber(f.views),
    sub: `${fmtNumber(f.guilds)} serveurs`,
  })));

  const tabItems = $derived<BarListItem[]>((data?.tabs ?? []).slice(0, 15).map((t) => ({
    id: `${t.page}:${t.tab}`,
    label: `${pageLabel(t.page)} › ${tabLabel(t.page, t.tab)}`,
    value: t.views,
  })));

  const blockedItems = $derived<BarListItem[]>((data?.pages ?? []).filter((p) => p.blocked > 0).sort((a, b) => b.blocked - a.blocked).slice(0, 10).map((p) => ({
    id: `blocked:${p.page}`,
    label: pageLabel(p.page),
    value: p.blocked,
    sub: featureLabel(p.feature),
  })));

  const exitItems = $derived<BarListItem[]>((data?.pages ?? []).filter((p) => p.exits > 0).sort((a, b) => b.exits - a.exits).slice(0, 10).map((p) => ({
    id: `exit:${p.page}`,
    label: pageLabel(p.page),
    value: p.exits,
    display: `${fmtNumber(p.exits)} · ${fmtPct(p.views > 0 ? (p.exits / p.views) * 100 : 0)} des vues`,
  })));

  function vital(dimension: string): string {
    const row = (data?.dimensions ?? []).find((d) => d.event === 'web_vital' && d.dimension === dimension);
    return row && row.count > 0 ? `${fmtNumber(Math.round(row.valueSum / row.count))} ms` : '–';
  }

  const jsErrorItems = $derived(dimensionItems('js_error'));
  const apiErrorItems = $derived(dimensionItems('api_error'));
</script>

<div class="space-y-6">
  <form class="flex flex-wrap items-center gap-2.5" onsubmit={applyGuildFilter}>
    <label for="usage-guild" class="text-body-sm font-semibold text-on-surface-variant">Serveur</label>
    <input
      id="usage-guild"
      type="text"
      inputmode="numeric"
      placeholder="Tous les serveurs (ou un ID)"
      bind:value={guildFilter}
      class="input w-64 max-w-full px-3 py-1.5 text-sm"
    />
    <Button type="submit" size="sm" variant="secondary">Filtrer</Button>
    {#if appliedGuild}
      <Button
        size="sm"
        variant="ghost"
        icon="X"
        onclick={() => { guildFilter = ''; appliedGuild = ''; }}
      >
        Retirer ({appliedGuild})
      </Button>
    {/if}
    <span class="text-body-sm text-on-surface-variant ml-auto">
      Admins globaux exclus · agrégats par jour, sans identifiant
    </span>
  </form>

  {#if error}
    <Callout variant="danger">{error}</Callout>
  {/if}

  {#if loading && !data}
    <div class="h-32 admin-surface animate-pulse"></div>
    <div class="h-72 admin-surface animate-pulse"></div>
  {:else if data}
    {@const t = data.totals}
    <MetricTabs
      metrics={metricTabs}
      active={trendMetric}
      onchange={(id) => {
        if (id === 'views' || id === 'visitorDays' || id === 'sessions' || id === 'saves') trendMetric = id;
      }}
      label="Indicateurs de fréquentation du dashboard"
    />

    <AdminCard
      title={activeMetricLabel}
      description={`${fmtNumber(t.guilds)} serveurs actifs · temps actif moyen ${fmtDuration(avgTime(t))} (${fmtDuration(t.activeMs)} au total)`}
    >
      {#snippet actions()}
        <FilterPills
          label="Style du graphique"
          value={chartMode}
          onchange={(v) => (chartMode = v)}
          options={[
            { value: 'line', label: 'Courbe' },
            { value: 'bar', label: 'Barres' },
          ]}
        />
      {/snippet}
      <TimeSeriesChart
        {labels}
        mode={chartMode}
        main={{ label: activeMetricLabel, values: daily.map((d) => d[trendMetric]), color: activeMetricColor }}
        format={(v) => fmtNumber(v)}
      />
    </AdminCard>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <AdminCard title="Modules les plus consultés" description="Vues cumulées de toutes les pages du module">
        <BarList items={featureItems} empty="Aucune donnée sur la période." />
      </AdminCard>
      <div class="space-y-6">
        <AdminCard title="Modules les moins consultés" description="Parmi ceux qui ont reçu au moins une visite">
          <BarList items={leastFeatures} empty="Aucune donnée sur la période." />
        </AdminCard>
        <AdminCard title="Onglets les plus ouverts">
          <BarList items={tabItems} empty="Aucun onglet ouvert sur la période." />
        </AdminCard>
      </div>
    </div>

    <div class="space-y-3">
      <AdminToolbar
        bind:search={pageSearch}
        placeholder="Filtrer par nom de page, route ou module…"
        resultCount={filteredPages.length}
        resultLabel="page"
      />
      <AdminTable
        columns={pageColumns}
        rows={visiblePages}
        bind:sortKey
        bind:sortDir
        emptyTitle="Aucune page consultée sur la période"
        emptyHint="Élargis la période ou retire le filtre serveur."
      >
        {#snippet row(item, _index)}
          {@const rowItem = item as DashboardUsagePageRow}
          {@const errCount = rowItem.apiErrors + rowItem.saveErrors}
          <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
            <td class="px-4 py-3">
              <span class="font-semibold text-on-surface block">{pageLabel(rowItem.page)}</span>
              <span class="text-2xs font-mono text-on-surface-variant">{rowItem.page} · {featureLabel(rowItem.feature)}</span>
            </td>
            <td class="px-4 py-3 text-right font-mono text-sm font-semibold tabular-nums">{fmtNumber(rowItem.views)}</td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden sm:table-cell">{fmtNumber(rowItem.visitorDays)}</td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden md:table-cell">{fmtNumber(rowItem.guilds)}</td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden md:table-cell">{fmtDuration(avgTime(rowItem))}</td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden lg:table-cell">{fmtNumber(rowItem.saves)}</td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden lg:table-cell">
              {rowItem.views > 0 ? fmtPct((rowItem.saves / rowItem.views) * 100) : '–'}
            </td>
            <td class="px-4 py-3 text-right">
              {#if errCount > 0}
                <AdminBadge size="sm" tone="danger" label={fmtNumber(errCount)} />
              {:else}
                <span class="font-mono text-sm text-on-surface-variant tabular-nums">0</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden xl:table-cell">{fmtNumber(rowItem.exits)}</td>
          </tr>
        {/snippet}
        {#snippet footer()}
          {#if filteredPages.length > 15}
            <Button size="sm" variant="ghost" onclick={() => { showAllPages = !showAllPages; }}>
              {showAllPages ? 'Afficher les 15 premières' : `Afficher les ${filteredPages.length} pages`}
            </Button>
          {/if}
        {/snippet}
      </AdminTable>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <AdminCard title="Par où on arrive" description="Source de chaque page vue">
        <BarList items={dimensionItems('page_view')} empty="Aucune donnée." />
      </AdminCard>
      <AdminCard title="Appareils" description="Au démarrage de chaque session">
        <BarList items={dimensionItems('session_start')} empty="Aucune donnée." />
      </AdminCard>
      <AdminCard title="Palette de commandes">
        <BarList items={dimensionItems('palette')} empty="Palette pas encore utilisée." />
      </AdminCard>
      <AdminCard title="Affichage" description="Thème, langue, largeur d’écran">
        <BarList items={dimensionItems('session_env', (d) => d.startsWith('theme:') || d.startsWith('locale:'))} empty="Aucune donnée." />
        <div class="mt-4">
          <BarList items={dimensionItems('session_env', (d) => d.startsWith('vw_'))} empty="" />
        </div>
      </AdminCard>
      <AdminCard title="Modifications non enregistrées" description="Issue de la barre d’enregistrement">
        <BarList items={dimensionItems('unsaved_prompt')} empty="Aucune donnée." />
      </AdminCard>
      <AdminCard title="Pages de sortie" description="Dernière page avant de fermer le dashboard">
        <BarList items={exitItems} empty="Aucune donnée." />
      </AdminCard>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <AdminCard title="Modules éteints ou fermés rencontrés" description="Pages ouvertes sur un module désactivé ou une section fermée au rôle : de l’intérêt qui bute">
        <BarList items={blockedItems} empty="Aucun refus sur la période." />
      </AdminCard>
      <AdminCard title="Vitesse perçue" description="Moyennes au premier chargement de chaque session">
        <div class="grid grid-cols-3 gap-3">
          <KpiTile label="Premier octet" value={vital('ttfb')} />
          <KpiTile label="Premier affichage" value={vital('fcp')} />
          <KpiTile label="Plus grand élément" value={vital('lcp')} />
        </div>
        <div class="grid grid-cols-2 gap-4 mt-5">
          <div>
            <p class="text-body-sm font-semibold text-on-surface mb-2">Erreurs API (lecture)</p>
            <BarList items={apiErrorItems} empty="Aucune." />
          </div>
          <div>
            <p class="text-body-sm font-semibold text-on-surface mb-2">Erreurs JavaScript</p>
            <BarList items={jsErrorItems} empty="Aucune." />
          </div>
        </div>
      </AdminCard>
    </div>

    <AdminTable
      columns={healthColumns}
      rows={data.health ?? []}
      emptyTitle="Aucune mesure de santé sur la période"
      emptyHint="La latence et les erreurs de chargement par page apparaîtront ici."
    >
      {#snippet row(item, _index)}
        {@const h = item as DashboardUsageResult['health'][number]}
        <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
          <td class="px-4 py-3 font-semibold text-on-surface">{pageLabel(h.page)}</td>
          <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden sm:table-cell">{fmtNumber(h.latencySamples)}</td>
          <td class="px-4 py-3 text-right font-mono text-sm tabular-nums">
            {h.latencySamples > 0 ? `${fmtNumber(Math.round(h.latencyMs / h.latencySamples))} ms` : '–'}
          </td>
          <td class="px-4 py-3 text-right">
            {#if h.slowShare >= 10}
              <AdminBadge size="sm" tone="warning" label={fmtPct(h.slowShare)} />
            {:else}
              <span class="font-mono text-sm text-on-surface-variant tabular-nums">{fmtPct(h.slowShare)}</span>
            {/if}
          </td>
          <td class="px-4 py-3 text-right">
            {#if h.apiErrors > 0}
              <AdminBadge size="sm" tone="danger" label={fmtNumber(h.apiErrors)} />
            {:else}
              <span class="font-mono text-sm text-on-surface-variant tabular-nums">0</span>
            {/if}
          </td>
          <td class="px-4 py-3 text-right hidden sm:table-cell">
            {#if h.jsErrors > 0}
              <AdminBadge size="sm" tone="danger" label={fmtNumber(h.jsErrors)} />
            {:else}
              <span class="font-mono text-sm text-on-surface-variant tabular-nums">0</span>
            {/if}
          </td>
          <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden md:table-cell">
            {h.routeLoads > 0 ? `${fmtNumber(Math.round(h.routeLoadMs / h.routeLoads))} ms` : '–'}
          </td>
        </tr>
      {/snippet}
    </AdminTable>
  {/if}
</div>
