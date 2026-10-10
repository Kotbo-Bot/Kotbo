<script lang="ts">
  import { router } from 'tinro';
  import { m } from '../../i18n';
  import { isPageBeta, isPageWip, type PageConfig } from '../../config/pages';
  import { authStore } from '../../stores/auth.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { mobileNav } from '../../stores/mobileNav.svelte';
  import { navigationStore, isActiveNavItem } from '../../stores/navigation.svelte';
  import { notificationsStore } from '../../stores/notifications.svelte';
  import { unsavedChanges } from '../../stores/unsavedChanges.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import Papicon from '../Papicon.svelte';

  const open = $derived(mobileNav.sheet === 'nav');

  let query = $state('');
  let searchInput = $state<HTMLInputElement | null>(null);

  const results = $derived(query.trim() ? navigationStore.search(query) : []);
  const searching = $derived(query.trim().length > 0);

  const guild = $derived(authStore.guilds.find((g) => g.id === authStore.selectedGuildId));

  // Closing wipes the query so the sheet always reopens on the browse view.
  $effect(() => {
    if (!open) query = '';
  });

  function isActive(href: string): boolean {
    return isActiveNavItem(href, $router.path, $router.url);
  }

  async function go(href: string) {
    if (isActive(href)) {
      mobileNav.close();
      return;
    }

    if (unsavedChanges.isDirty) {
      const confirmed = await confirmDialog.ask({
        title: m.banner_unsaved_title(),
        description: m.banner_unsaved_desc({ page: unsavedChanges.pageLabel }),
        confirmLabel: m.banner_unsaved_leave(),
        variant: 'warning',
      });
      if (!confirmed) return;
      unsavedChanges.clear();
    }

    mobileNav.close();
    router.goto(href);
  }

  function toggleFavorite(event: MouseEvent, href: string) {
    event.preventDefault();
    event.stopPropagation();
    navigationStore.toggleFavorite(href);
  }

  function badgeFor(item: PageConfig): number {
    return item.href === '/inbox' ? notificationsStore.unreadCount : 0;
  }
</script>

<BottomSheet
  {open}
  title={m.nav_browse()}
  subtitle={guild?.name}
  maxHeight="90dvh"
  onclose={() => mobileNav.close()}
