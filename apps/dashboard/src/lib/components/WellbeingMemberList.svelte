<script lang="ts">
  /**
   * Liste de membres désignés un par un dans la cellule de suivi : équipe,
   * direction, destinataires des alertes. Contrairement à un rôle Discord,
   * personne d'autre que le propriétaire ne peut la modifier.
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
  }: { ids: string[]; max: number; id: string; describedBy?: string } = $props();

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
      <div class="flex-1"><MemberSearchSelect {id} {describedBy} bind:value={candidate} placeholder={m.wb_member_ph()} /></div>
      <Button size="sm" variant="secondary" disabled={!candidate} onclick={add}>{m.wb_alerts_add_user()}</Button>
    </div>
  {/if}
</div>
