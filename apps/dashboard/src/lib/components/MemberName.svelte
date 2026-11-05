<!--
  Pseudo seul, cliquable vers la fiche membre, pour les listes qui affichent l'avatar à
  part. Sans accès à « Membres », le pseudo reste un simple texte.
-->
<script lang="ts">
  import { memberCaseModal } from '../stores/memberCaseModal.svelte';

  let {
    userId,
    name = null,
    prefix = '',
    class: className = '',
  }: {
    userId: string;
    /** Pseudo à afficher. À défaut, l'identifiant sert de libellé. */
    name?: string | null;
    /** Préfixe collé au pseudo, typiquement '@'. */
    prefix?: string;
    class?: string;
  } = $props();

  const label = $derived(name?.trim() || userId);
</script>

{#if memberCaseModal.canOpen}
  <button
    type="button"
    onclick={() => memberCaseModal.show(userId, label)}
    title={userId}
    class="max-w-full truncate text-left rounded transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 {className}"
  >{prefix}{label}</button>
{:else}
  <span title={userId} class={className}>{prefix}{label}</span>
{/if}
