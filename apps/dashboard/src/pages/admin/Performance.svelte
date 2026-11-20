<script lang="ts">
  /**
   * Profil des requetes a la base : lesquelles pesent le plus depuis le
   * demarrage du bot. Le tri par defaut porte sur le temps cumule, car une
   * requete rapide appelee cent mille fois coute plus qu'un rapport lent.
   */
  import { onMount } from 'svelte';
  import { errorMessage } from '@kotbo/shared';
  import { fetchQueryStats, type QueryStats } from '../../lib/api/adminInsights';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import { formatCompact, formatNumber, formatPercent } from '../../lib/components/admin/format';
  import { Button, Callout } from '../../lib/components/ui';

  type Entry = QueryStats['entries'][number];

  let data = $state<QueryStats | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let search = $state('');
  let filter = $state('ALL');
  let sortKey = $state('totalMs');
  let sortDir = $state<'asc' | 'desc'>('desc');

  async function load() {
    loading = true;
    try {
      data = await fetchQueryStats(200);
      error = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const entries = $derived(data?.entries ?? []);
  const totalCount = $derived(entries.reduce((sum, entry) => sum + entry.count, 0));
  const totalMs = $derived(entries.reduce((sum, entry) => sum + entry.totalMs, 0));
  const slowCount = $derived(entries.reduce((sum, entry) => sum + entry.slowCount, 0));
  const errorCount = $derived(entries.reduce((sum, entry) => sum + entry.errorCount, 0));

  const rows = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    const list = entries.filter((entry) => {
      if (filter === 'SLOW' && entry.slowCount === 0) return false;
      if (filter === 'ERROR' && entry.errorCount === 0) return false;
      return entry.key.toLowerCase().includes(needle);
    });
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const left = a[sortKey as keyof Entry];
      const right = b[sortKey as keyof Entry];
      return (typeof left === 'string' ? left.localeCompare(String(right)) : Number(left) - Number(right)) * direction;
    });
  });

  function formatMs(value: number): string {
    if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
    return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
  }

  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return days > 0 ? `${days} j ${hours} h` : `${hours} h ${Math.floor((seconds % 3600) / 60)} min`;
  }

  const columns: AdminTableColumn[] = [
    { key: 'key', label: 'Requête', sortKey: 'key' },
    { key: 'totalMs', label: 'Temps cumulé', sortKey: 'totalMs', align: 'right' },
    { key: 'count', label: 'Appels', sortKey: 'count', align: 'right' },
    { key: 'avgMs', label: 'Moyenne', sortKey: 'avgMs', align: 'right', hideBelow: 'sm' },
    { key: 'maxMs', label: 'Pire cas', sortKey: 'maxMs', align: 'right', hideBelow: 'md' },
    { key: 'slowCount', label: 'Lentes', sortKey: 'slowCount', align: 'right', hideBelow: 'md' },
    { key: 'errorCount', label: 'Erreurs', sortKey: 'errorCount', align: 'right', hideBelow: 'lg' },
  ];
</script>

<AdminShell title="Performances" description="Les requêtes à la base qui pèsent le plus depuis le dernier démarrage du bot.">
  {#snippet actions()}
    {#if data}
      <AdminBadge label={data.readReplicaConfigured ? 'Réplica de lecture actif' : 'Sans réplica de lecture'} tone={data.readReplicaConfigured ? 'success' : 'neutral'} dot />
    {/if}
    <Button icon="RefreshCw" {loading} onclick={load}>Actualiser</Button>
  {/snippet}

  {#if error}
    <Callout variant="danger">{error}</Callout>
  {/if}

  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    <AdminStat label="Requêtes" value={data ? formatCompact(totalCount) : '–'} hint={data ? `depuis ${formatUptime(data.uptimeSeconds)}` : ''} icon="Database" tone="primary" loading={loading && !data} />
    <AdminStat label="Temps passé en base" value={data ? formatMs(totalMs) : '–'} hint={data && totalCount > 0 ? `${formatMs(totalMs / totalCount)} en moyenne` : ''} icon="Clock" tone="info" loading={loading && !data} />
    <AdminStat label="Requêtes lentes" value={data ? formatNumber(slowCount) : '–'} hint={data ? formatPercent(slowCount, totalCount, 2) : ''} icon="AlertTriangle" tone={slowCount > 0 ? 'warning' : 'success'} loading={loading && !data} />
    <AdminStat label="Erreurs" value={data ? formatNumber(errorCount) : '–'} icon="AlertOctagon" tone={errorCount > 0 ? 'danger' : 'success'} loading={loading && !data} />
  </div>

  <AdminToolbar
    bind:search
    bind:activeFilter={filter}
    placeholder="Rechercher un modèle ou une opération (guild.findUnique)…"
    filters={[
      { value: 'ALL', label: 'Toutes', count: entries.length },
      { value: 'SLOW', label: 'Lentes', count: entries.filter((entry) => entry.slowCount > 0).length },
      { value: 'ERROR', label: 'En erreur', count: entries.filter((entry) => entry.errorCount > 0).length },
    ]}
    resultCount={rows.length}
    resultLabel="requête"
  />

  <AdminTable
    {columns}
    {rows}
    loading={loading && !data}
    bind:sortKey
    bind:sortDir
    emptyIcon="Database"
    emptyTitle={entries.length === 0 ? 'Aucune requête mesurée' : 'Aucune requête ne correspond'}
    emptyHint={entries.length === 0 ? 'Le profil se remplit dès les premières requêtes après le démarrage.' : 'Élargis la recherche ou change de filtre.'}
  >
    {#snippet row(item, _index)}
      {@const entry = item as Entry}
      <tr class="border-b border-outline-variant/60 hover:bg-on-surface/3 transition-colors">
        <td class="px-4 py-3">
          <p class="text-sm font-semibold font-mono text-on-surface">{entry.key}</p>
          <span class="block h-1 mt-1.5 rounded-full bg-surface-container overflow-hidden max-w-48">
            <span class="block h-full rounded-full bg-primary" style="width: {totalMs > 0 ? Math.max(2, (entry.totalMs / totalMs) * 100) : 0}%"></span>
          </span>
        </td>
        <td class="px-4 py-3 text-right text-sm font-semibold tabular-nums">{formatMs(entry.totalMs)}</td>
        <td class="px-4 py-3 text-right text-sm tabular-nums">{formatCompact(entry.count)}</td>
        <td class="px-4 py-3 text-right text-sm tabular-nums hidden sm:table-cell">{formatMs(entry.avgMs)}</td>
        <td class="px-4 py-3 text-right text-sm tabular-nums hidden md:table-cell">{formatMs(entry.maxMs)}</td>
        <td class="px-4 py-3 text-right text-sm tabular-nums hidden md:table-cell {entry.slowCount > 0 ? 'text-warning font-semibold' : 'text-on-surface-variant'}">{formatNumber(entry.slowCount)}</td>
        <td class="px-4 py-3 text-right text-sm tabular-nums hidden lg:table-cell {entry.errorCount > 0 ? 'text-error font-semibold' : 'text-on-surface-variant'}">{formatNumber(entry.errorCount)}</td>
      </tr>
    {/snippet}
  </AdminTable>
</AdminShell>
