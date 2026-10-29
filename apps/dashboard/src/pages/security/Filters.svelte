<script lang="ts">
  /**
   * Securite > Filtres.
   *
   * Cible du lot 4 : onglets « Contenu », « Comportemental », « Pseudos »
   * (ex-page /nickname-moderation) et « Exceptions ». Le contenu anti-raid
   * d'AutoMod part vers Securite > Anti-raid au lot 3.
   *
   * Sous-onglet `/security/filters/nicknames` : rendu ici tant que la fusion
   * n'est pas faite, pour que la redirection de /nickname-moderation aboutisse.
   */
  import { router } from 'tinro';
  import AutoMod from '../AutoMod.svelte';
  import NicknameModeration from '../NicknameModeration.svelte';
  import ServerFileFilters from '../ServerFileFilters.svelte';

  const showNicknames = $derived($router.path.startsWith('/security/filters/nicknames'));
  // « Serveurs & fichiers » : réglages de l'Anti-raid, rendus en onglet de Filtres.
  const showServers = $derived($router.path.startsWith('/security/filters/servers'));
</script>

{#if showNicknames}
  <NicknameModeration />
{:else if showServers}
  <ServerFileFilters />
{:else}
  <AutoMod />
{/if}
