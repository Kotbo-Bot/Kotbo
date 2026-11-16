<!--
  Pseudo seul, cliquable vers la fiche membre, pour les listes qui affichent l'avatar à
  part. Sans accès à « Membres », le pseudo reste un simple texte. Le tag de serveur
  suit le pseudo comme sur Discord, lu dans le store partagé `memberIdentities`.
-->
<script lang="ts">
  import { memberCaseModal } from '../stores/memberCaseModal.svelte';
  import { memberIdentities } from '../stores/memberIdentities.svelte';
  import ServerTagPill from './ServerTagPill.svelte';

  let {
    userId,
    name = null,
    prefix = '',
    tag = true,
    class: className = '',
  }: {
    userId: string;
    /** Pseudo à afficher. À défaut, celui du store, puis l'identifiant. */
    name?: string | null;
    /** Préfixe collé au pseudo, typiquement '@'. */
    prefix?: string;
    /** Affiche le tag de serveur à côté du pseudo. */
    tag?: boolean;
    class?: string;
  } = $props();

  const known = $derived(memberIdentities.get(userId));
  const label = $derived(name?.trim() || known?.displayName || userId);
  const shownTag = $derived(tag ? known?.serverTag ?? null : null);
</script>

<span class="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle">
  {#if memberCaseModal.canOpen}
    <button
      type="button"
      onclick={() => memberCaseModal.show(userId, label)}
      title={userId}
      class="max-w-full truncate text-left rounded transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 {className}"
    >{prefix}{label}</button>
  {:else}
    <span title={userId} class="truncate {className}">{prefix}{label}</span>
  {/if}
  {#if shownTag}
    <ServerTagPill tag={shownTag.tag} badgeUrl={shownTag.badgeUrl} />
  {/if}
</span>
