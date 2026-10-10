<script lang="ts">
  import { m } from '../../i18n';
  import type { PageConfig } from '../../config/pages';
  import { mobileNav } from '../../stores/mobileNav.svelte';
  import { mobileTabs, TAB_SLOTS } from '../../stores/mobileTabs.svelte';
  import { navigationStore } from '../../stores/navigation.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import Papicon from '../Papicon.svelte';

  const open = $derived(mobileNav.sheet === 'tabs');

  /**
   * The list is read straight back from the store on every change, so the bar
   * behind the sheet and the preview above always show the same thing. There is
   * no draft to save and nothing to discard.
   */
  const chosen = $derived(mobileTabs.resolve(navigationStore.allItems));
  const chosenHrefs = $derived(new Set(chosen.map((item) => item.href)));
  const isFull = $derived(chosen.length >= TAB_SLOTS);

  let query = $state('');

  /** Groups with their already-chosen pages removed, empty groups dropped. */
  const addableGroups = $derived(
    navigationStore.groups
      .map((group) => ({
        key: group.key,
        label: group.label,
        items: group.items.filter((item) => !chosenHrefs.has(item.href)),
      }))
      .filter((group) => group.items.length > 0),
  );

  const searchResults = $derived(
    query.trim()
      ? navigationStore.search(query).filter((item) => !chosenHrefs.has(item.href))
      : [],
  );

  $effect(() => {
    if (!open) query = '';
  });

  /** The shortcut that just moved, briefly marked in the preview. */
  let flashed = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  function flash(href: string) {
    flashed = href;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashed = null), 600);
  }

  function commit(hrefs: string[], focus: string) {
    mobileTabs.set(hrefs);
    flash(focus);
  }

  function move(index: number, direction: -1 | 1) {
    const next = chosen.map((item) => item.href);
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    commit(next, next[target]);
  }

  function remove(href: string) {
    if (chosen.length <= 1) return;
    commit(
      chosen.filter((item) => item.href !== href).map((item) => item.href),
      href,
    );
  }

  function add(href: string) {
    if (isFull) return;
    commit([...chosen.map((item) => item.href), href], href);
    query = '';
  }
</script>

<BottomSheet
  {open}
  title={m.nav_tabbar_title()}
  subtitle={m.nav_tabbar_subtitle({ count: TAB_SLOTS })}
  maxHeight="90dvh"
  onclose={() => mobileNav.close()}
