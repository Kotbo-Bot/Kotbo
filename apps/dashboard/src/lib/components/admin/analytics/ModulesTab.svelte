<!--
  Onglet « Modules » de /admin/analytics, qui remplace l'ancienne page
  /admin/modules : activation sur le parc, usage réel côté Discord
  (commandes, boutons, menus, modales), performance, et vues de la page du
  module dans le dashboard quand sa clé correspond.
-->
<script lang="ts">
  import AdminCard from '../AdminCard.svelte';
  import AdminTable from '../AdminTable.svelte';
  import AdminToolbar from '../AdminToolbar.svelte';
  import AdminBadge from '../AdminBadge.svelte';
  import type { AdminFilterOption, AdminTableColumn } from '../types';
  import MetricTabs, { type MetricTab } from '../../analytics/MetricTabs.svelte';
  import BarList, { type BarListItem } from '../../analytics/BarList.svelte';
  import TimeSeriesChart from '../../analytics/TimeSeriesChart.svelte';
  import { SERIES, fmtNumber, fmtPct, shortDate } from '../../analytics/analyticsFormat';
  import { Callout, FilterPills } from '../../ui';
  import {
    fetchAdminDashboardUsage,
    fetchAdminModuleFleet,
    type DashboardUsageResult,
    type ModuleFleetResult,
    type ModuleFleetRow,
  } from '../../../api';
  import { moduleName } from '../../../moduleLabels';
  import { getModuleDefinition } from '@kotbo/contracts';

  const { from, to, compare = false }: { from: string; to: string; compare?: boolean } = $props();

  let fleet = $state<ModuleFleetResult | null>(null);
  let usage = $state<DashboardUsageResult | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let chartMode = $state<'line' | 'bar'>('line');
  let search = $state('');
  let stateFilter = $state('all');

  $effect(() => {
    const range = { from, to };
    loading = true;
    error = null;
    Promise.all([
      fetchAdminModuleFleet(range),
      // Les vues dashboard sont un complément : leur échec ne vide pas l'onglet.
      fetchAdminDashboardUsage(range).catch(() => null),
    ])
      .then(([f, u]) => {
        fleet = f;
        usage = u;
      })
      .catch((err) => { error = err instanceof Error ? err.message : 'Chargement impossible'; })
      .finally(() => { loading = false; });
  });

  function label(key: string): string {
    if (key === 'core') return 'Commandes générales';
    return moduleName(key, getModuleDefinition(key)?.name ?? key);
  }

  const viewsByFeature = $derived(new Map((usage?.features ?? []).map((f) => [f.feature, f.views])));

  function trend(row: ModuleFleetRow): number | null {
    if (row.previousUsage === 0) return row.totalUsage > 0 ? null : 0;
    return ((row.totalUsage - row.previousUsage) / row.previousUsage) * 100;
  }

  function fmtTrend(value: number | null): string {
    if (value === null) return 'nouveau';
    if (Math.abs(value) < 0.5) return 'stable';
    return `${value > 0 ? '+' : ''}${fmtPct(value, 0)}`;
  }

  const rows = $derived(fleet?.modules ?? []);
  const daily = $derived(fleet?.daily ?? []);
  const labels = $derived(daily.map((d) => shortDate(d.dateKey)));

  const totals = $derived.by(() => {
    const usageSum = rows.reduce((s, r) => s + r.totalUsage, 0);
    const previousSum = rows.reduce((s, r) => s + r.previousUsage, 0);
    const executions = rows.reduce((s, r) => s + r.executions, 0);
    const errors = rows.reduce((s, r) => s + r.errors, 0);
    const weighted = rows.reduce((s, r) => s + r.avgExecutionMs * r.executions, 0);
    return {
      used: rows.filter((r) => r.totalUsage > 0).length,
      listed: rows.filter((r) => r.module !== 'core').length,
      usageSum,
      delta: compare && previousSum > 0 ? Math.round(((usageSum - previousSum) / previousSum) * 100) : null,
      errorRate: executions > 0 ? (errors / executions) * 100 : 0,
      avgMs: executions > 0 ? Math.round(weighted / executions) : 0,
    };
  });

  const kpis = $derived<MetricTab[]>([
    {
      id: 'used',
      label: 'Modules utilisés',
      value: `${totals.used} / ${totals.listed}`,
      hint: 'Au moins une utilisation sur la période',
      color: SERIES[0],
    },
    {
      id: 'usage',
      label: 'Utilisations',
      value: fmtNumber(totals.usageSum),
      delta: totals.delta,
      spark: daily.map((d) => d.usage),
      color: SERIES[1],
    },
    {
      id: 'latency',
      label: 'Latence moyenne',
      value: `${fmtNumber(totals.avgMs)} ms`,
      hint: 'Pondérée par le nombre d’exécutions',
      color: SERIES[2],
    },
    {
      id: 'errors',
      label: 'Taux d’erreur',
      value: fmtPct(totals.errorRate),
      invert: true,
      color: SERIES[3],
    },
  ]);

  const usageItems = $derived<BarListItem[]>(rows.filter((r) => r.totalUsage > 0).slice(0, 15).map((r) => ({
    id: r.module,
    label: label(r.module),
    value: r.totalUsage,
    display: fmtNumber(r.totalUsage),
    sub: `${fmtNumber(r.commands)} commandes · ${fmtNumber(r.events)} interactions · ${fmtNumber(r.usedGuilds)} serveurs · ${fmtTrend(trend(r))}`,
  })));

  const activationItems = $derived<BarListItem[]>([...rows]
    .filter((r) => r.module !== 'core')
    .sort((a, b) => b.activationRate - a.activationRate)
    .slice(0, 15)
    .map((r) => ({
      id: `act:${r.module}`,
      label: label(r.module),
      value: r.activationRate,
      display: fmtPct(r.activationRate),
      sub: `${fmtNumber(r.enabledGuilds)} / ${fmtNumber(fleet?.totalGuilds ?? 0)} serveurs`,
    })));

  const idleItems = $derived<BarListItem[]>(rows
    .filter((r) => r.enabledGuilds > 0 && r.totalUsage === 0)
    .sort((a, b) => b.enabledGuilds - a.enabledGuilds)
    .slice(0, 12)
    .map((r) => ({ id: `idle:${r.module}`, label: label(r.module), value: r.enabledGuilds, display: `${fmtNumber(r.enabledGuilds)} serveurs` })));

  let sortKey = $state('totalUsage');
  let sortDir = $state<'asc' | 'desc'>('desc');

  const filterOptions = $derived<AdminFilterOption[]>([
    { value: 'all', label: 'Tous', count: rows.length },
    { value: 'used', label: 'Utilisés', count: rows.filter((r) => r.totalUsage > 0).length },
    { value: 'idle', label: 'Allumés sans usage', count: rows.filter((r) => r.enabledGuilds > 0 && r.totalUsage === 0).length },
    { value: 'errors', label: 'Avec erreurs', count: rows.filter((r) => r.errors > 0).length },
  ]);

  const filteredModules = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (stateFilter === 'used' && r.totalUsage <= 0) return false;
      if (stateFilter === 'idle' && !(r.enabledGuilds > 0 && r.totalUsage === 0)) return false;
      if (stateFilter === 'errors' && r.errors <= 0) return false;
      if (!q) return true;
      return label(r.module).toLowerCase().includes(q) || r.module.toLowerCase().includes(q);
    });
    const factor = sortDir === 'desc' ? -1 : 1;
    return list.sort((a, b) => {
      const va = sortKey === 'views' ? viewsByFeature.get(a.module) ?? 0 : Number((a as unknown as Record<string, unknown>)[sortKey] ?? 0);
      const vb = sortKey === 'views' ? viewsByFeature.get(b.module) ?? 0 : Number((b as unknown as Record<string, unknown>)[sortKey] ?? 0);
      return (va - vb) * factor;
    });
  });

  const COLUMNS: AdminTableColumn[] = [
    { key: 'module', label: 'Module' },
    { key: 'totalUsage', label: 'Usage', sortKey: 'totalUsage', align: 'right' },
    { key: 'enabledGuilds', label: 'Allumé sur', sortKey: 'enabledGuilds', align: 'right', hideBelow: 'sm' },
    { key: 'usedGuilds', label: 'Utilisé sur', sortKey: 'usedGuilds', align: 'right', hideBelow: 'md' },
    { key: 'userDays', label: 'Membres-jours', sortKey: 'userDays', align: 'right', hideBelow: 'lg' },
    { key: 'avgExecutionMs', label: 'Latence moy.', sortKey: 'avgExecutionMs', align: 'right', hideBelow: 'md' },
    { key: 'errorRate', label: 'Erreurs', sortKey: 'errorRate', align: 'right' },
    { key: 'views', label: 'Vues dashboard', sortKey: 'views', align: 'right', hideBelow: 'xl' },
    { key: 'trend', label: 'Tendance', align: 'right', hideBelow: 'sm' },
  ];