>
  <!-- Account, theme and server moved behind the avatar in the top bar. The one
       setting that belongs to this surface sits in the header, where it is read
       before the list rather than found under eighty page links. -->
  {#snippet header()}
    <button
      type="button"
      class="navsheet__shortcuts"
      aria-haspopup="dialog"
      onclick={() => mobileNav.open('tabs')}
    >
      <Papicon icon="tune" size={15} />
      <span>{m.nav_shortcuts()}</span>
    </button>
  {/snippet}

  <div class="navsheet">
    <!-- Search first: no tab bar can hold 80 pages, so typing is the fast path. -->
    <div class="navsheet__search">
      <Papicon icon="search" size={16} class="navsheet__search-icon" />
      <input
        bind:this={searchInput}
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
        <button type="button" onclick={() => { query = ''; searchInput?.focus(); }} aria-label={m.common_clear()}>
          <Papicon icon="x" size={14} />
        </button>
      {/if}
    </div>

    {#if searching}
      {#if results.length > 0}
        <ul class="navsheet__list" aria-label={m.nav_search_results()}>
          {#each results as item (item.href)}
            {@render row(item)}
          {/each}
        </ul>
      {:else}
        <p class="navsheet__empty">{m.sidebar_no_results({ query })}</p>
      {/if}
    {:else}
      {#if navigationStore.favoriteItems.length > 0}
        {@render section(m.nav_favorites(), navigationStore.favoriteItems)}
      {/if}

      {#if navigationStore.recentItems.length > 0}
        {@render section(m.nav_recents(), navigationStore.recentItems)}
      {/if}

      {#each navigationStore.menuGroups as group (group.key)}
        {@render section(group.label, group.items)}
      {/each}
    {/if}
  </div>
</BottomSheet>

{#snippet section(label: string, items: PageConfig[])}
  <section class="navsheet__group">
    <h3 class="navsheet__group-title">{label}</h3>
    <ul class="navsheet__list">
      {#each items as item (item.href)}
        {@render row(item)}
      {/each}
    </ul>
  </section>
{/snippet}

{#snippet row(item: PageConfig)}
  {@const active = isActive(item.href)}
  {@const badge = badgeFor(item)}
  <li class="navsheet__item">
    <button
      type="button"
      class="navsheet__row"
      class:navsheet__row--active={active}
      class:navsheet__row--muted={navigationStore.isModuleDisabled(item.featureKey, item.href)}
      aria-current={active ? 'page' : undefined}
      onclick={() => go(item.href)}
    >
      <span class="navsheet__row-icon"><Papicon icon={item.icon ?? 'circle'} size={17} /></span>
      <span class="navsheet__row-label">{item.name}</span>

      {#if isPageWip(item)}
        <span class="navsheet__tag navsheet__tag--wip">WIP</span>
      {:else if isPageBeta(item)}
        <span class="navsheet__tag navsheet__tag--beta">BETA</span>
      {/if}

      {#if badge > 0}
        <span class="navsheet__count">{badge > 99 ? '99+' : badge}</span>
      {/if}

    </button>

    <button
      type="button"
      class="navsheet__star"
      class:navsheet__star--on={navigationStore.isFavorite(item.href)}
      aria-pressed={navigationStore.isFavorite(item.href)}
      aria-label={navigationStore.isFavorite(item.href) ? m.nav_unfavorite() : m.nav_favorite()}
      onclick={(event) => toggleFavorite(event, item.href)}
    >
      <Papicon icon="star" size={15} />
    </button>
  </li>
{/snippet}

<style>
  .navsheet {
    padding-bottom: 1rem;
  }

  .navsheet__search {
    position: sticky;
    z-index: 2;
    top: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    padding: 0.125rem 0 0.625rem;
    background: var(--surface-container-lowest);
  }

  .navsheet__search :global(.navsheet__search-icon) {
    position: absolute;
    left: 0.875rem;
    color: var(--on-surface-variant);
    pointer-events: none;
  }

  .navsheet__search input {
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

  .navsheet__search input:focus {
    border-color: color-mix(in srgb, var(--primary-color) 55%, transparent);
    outline: none;
  }

  .navsheet__search input::-webkit-search-cancel-button {
    display: none;
  }

  .navsheet__search > button {
    position: absolute;
    right: 0.5rem;
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border-radius: 999px;
    color: var(--on-surface-variant);
  }

  .navsheet__group + .navsheet__group {
    margin-top: 1.125rem;
  }

  .navsheet__group-title {
    margin-bottom: 0.375rem;
    padding-left: 0.25rem;
    color: var(--on-surface-variant);
    font-family: var(--font-label);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .navsheet__list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  /* The star is a sibling rather than a nested control: a button inside a
     button is invalid, and screen readers would not reach the favourite. */
  .navsheet__item {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .navsheet__row {
    display: flex;
    width: 100%;
    min-height: 3rem;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.5rem 0 0.625rem;
    border-radius: 0.75rem;
    color: var(--on-surface);
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }

  .navsheet__row:active {
    background: var(--surface-container);
  }

  .navsheet__row--active {
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
    color: var(--primary-color);
  }

  .navsheet__row--muted {
    opacity: 0.45;
  }

  .navsheet__row-icon {
    display: grid;
    width: 1.75rem;
    flex: none;
    place-items: center;
    color: inherit;
    opacity: 0.75;
  }

  .navsheet__row--active .navsheet__row-icon {
    opacity: 1;
  }

  .navsheet__row-label {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    font-size: 0.9375rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .navsheet__row--active .navsheet__row-label {
    font-weight: 650;
  }

  .navsheet__tag {
    flex: none;
    padding: 0.125rem 0.3125rem;
    border-radius: 0.25rem;
    font-size: 0.5625rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .navsheet__tag--wip {
    background: color-mix(in srgb, #f59e0b 16%, transparent);
    color: #b45309;
  }

  .navsheet__tag--beta {
    background: color-mix(in srgb, #a855f7 16%, transparent);
    color: #7e22ce;
  }

  :global(.dark) .navsheet__tag--wip { color: #fbbf24; }
  :global(.dark) .navsheet__tag--beta { color: #d8b4fe; }

  .navsheet__count {
    display: grid;
    min-width: 1.25rem;
    height: 1.25rem;
    flex: none;
    padding: 0 0.3125rem;
    place-items: center;
    border-radius: 999px;
    background: var(--primary-color);
    color: var(--on-primary-color);
    font-size: 0.625rem;
    font-weight: 700;
  }

  .navsheet__star {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    flex: none;
    place-items: center;
    border-radius: 999px;
    color: var(--on-surface-variant);
    opacity: 0.35;
    -webkit-tap-highlight-color: transparent;
  }

  .navsheet__star:active {
    background: var(--surface-container);
  }

  .navsheet__star--on {
    color: #f59e0b;
    opacity: 1;
  }

  .navsheet__row :global(.navsheet__chevron) {
    flex: none;
    color: var(--on-surface-variant);
    opacity: 0.5;
  }

  .navsheet__shortcuts {
    display: flex;
    min-height: 2.25rem;
    flex: none;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    border: 1px solid var(--outline-variant);
    border-radius: 999px;
    background: var(--surface-container);
    color: var(--on-surface);
    font-family: var(--font-label);
    font-size: 0.75rem;
    font-weight: 650;
    white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
  }

  .navsheet__shortcuts:active {
    background: color-mix(in srgb, var(--primary-color) 12%, transparent);
    color: var(--primary-color);
  }

  .navsheet__empty {
    padding: 2rem 1rem;
    color: var(--on-surface-variant);
    font-size: 0.875rem;
    text-align: center;
  }

</style>
