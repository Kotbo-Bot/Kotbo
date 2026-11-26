<!--
  Référent du réseau d'un dossier : un membre de la cellule d'un autre
  serveur du réseau, qui lit et annote ce dossier depuis son propre serveur.
  Rien n'est affiché hors réseau, ou tant que la cellule ne partage pas.
-->
<script lang="ts">
  import { dashboardFetch } from '../../api';
  import { m } from '../../i18n';
  import { toast } from '../../stores/toast.svelte';
  import Papicon from '../Papicon.svelte';
  import { Button } from '../ui';

  type PoolEntry = { userId: string; guildId: string; name: string; guildName: string; active: number };

  const {
    caseId,
    subjectUserId,
    referentId,
    referentGuildId,
    canWrite,
    onchange,
  }: {
    caseId: string;
    subjectUserId: string | null;
    referentId: string | null;
    referentGuildId: string | null;
    canWrite: boolean;
    onchange: (item: any) => void;
  } = $props();

  let available = $state(false);
  let candidates = $state<PoolEntry[]>([]);
  let choice = $state('');
  let saving = $state(false);

  const keyOf = (entry: { userId: string; guildId: string }) => `${entry.guildId}:${entry.userId}`;
  const current = $derived(candidates.find((entry) => entry.userId === referentId && entry.guildId === referentGuildId) ?? null);

  $effect(() => {
    const query = subjectUserId ? `?subjectUserId=${encodeURIComponent(subjectUserId)}` : '';
    void caseId;
    void (async () => {
      const res = await dashboardFetch(`/wellbeing/network/pool${query}`).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      available = data?.available === true;
      candidates = data?.candidates ?? [];
    })();
  });

  async function save(entry: PoolEntry | null) {
    if (saving) return;
    saving = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/network-referent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry ? { userId: entry.userId, guildId: entry.guildId } : { userId: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      onchange(data.item);
      choice = '';
      toast.success(entry ? m.toast_wb_network_referent_set() : m.toast_wb_network_referent_cleared());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      saving = false;
    }
  }
</script>

{#if available || referentId}
  <div class="rounded-xl border border-outline-variant/40 p-4 space-y-2">
    <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Globe" size={15} /> {m.wb_network_referent_title()}</h3>
    <p class="text-xs text-on-surface-variant">{m.wb_network_referent_desc()}</p>
    {#if referentId}
      <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
        {#if current}
          <span><span class="font-semibold text-on-surface">{current.name}</span> <span class="text-xs text-on-surface-variant">· {current.guildName}</span></span>
        {:else}
          <span class="text-on-surface-variant">{m.wb_network_referent_suspended()}</span>
        {/if}
        {#if canWrite}
          <Button size="sm" variant="ghost" icon="X" loading={saving} onclick={() => void save(null)}>{m.wb_network_referent_clear()}</Button>
        {/if}
      </div>
    {:else if canWrite && candidates.length > 0}
      <div class="flex flex-wrap items-center gap-2">
        <label for="wb-network-referent" class="sr-only">{m.wb_network_referent_title()}</label>
        <select id="wb-network-referent" class="input flex-1 min-w-48" bind:value={choice}>
          <option value="">{m.wb_network_referent_ph()}</option>
          {#each candidates as entry (keyOf(entry))}
            <option value={keyOf(entry)}>{m.wb_network_referent_option({ name: entry.name, guild: entry.guildName, count: entry.active })}</option>
          {/each}
        </select>
        <Button size="sm" variant="secondary" icon="UserPlus" disabled={!choice} loading={saving}
          onclick={() => void save(candidates.find((entry) => keyOf(entry) === choice) ?? null)}>{m.wb_network_referent_assign()}</Button>
      </div>
    {:else if canWrite}
      <p class="text-sm text-on-surface-variant">{m.wb_network_referent_none()}</p>
    {/if}
  </div>
{/if}
