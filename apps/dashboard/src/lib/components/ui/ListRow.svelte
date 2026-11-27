<!--
  Ligne d'un ListGroup : pastille d'icône, libellé, aide, et à droite un réglage
  (children). Avec `href` ou `onclick`, toute la ligne est la cible.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Papicon from '../Papicon.svelte';

  const {
    icon = '',
    label,
    description = '',
    href = undefined,
    onclick = undefined,
    external = false,
    danger = false,
    stacked = false,
    media,
    children,
  }: {
    icon?: string;
    label: string;
    description?: string;
    href?: string;
    onclick?: () => void;
    external?: boolean;
    danger?: boolean;
    /** Le réglage passe sous le libellé (sélecteur large, champ). */
    stacked?: boolean;
    /** Remplace la pastille d'icône (avatar, image). */
    media?: Snippet;
    children?: Snippet;
  } = $props();

  const pressable = $derived(Boolean(href || onclick));
</script>

<svelte:element
  this={href ? 'a' : onclick ? 'button' : 'div'}
  {href}
  {onclick}
  type={!href && onclick ? 'button' : undefined}
  target={external ? '_blank' : undefined}
  rel={external ? 'noopener noreferrer' : undefined}
  role={href ? 'link' : onclick ? 'button' : undefined}
  class="list-row"
  class:list-row--pressable={pressable}
  class:list-row--stacked={stacked}
  class:list-row--danger={danger}
>
  <span class="list-row__text">
    {#if media}
      {@render media()}
    {:else if icon}
      <span class="icon-disc" aria-hidden="true"><Papicon {icon} size={16} /></span>
    {/if}
    <span class="min-w-0">
      <span class="list-row__label">{label}</span>
      {#if description}<span class="list-row__desc">{description}</span>{/if}
    </span>
  </span>
  {#if children}
    <span class="list-row__control">{@render children()}</span>
  {:else if pressable}
    <Papicon icon={external ? 'external-link' : 'chevron-right'} size={15} class="shrink-0 text-on-surface-variant" />
  {/if}
</svelte:element>
