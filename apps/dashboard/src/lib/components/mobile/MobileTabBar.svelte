<script lang="ts">
  import { router } from 'tinro';
  import { m } from '../../i18n';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { mobileNav } from '../../stores/mobileNav.svelte';
  import { mobileTabs } from '../../stores/mobileTabs.svelte';
  import { navigationStore, isActiveNavItem } from '../../stores/navigation.svelte';
  import { notificationsStore } from '../../stores/notifications.svelte';
  import { unsavedChanges } from '../../stores/unsavedChanges.svelte';
  import Papicon from '../Papicon.svelte';

  const tabs = $derived(mobileTabs.resolve(navigationStore.allItems));
  const isNavSheetOpen = $derived(mobileNav.sheet === 'nav');

  function isActive(href: string): boolean {
    return !isNavSheetOpen && isActiveNavItem(href, $router.path, $router.url);
  }

  function badgeFor(href: string): number {
    return href === '/inbox' ? notificationsStore.unreadCount : 0;
  }

  async function navigate(event: MouseEvent, href: string) {
    event.preventDefault();
    if (consumeLongPress()) return;
    mobileNav.close();

    if (isActiveNavItem(href, $router.path, $router.url)) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
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

    router.goto(href);
  }

  function openMore() {
    if (consumeLongPress()) return;
    mobileNav.toggle('nav');
  }

  /**
   * Holding the bar opens its editor, the gesture people already expect from a
   * phone home screen. The navigation sheet also opens it from a plain button
   * in its header, so nobody has to discover the gesture to reach it.
   */
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_SLOP = 10;

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressOrigin = { x: 0, y: 0 };
  let longPressFired = false;

  function cancelLongPress() {
    if (pressTimer === null) return;
    clearTimeout(pressTimer);
    pressTimer = null;
  }

  /** The tap that ends a long press must not also navigate. */
  function consumeLongPress(): boolean {
    if (!longPressFired) return false;
    longPressFired = false;
    return true;
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse') return;
    longPressFired = false;
    pressOrigin = { x: event.clientX, y: event.clientY };
    cancelLongPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressFired = true;
      navigator.vibrate?.(12);
      mobileNav.open('tabs');
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event: PointerEvent) {
    if (pressTimer === null) return;
    const moved =
      Math.abs(event.clientX - pressOrigin.x) > LONG_PRESS_SLOP ||
      Math.abs(event.clientY - pressOrigin.y) > LONG_PRESS_SLOP;
    if (moved) cancelLongPress();
  }

  /**
   * Android resizes the visual viewport when the soft keyboard opens, which
   * would leave a fixed bar stranded in the middle of the screen. Hide it while
   * the keyboard is up.
   */
  let keyboardOpen = $state(false);

  $effect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const onResize = () => {
      keyboardOpen = window.innerHeight - viewport.height > 160;
    };

    viewport.addEventListener('resize', onResize);
    onResize();
    return () => viewport.removeEventListener('resize', onResize);
  });
</script>

{#if tabs.length > 0}
  <nav
    class="tabbar"
    class:tabbar--hidden={keyboardOpen}
    aria-label={m.nav_group_general()}
    aria-hidden={keyboardOpen}
    inert={keyboardOpen}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={cancelLongPress}
    onpointercancel={cancelLongPress}
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each tabs as tab (tab.href)}
      {@const badge = badgeFor(tab.href)}
      <a
        href={tab.href}
        class="tabbar__tab"
        class:tabbar__tab--active={isActive(tab.href)}
        aria-current={isActive(tab.href) ? 'page' : undefined}
        onclick={(event) => navigate(event, tab.href)}
      >
        <span class="tabbar__glyph">
          <Papicon icon={tab.icon ?? 'circle'} size={20} />
          {#if badge > 0}
            <span class="tabbar__badge" aria-hidden="true">{badge > 9 ? '9+' : badge}</span>
          {/if}
        </span>
        <span class="tabbar__label">{tab.name}</span>
        {#if badge > 0}
          <span class="sr-only">{badge}</span>
        {/if}
      </a>
    {/each}

    <button
      type="button"
      class="tabbar__tab"
      class:tabbar__tab--active={isNavSheetOpen}
      aria-expanded={isNavSheetOpen}
      aria-haspopup="dialog"
      onclick={openMore}
    >
      <span class="tabbar__glyph">
        <Papicon icon={isNavSheetOpen ? 'x' : 'menu'} size={20} />
      </span>
      <span class="tabbar__label">{m.nav_more()}</span>
    </button>
  </nav>
{/if}

<style>
  .tabbar {
    position: fixed;
    z-index: 45;
    right: 0;
    bottom: 0;
    left: 0;
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    align-items: stretch;
    padding: 0.25rem 0 calc(0.25rem + env(safe-area-inset-bottom));
    border-top: 1px solid var(--outline-variant);
    background: color-mix(in srgb, var(--surface-container-lowest) 88%, transparent);
    transition: transform 200ms ease, opacity 200ms ease;
    -webkit-backdrop-filter: blur(20px) saturate(1.6);
    backdrop-filter: blur(20px) saturate(1.6);
    /* A long press edits the bar, so suppress the browser's own hold menu. */
    -webkit-touch-callout: none;
    user-select: none;
  }

  .tabbar--hidden {
    opacity: 0;
    pointer-events: none;
    transform: translateY(100%);
  }

  .tabbar__tab {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 3.25rem;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    color: var(--on-surface-variant);
    transition: color 150ms ease;
    -webkit-tap-highlight-color: transparent;
  }

  .tabbar__tab--active {
    color: var(--on-surface);
  }

  /* L'onglet actif porte une pastille derriere son icone : une couleur seule
     ne se lit pas en plein soleil, et le trait de 3px d'avant passait
     inapercu. */
  .tabbar__glyph {
    position: relative;
    display: grid;
    width: 3.5rem;
    height: 2rem;
    place-items: center;
    border-radius: 999px;
    transition: background-color 150ms ease, transform 150ms ease;
  }

  .tabbar__tab--active .tabbar__glyph {
    background: color-mix(in srgb, var(--primary-color) 16%, transparent);
    color: var(--primary-color);
  }

  .tabbar__tab:active .tabbar__glyph {
    transform: scale(0.94);
  }

  /* 11px, le plancher du dashboard. Les libelles du menu ont ete raccourcis
     pour tenir dans un cinquieme d'ecran sans etre coupes. */
  .tabbar__label {
    max-width: 100%;
    overflow: hidden;
    padding: 0 0.125rem;
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tabbar__tab--active .tabbar__label {
    font-weight: 600;
  }

  .tabbar__badge {
    position: absolute;
    top: -0.125rem;
    right: 0.5rem;
    display: grid;
    min-width: 1.125rem;
    height: 1.125rem;
    padding: 0 0.25rem;
    place-items: center;
    border: 2px solid var(--surface-container-lowest);
    border-radius: 999px;
    background: var(--primary-color);
    color: var(--on-primary-color);
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Landscape phones have almost no vertical room; drop the labels. */
  @media (max-height: 460px) and (orientation: landscape) {
    .tabbar__label {
      display: none;
    }

    .tabbar__tab {
      min-height: 2.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tabbar,
    .tabbar__glyph {
      transition: none;
    }
  }
</style>
