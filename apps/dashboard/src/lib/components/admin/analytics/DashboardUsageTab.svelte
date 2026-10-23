<!--
  Onglet « Usage du dashboard » de /admin/analytics : ce que les gestionnaires
  consultent, combien de temps, ce qu'ils y enregistrent, par où ils arrivent,
  et où le dashboard les fait attendre ou échoue.

  Les visiteurs se lisent en visiteurs-jours : la télémétrie ne garde qu'un
  hash du jour, une personne revenue trois jours compte trois fois.
-->
<script lang="ts">
  import AdminCard from '../AdminCard.svelte';
  import AdminStat from '../AdminStat.svelte';
  import BarList, { type BarListItem } from '../../analytics/BarList.svelte';
  import TrendChart from '../../analytics/TrendChart.svelte';
  import { fmtNumber, fmtPct } from '../../analytics/analyticsFormat';
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
    // Le temps d'une visite peut partir en plusieurs lots : on le rapporte aux vues.
    return row.views > 0 ? row.activeMs / row.views : 0;
  }

  function delta(current: number, previous: number | undefined): number | null {
    if (!compare || previous === undefined || previous === 0) return null;
    return ((current - previous) / previous) * 100;
  }

  // ── Tendance ─────────────────────────────────────────────────────────────
  type TrendMetric = 'views' | 'visitorDays' | 'sessions' | 'saves';
  const TREND_METRICS: Array<{ id: TrendMetric; label: string }> = [
    { id: 'views', label: 'Pages vues' },
    { id: 'visitorDays', label: 'Visiteurs' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'saves', label: 'Enregistrements' },
  ];
  let trendMetric = $state<TrendMetric>('views');

  // ── Tableau des pages ────────────────────────────────────────────────────
  type SortKey = 'views' | 'visitorDays' | 'guilds' | 'avgTime' | 'saves' | 'saveRate' | 'errors' | 'exits';
  let sortKey = $state<SortKey>('views');
  let showAllPages = $state(false);

  function sortValue(row: DashboardUsagePageRow, key: SortKey): number {
    switch (key) {
      case 'avgTime': return avgTime(row);
      case 'saveRate': return row.views > 0 ? row.saves / row.views : 0;
      case 'errors': return row.apiErrors + row.saveErrors;
      default: return row[key];
    }
  }

  const sortedPages = $derived([...(data?.pages ?? [])].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey)));
  const visiblePages = $derived(showAllPages ? sortedPages : sortedPages.slice(0, 15));

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
  <form class="flex flex-wrap items-center gap-2" onsubmit={applyGuildFilter}>
    <label for="usage-guild" class="text-body-sm text-on-surface-variant">Serveur</label>
    <input
      id="usage-guild"
      type="text"
      inputmode="numeric"
      placeholder="Tous les serveurs (ou un ID)"
      bind:value={guildFilter}
      class="w-64 max-w-full px-3 py-1.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary"
    />
    <button type="submit" class="px-3 py-1.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-sm font-semibold text-on-surface hover:bg-surface-container-highest transition">
      Filtrer
    </button>
    {#if appliedGuild}
      <button type="button" class="px-3 py-1.5 rounded-xl text-sm text-on-surface-variant hover:text-on-surface" onclick={() => { guildFilter = ''; appliedGuild = ''; }}>
        Retirer le filtre
      </button>
    {/if}
    <span class="text-body-sm text-on-surface-variant ml-auto">Admins globaux exclus · agrégats par jour, sans identifiant</span>
  </form>

  {#if error}
    <p class="p-3 rounded-xl bg-error/10 border border-error/25 text-error text-sm font-semibold">{error}</p>
  {/if}

  {#if loading && !data}
    <div class="grid grid-cols-2 lg:grid-cols-6 gap-4">
      {#each Array.from({ length: 6 }) as _, i (i)}
        <AdminStat label="…" value="" loading />
      {/each}
    </div>
  {:else if data}
    {@const t = data.totals}
    {@const p = data.previousTotals}
    <div class="grid grid-cols-2 lg:grid-cols-6 gap-4">
      <AdminStat label="Pages vues" value={fmtNumber(t.views)} icon="Eye" delta={delta(t.views, p?.views)} />
      <AdminStat label="Visiteurs" value={fmtNumber(t.visitorDays)} icon="Users" tone="info" hint="Visiteurs uniques, cumulés jour par jour" delta={delta(t.visitorDays, p?.visitorDays)} />
      <AdminStat label="Sessions" value={fmtNumber(t.sessions)} icon="activity" tone="neutral" hint={t.sessions > 0 ? `${(t.views / t.sessions).toFixed(1)} pages par session` : ''} delta={delta(t.sessions, p?.sessions)} />
      <AdminStat label="Serveurs actifs" value={fmtNumber(t.guilds)} icon="Server" tone="neutral" delta={delta(t.guilds, p?.guilds)} />
      <AdminStat label="Temps actif / vue" value={fmtDuration(avgTime(t))} icon="Clock" tone="neutral" hint={`${fmtDuration(t.activeMs)} au total`} />
      <AdminStat label="Enregistrements" value={fmtNumber(t.saves)} icon="CheckCircle" tone="success" hint={t.views > 0 ? `${fmtPct((t.saves / t.views) * 100)} des vues` : ''} delta={delta(t.saves, p?.saves)} />
    </div>

    <AdminCard title="Évolution" description="Une mesure à la fois, jour par jour">
      {#snippet actions()}
        <div class="flex items-center rounded-xl bg-surface-container-high p-1 border border-outline-variant/30 text-xs font-semibold">
          {#each TREND_METRICS as metric (metric.id)}
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg transition {trendMetric === metric.id ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}"
              aria-pressed={trendMetric === metric.id}
              onclick={() => { trendMetric = metric.id; }}
            >
              {metric.label}
            </button>
          {/each}
        </div>
      {/snippet}
      <TrendChart
        dates={data.daily.map((d) => d.dateKey)}
        values={data.daily.map((d) => d[trendMetric])}
        label={TREND_METRICS.find((mt) => mt.id === trendMetric)?.label ?? ''}
        previousLabel=""
        format={(v) => fmtNumber(v)}
        height={220}
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

    <AdminCard title="Pages" description="Clique sur un en-tête pour trier. « Taux d’enregistrement » : enregistrements rapportés aux vues." padded={false}>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-outline-variant/20 text-xs font-semibold text-on-surface-variant">
              <th class="py-2.5 px-4">Page</th>
              {#each [
                { key: 'views', label: 'Vues' },
                { key: 'visitorDays', label: 'Visiteurs' },
                { key: 'guilds', label: 'Serveurs' },
                { key: 'avgTime', label: 'Temps / vue' },
                { key: 'saves', label: 'Enreg.' },
                { key: 'saveRate', label: 'Taux d’enreg.' },
                { key: 'errors', label: 'Erreurs' },
                { key: 'exits', label: 'Sorties' },
              ] as col (col.key)}
                <th class="py-2.5 px-3 text-right" aria-sort={sortKey === col.key ? 'descending' : 'none'}>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 hover:text-on-surface {sortKey === col.key ? 'text-on-surface' : ''}"
                    onclick={() => { sortKey = col.key as SortKey; }}
                  >
                    {col.label}{sortKey === col.key ? ' ↓' : ''}
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            {#each visiblePages as row (row.page)}
              <tr class="hover:bg-surface-container-highest/30 transition">
                <td class="py-2.5 px-4">
                  <span class="font-semibold text-on-surface block">{pageLabel(row.page)}</span>
                  <span class="text-2xs font-mono text-on-surface-variant">{row.page} · {featureLabel(row.feature)}</span>
                </td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface">{fmtNumber(row.views)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtNumber(row.visitorDays)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtNumber(row.guilds)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtDuration(avgTime(row))}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtNumber(row.saves)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{row.views > 0 ? fmtPct((row.saves / row.views) * 100) : '–'}</td>
                <td class="py-2.5 px-3 text-right font-mono {row.apiErrors + row.saveErrors > 0 ? 'text-error' : 'text-on-surface-variant'}">{fmtNumber(row.apiErrors + row.saveErrors)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtNumber(row.exits)}</td>
              </tr>
            {:else}
              <tr><td colspan="9" class="py-8 text-center text-sm text-on-surface-variant">Aucune page consultée sur la période.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if sortedPages.length > 15}
        <div class="px-4 py-3 border-t border-outline-variant/15">
          <button type="button" class="text-sm font-semibold text-primary" onclick={() => { showAllPages = !showAllPages; }}>
            {showAllPages ? 'Afficher les 15 premières' : `Afficher les ${sortedPages.length} pages`}
          </button>
        </div>
      {/if}
    </AdminCard>

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
        <dl class="grid grid-cols-3 gap-3">
          <div class="p-3 rounded-xl bg-surface-container-high">
            <dt class="text-body-sm text-on-surface-variant">Premier octet</dt>
            <dd class="text-lg font-bold text-on-surface">{vital('ttfb')}</dd>
          </div>
          <div class="p-3 rounded-xl bg-surface-container-high">
            <dt class="text-body-sm text-on-surface-variant">Premier affichage</dt>
            <dd class="text-lg font-bold text-on-surface">{vital('fcp')}</dd>
          </div>
          <div class="p-3 rounded-xl bg-surface-container-high">
            <dt class="text-body-sm text-on-surface-variant">Plus grand élément</dt>
            <dd class="text-lg font-bold text-on-surface">{vital('lcp')}</dd>
          </div>
        </dl>
        <div class="grid grid-cols-2 gap-4 mt-4">
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

    <AdminCard title="Santé par page" description="Latence des lectures, part au-delà de 3 s, erreurs et chargement du code de la page" padded={false}>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-outline-variant/20 text-xs font-semibold text-on-surface-variant">
              <th class="py-2.5 px-4">Page</th>
              <th class="py-2.5 px-3 text-right">Lectures</th>
              <th class="py-2.5 px-3 text-right">Latence moy.</th>
              <th class="py-2.5 px-3 text-right">&gt; 3 s</th>
              <th class="py-2.5 px-3 text-right">Erreurs API</th>
              <th class="py-2.5 px-3 text-right">Erreurs JS</th>
              <th class="py-2.5 px-3 text-right">Chargement moy.</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            {#each data.health as h (h.page)}
              <tr>
                <td class="py-2.5 px-4 font-semibold text-on-surface">{pageLabel(h.page)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtNumber(h.latencySamples)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface">{h.latencySamples > 0 ? `${fmtNumber(Math.round(h.latencyMs / h.latencySamples))} ms` : '–'}</td>
                <td class="py-2.5 px-3 text-right font-mono {h.slowShare >= 10 ? 'text-warning' : 'text-on-surface-variant'}">{fmtPct(h.slowShare)}</td>
                <td class="py-2.5 px-3 text-right font-mono {h.apiErrors > 0 ? 'text-error' : 'text-on-surface-variant'}">{fmtNumber(h.apiErrors)}</td>
                <td class="py-2.5 px-3 text-right font-mono {h.jsErrors > 0 ? 'text-error' : 'text-on-surface-variant'}">{fmtNumber(h.jsErrors)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{h.routeLoads > 0 ? `${fmtNumber(Math.round(h.routeLoadMs / h.routeLoads))} ms` : '–'}</td>
              </tr>
            {:else}
              <tr><td colspan="7" class="py-8 text-center text-sm text-on-surface-variant">Aucune mesure sur la période.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </AdminCard>
  {/if}
</div>
