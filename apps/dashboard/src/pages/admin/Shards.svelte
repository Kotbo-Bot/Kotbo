<script lang="ts">
  import { m } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchAdminShards, restartAdminShard, restartAllAdminShards, reconfigureAdminShards } from '../../lib/api';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import type { AdminTableColumn, AdminTone } from '../../lib/components/admin/types';
  import { Button, Field } from '../../lib/components/ui';

  import { errorMessage } from '@kotbo/shared';
  type ShardSnapshot = {
    shardId: number;
    status: 'online' | 'offline' | 'starting' | 'restarting';
    guildCount: number;
    memberCount: number;
    ping: number;
    uptime: number;
    readyAt: string | null;
    memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
  };

  type ShardingConfig = { mode: 'auto' | 'fixed'; shardCount: number | null };

  let shardState = $state<{ config: ShardingConfig; shards: ShardSnapshot[]; onlineShardCount: number } | null>(null);
  let shardLoading = $state(true);
  let shardActionLoading = $state('');
  let shardMode = $state<'auto' | 'fixed'>('auto');
  let shardCount = $state('');

  const shardRows = $derived(shardState?.shards ?? []);
  const shardConfiguredCount = $derived(
    shardState?.config.mode === 'fixed'
      ? (shardState?.config.shardCount ?? shardRows.length)
      : shardRows.length,
  );
  const shardAveragePing = $derived(
    shardRows.length > 0
      ? Math.round(shardRows.reduce((sum, shard) => sum + shard.ping, 0) / shardRows.length)
      : 0,
  );
  const maxShardGuildCount = $derived(
    shardRows.length > 0 ? Math.max(...shardRows.map((shard) => shard.guildCount)) : 0,
  );

  onMount(async () => { await refreshShards(); });

  function formatShardUptime(seconds: number) {
    if (!seconds || seconds <= 0) return '0m';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}j ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function shardStatusLabel(status: ShardSnapshot['status']) {
    if (status === 'online') return 'En ligne';
    if (status === 'starting') return 'Démarrage';
    if (status === 'restarting') return 'Redémarrage';
    return 'Hors ligne';
  }

  function shardStatusTone(status: ShardSnapshot['status']): AdminTone {
    if (status === 'online') return 'success';
    if (status === 'starting') return 'warning';
    if (status === 'restarting') return 'info';
    return 'danger';
  }

  const barTone: Record<AdminTone, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    info: 'bg-sky-500',
    danger: 'bg-error',
    primary: 'bg-primary',
    neutral: 'bg-on-surface-variant',
  };

  // Le squelette ne sert qu'au premier chargement : un rafraîchissement garde
  // les lignes affichées au lieu de faire clignoter le tableau.
  const initialLoading = $derived(shardLoading && !shardState);

  const columns: AdminTableColumn[] = [
    { key: 'shard', label: 'Shard' },
    { key: 'status', label: 'État' },
    { key: 'guilds', label: 'Serveurs', align: 'right' },
    { key: 'members', label: 'Membres', align: 'right', hideBelow: 'sm' },
    { key: 'ping', label: 'Ping', align: 'right' },
    { key: 'uptime', label: 'Uptime', align: 'right', hideBelow: 'md' },
    { key: 'actions', label: '', align: 'right', width: 'w-32' },
  ];

  async function refreshShards() {
    try {
      shardLoading = true;
      const data = await fetchAdminShards();
      shardState = {
        config: data.config ?? { mode: 'auto', shardCount: null },
        shards: data.shards ?? [],
        onlineShardCount: data.onlineShardCount ?? 0,
      };
      shardMode = shardState.config.mode;
      shardCount = shardState.config.shardCount ? String(shardState.config.shardCount) : '';
    } catch (err) {
      toast.error(errorMessage(err) || m.ashd_load_error());
    } finally {
      shardLoading = false;
    }
  }

  async function handleRestartShard(shardId: number) {
    if (!(await confirmDialog.ask({ title: `Redémarrer le shard ${shardId} ?`, confirmLabel: 'Redémarrer', variant: 'warning' }))) return;
    try {
      shardActionLoading = `restart:${shardId}`;
      await restartAdminShard(shardId);
      toast.success(m.ashd_restarted({ id: shardId }));
      await refreshShards();
    } catch (err) {
      toast.error(errorMessage(err) || m.ashd_restart_error());
    } finally {
      shardActionLoading = '';
    }
  }

  async function handleRestartAllShards() {
    if (!(await confirmDialog.ask({ title: 'Redémarrer tous les shards ?', description: 'Le bot sera brièvement indisponible sur tous les serveurs.', confirmLabel: 'Tout redémarrer', variant: 'warning' }))) return;
    try {
      shardActionLoading = 'restart-all';
      await restartAllAdminShards();
      toast.success(m.ashd_restart_all());
      await refreshShards();
    } catch (err) {
      toast.error(errorMessage(err) || m.ashd_restart_all_error());
    } finally {
      shardActionLoading = '';
    }
  }

  async function handleReconfigureShards() {
    const payload = {
      mode: shardMode,
      shardCount: shardMode === 'fixed' ? Number(shardCount) : null,
    };
    if (payload.mode === 'fixed' && (!Number.isInteger(payload.shardCount) || (payload.shardCount ?? 0) < 1)) {
      toast.error(m.ashd_count_invalid());
      return;
    }
    try {
      shardActionLoading = 'reconfigure';
      await reconfigureAdminShards(payload);
      toast.success(m.ashd_config_saved());
    } catch (err) {
      toast.error(errorMessage(err) || m.ashd_reconfigure_error());
    } finally {
      shardActionLoading = '';
    }
  }
