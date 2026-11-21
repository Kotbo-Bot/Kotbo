<script lang="ts">
  /**
   * Cadre commun des aperçus Discord rendus par @arcscord/discord-ui-svelte :
   * thème sombre quel que soit celui du dashboard (Discord n'a pas le sien),
   * langue du dashboard et fuseau du navigateur pour les dates.
   */
  import type { Snippet } from 'svelte';
  import { DiscordUI } from '@arcscord/discord-ui-svelte';
  import '@arcscord/discord-ui-svelte/styles.css';
  import { getLocale } from '../../i18n';

  const { class: className, children }: { class?: string; children: Snippet } = $props();

  const locale = $derived(getLocale() === 'fr' ? 'fr-FR' : 'en-US');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>

<DiscordUI theme="dark" {locale} {timeZone} class={className}>
  {@render children()}
</DiscordUI>
