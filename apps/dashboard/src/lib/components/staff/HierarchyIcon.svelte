<!--
  Icone d'un pole. Le champ accepte un emoji (« 🛡️ ») ou un nom d'icone
  (« Shield ») : la page affichait le nom tel quel, en toutes lettres, a cote
  du titre du pole.
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';

  const {
    icon = null,
    color = null,
    size = 32,
  }: { icon?: string | null; color?: string | null; size?: number } = $props();

  const isIconName = $derived(!!icon && /^[A-Za-z][\w-]*$/.test(icon));
  const tint = $derived(color || 'var(--primary-color)');
</script>

<span
  class="inline-flex shrink-0 items-center justify-center rounded-lg"
  style="width: {size}px; height: {size}px; color: {tint}; background: color-mix(in srgb, {tint} 14%, transparent);"
  aria-hidden="true"
>
  {#if !icon}
    <Papicon icon="layers" size={Math.round(size * 0.5)} />
  {:else if isIconName}
    <Papicon {icon} size={Math.round(size * 0.5)} />
  {:else}
    <span style="font-size: {Math.round(size * 0.5)}px; line-height: 1;">{icon}</span>
  {/if}
</span>