</script>

<div class="space-y-6">
  <p class="text-body-sm text-on-surface-variant">
    Usage = commandes, boutons, menus et modales du module, plus les appels suivis. Les serveurs qui ont coupé les analytics ne comptent que dans la performance.
  </p>

  {#if error}
    <Callout variant="danger">{error}</Callout>
  {/if}

  {#if loading && !fleet}
    <div class="h-32 admin-surface animate-pulse"></div>
    <div class="h-72 admin-surface animate-pulse"></div>
  {:else if fleet}
    <MetricTabs metrics={kpis} active="" onchange={() => {}} interactive={false} label="Synthèse des modules" />

    <AdminCard title="Utilisations par jour" description="Tous modules confondus">
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
        main={{ label: 'Utilisations', values: daily.map((d) => d.usage), color: SERIES[0] }}
        format={(v) => fmtNumber(v)}
      />
    </AdminCard>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <AdminCard title="Modules les plus utilisés" description="Tendance comparée à la période précédente de même durée">
        <BarList items={usageItems} empty="Aucune utilisation sur la période." />
      </AdminCard>
      <div class="space-y-6">
        <AdminCard title="Taux d’activation" description="Part des serveurs où le module est allumé">
          <BarList items={activationItems} max={100} empty="Aucune activation connue." />
        </AdminCard>
        <AdminCard title="Allumés mais jamais utilisés" description="Sur la période : à expliquer ou à mettre en avant">
          <BarList items={idleItems} empty="Tous les modules allumés servent." />
        </AdminCard>
      </div>
    </div>

    <div class="space-y-3">
      <AdminToolbar
        bind:search
        placeholder="Rechercher un module…"
        filters={filterOptions}
        bind:activeFilter={stateFilter}
        resultCount={filteredModules.length}
        resultLabel="module"
      />
      <AdminTable
        columns={COLUMNS}
        rows={filteredModules}
        bind:sortKey
        bind:sortDir
        emptyTitle="Aucun module correspondant"
        emptyHint="Modifie la recherche ou le filtre."
      >
        {#snippet row(item, _index)}
          {@const rowItem = item as ModuleFleetRow}
          {@const t = trend(rowItem)}
          <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
            <td class="px-4 py-3">
              <span class="font-semibold text-on-surface block">{label(rowItem.module)}</span>
              <span class="text-2xs font-mono text-on-surface-variant">{rowItem.module}</span>
            </td>
            <td
              class="px-4 py-3 text-right font-mono text-sm font-semibold text-on-surface tabular-nums"
              title={`${fmtNumber(rowItem.commands)} commandes · ${fmtNumber(rowItem.events)} interactions · ${fmtNumber(rowItem.apiCalls)} appels`}
            >
              {fmtNumber(rowItem.totalUsage)}
            </td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden sm:table-cell">
              {rowItem.module === 'core' ? '–' : `${fmtNumber(rowItem.enabledGuilds)} · ${fmtPct(rowItem.activationRate)}`}
            </td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden md:table-cell">
              {fmtNumber(rowItem.usedGuilds)}
            </td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden lg:table-cell">
              {fmtNumber(rowItem.userDays)}
            </td>
            <td
              class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden md:table-cell"
              title={rowItem.maxExecutionMs > 0 ? `Max ${fmtNumber(rowItem.maxExecutionMs)} ms` : ''}
            >
              {rowItem.executions > 0 ? `${fmtNumber(rowItem.avgExecutionMs)} ms` : '–'}
            </td>
            <td class="px-4 py-3 text-right">
              {#if rowItem.executions === 0}
                <span class="font-mono text-sm text-on-surface-variant tabular-nums">–</span>
              {:else if rowItem.errorRate > 5}
                <AdminBadge size="sm" tone="danger" label={fmtPct(rowItem.errorRate)} />
              {:else}
                <span class="font-mono text-sm text-on-surface-variant tabular-nums">{fmtPct(rowItem.errorRate)}</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-right font-mono text-sm text-on-surface-variant tabular-nums hidden xl:table-cell">
              {viewsByFeature.has(rowItem.module) ? fmtNumber(viewsByFeature.get(rowItem.module) ?? 0) : '–'}
            </td>
            <td class="px-4 py-3 text-right hidden sm:table-cell">
              {#if rowItem.totalUsage === 0 && rowItem.previousUsage === 0}
                <span class="text-xs text-on-surface-variant">–</span>
              {:else if t === null}
                <AdminBadge size="sm" tone="info" label="Nouveau" />
              {:else if Math.abs(t) < 0.5}
                <span class="text-xs font-mono text-on-surface-variant">stable</span>
              {:else}
                <AdminBadge size="sm" tone={t > 0 ? 'success' : 'warning'} label={fmtTrend(t)} />
              {/if}
            </td>
          </tr>
        {/snippet}
      </AdminTable>
    </div>
  {/if}
</div>
