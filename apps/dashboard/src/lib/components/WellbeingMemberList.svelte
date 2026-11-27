<script lang="ts">
  /**
   * Liste de membres désignés un par un dans la cellule de suivi : équipe,
   * direction, destinataires des alertes. Contrairement à un rôle Discord,
   * personne d'autre que le propriétaire ne peut la modifier.
   *
   * Avec `candidates`, le choix se limite à ces membres (les collègues de la
   * cellule à prévenir, par exemple) au lieu de tout le serveur.
   */
  import MemberName from './MemberName.svelte';
  import MemberSearchSelect from './MemberSearchSelect.svelte';
  import { Button } from './ui';
  import { m } from '../i18n';

  let {
    ids = $bindable([]),
    max,
    id,
    describedBy = undefined,
    candidates = undefined,
  }: {
    ids: string[];
    max: number;
    id: string;
    describedBy?: string;
    candidates?: ReadonlyArray<{ id: string; name: string }>;
  } = $props();

  const remaining = $derived(candidates?.filter((member) => !ids.includes(member.id)) ?? []);

  let candidate = $state('');

  function add() {
    if (candidate && !ids.includes(candidate) && ids.length < max) ids = [...ids, candidate];
    candidate = '';
  }
</script>

<div class="space-y-2">
  {#if ids.length > 0}
    <ul class="flex flex-wrap gap-2">
      {#each ids as userId (userId)}
        <li class="flex items-center gap-1 rounded-md bg-surface-container px-2 py-1 text-xs">
          <MemberName {userId} />
          <button type="button" class="text-on-surface-variant hover:text-error"
            aria-label={m.wb_alerts_remove_user({ name: userId })}
            onclick={() => (ids = ids.filter((u) => u !== userId))}>×</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if ids.length < max}
    <div class="flex gap-2">
      <div class="flex-1">
        {#if candidates}
          <select {id} aria-describedby={describedBy} class="input w-full" bind:value={candidate} disabled={remaining.length === 0}>
            <option value="">{remaining.length > 0 ? m.wb_member_pick() : m.wb_member_pick_none()}</option>
            {#each remaining as member (member.id)}
              <option value={member.id}>{member.name}</option>
            {/each}
          </select>
        {:else}
          <MemberSearchSelect {id} {describedBy} bind:value={candidate} placeholder={m.wb_member_ph()} />
        {/if}
      </div>
      <Button size="sm" variant="secondary" disabled={!candidate} onclick={add}>{m.wb_alerts_add_user()}</Button>
    </div>
  {/if}
</div>
