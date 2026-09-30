<!--
  Onglet « Modules » de /admin/analytics, qui remplace l'ancienne page
  /admin/modules : activation sur le parc, usage réel côté Discord
  (commandes, boutons, menus, modales), performance, et vues de la page du
  module dans le dashboard quand sa clé correspond.
-->
<script lang="ts">
  import AdminCard from '../AdminCard.svelte';
  import AdminStat from '../AdminStat.svelte';
  import BarList, { type BarListItem } from '../../analytics/BarList.svelte';
  import TrendChart from '../../analytics/TrendChart.svelte';
  import { fmtNumber, fmtPct } from '../../analytics/analyticsFormat';
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
    if (Math.abs(value) < 0.5) return '→ stable';
    return `${value > 0 ? '↑ +' : '↓ '}${fmtPct(value, 0)}`;
  }

  const totals = $derived.by(() => {
    const rows = fleet?.modules ?? [];
    const usageSum = rows.reduce((s, r) => s + r.totalUsage, 0);
    const previousSum = rows.reduce((s, r) => s + r.previousUsage, 0);
    const executions = rows.reduce((s, r) => s + r.executions, 0);
    const errors = rows.reduce((s, r) => s + r.errors, 0);
    const weighted = rows.reduce((s, r) => s + r.avgExecutionMs * r.executions, 0);
    return {
      used: rows.filter((r) => r.totalUsage > 0).length,
      listed: rows.filter((r) => r.module !== 'core').length,
      usageSum,
      delta: compare && previousSum > 0 ? ((usageSum - previousSum) / previousSum) * 100 : null,
      errorRate: executions > 0 ? (errors / executions) * 100 : 0,
      avgMs: executions > 0 ? Math.round(weighted / executions) : 0,
    };
  });

  const usageItems = $derived<BarListItem[]>((fleet?.modules ?? []).filter((r) => r.totalUsage > 0).slice(0, 15).map((r) => ({
    id: r.module,
    label: label(r.module),
    value: r.totalUsage,
    display: fmtNumber(r.totalUsage),
    sub: `${fmtNumber(r.commands)} commandes · ${fmtNumber(r.events)} interactions · ${fmtNumber(r.usedGuilds)} serveurs · ${fmtTrend(trend(r))}`,
  })));

  const activationItems = $derived<BarListItem[]>([...(fleet?.modules ?? [])]
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

  const idleItems = $derived<BarListItem[]>((fleet?.modules ?? [])
    .filter((r) => r.enabledGuilds > 0 && r.totalUsage === 0)
    .sort((a, b) => b.enabledGuilds - a.enabledGuilds)
    .slice(0, 12)
    .map((r) => ({ id: `idle:${r.module}`, label: label(r.module), value: r.enabledGuilds, display: `${fmtNumber(r.enabledGuilds)} serveurs` })));

  type SortKey = 'totalUsage' | 'enabledGuilds' | 'usedGuilds' | 'userDays' | 'avgExecutionMs' | 'errorRate' | 'views';
  let sortKey = $state<SortKey>('totalUsage');
  const sorted = $derived([...(fleet?.modules ?? [])].sort((a, b) => {
    const va = sortKey === 'views' ? viewsByFeature.get(a.module) ?? 0 : a[sortKey];
    const vb = sortKey === 'views' ? viewsByFeature.get(b.module) ?? 0 : b[sortKey];
    return vb - va;
  }));

  const COLUMNS: Array<{ key: SortKey; label: string }> = [
    { key: 'totalUsage', label: 'Usage' },
    { key: 'enabledGuilds', label: 'Allumé sur' },
    { key: 'usedGuilds', label: 'Utilisé sur' },
    { key: 'userDays', label: 'Membres-jours' },
    { key: 'avgExecutionMs', label: 'Latence moy.' },
    { key: 'errorRate', label: 'Erreurs' },
    { key: 'views', label: 'Vues dashboard' },
  ];
</script>

<div class="space-y-6">
  <p class="text-body-sm text-on-surface-variant">
    Usage = commandes, boutons, menus et modales du module, plus les appels suivis. Les serveurs qui ont coupé les analytics ne comptent que dans la performance.
  </p>

  {#if error}
    <p class="p-3 rounded-xl bg-error/10 border border-error/25 text-error text-sm font-semibold">{error}</p>
  {/if}

  {#if loading && !fleet}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {#each Array.from({ length: 4 }) as _, i (i)}
        <AdminStat label="…" value="" loading />
      {/each}
    </div>
  {:else if fleet}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <AdminStat label="Modules utilisés" value={`${totals.used} / ${totals.listed}`} icon="Box" hint="Au moins une utilisation sur la période" />
      <AdminStat label="Utilisations" value={fmtNumber(totals.usageSum)} icon="activity" tone="info" delta={totals.delta} />
      <AdminStat label="Latence moyenne" value={`${fmtNumber(totals.avgMs)} ms`} icon="Clock" tone="neutral" hint="Pondérée par le nombre d’exécutions" />
      <AdminStat label="Taux d’erreur" value={fmtPct(totals.errorRate)} icon="AlertTriangle" tone={totals.errorRate > 5 ? 'danger' : 'neutral'} />
    </div>

    <AdminCard title="Utilisations par jour" description="Tous modules confondus">
      <TrendChart
        dates={fleet.daily.map((d) => d.dateKey)}
        values={fleet.daily.map((d) => d.usage)}
        label="Utilisations"
        previousLabel=""
        format={(v) => fmtNumber(v)}
        height={220}
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

    <AdminCard title="Tous les modules" description="Clique sur un en-tête pour trier" padded={false}>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-outline-variant/20 text-xs font-semibold text-on-surface-variant">
              <th class="py-2.5 px-4">Module</th>
              {#each COLUMNS as col (col.key)}
                <th class="py-2.5 px-3 text-right" aria-sort={sortKey === col.key ? 'descending' : 'none'}>
                  <button
                    type="button"
                    class="hover:text-on-surface {sortKey === col.key ? 'text-on-surface' : ''}"
                    onclick={() => { sortKey = col.key; }}
                  >
                    {col.label}{sortKey === col.key ? ' ↓' : ''}
                  </button>
                </th>
              {/each}
              <th class="py-2.5 px-3 text-right">Tendance</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/15">
            {#each sorted as row (row.module)}
              {@const t = trend(row)}
              <tr class="hover:bg-surface-container-highest/30 transition">
                <td class="py-2.5 px-4">
                  <span class="font-semibold text-on-surface block">{label(row.module)}</span>
                  <span class="text-2xs font-mono text-on-surface-variant">{row.module}</span>
                </td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface" title={`${fmtNumber(row.commands)} commandes · ${fmtNumber(row.events)} interactions · ${fmtNumber(row.apiCalls)} appels`}>{fmtNumber(row.totalUsage)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{row.module === 'core' ? '–' : `${fmtNumber(row.enabledGuilds)} · ${fmtPct(row.activationRate)}`}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtNumber(row.usedGuilds)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{fmtNumber(row.userDays)}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant" title={row.maxExecutionMs > 0 ? `Max ${fmtNumber(row.maxExecutionMs)} ms` : ''}>{row.executions > 0 ? `${fmtNumber(row.avgExecutionMs)} ms` : '–'}</td>
                <td class="py-2.5 px-3 text-right font-mono {row.errorRate > 5 ? 'text-error' : 'text-on-surface-variant'}">{row.executions > 0 ? fmtPct(row.errorRate) : '–'}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{viewsByFeature.has(row.module) ? fmtNumber(viewsByFeature.get(row.module) ?? 0) : '–'}</td>
                <td class="py-2.5 px-3 text-right font-mono text-on-surface-variant">{row.totalUsage === 0 && row.previousUsage === 0 ? '–' : fmtTrend(t)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </AdminCard>
  {/if}
</div>
