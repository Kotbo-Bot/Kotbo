<!--
  Tag de serveur et badge de booster d'un membre, seuls, pour les mises en page qui
  posent pseudo et photo elles-mêmes (en-têtes de fiche). Ailleurs, préférer
  UserDisplay ou MemberName, qui les incluent déjà. Rien n'est rendu tant que
  l'identité est inconnue.
-->
<script lang="ts">
  import { memberIdentities } from '../stores/memberIdentities.svelte';
  import ServerTagPill from './ServerTagPill.svelte';
  import BoosterBadge from './BoosterBadge.svelte';

  const { userId }: { userId: string | null | undefined } = $props();

  const identity = $derived(memberIdentities.get(userId));
  const tag = $derived(identity?.serverTag ?? null);
</script>

{#if tag}
  <ServerTagPill tag={tag.tag} badgeUrl={tag.badgeUrl} />
{/if}
{#if identity?.boostingSince}
  <BoosterBadge since={identity.boostingSince} />
{/if}