</script>

<AdminShell title="Shards" description="Répartition des serveurs sur les shards Discord, latence et redémarrages contrôlés.">
  {#snippet actions()}
    <Button icon="RefreshCw" loading={shardLoading} onclick={refreshShards}>Rafraîchir</Button>
    <Button variant="danger" icon="Power" loading={shardActionLoading === 'restart-all'} onclick={handleRestartAllShards}>
      Redémarrer tout
    </Button>
  {/snippet}

  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
    <AdminStat label="Shards" value={shardConfiguredCount} hint="mode {shardState?.config.mode === 'fixed' ? 'fixe' : 'automatique'}" icon="Zap" tone="primary" loading={initialLoading} />
    <AdminStat
      label="En ligne"
      value="{shardState?.onlineShardCount ?? 0}/{shardConfiguredCount}"
      icon="CheckCircle"
      tone={(shardState?.onlineShardCount ?? 0) === shardConfiguredCount ? 'success' : 'danger'}
      loading={initialLoading}
    />
    <AdminStat
      label="Ping moyen"
      value="{shardAveragePing} ms"
      icon="activity"
      tone={shardAveragePing > 250 ? 'danger' : shardAveragePing > 130 ? 'warning' : 'success'}
      loading={initialLoading}
    />
  </div>

  <div class="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
    <AdminCard title="Configuration" description="Mode de sharding" icon="Settings" tone="primary">
      <form class="space-y-4" onsubmit={(e) => { e.preventDefault(); void handleReconfigureShards(); }}>
        <Field label="Mode de sharding">
          {#snippet children(id)}
            <select {id} bind:value={shardMode} class="input">
              <option value="auto">Automatique</option>
              <option value="fixed">Fixe</option>
            </select>
          {/snippet}
        </Field>
        <Field label="Nombre de shards" hint={shardMode === 'fixed' ? '' : 'Discord décide du nombre en mode automatique.'}>
          {#snippet children(id, describedBy)}
            <input
              {id}
              aria-describedby={describedBy}
              type="number"
              min="1"
              bind:value={shardCount}
              placeholder="Auto si vide"
              disabled={shardMode !== 'fixed'}
              class="input"
            />
          {/snippet}
        </Field>
        <Button type="submit" variant="primary" fullWidth loading={shardActionLoading === 'reconfigure'}>Appliquer</Button>
      </form>
    </AdminCard>

    <div class="xl:col-span-2 space-y-4">
      {#if shardRows.length > 1}
        <AdminCard title="Serveurs par shard" icon="Server" tone="neutral">
          <div class="flex items-end gap-2 h-24">
            {#each shardRows as shard (shard.shardId)}
              <div class="flex-1 flex flex-col items-center gap-1.5 min-w-0" title="Shard {shard.shardId} · {shard.guildCount} serveurs">
                <div class="w-full relative h-20">
                  <div
                    class="absolute bottom-0 w-full rounded-t-md transition-all duration-700 {barTone[shardStatusTone(shard.status)]}"
                    style="height: {maxShardGuildCount > 0 ? Math.max(6, (shard.guildCount / maxShardGuildCount) * 100) : 6}%"
                  ></div>
                </div>
                <p class="text-2xs font-semibold text-on-surface-variant tabular-nums truncate w-full text-center">#{shard.shardId}</p>
              </div>
            {/each}
          </div>
        </AdminCard>
      {/if}

      <AdminTable
        {columns}
        rows={shardRows}
        loading={initialLoading}
        skeletonRows={2}
        emptyIcon="Zap"
        emptyTitle="Aucun shard disponible"
        emptyHint="Le gestionnaire de shards n’a rien remonté. Rafraîchis dans quelques secondes."
      >
        {#snippet row(entry, _index)}
          {@const shard = entry as ShardSnapshot}
          <tr class="border-b border-outline-variant/12 hover:bg-on-surface/3 transition-colors">
            <td class="px-4 py-3">
              <p class="text-body-sm font-semibold text-on-surface tabular-nums">#{shard.shardId}</p>
              <p class="text-2xs font-mono text-on-surface-variant">
                {shard.readyAt ? new Date(shard.readyAt).toLocaleTimeString('fr-FR') : '-'}
              </p>
            </td>
            <td class="px-4 py-3">
              <AdminBadge
                label={shardStatusLabel(shard.status)}
                tone={shardStatusTone(shard.status)}
                dot
                pulse={shard.status === 'starting' || shard.status === 'restarting'}
              />
            </td>
            <td class="px-4 py-3 text-right text-body-sm font-semibold text-on-surface tabular-nums">{shard.guildCount.toLocaleString('fr-FR')}</td>
            <td class="px-4 py-3 text-right text-body-sm text-on-surface tabular-nums hidden sm:table-cell">{shard.memberCount.toLocaleString('fr-FR')}</td>
            <td class="px-4 py-3 text-right">
              <span class="text-body-sm font-semibold font-mono tabular-nums {shard.ping > 250 ? 'text-error' : shard.ping > 130 ? 'text-warning' : 'text-success'}">
                {shard.ping} ms
              </span>
            </td>
            <td class="px-4 py-3 text-right text-body-sm text-on-surface-variant tabular-nums hidden md:table-cell">{formatShardUptime(shard.uptime)}</td>
            <td class="px-4 py-3 text-right">
              <Button size="sm" icon="RefreshCw" loading={shardActionLoading === `restart:${shard.shardId}`} onclick={() => handleRestartShard(shard.shardId)}>
                Redémarrer
              </Button>
            </td>
          </tr>
        {/snippet}
      </AdminTable>
    </div>
  </div>
</AdminShell>
