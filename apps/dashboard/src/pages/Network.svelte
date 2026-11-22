<script lang="ts">
  /**
   * Réseau de serveurs : regroupe plusieurs serveurs publics sous un serveur
   * principal qui porte les données partagées (voir `networkScope.ts` côté bot).
   *
   * Chaque serveur du réseau garde son propre abonnement : 5 serveurs, c'est
   * 5 offres Plus. L'API refuse le rattachement d'un serveur sans offre payante.
   */
  import { onMount } from 'svelte';
  import { dashboardFetch } from '../lib/api/client';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import { m } from '../lib/i18n';

  let network = $state<{
    id: string;
    name: string;
    planKey: string;
    maxGuilds: number;
    billingStatus: string;
    members: Array<{ guildId: string; name: string; iconUrl: string | null; role: string }>;
  } | null>(null);
  let networkName = $state('');
  let linkGuildId = $state('');
  let networkBusy = $state(false);

  const linkableGuilds = $derived(
    authStore.guilds.filter(
      (g) => !network?.members.some((m) => m.guildId === g.id),
    ),
  );

  async function loadNetwork() {
    try {
      const res = await dashboardFetch('/billing/network');
      if (res.ok) {
        const data = await res.json();
        network = data.network;
        if (network?.name) networkName = network.name;
      }
    } catch { /* ignored */ }
  }

  async function createOrRenameNetwork(event: SubmitEvent) {
    event.preventDefault();
    if (networkBusy) return;
    networkBusy = true;
    try {
      const res = await dashboardFetch('/billing/network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: networkName.trim() || 'Réseau multi-serveurs' }),
      });
      if (!res.ok) throw new Error('network');
      toast.success('Réseau enregistré');
      await loadNetwork();
    } catch {
      toast.error('Impossible de créer le réseau.');
    } finally {
      networkBusy = false;
    }
  }

  async function linkGuildToNetwork() {
    if (!linkGuildId || networkBusy) return;
    networkBusy = true;
    try {
      const res = await dashboardFetch('/billing/network/guilds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetGuildId: linkGuildId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'link');
      linkGuildId = '';
      toast.success('Serveur rattaché au réseau');
      await loadNetwork();
    } catch (err: any) {
      toast.error(err?.message || 'Impossible de rattacher ce serveur.');
    } finally {
      networkBusy = false;
    }
  }

  async function unlinkGuildFromNetwork(targetGuildId: string) {
    if (networkBusy) return;
    networkBusy = true;
    try {
      const res = await dashboardFetch(`/billing/network/guilds/${targetGuildId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('unlink');
      toast.success('Serveur retiré du réseau');
      await loadNetwork();
    } catch {
      toast.error('Impossible de retirer ce serveur.');
    } finally {
      networkBusy = false;
    }
  }

  onMount(() => {
    void loadNetwork();
  });
</script>

<div class="pb-24 space-y-6">
  <header class="max-w-2xl mx-auto w-full space-y-1">
    <h1 class="text-2xl font-semibold tracking-tight text-on-surface font-headline leading-tight">{m.nav_network()}</h1>
    <p class="text-body-sm text-on-surface-variant">
      Regroupez jusqu'à {network?.maxGuilds ?? 5} serveurs sous un même réseau : ils partagent leurs données.
      Chaque serveur garde son abonnement Plus (5 serveurs = 5 abonnements).
    </p>
  </header>

  <section class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-5 space-y-4 max-w-2xl mx-auto w-full">
    {#if network}
      <div class="flex justify-end">
        <span class="px-2.5 py-0.5 rounded-full text-2xs font-semibold bg-primary/15 text-primary">
          {network.members.length}/{network.maxGuilds} serveurs
        </span>
      </div>
    {/if}

    {#if !network}
      <form onsubmit={createOrRenameNetwork} class="flex flex-wrap gap-2">
        <input bind:value={networkName} placeholder="Nom de l'association ou du réseau" class="input flex-1 text-sm" required />
        <Button type="submit" size="sm" variant="primary" loading={networkBusy}>Créer le regroupement</Button>
      </form>
    {:else}
      <div class="divide-y divide-outline-variant rounded-lg border border-outline-variant overflow-hidden bg-surface-container-lowest">
        {#each network.members as member (member.guildId)}
          <div class="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm">
            <div class="flex items-center gap-2.5 min-w-0">
              {#if member.iconUrl}
                <img src={member.iconUrl} alt="" class="w-6 h-6 rounded-md object-cover" />
              {/if}
              <span class="font-medium text-on-surface truncate">{member.name}</span>
              <span class="text-2xs px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant">
                {member.role === 'PRIMARY' ? 'Principal' : 'Rattaché'}
              </span>
            </div>
            {#if member.role !== 'PRIMARY'}
              <button
                type="button"
                disabled={networkBusy}
                onclick={() => void unlinkGuildFromNetwork(member.guildId)}
                class="text-xs text-error hover:underline"
              >
                Retirer
              </button>
            {/if}
          </div>
        {/each}
      </div>

      {#if network.members.length < network.maxGuilds && linkableGuilds.length > 0}
        <div class="flex flex-wrap gap-2">
          <select bind:value={linkGuildId} class="input flex-1 text-sm">
            <option value="">Sélectionner un autre serveur à rattacher…</option>
            {#each linkableGuilds as g (g.id)}
              <option value={g.id}>{g.name}</option>
            {/each}
          </select>
          <Button size="sm" variant="secondary" disabled={!linkGuildId || networkBusy} onclick={() => void linkGuildToNetwork()}>
            Rattacher
          </Button>
        </div>
      {/if}
    {/if}
  </section>
</div>
