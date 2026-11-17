<script lang="ts">
  import { m } from '../../i18n';
  import { onMount } from 'svelte';
  import type { SortDirection, SortField } from '../../sanctions/filterSort';
  import Papicon from '../Papicon.svelte';

  export type ColumnFilterOption = {
    value: string;
    label: string;
  };

  const {
    label,
    sortField = null,
    sortDirection = null,
    onToggleSort,
    options = [],
    selectedValues = [],
    onToggleValue,
    searchable = false,
    disabled = false,
  }: {
    label: string;
    sortField?: SortField | null;
    sortDirection?: SortDirection | null;
    onToggleSort?: (() => void) | undefined;
    options?: ColumnFilterOption[];
    selectedValues?: string[];
    onToggleValue?: ((value: string) => void) | undefined;
    searchable?: boolean;
    disabled?: boolean;
  } = $props();

  let filterOpen = $state(false);
  let searchTerm = $state('');
  let rootElement = $state<HTMLElement | null>(null);

  const canSort = $derived(Boolean(sortField && onToggleSort));
  const canFilter = $derived(Boolean(onToggleValue && options.length > 0));
  const selectedCount = $derived(selectedValues.length);
  const displaySearch = $derived(searchable || options.length >= 8);
  const filteredOptions = $derived.by(() => {
    if (!displaySearch) {
      return options;
    }

    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (!normalizedSearch) {
      return options;
    }

    return options.filter((entry) => entry.label.toLowerCase().includes(normalizedSearch));
  });

  function closeFilterPanel() {
    filterOpen = false;
    searchTerm = '';
  }

  function toggleFilterPanel() {
    filterOpen = !filterOpen;
    if (!filterOpen) {
      searchTerm = '';
    }
  }

  function clearFilter() {
    for (const selected of selectedValues) {
      onToggleValue?.(selected);
    }
  }

  onMount(() => {
    const handleWindowPointerDown = (event: PointerEvent) => {
      if (!filterOpen || !rootElement) {
        return;
      }

      const target = event.target;
      if (target instanceof Node && !rootElement.contains(target)) {
        closeFilterPanel();
      }
    };

    window.addEventListener('pointerdown', handleWindowPointerDown);
    return () => window.removeEventListener('pointerdown', handleWindowPointerDown);
  });
</script>

<div class="relative" bind:this={rootElement}>
  <div class="flex items-center gap-1.5">
    <span class="text-xs font-semibold text-on-surface-variant">{label}</span>

    {#if canSort}
      <button
        type="button"
        onclick={() => onToggleSort?.()}
        class="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-transparent text-2xs font-semibold transition hover:border-outline-variant hover:bg-surface-container {sortDirection ? 'text-primary' : 'text-on-surface-variant'}"
        title={sortDirection ? `Tri ${sortDirection === 'asc' ? 'croissant' : 'decroissant'}` : m.csf_enable_sort()}
        disabled={disabled}
      >
        {#if sortDirection === 'asc'}
          <Papicon icon="arrow-up" size={12} />
        {:else if sortDirection === 'desc'}
          <Papicon icon="arrow-down" size={12} />
        {:else}
          <Papicon icon="chevrons-up-down" size={12} />
        {/if}
      </button>
    {/if}

    {#if canFilter}
      <button
        type="button"
        onclick={toggleFilterPanel}
        class="inline-flex h-6 min-w-6 items-center justify-center rounded-md border text-2xs font-semibold transition {selectedCount > 0 ? 'border-primary/35 bg-primary/10 text-primary' : 'border-outline-variant text-on-surface-variant hover:border-outline-variant hover:bg-surface-container'}"
        title={selectedCount > 0 ? `${selectedCount} filtre(s) actif(s)` : m.csf_filter_column()}
        disabled={disabled}
      >
        <Papicon icon="filter" size={12} />
      </button>
    {/if}
  </div>

  {#if canFilter && filterOpen}
    <div class="absolute left-0 top-8 z-20 w-64 rounded-xl border border-outline-variant bg-white p-3 shadow-sm">
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-xs font-semibold text-on-surface-variant">{m.csf_filter_label({ label: label.toLowerCase() })}</p>
        {#if selectedCount > 0}
          <button
            type="button"
            onclick={clearFilter}
            class="text-2xs font-bold text-primary transition hover:opacity-80"
          >
            {m.csf_clear()}
          </button>
        {/if}
      </div>

      {#if displaySearch}
        <input aria-label={m.csf_search_ph()}
          type="text"
          bind:value={searchTerm}
          placeholder={m.csf_search_ph()}
          class="mb-2 w-full rounded-lg border border-outline-variant bg-white px-2.5 py-1.5 text-xs text-on-surface outline-none transition focus:border-primary"
        />
      {/if}

      <div class="max-h-56 space-y-1 overflow-y-auto pr-1">
        {#if filteredOptions.length === 0}
          <p class="py-2 text-xs text-on-surface-variant">{m.csf_no_result()}</p>
        {:else}
          {#each filteredOptions as entry (entry.value)}
            <label class="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-surface-container-low">
              <input
                type="checkbox"
                checked={selectedValues.includes(entry.value)}
                onchange={() => onToggleValue?.(entry.value)}
                class="rounded border-outline-variant"
              />
              <span class="truncate">{entry.label}</span>
            </label>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>