>
  {#snippet footer()}
    <div class="editor__footer">
      <p class="editor__hint">{m.nav_tabbar_hint()}</p>
      {#if mobileTabs.isCustomized}
        <button type="button" class="editor__reset" onclick={() => mobileTabs.reset()}>
          <Papicon icon="refresh-cw" size={15} />
          <span>{m.nav_tabbar_reset()}</span>
        </button>
      {/if}
    </div>
  {/snippet}

  <div class="editor">
    <!-- The bar itself, drawn where the sheet covers the real one. -->
    <div class="editor__preview" aria-hidden="true">
      {#each chosen as item (item.href)}
        <span class="editor__preview-tab" class:editor__preview-tab--flash={flashed === item.href}>
          <Papicon icon={item.icon ?? 'circle'} size={18} />
          <span class="editor__preview-label">{item.name}</span>
        </span>
      {/each}
      <span class="editor__preview-tab editor__preview-tab--fixed">
        <Papicon icon="menu" size={18} />
        <span class="editor__preview-label">{m.nav_more()}</span>
      </span>
    </div>

    <div class="editor__heading">
      <h3 class="editor__label">{m.nav_tabbar_chosen()}</h3>
      <span class="editor__count" class:editor__count--full={isFull}>
        {chosen.length}/{TAB_SLOTS}
      </span>
    </div>

    <ul class="editor__slots">
      {#each chosen as item, index (item.href)}
        <li class="editor__slot">
          <span class="editor__slot-icon"><Papicon icon={item.icon ?? 'circle'} size={17} /></span>
          <span class="editor__slot-label">{item.name}</span>

          <button
            type="button"
            class="editor__ghost"
            disabled={index === 0}
            aria-label={m.nav_tabbar_move_left({ page: item.name })}
            onclick={() => move(index, -1)}
          >
            <Papicon icon="arrow-left" size={16} />
          </button>

          <button
            type="button"
            class="editor__ghost"
            disabled={index === chosen.length - 1}
            aria-label={m.nav_tabbar_move_right({ page: item.name })}
            onclick={() => move(index, 1)}
          >
            <Papicon icon="arrow-right" size={16} />
          </button>

          <button
            type="button"
            class="editor__ghost editor__ghost--remove"
            disabled={chosen.length <= 1}
            aria-label={m.nav_tabbar_remove({ page: item.name })}
            onclick={() => remove(item.href)}
          >
            <Papicon icon="minus" size={16} />
          </button>
        </li>
      {/each}
    </ul>

    <h3 class="editor__label editor__label--spaced">{m.nav_tabbar_add()}</h3>

    {#if isFull}
      <p class="editor__notice">{m.nav_tabbar_full({ count: TAB_SLOTS })}</p>
    {:else}
      <div class="editor__search">
        <Papicon icon="search" size={16} class="editor__search-icon" />
        <input
          bind:value={query}
          type="search"
          inputmode="search"
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          placeholder={m.nav_search_pages()}
          aria-label={m.nav_search_pages()}
        />
        {#if query}
          <button type="button" onclick={() => (query = '')} aria-label={m.common_clear()}>
            <Papicon icon="x" size={14} />
          </button>
        {/if}
      </div>

      {#if query.trim()}
        {#if searchResults.length > 0}
          <ul class="editor__list">
            {#each searchResults as item (item.href)}
              {@render candidate(item)}
            {/each}
          </ul>
        {:else}
          <p class="editor__notice">{m.sidebar_no_results({ query })}</p>
        {/if}
      {:else}
        {#each addableGroups as group (group.key)}
          <h4 class="editor__group">{group.label}</h4>
          <ul class="editor__list">
            {#each group.items as item (item.href)}
              {@render candidate(item)}
            {/each}
          </ul>
        {/each}
      {/if}
    {/if}
  </div>
</BottomSheet>

{#snippet candidate(item: PageConfig)}
  <li>
    <button type="button" class="editor__candidate" onclick={() => add(item.href)}>
      <span class="editor__slot-icon"><Papicon icon={item.icon ?? 'circle'} size={17} /></span>
      <span class="editor__slot-label">{item.name}</span>
      <span class="editor__add" aria-hidden="true"><Papicon icon="plus" size={15} /></span>
      <span class="editor__sr">{m.nav_tabbar_add_one({ page: item.name })}</span>
    </button>
  </li>
{/snippet}

<style>
  .editor {
    padding-bottom: 0.5rem;
  }

  /* ── Live replica of the bar ── */

  .editor__preview {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    align-items: stretch;
    padding: 0.375rem 0.25rem;
    border: 1px solid var(--outline-variant);
    border-radius: 1rem;
    background: var(--surface-container);
  }

  .editor__preview-tab {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.25rem 0.125rem;
    border-radius: 0.625rem;
    color: var(--on-surface);
    transition: background-color 300ms ease, color 300ms ease;
  }

  .editor__preview-tab--fixed {
    color: var(--on-surface-variant);
    opacity: 0.5;
  }

  .editor__preview-tab--flash {
    background: color-mix(in srgb, var(--primary-color) 16%, transparent);
    color: var(--primary-color);
  }

  .editor__preview-label {
    max-width: 100%;
    overflow: hidden;
    font-family: var(--font-label);
    font-size: 0.5625rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Chosen shortcuts ── */

  .editor__heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 1.25rem 0 0.375rem;
  }

  .editor__label {
    padding-left: 0.25rem;
    color: var(--on-surface-variant);
    font-family: var(--font-label);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .editor__label--spaced {
    margin: 1.5rem 0 0.5rem;
  }

  .editor__count {
    flex: none;
    color: var(--on-surface-variant);
    font-family: var(--font-label);
    font-size: 0.75rem;
    font-weight: 700;
  }

  .editor__count--full {
    color: var(--primary-color);
  }

  .editor__slots,
  .editor__list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .editor__slot,
  .editor__candidate {
    display: flex;
    width: 100%;
    min-height: 3rem;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.25rem 0 0.625rem;
    border-radius: 0.75rem;
    color: var(--on-surface);
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }

  .editor__slot {
    border: 1px solid var(--outline-variant);
    background: var(--surface-container);
  }

  .editor__candidate:active {
    background: var(--surface-container);
  }

  .editor__slot-icon {
    display: grid;
    width: 1.5rem;
    flex: none;
    place-items: center;
    opacity: 0.75;
  }

  .editor__slot-label {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    margin-right: 0.5rem;
    font-size: 0.9375rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .editor__ghost {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    flex: none;
    place-items: center;
    border-radius: 0.625rem;
    color: var(--on-surface-variant);
    -webkit-tap-highlight-color: transparent;
  }

  .editor__ghost:active {
    background: var(--surface-container-lowest);
  }

  .editor__ghost:disabled {
    opacity: 0.25;
  }

  .editor__ghost--remove {
    color: #dc2626;
  }

  :global(.dark) .editor__ghost--remove {
    color: #f87171;
  }

  .editor__add {
    display: grid;
    width: 2rem;
    height: 2rem;
    flex: none;
    place-items: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary-color) 12%, transparent);
    color: var(--primary-color);
  }

  /* ── Add a shortcut ── */

  .editor__search {
    position: relative;
    display: flex;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .editor__search :global(.editor__search-icon) {
    position: absolute;
    left: 0.875rem;
    color: var(--on-surface-variant);
    pointer-events: none;
  }

  .editor__search input {
    width: 100%;
    min-height: 2.875rem;
    padding: 0 2.5rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.875rem;
    background: var(--surface-container);
    color: var(--on-surface);
    /* 16px keeps iOS Safari from zooming the page when the field is focused. */
    font-size: 1rem;
  }

  .editor__search input:focus {
    border-color: color-mix(in srgb, var(--primary-color) 55%, transparent);
    outline: none;
  }

  .editor__search input::-webkit-search-cancel-button {
    display: none;
  }

  .editor__search > button {
    position: absolute;
    right: 0.5rem;
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border-radius: 999px;
    color: var(--on-surface-variant);
  }

  .editor__group {
    margin: 0.75rem 0 0.25rem;
    padding-left: 0.625rem;
    color: var(--on-surface-variant);
    font-size: 0.75rem;
    font-weight: 650;
    opacity: 0.8;
  }

  .editor__notice {
    padding: 0.75rem 0.625rem;
    color: var(--on-surface-variant);
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  /* ── Footer ── */

  .editor__footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .editor__hint {
    flex: 1 1 auto;
    color: var(--on-surface-variant);
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .editor__reset {
    display: flex;
    min-height: 2.5rem;
    flex: none;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.75rem;
    color: var(--on-surface);
    font-size: 0.8125rem;
    font-weight: 600;
    -webkit-tap-highlight-color: transparent;
  }

  .editor__reset:active {
    background: var(--surface-container);
  }

  .editor__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .editor__preview-tab {
      transition: none;
    }
  }
</style>
