<script lang="ts">
  /**
   * Doubles comptes, tous serveurs confondus.
   *
   * Les liens sont posés serveur par serveur ; cette vue les fusionne en groupes
   * (A lié à B, B lié à C → un groupe de trois comptes) pour repérer d'un coup
   * d'œil les personnes qui jouent avec plusieurs comptes.
   */
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { fetchAdminLinkedGroups, type LinkedGroup } from '../../lib/api';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import MetricTabs from '../../lib/components/analytics/MetricTabs.svelte';
  import UserDisplay from '../../lib/components/UserDisplay.svelte';
  import { SERIES, fmtNumber } from '../../lib/components/analytics/analyticsFormat';
  import { Button, EmptyState, FilterPills } from '../../lib/components/ui';

  const PAGE = 30;

  let groups = $state<LinkedGroup[]>([]);
  let total = $state(0);
  let totalAccounts = $state(0);
  let truncated = $state(false);
  let loading = $state(true);
  let loadingMore = $state(false);

  let search = $state('');
  let status = $state('ALL');
  let minAccounts = $state('2');

  let selected = $state<LinkedGroup | null>(null);
  let detailOpen = $state(false);

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const query = (offset: number) => ({
    search: search.trim() || undefined,
    status: status === 'ALL' ? undefined : (status as 'VALIDATED' | 'PENDING'),
    minAccounts: Number(minAccounts),
    offset,
    limit: PAGE,
  });

  async function load() {
    loading = true;
    try {
      const result = await fetchAdminLinkedGroups(query(0));
      groups = result.groups;
      total = result.total;
      totalAccounts = result.totalAccounts;
      truncated = result.truncated;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Chargement impossible.');
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    try {
      const result = await fetchAdminLinkedGroups(query(groups.length));
      groups = [...groups, ...result.groups];
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Chargement impossible.');
    } finally {
      loadingMore = false;
    }
  }

  onMount(load);

  // Filtrage côté serveur : on temporise la frappe.
  let firstRun = true;
  $effect(() => {
    void search;
    if (firstRun) { firstRun = false; return; }
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void load(), 350);
    return () => { if (searchTimer) clearTimeout(searchTimer); };
  });

  const biggest = $derived(groups.reduce((max, g) => Math.max(max, g.accounts.length), 0));
  const multiGuild = $derived(groups.filter((g) => g.guildCount > 1).length);

  function open(group: LinkedGroup) {
    selected = group;
    detailOpen = true;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  const nameOf = (group: LinkedGroup, userId: string) => {
    const account = group.accounts.find((a) => a.userId === userId);
    return account?.name ?? account?.username ?? userId;
  };
</script>

<AdminShell
  title="Doubles comptes"
  description="Comptes liés entre eux sur l’ensemble des serveurs, regroupés de proche en proche."
>
  {#snippet actions()}
    <Button icon="RefreshCw" {loading} onclick={load}>Actualiser</Button>
  {/snippet}

  <MetricTabs
    interactive={false}
    active=""
    onchange={() => {}}
    label="Indicateurs des doubles comptes"
    metrics={[
      { id: 'groups', label: 'Groupes', value: fmtNumber(total), color: SERIES[0] },
      { id: 'accounts', label: 'Comptes concernés', value: fmtNumber(totalAccounts), color: SERIES[1] },
      { id: 'biggest', label: 'Plus gros groupe (page)', value: fmtNumber(biggest), color: SERIES[3] },
      { id: 'multi', label: 'Sur plusieurs serveurs (page)', value: fmtNumber(multiGuild), color: SERIES[2] },
    ]}
  />

  <AdminToolbar bind:search placeholder="Rechercher un pseudo, un tag ou un ID Discord…">
    {#snippet actions()}
      <FilterPills
        label="Statut"
        value={status}
        onchange={(v) => { status = v; void load(); }}
        options={[
          { value: 'ALL', label: 'Tous' },
          { value: 'VALIDATED', label: 'Validés' },
          { value: 'PENDING', label: 'À valider' },
        ]}
      />
      <FilterPills
        label="Taille"
        value={minAccounts}
        onchange={(v) => { minAccounts = v; void load(); }}
        options={[
          { value: '2', label: '2+' },
          { value: '3', label: '3+' },
          { value: '5', label: '5+' },
        ]}
      />
    {/snippet}
  </AdminToolbar>

  {#if truncated}
    <p class="text-xs text-on-surface-variant">
      La table dépasse le volume chargé : seuls les liens les plus récents sont analysés, certains groupes peuvent être incomplets.
    </p>
  {/if}

  {#if loading}
    <div class="space-y-2">
      {#each Array(6) as _, index (index)}
        <div class="h-20 rounded-2xl bg-on-surface/6 animate-pulse"></div>
      {/each}
    </div>
  {:else if groups.length === 0}
    <EmptyState
      icon="Users"
      title="Aucun groupe"
      description="Aucun compte lié ne correspond à ces filtres. Les liens écartés par le staff (faux positifs) ne sont pas comptés."
      reason="nothing-matches"
    />
  {:else}
    <ul class="space-y-2">
      {#each groups as group (group.id)}
        <li>
          <button
            type="button"
            onclick={() => open(group)}
            class="w-full text-left rounded-xl border border-outline-variant/25 bg-surface-container-lowest/70 p-3.5 flex flex-wrap items-center gap-x-6 gap-y-3
              hover:border-primary/35 hover:bg-surface-container-low/60 transition focus-visible:outline-2 focus-visible:outline-primary"
          >
            <div class="flex flex-wrap gap-x-5 gap-y-2 min-w-0 flex-1">
              {#each group.accounts as account (account.userId)}
                <UserDisplay
                  userId={account.userId}
                  name={account.name}
                  username={account.username}
                  avatarUrl={account.avatarUrl}
                  size="sm"
                />
              {/each}
            </div>
            <div class="flex flex-wrap items-center gap-1.5 shrink-0">
              <AdminBadge size="sm" label="{group.accounts.length} comptes" tone="primary" />
              <AdminBadge size="sm" label="{group.guildCount} serveur{group.guildCount > 1 ? 's' : ''}" tone="neutral" />
              {#if group.validatedCount < group.links.length}
                <AdminBadge size="sm" label="À valider" tone="warning" />
              {/if}
              <span class="text-2xs text-on-surface-variant tabular-nums">{formatDate(group.lastLinkedAt)}</span>
            </div>
          </button>
        </li>
      {/each}
    </ul>

    {#if groups.length < total}
      <button
        type="button"
        onclick={loadMore}
        disabled={loadingMore}
        class="w-full h-11 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-body-sm font-semibold text-on-surface-variant hover:text-on-surface transition disabled:opacity-50"
      >
        {loadingMore ? 'Chargement…' : `Charger plus de groupes (${groups.length}/${total})`}
      </button>
    {/if}
  {/if}
</AdminShell>

<AdminDrawer bind:open={detailOpen} width="sm" title="Groupe de comptes" subtitle={selected ? `${selected.accounts.length} comptes · ${selected.guildCount} serveur${selected.guildCount > 1 ? 's' : ''}` : ''}>
  {#if selected}
    {@const group = selected}
    <div class="space-y-5">
      <div class="space-y-2.5">
        <p class="text-xs font-semibold text-on-surface-variant">Comptes</p>
        {#each group.accounts as account (account.userId)}
          <div class="flex items-center justify-between gap-3">
            <UserDisplay
              userId={account.userId}
              name={account.name}
              username={account.username}
              avatarUrl={account.avatarUrl}
              handle
              size="sm"
            />
            <span class="text-2xs text-on-surface-variant shrink-0">
              {account.guildCount} serveur{account.guildCount > 1 ? 's' : ''}
            </span>
          </div>
          <p class="text-2xs font-mono text-on-surface-variant -mt-1.5">{account.userId}</p>
        {/each}
      </div>

      <div class="space-y-2">
        <p class="text-xs font-semibold text-on-surface-variant">Liens ({group.links.length})</p>
        {#each group.links as link (`${link.guildId}-${link.user1Id}-${link.user2Id}`)}
          <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3 space-y-1.5">
            <p class="text-body-sm text-on-surface">
              {nameOf(group, link.user1Id)} <span class="text-on-surface-variant">↔</span> {nameOf(group, link.user2Id)}
            </p>
            <div class="flex flex-wrap items-center gap-1.5">
              <AdminBadge size="sm" label={link.guildName} tone="neutral" />
              <AdminBadge size="sm" label={link.type === 'MANUAL' ? 'Manuel' : 'Détection'} tone={link.type === 'MANUAL' ? 'primary' : 'info'} />
              <AdminBadge size="sm" label={link.status === 'VALIDATED' ? 'Validé' : 'À valider'} tone={link.status === 'VALIDATED' ? 'success' : 'warning'} />
              <span class="text-2xs text-on-surface-variant tabular-nums">{formatDate(link.createdAt)}</span>
            </div>
            {#if link.reason}
              <p class="text-xs text-on-surface-variant leading-snug">{link.reason}</p>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</AdminDrawer>
