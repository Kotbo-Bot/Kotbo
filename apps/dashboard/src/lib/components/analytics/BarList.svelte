<!--
  Classement horizontal : libellé, barre proportionnelle au premier, valeur.
  Les barres portent une couleur d'identité ; le texte reste dans les encres
  du thème. Avec `onselect`, chaque ligne devient un bouton.
-->
<script lang="ts" module>
  export interface BarListItem {
    id: string;
    label: string;
    value: number;
    /** Valeur affichée, si elle diffère du nombre brut (« 7,9 % »). */
    display?: string;
    sub?: string;
    color?: string;
  }
</script>

<script lang="ts" generics="T extends BarListItem">
  import type { Snippet } from 'svelte';
  import { fmtNumber } from './analyticsFormat';

  const {
    items,
    color = 'var(--series-1)',
    leading,
    trailing,
    onselect,
    empty = '',
    max = undefined,
  }: {
    items: T[];
    color?: string;
    leading?: Snippet<[T]>;
    trailing?: Snippet<[T]>;
    onselect?: (item: T) => void;
    empty?: string;
    /** Valeur pleine échelle ; par défaut la plus grande de la liste. */
    max?: number;
  } = $props();

  const scale = $derived(max ?? Math.max(1, ...items.map((i) => i.value)));
  const tip = (item: T) => `${item.label} : ${item.display ?? fmtNumber(item.value)}`;
</script>

{#if items.length === 0}
  <p class="text-body-sm text-on-surface-variant py-2">{empty}</p>
{:else}
  <ul class="flex flex-col gap-2.5">
    <!-- Clé suffixée par l'index : un id en double côté appelant ferait planter la page (each_key_duplicate). -->
    {#each items as item, i (`${item.id}:${i}`)}
      <li>
        {#if onselect}
          <button type="button" class="bar-row bar-row--button" onclick={() => onselect(item)} title={tip(item)}>
            {@render row(item)}
          </button>
        {:else}
          <div class="bar-row" title={tip(item)}>
            {@render row(item)}
          </div>
        {/if}
      </li>
    {/each}
  </ul>

  {#snippet row(item: T)}
    {#if leading}{@render leading(item)}{/if}
    <span class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="flex items-baseline gap-2 min-w-0">
        <span class="truncate text-body-sm text-on-surface">{item.label}</span>
        {#if item.sub}<span class="truncate text-2xs text-on-surface-variant">{item.sub}</span>{/if}
      </span>
      <span class="bar-track" aria-hidden="true">
        <span class="bar-fill" style="width: {Math.max(1.5, (item.value / scale) * 100)}%; background: {item.color ?? color};"></span>
      </span>
    </span>
    {#if trailing}{@render trailing(item)}{/if}
    <span class="shrink-0 text-body-sm font-medium tabular-nums text-on-surface">{item.display ?? fmtNumber(item.value)}</span>
  {/snippet}
{/if}

<style>
  .bar-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    text-align: left;
    border-radius: 0.5rem;
  }

  .bar-row--button {
    padding: 0.25rem 0.375rem;
    margin: -0.25rem -0.375rem;
    width: calc(100% + 0.75rem);
    cursor: pointer;
  }

  .bar-row--button:hover {
    background: var(--color-surface-container);
  }

  .bar-row--button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .bar-track {
    display: block;
    height: 6px;
    border-radius: 999px;
    background: var(--color-surface-container);
    overflow: hidden;
  }

  .bar-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
  }
</style>
