<script lang="ts">
  import { fade } from 'svelte/transition';
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { notificationsStore } from '../stores/notifications.svelte';
  import { sidebarStore } from '../stores/sidebar.svelte';
  import { searchStore } from '../stores/search.svelte';
  import { navigationStore, isActiveNavItem as matchNavItem, type NavGroup } from '../stores/navigation.svelte';
  import { prefetchRoute } from '../lazyRoutes';
  import { portal } from '../actions/portal';
  import { lockBodyScroll, unlockBodyScroll } from '../scrollLock';
  import type { PageConfig } from '../config/pages';
  import { resolveGuildIconSrc } from '../discordMedia';
  import { m } from '../i18n';
  import { serverSwitcherStore } from '../stores/serverSwitcher.svelte';
  import { brandingStore } from '../stores/branding.svelte';

  let isDesktop = $state(
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true,
  );

  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => { isDesktop = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  const collapsed  = $derived(sidebarStore.collapsed);
  const mobileOpen = $derived(sidebarStore.mobileOpen ?? false);
  const isCollapsed = $derived(collapsed && isDesktop);

  // Shared counter rather than a bare class toggle: a modal opened from the
  // drawer must not release the page when only one of the two closes.
  $effect(() => {
    if (isDesktop || !mobileOpen) return;
    lockBodyScroll();
    return unlockBodyScroll;
  });

  $effect(() => {
    $router.path;
    if (!isDesktop) sidebarStore.closeMobile?.();
  });

  let activeTooltip = $state<{ text: string; top: number } | null>(null);

  function showTooltip(e: MouseEvent, text: string): void {
    if (!isCollapsed) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    activeTooltip = { text, top: rect.top + rect.height / 2 };
  }

  const hideTooltip = (): void => { activeTooltip = null; };

  $effect(() => { if (!isCollapsed) activeTooltip = null; });

  const currentGuild = $derived(
    authStore.guilds.find((g) => g.id === authStore.selectedGuildId),
  );
  const currentGuildIcon = $derived(
    currentGuild ? resolveGuildIconSrc(currentGuild.id, currentGuild.icon) : null,
  );

  const isStaffServerGuild = $derived(navigationStore.isStaffServer);
  const navGroups = $derived(navigationStore.menuGroups);
  const favorites = $derived(navigationStore.favorites);

  /**
   * Le groupe « general » n'a pas d'en-tete : ses quelques pages (accueil,
   * notifications, statistiques) sont celles qu'on ouvre chaque jour, et les
   * ranger derriere un titre n'apprenait rien.
   */
  const primaryGroup = $derived(navGroups.find((g) => g.key === 'general') ?? null);
  const spaces = $derived(navGroups.filter((g) => g.key !== 'general'));

  const pinnedItems = $derived(
    favorites
      .map((href) => navGroups.flatMap((g) => g.items).find((item) => item.href === href))
      .filter((item): item is PageConfig => !!item),
  );

  function isActiveNavItem(href: string): boolean {
    return matchNavItem(href, $router.path, $router.url);
  }

  const activeSpaceKey = $derived(
    spaces.find((g) => g.items.some((i) => isActiveNavItem(i.href)))?.key ?? null,
  );

  /**
   * Un seul espace ouvert a la fois. La barre listait jusqu'a soixante-dix
   * pages d'un bloc ; elle n'en montre plus que les titres des espaces, et le
   * contenu de celui ou l'on se trouve. Ouvrir un autre espace pour y jeter un
   * oeil referme le precedent, et changer de page ramene l'espace courant.
   */
  let openSpace = $state<string | null>(null);

  $effect(() => {
    openSpace = activeSpaceKey;
  });

  function toggleSpace(key: string): void {
    openSpace = openSpace === key ? null : key;
  }

  function toggleFavorite(href: string, e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    navigationStore.toggleFavorite(href);
  }

  function openSearch(): void {
    sidebarStore.closeMobile?.();
    searchStore.show();
  }

  let swipeStartX = 0;
  let swipeStartY = 0;

  function onTouchStart(e: TouchEvent): void {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }

  function onTouchEnd(e: TouchEvent): void {
    const dx = swipeStartX - e.changedTouches[0].clientX;
    const dy = Math.abs(swipeStartY - e.changedTouches[0].clientY);

    if (dx > 60 && dy < 80) sidebarStore.closeMobile?.();
  }

  const LOGO_URL = $derived(brandingStore.logoUrl || '/favicon.svg');
  const unread = $derived(notificationsStore.unreadCount);
</script>

{#snippet unreadBadge(href: string)}
  {#if href === '/inbox' && unread > 0}
    <span
      class="min-w-4 h-4 px-1 rounded-full bg-primary text-on-primary text-2xs font-semibold leading-none flex items-center justify-center"
      aria-label="{unread} notifications non lues"
    >
      {unread > 99 ? '99+' : unread}
    </span>
  {/if}
{/snippet}

{#snippet pageLink(item: PageConfig, withIcon: boolean)}
  {@const active = isActiveNavItem(item.href)}
  <div class="nav-row group relative flex items-center rounded-lg transition-colors duration-150 {active ? 'is-active' : ''}">
    <a
      href={item.href}
      onmouseenter={() => prefetchRoute(item.href)}
      onfocus={() => prefetchRoute(item.href)}
      aria-current={active ? 'page' : undefined}
      class="flex-1 flex items-center gap-2.5 min-w-0 py-1.5 {withIcon ? 'pl-2.5' : 'pl-3'} pr-1.5"
    >
      {#if withIcon}
        <Papicon icon={item.icon} size={16} class="shrink-0 nav-row__icon" />
      {/if}
      <span class="flex-1 min-w-0 truncate text-body-sm">{item.name}</span>
      {@render unreadBadge(item.href)}
    </a>
    <button
      type="button"
      onclick={(e) => toggleFavorite(item.href, e)}
      aria-label={favorites.includes(item.href) ? m.nav_unfavorite() : m.nav_favorite()}
      aria-pressed={favorites.includes(item.href)}
      class="nav-row__pin mr-1 flex items-center justify-center w-6 h-6 rounded-md shrink-0 transition-opacity duration-150
        {favorites.includes(item.href) ? 'opacity-100 text-warning' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-on-surface-variant/50 hover:text-warning'}"
    >
      <Papicon icon="star" size={12} class={favorites.includes(item.href) ? 'fill-current' : ''} />
    </button>
  </div>
{/snippet}

{#snippet railLink(href: string, icon: string, label: string, active: boolean)}
  <a
    {href}
    onmouseenter={(e) => { showTooltip(e, label); prefetchRoute(href); }}
    onfocus={() => prefetchRoute(href)}
    onmouseleave={hideTooltip}
    aria-label={label}
    aria-current={active ? 'page' : undefined}
    class="relative flex items-center justify-center w-full h-10 rounded-lg transition-colors duration-150
      {active ? 'text-primary bg-primary/10' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}"
  >
    <Papicon {icon} size={18} />
    {#if href === '/inbox' && unread > 0}
      <span class="absolute top-1.5 right-2.5 w-2 h-2 rounded-full bg-primary" aria-hidden="true"></span>
    {/if}
  </a>
{/snippet}

{#if !isDesktop && mobileOpen}
  <div
    role="presentation"
    class="mobile-sidebar-backdrop fixed inset-0 bg-black/30 z-40"
    transition:fade={{ duration: 150 }}
    onclick={() => sidebarStore.closeMobile?.()}
  ></div>
{/if}

<aside
  id="dashboard-sidebar"
  data-telemetry-nav="sidebar"
  inert={!isDesktop && !mobileOpen}
  aria-hidden={!isDesktop && !mobileOpen}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  class="
    fixed left-0 top-0 h-dvh flex flex-col z-50
    bg-surface-container-lowest
    border-r border-outline-variant
    will-change-transform transition-[transform,width] duration-200 ease-in-out
    app-sidebar w-72
    {!isDesktop && mobileOpen ? 'translate-x-0 shadow-lg' : ''}
    {!isDesktop && !mobileOpen ? '-translate-x-full' : ''}
    lg:translate-x-0 lg:shadow-none
    {isCollapsed ? 'lg:w-[4.5rem]' : 'lg:w-60'}
  "
>

  <button
    type="button"
    onclick={() => sidebarStore.toggle()}
    class="
      absolute -right-3 top-14 z-10
      w-6 h-6 rounded-full border border-outline-variant
      bg-surface-container-lowest shadow-sm
      hidden lg:flex items-center justify-center
      transition-colors duration-150
      hover:bg-surface-container hover:text-primary
      text-on-surface-variant
    "
    aria-label={isCollapsed ? 'Déplier le menu' : 'Replier le menu'}
  >
    <div class="transition-transform duration-200 {isCollapsed ? 'rotate-180' : ''}">
      <Papicon icon="chevrons-left" size={12} />
    </div>
  </button>

  <div class="flex items-center gap-2.5 px-4 h-14 shrink-0 {isCollapsed ? 'lg:justify-center lg:px-0' : ''}">
    <img alt={brandingStore.brandName} src={LOGO_URL} class="w-7 h-7 shrink-0 object-cover rounded-lg" />

    {#if !isCollapsed}
      <span class="flex-1 min-w-0 text-sm font-semibold text-on-surface truncate font-headline">{brandingStore.brandName}</span>
      {#if isStaffServerGuild}
        <span class="shrink-0 px-1.5 py-0.5 rounded-md text-2xs font-medium bg-primary/10 text-primary">Staff</span>
      {/if}

      <button
        type="button"
        onclick={() => sidebarStore.closeMobile?.()}
        class="flex items-center justify-center w-8 h-8 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors lg:hidden"
        aria-label="Fermer le menu"
      >
        <Papicon icon="x" size={16} />
      </button>
    {/if}
  </div>

  {#if !isDesktop && !isCollapsed}
    <button
      type="button"
      onclick={() => {
        sidebarStore.closeMobile();
        serverSwitcherStore.show();
      }}
      disabled={authStore.guilds.length <= 1}
      class="mx-3 mb-3 flex min-h-12 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 text-left transition-colors hover:bg-surface-container-high disabled:cursor-default"
      aria-label={authStore.guilds.length > 1 ? 'Changer de serveur' : 'Serveur actuel'}
    >
      {#if currentGuildIcon}
        <img src={currentGuildIcon} alt="" width="32" height="32" class="h-8 w-8 shrink-0 rounded-lg object-cover" />
      {:else}
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">
          {currentGuild?.name?.charAt(0) ?? '?'}
        </span>
      {/if}
      <span class="min-w-0 flex-1 block truncate text-sm font-semibold text-on-surface">{currentGuild?.name ?? 'Serveur'}</span>
      {#if authStore.guilds.length > 1}
        <Papicon icon="chevron-right" size={16} class="shrink-0 text-on-surface-variant/60" />
      {/if}
    </button>
  {/if}

  <!-- Une seule recherche dans tout le dashboard : la barre filtrait le menu
       pendant que la palette cherchait les memes pages, avec deux raccourcis
       differents. Ce bouton ouvre la palette, qui sait aussi lancer des actions. -->
  <div class="px-3 pb-3 {isCollapsed ? 'lg:px-2' : ''}">
    <button
      type="button"
      onclick={openSearch}
      onmouseenter={(e) => showTooltip(e, m.nav_search_pages())}
      onmouseleave={hideTooltip}
      aria-label={m.nav_search_pages()}
      class="nav-search w-full flex items-center gap-2 h-9 rounded-lg border border-outline-variant bg-surface-container-low text-on-surface-variant hover:text-on-surface hover:border-outline transition-colors
        {isCollapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3'}"
    >
      <Papicon icon="search" size={14} class="shrink-0" />
      {#if !isCollapsed}
        <span class="flex-1 text-left text-body-sm">Rechercher</span>
        <kbd class="hidden lg:inline text-2xs font-medium text-on-surface-variant/70 font-body">Ctrl K</kbd>
      {/if}
    </button>
  </div>

  <nav
    class="flex-1 overflow-y-auto overscroll-contain scrollbar-hide pb-3 {isCollapsed ? 'lg:px-2' : 'px-3'}"
    aria-label="Navigation principale"
  >
    {#if isCollapsed}
      <div class="flex flex-col gap-1">
        {#each primaryGroup?.items ?? [] as item (item.href)}
          {@render railLink(item.href, item.icon ?? 'circle', item.name, isActiveNavItem(item.href))}
        {/each}
        <div class="h-px bg-outline-variant my-2" aria-hidden="true"></div>
        {#each spaces as space (space.key)}
          {@render railLink(space.items[0].href, space.icon, space.label, activeSpaceKey === space.key)}
        {/each}
      </div>
    {:else}
      {#if pinnedItems.length > 0}
        <p class="px-3 pb-1 text-2xs font-medium text-on-surface-variant/70">{m.nav_pinned()}</p>
        <div class="space-y-px mb-3">
          {#each pinnedItems as item (item.href)}
            {@render pageLink(item, true)}
          {/each}
        </div>
      {/if}

      {#if primaryGroup}
        <div class="space-y-px">
          {#each primaryGroup.items as item (item.href)}
            {@render pageLink(item, true)}
          {/each}
        </div>
      {/if}

      {#if spaces.length > 0}
        <div class="mt-4 space-y-px">
          {#each spaces as space (space.key)}
            {@const open = openSpace === space.key}
            {@const current = activeSpaceKey === space.key}
            <button
              type="button"
              onclick={() => toggleSpace(space.key)}
              aria-expanded={open}
              aria-controls="nav-space-{space.key}"
              class="nav-space w-full flex items-center gap-2.5 pl-2.5 pr-2 py-1.5 rounded-lg text-left transition-colors hover:bg-surface-container
                {current ? 'text-on-surface' : 'text-on-surface-variant hover:text-on-surface'}"
            >
              <Papicon icon={space.icon} size={16} class="shrink-0 {current ? 'text-primary' : 'text-on-surface-variant/70'}" />
              <span class="flex-1 min-w-0 truncate text-body-sm {current ? 'font-medium' : ''}">{space.label}</span>
              <span
                aria-hidden="true"
                class="text-on-surface-variant/40 transition-transform duration-150 {open ? '' : '-rotate-90'}"
              >
                <Papicon icon="chevron-down" size={12} />
              </span>
            </button>

            {#if open}
              <div id="nav-space-{space.key}" class="nav-thread relative ml-[1.1rem] pl-2 mt-px mb-2 space-y-px">
                {#each space.items as item (item.href)}
                  {@render pageLink(item, false)}
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </nav>

  {#if authStore.isBotAdmin || navigationStore.canViewBilling}
    <div class="border-t border-outline-variant {isCollapsed ? 'lg:px-2 py-2' : 'px-3 py-2'} space-y-px">
      {#if navigationStore.canViewBilling}
        {#if isCollapsed}
          {@render railLink('/billing', 'credit-card', m.nav_billing(), isActiveNavItem('/billing'))}
        {:else}
          {@render pageLink({ name: m.nav_billing(), icon: 'credit-card', href: '/billing' }, true)}
        {/if}
      {/if}

      {#if authStore.isBotAdmin}
        {#if isCollapsed}
          {@render railLink('/admin', 'lock', m.nav_administration(), isActiveNavItem('/admin'))}
        {:else}
          {@render pageLink({ name: m.nav_administration(), icon: 'lock', href: '/admin' }, true)}
        {/if}
      {/if}
    </div>
  {/if}
</aside>

{#if activeTooltip && isCollapsed}
  <div
    use:portal
    role="tooltip"
    class="fixed z-100 -translate-y-1/2 pointer-events-none bg-surface-container-highest text-on-surface border border-outline-variant rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap shadow-sm animate-in fade-in"
    style="left: calc(4.5rem + 8px); top: {activeTooltip.top}px"
  >
    {activeTooltip.text}
  </div>
{/if}

<style>
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

  .nav-row {
    color: var(--on-surface-variant);
  }

  .nav-row:hover {
    color: var(--on-surface);
    background: var(--surface-container);
  }

  .nav-row :global(.nav-row__icon) {
    color: color-mix(in srgb, var(--on-surface-variant) 75%, transparent);
  }

  .nav-row.is-active {
    color: var(--on-surface);
    background: color-mix(in srgb, var(--primary-color) 10%, transparent);
    font-weight: 500;
  }

  .nav-row.is-active :global(.nav-row__icon) {
    color: var(--primary-color);
  }

  /* Le fil de l'espace ouvert : une ligne fine relie ses pages a son titre,
     et la page courante y est marquee d'un segment de la couleur principale.
     C'est le seul ornement de la barre, et il dit ou l'on se trouve. */
  .nav-thread::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0.25rem;
    bottom: 0.25rem;
    width: 1px;
    background: var(--outline-variant);
  }

  .nav-thread .nav-row.is-active::before {
    content: "";
    position: absolute;
    left: -0.5rem;
    top: 0.375rem;
    bottom: 0.375rem;
    width: 2px;
    margin-left: -0.5px;
    border-radius: 2px;
    background: var(--primary-color);
  }

  .nav-thread .nav-row.is-active {
    background: transparent;
    color: var(--primary-color);
  }

  .nav-thread .nav-row.is-active:hover {
    background: var(--surface-container);
  }
</style>
