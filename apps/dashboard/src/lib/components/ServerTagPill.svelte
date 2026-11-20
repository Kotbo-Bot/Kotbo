<!-- Tag de serveur en pastille, comme Discord l'affiche à côté du pseudo. Avec `onclick`, la pastille devient un bouton. -->
<script lang="ts">
  import Papicon from './Papicon.svelte';

  const {
    tag,
    badgeUrl = null,
    onclick = null,
  }: { tag: string; badgeUrl?: string | null; onclick?: (() => void) | null } = $props();
</script>

{#snippet content()}
  {#if badgeUrl}
    <img src={badgeUrl} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
  {:else}
    <Papicon icon="tag" size={11} />
  {/if}
  <span>{tag}</span>
{/snippet}

{#if onclick}
  <button
    type="button"
    {onclick}
    title="Voir le serveur du tag {tag}"
    class="badge badge-neutral shrink-0 transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
  >
    {@render content()}
  </button>
{:else}
  <span class="badge badge-neutral shrink-0">
    {@render content()}
  </span>
{/if}
