<!--
  Tag de serveur d'un membre, seul, pour les mises en page qui posent pseudo et photo
  elles-mêmes (en-têtes de fiche). Ailleurs, préférer UserDisplay ou MemberName, qui
  l'incluent déjà. Rien n'est rendu tant que le tag est inconnu ou absent.
-->
<script lang="ts">
  import { memberIdentities } from '../stores/memberIdentities.svelte';
  import ServerTagPill from './ServerTagPill.svelte';

  const { userId }: { userId: string | null | undefined } = $props();

  const tag = $derived(memberIdentities.get(userId)?.serverTag ?? null);
</script>

{#if tag}
  <ServerTagPill tag={tag.tag} badgeUrl={tag.badgeUrl} />
{/if}
