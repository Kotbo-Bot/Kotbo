<script lang="ts">
  import { router } from 'tinro';
  import { m } from '../../i18n';
  import type { PageConfig } from '../../config/pages';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { mobileNav } from '../../stores/mobileNav.svelte';
  import { navigationStore, isActiveNavItem } from '../../stores/navigation.svelte';
  import { notificationsStore } from '../../stores/notifications.svelte';
  import { unsavedChanges } from '../../stores/unsavedChanges.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import Papicon from '../Papicon.svelte';

  const open = $derived(mobileNav.sheet === 'nav');

  /*
   * Meme architecture que la barre laterale : les epingles en tete, le groupe
   * « general » a plat, puis les espaces en accordeon dont un seul est ouvert.
   * Un utilisateur qui passe du telephone a l'ordinateur retrouve ses pages au
   * meme endroit.
   */
  const navGroups = $derived(navigationStore.menuGroups);
  const primaryGroup = $derived(navGroups.find((g) => g.key === 'general') ?? null);
  const spaces = $derived(navGroups.filter((g) => g.key !== 'general'));

  const pinnedItems = $derived(
    navigationStore.favorites
      .map((href) => navGroups.flatMap((g) => g.items).find((item) => item.href === href))
      .filter((item): item is PageConfig => !!item),
  );

  function isActive(href: string): boolean {
    return isActiveNavItem(href, $router.path, $router.url);
  }

  const activeSpaceKey = $derived(
    spaces.find((g) => g.items.some((item) => isActive(item.href)))?.key ?? null,
  );

  let openSpace = $state<string | null>(null);

  // Chaque ouverture repart de l'espace de la page courante.
  $effect(() => {
    if (open) openSpace = activeSpaceKey;
  });

  function toggleSpace(key: string): void {
    openSpace = openSpace === key ? null : key;
  }

  /*
   * Recherche. Le champ ne montre jamais un ecran vide : des qu'il a le focus,
   * il propose les pages recentes et epinglees, puis les resultats en tapant.
   * Le mode ne se quitte que par « Annuler » ou en fermant la feuille, pas sur
   * une perte de focus : sinon toucher un resultat, qui ferme le clavier,
   * changeait la liste sous le doigt avant que le toucher n'arrive.
   */
  let query = $state('');
  let searching = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);

  const trimmed = $derived(query.trim());
  // Les pages en chantier restent hors du menu, recherche comprise.
  const results = $derived(
    trimmed ? navigationStore.search(trimmed).filter((item) => !item.wip) : [],
  );

  const recentItems = $derived(
    navigationStore.recentItems.filter((item) => !item.wip && !isActive(item.href)),
  );

  /** Ce que la recherche propose avant la premiere lettre, ou faute de resultat. */
  const suggestions = $derived.by(() => {
    if (recentItems.length > 0) return { label: m.nav_recents(), items: recentItems };
    if (pinnedItems.length > 0) return { label: m.nav_pinned(), items: pinnedItems };
    return { label: m.nav_suggestions(), items: primaryGroup?.items ?? [] };
  });

  /** Espace d'une page, affiche a cote d'un resultat pour lever les homonymes. */
  const spaceOf = $derived(
    new Map(
      navigationStore.groups.flatMap((group) =>
        group.key === 'general' ? [] : group.items.map((item) => [item.href, group.label] as const),
      ),
    ),
  );

  $effect(() => {
    if (open) return;
    query = '';
    searching = false;
  });

  function cancelSearch(): void {
    query = '';
    searching = false;
    searchInput?.blur();
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

<BottomSheet {open} title={m.nav_browse()} maxHeight="90dvh" onclose={() => mobileNav.close()}>
  <!-- Choisir les onglets de la barre du bas se fait ici, a cote de la liste
       dont ils sont tires. -->
  {#snippet header()}
    <button
      type="button"
      class="navsheet__shortcuts"
      aria-haspopup="dialog"
      onclick={() => mobileNav.open('tabs')}
    >
      <Papicon icon="tune" size={16} />
      <span>{m.nav_shortcuts()}</span>
    </button>
  {/snippet}

  <div class="navsheet" class:navsheet--searching={searching}>
    <div class="navsheet__search">
      <div class="navsheet__field">
        <Papicon icon="search" size={16} class="navsheet__field-icon" />
        <input
          bind:this={searchInput}
          bind:value={query}
          type="search"
          inputmode="search"
          enterkeyhint="go"
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          placeholder={m.nav_search_pages()}
          aria-label={m.nav_search_pages()}
          onfocus={() => (searching = true)}
          onkeydown={(event) => {
            if (event.key === 'Enter' && results[0]) void go(results[0].href);
          }}
        />
        {#if query}
          <button
            type="button"
            class="navsheet__clear"
            onclick={() => { query = ''; searchInput?.focus(); }}
            aria-label={m.common_clear()}
          >
            <Papicon icon="x" size={16} />
          </button>
        {/if}
      </div>
      {#if searching}
        <button type="button" class="navsheet__cancel" onclick={cancelSearch}>
          {m.common_cancel()}
        </button>
      {/if}
    </div>

    {#if searching}
      {#if trimmed && results.length > 0}
        <ul class="navsheet__list" aria-label={m.nav_search_results()}>
          {#each results as item (item.href)}
            {@render row(item, { icon: true, context: spaceOf.get(item.href) })}
          {/each}
        </ul>
      {:else}
        {#if trimmed}
          <p class="navsheet__empty" role="status">{m.sidebar_no_results({ query: trimmed })}</p>
        {/if}
        {#if suggestions.items.length > 0}
          {@render section(suggestions.label, suggestions.items)}
        {/if}
      {/if}
    {:else}
      {#if pinnedItems.length > 0}
        {@render section(m.nav_pinned(), pinnedItems)}
      {/if}

      {#if primaryGroup}
        <ul class="navsheet__list">
          {#each primaryGroup.items as item (item.href)}
            {@render row(item, { icon: true })}
          {/each}
        </ul>
      {/if}

      {#if spaces.length > 0}
        <div class="navsheet__spaces">
          {#each spaces as space (space.key)}
            {@const expanded = openSpace === space.key}
            {@const current = activeSpaceKey === space.key}
            <button
              type="button"
              class="navsheet__space"
              class:navsheet__space--current={current}
              aria-expanded={expanded}
              aria-controls="navsheet-space-{space.key}"
              onclick={() => toggleSpace(space.key)}
            >
              <span class="navsheet__icon"><Papicon icon={space.icon} size={20} /></span>
              <span class="navsheet__label">{space.label}</span>
              <span class="navsheet__chevron" class:navsheet__chevron--open={expanded} aria-hidden="true">
                <Papicon icon="chevron-down" size={16} />
              </span>
            </button>

            {#if expanded}
              <ul id="navsheet-space-{space.key}" class="navsheet__list navsheet__thread">
                {#each space.items as item (item.href)}
                  {@render row(item, { icon: false })}
                {/each}
              </ul>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</BottomSheet>

{#snippet section(label: string, items: PageConfig[])}
  <section class="navsheet__group">
    <h3 class="navsheet__group-title">{label}</h3>
    <ul class="navsheet__list">
      {#each items as item (item.href)}
        {@render row(item, { icon: true })}
      {/each}
    </ul>
  </section>
{/snippet}

{#snippet row(item: PageConfig, opts: { icon: boolean; context?: string })}
  {@const active = isActive(item.href)}
  {@const badge = badgeFor(item)}
  {@const pinned = navigationStore.isFavorite(item.href)}
  <li class="navsheet__item" class:navsheet__item--active={active}>
    <button
      type="button"
      class="navsheet__row"
      class:navsheet__row--plain={!opts.icon}
      aria-current={active ? 'page' : undefined}
      onclick={() => go(item.href)}
    >
      {#if opts.icon}
        <span class="navsheet__icon"><Papicon icon={item.icon ?? 'circle'} size={20} /></span>
      {/if}
      <span class="navsheet__label">{item.name}</span>
      {#if opts.context}
        <span class="navsheet__context">{opts.context}</span>
      {/if}
      {#if badge > 0}
        <span class="navsheet__count">{badge > 99 ? '99+' : badge}</span>
      {/if}
    </button>

    <!-- L'etoile est une soeur du lien, pas un enfant : un bouton dans un
         bouton est invalide et les lecteurs d'ecran ne l'atteindraient pas. -->
    <button
      type="button"
      class="navsheet__pin"
      class:navsheet__pin--on={pinned}
      aria-pressed={pinned}
      aria-label={pinned ? m.nav_unfavorite() : m.nav_favorite()}
      onclick={(event) => toggleFavorite(event, item.href)}
    >
      <Papicon icon="star" size={16} class={pinned ? 'fill-current' : ''} />
    </button>
  </li>
{/snippet}

<style>
  /* Trois tailles de texte dans la feuille : le champ et les lignes (16px),
     les intitules et le contexte (12px), le titre de la feuille. */

  .navsheet {
    padding-bottom: 1rem;
  }

  /* En recherche, la feuille garde sa hauteur : sans cela elle se tassait a
     chaque lettre et le champ descendait sous le pouce. */
  .navsheet--searching {
    min-height: calc(90dvh - 6rem);
  }

  /* ── Recherche ── */

  .navsheet__search {
    position: sticky;
    z-index: 2;
    top: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.75rem;
    background: var(--surface-container-lowest);
  }

  .navsheet__field {
    position: relative;
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    align-items: center;
  }

  .navsheet__field :global(.navsheet__field-icon) {
    position: absolute;
    left: 0.75rem;
    color: var(--on-surface-variant);
    pointer-events: none;
  }

  .navsheet__field input {
    width: 100%;
    height: 2.75rem;
    padding: 0 2.75rem 0 2.5rem;
    border: 1px solid var(--outline-variant);
    border-radius: 0.75rem;
    background: var(--surface-container);
    color: var(--on-surface);
    /* 16px : en dessous, Safari iOS zoome la page au focus. */
    font-size: 1rem;
  }

  .navsheet__field input::placeholder {
    color: var(--on-surface-variant);
  }

  .navsheet__field input:focus {
    border-color: color-mix(in srgb, var(--primary-color) 55%, transparent);
    outline: none;
  }

  .navsheet__field input::-webkit-search-cancel-button {
    display: none;
  }

  .navsheet__clear {
    position: absolute;
    right: 0;
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    place-items: center;
    border-radius: 999px;
    color: var(--on-surface-variant);
  }

  .navsheet__cancel {
    min-height: 2.75rem;
    flex: none;
    padding: 0 0.25rem;
    color: var(--primary-color);
    font-size: 1rem;
    font-weight: 500;
    -webkit-tap-highlight-color: transparent;
  }

  .navsheet__empty {
    padding: 0.5rem 0.75rem 0;
    color: var(--on-surface-variant);
    font-size: 0.75rem;
  }

  /* ── Listes ── */

  .navsheet__group {
    margin-bottom: 1rem;
  }

  .navsheet__group-title {
    padding: 0.75rem 0.75rem 0.25rem;
    color: var(--on-surface-variant);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .navsheet__list {
    display: flex;
    flex-direction: column;
  }

  .navsheet__item {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 0.75rem;
  }

  .navsheet__item--active {
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
  }

  .navsheet__row,
  .navsheet__space {
    display: flex;
    min-width: 0;
    min-height: 3rem;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.25rem 0 0.75rem;
    border-radius: 0.75rem;
    color: var(--on-surface);
    font-size: 1rem;
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }

  .navsheet__row:active,
  .navsheet__space:active {
    background: var(--surface-container);
  }

  .navsheet__item--active .navsheet__row {
    color: var(--primary-color);
    font-weight: 600;
  }

  .navsheet__icon {
    display: grid;
    width: 1.25rem;
    flex: none;
    place-items: center;
    color: var(--on-surface-variant);
  }

  .navsheet__item--active .navsheet__icon,
  .navsheet__space--current .navsheet__icon {
    color: var(--primary-color);
  }

  .navsheet__label {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .navsheet__context {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    color: var(--on-surface-variant);
    font-size: 0.75rem;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .navsheet__count {
    display: grid;
    min-width: 1.25rem;
    height: 1.25rem;
    flex: none;
    padding: 0 0.25rem;
    place-items: center;
    border-radius: 999px;
    background: var(--primary-color);
    color: var(--on-primary-color);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .navsheet__pin {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    flex: none;
    place-items: center;
    border-radius: 999px;
    color: color-mix(in srgb, var(--on-surface-variant) 45%, transparent);
    -webkit-tap-highlight-color: transparent;
  }

  .navsheet__pin:active {
    background: var(--surface-container);
  }

  .navsheet__pin--on {
    color: var(--warning-color);
  }

  /* ── Espaces ── */

  .navsheet__spaces {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--outline-variant);
  }

  .navsheet__space {
    width: 100%;
    padding-right: 0.75rem;
    color: var(--on-surface-variant);
  }

  .navsheet__space--current {
    color: var(--on-surface);
    font-weight: 500;
  }

  .navsheet__chevron {
    display: grid;
    flex: none;
    place-items: center;
    color: var(--on-surface-variant);
    transform: rotate(-90deg);
    transition: transform 150ms ease;
  }

  .navsheet__chevron--open {
    transform: none;
  }

  /* Le fil de l'espace ouvert, comme dans la barre laterale : une ligne fine
     sous l'icone de l'espace relie ses pages, et la page courante y porte un
     segment de la couleur principale. */
  .navsheet__thread {
    position: relative;
    margin: 0 0 0.5rem 1.375rem;
    padding-left: 0.5rem;
  }

  .navsheet__thread::before {
    position: absolute;
    top: 0.5rem;
    bottom: 0.5rem;
    left: 0;
    width: 1px;
    content: '';
    background: var(--outline-variant);
  }

  .navsheet__thread .navsheet__item--active {
    background: transparent;
  }

  .navsheet__thread .navsheet__item--active::before {
    position: absolute;
    top: 0.75rem;
    bottom: 0.75rem;
    left: -0.5rem;
    width: 2px;
    margin-left: -0.5px;
    content: '';
    border-radius: 2px;
    background: var(--primary-color);
  }

  .navsheet__row--plain {
    min-height: 2.75rem;
  }

  /* ── En-tete ── */

  .navsheet__shortcuts {
    display: flex;
    min-height: 2.75rem;
    flex: none;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.75rem;
    border-radius: 999px;
    color: var(--primary-color);
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
  }

  .navsheet__shortcuts:active {
    background: color-mix(in srgb, var(--primary-color) 12%, transparent);
  }

  @media (prefers-reduced-motion: reduce) {
    .navsheet__chevron {
      transition: none;
    }
  }
</style>
