<script lang="ts">
  /**
   * Classement en barres : chaque ligne porte sa propre jauge en fond, ce qui
   * permet de comparer vingt valeurs d'un coup d'oeil sans axe ni legende.
   */
  export interface BarItem {
    key: string;
    label: string;
    sublabel?: string;
    value: number;
    href?: string;
    image?: string | null;
  }

  const {
    items,
    formatValue = (value: number) => value.toLocaleString('fr-FR'),
    emptyLabel = 'Rien à afficher sur la période.',
    limit = 10,
  }: {
    items: BarItem[];
    formatValue?: (value: number) => string;
    emptyLabel?: string;
    limit?: number;
  } = $props();

  let expanded = $state(false);
  const visible = $derived(expanded ? items : items.slice(0, limit));
  const max = $derived(Math.max(1, ...items.map((item) => item.value)));
</script>

{#if items.length === 0}
  <p class="text-body-sm text-on-surface-variant py-4">{emptyLabel}</p>
{:else}
  <ol class="space-y-1">
    {#each visible as item, index (item.key)}
      <li>
        <svelte:element
          this={item.href ? 'a' : 'div'}
          href={item.href}
          class="relative flex items-center gap-3 h-10 px-3 rounded-xl overflow-hidden
            {item.href ? 'hover:bg-on-surface/4 focus-visible:outline-2 focus-visible:outline-primary' : ''}"
        >
          <span class="absolute inset-y-1 left-0 rounded-lg bg-primary/12" style="width: {(item.value / max) * 100}%" aria-hidden="true"></span>
          <span class="relative w-5 shrink-0 text-xs font-semibold text-on-surface-variant tabular-nums">{index + 1}</span>
          {#if item.image}
            <img src={item.image} alt="" class="relative w-6 h-6 rounded-lg shrink-0 object-cover" loading="lazy" />
          {/if}
          <span class="relative min-w-0 flex-1 flex items-baseline gap-2">
            <span class="text-sm font-semibold text-on-surface truncate">{item.label}</span>
            {#if item.sublabel}
              <span class="text-xs text-on-surface-variant truncate hidden sm:inline">{item.sublabel}</span>
            {/if}
          </span>
          <span class="relative shrink-0 text-sm font-semibold text-on-surface tabular-nums">{formatValue(item.value)}</span>
        </svelte:element>
      </li>
    {/each}
  </ol>
  {#if items.length > limit}
    <button
      type="button"
      onclick={() => (expanded = !expanded)}
      class="mt-2 text-body-sm font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded"
    >
      {expanded ? 'Réduire' : `Voir les ${items.length}`}
    </button>
  {/if}
{/if}
