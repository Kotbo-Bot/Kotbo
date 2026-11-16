<!-- Tag de serveur en pastille, comme Discord l'affiche à côté du pseudo. -->
<script lang="ts">
  import Papicon from './Papicon.svelte';

  const { tag, badgeUrl = null }: { tag: string; badgeUrl?: string | null } = $props();
</script>

<span class="badge badge-neutral shrink-0">
  {#if badgeUrl}
    <img src={badgeUrl} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
  {:else}
    <Papicon icon="tag" size={11} />
  {/if}
  <span>{tag}</span>
</span>
