<script lang="ts">
  import Sidebar from './Sidebar.svelte';
  import Navbar from './Navbar.svelte';
  import Breadcrumbs from './Breadcrumbs.svelte';
  import ServerSwitcherModal from './ServerSwitcherModal.svelte';
  import UnsavedChangesBar from './UnsavedChangesBar.svelte';
  import TutorialWelcome from './TutorialWelcome.svelte';
  import GuideSpotlight from './GuideSpotlight.svelte';
  import MobileTopBar from './mobile/MobileTopBar.svelte';
  import MobileTabBar from './mobile/MobileTabBar.svelte';
  import MobileNavSheet from './mobile/MobileNavSheet.svelte';
  import MobileAccountSheet from './mobile/MobileAccountSheet.svelte';
  import MobileTabEditor from './mobile/MobileTabEditor.svelte';
  import DemoBanner from './DemoBanner.svelte';
  import DemoTour from './DemoTour.svelte';
  import { DEMO_MODE } from '../demo/mode';

  import { onMount, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { router } from 'tinro';
  import { dashboardLifecycle } from '../dashboardLifecycle';
  import { sidebarStore } from '../stores/sidebar.svelte';
  import { feedbackModal } from '../stores/feedbackModal.svelte';
  import { getPageStatus } from '../config/pages';
  import { historyStore } from '../stores/history.svelte';
  import { serverSwitcherStore } from '../stores/serverSwitcher.svelte';
  import { searchStore } from '../stores/search.svelte';
  import { unsavedChanges } from '../stores/unsavedChanges.svelte';
  import { confirmDialog } from '../stores/confirmDialog.svelte';
  import { isMobile, isPhone } from '../stores/media.svelte';
  import { navigationStore } from '../stores/navigation.svelte';
  import { mobileNav } from '../stores/mobileNav.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { onboardingStore } from '../stores/tutorial.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { m } from '../i18n';
  import { responsiveTables } from '../actions/responsiveTables';
  import { getMobilePageLayout, getPageKey } from '../mobilePageContext';

  const { children }: { children?: Snippet } = $props();

  onMount(() => {
    dashboardLifecycle.init();

    if (DEMO_MODE) {
      const p = $router.path;
      router.goto(p === '/demo' || p === '/demo/' ? '/' : (p || '/'), true);
    }

    // Block browser tab/window close when there are unsaved changes
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unsavedChanges.isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      dashboardLifecycle.destroy();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  });

  $effect(() => {
    const id = authStore.selectedGuildId;
    if (!id) return;
    onboardingStore.initialize(id);
  });

  // Favourites are per guild and shared by the sidebar and the mobile sheet.
  // untrack keeps the store's own writes from re-triggering this effect.
  $effect(() => {
    void authStore.selectedGuildId;
    void (dashboardStore.state as { sidebarFavorites?: unknown }).sidebarFavorites;
    untrack(() => navigationStore.hydrateFavorites());
  });

  $effect(() => {
    const path = $router.path;
    const url = $router.url;
    if (path !== '/' && authStore.isAuthenticated) {
      void dashboardStore.ensureFullState();
    }
    if (!onboardingStore.initialized) return;
    const qs = url.includes('?') ? url.split('?')[1] : '';
    onboardingStore.onPageVisit(path, qs);
  });

  // Every route change closes the mobile sheet and feeds the "recent pages"
  // shortcut in the navigation sheet.
  $effect(() => {
    const path = $router.path;
    untrack(() => {
      mobileNav.close();
      navigationStore.noteVisit(path);
    });
  });

  const collapsed = $derived(sidebarStore.collapsed);

  // Reactively calculate the status of the current page
  const pageStatus = $derived(getPageStatus($router.path, $router.url));
  const mobilePageLayout = $derived(getMobilePageLayout($router.path));
  const pageKey = $derived(getPageKey($router.path));

  function handleGlobalKeyDown(e: KeyboardEvent) {
    const activeEl = document.activeElement;
    const isEditing = activeEl && (
      activeEl.tagName === 'INPUT' || 
      activeEl.tagName === 'TEXTAREA' || 
      activeEl.getAttribute('contenteditable') === 'true'
    );

    // Ctrl+G: Sélecteur de serveur
    const isG = e.key === 'g' || e.key === 'G';
    if ((e.ctrlKey || e.metaKey) && isG) {
      e.preventDefault();
      searchStore.close();
      feedbackModal.close();
      serverSwitcherStore.toggle();
      onboardingStore.markShortcutUsed();
      return;
    }

    if (isEditing) return;

    const isZ = e.key === 'z' || e.key === 'Z';
    const isY = e.key === 'y' || e.key === 'Y';

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && isZ) {
      e.preventDefault();
      historyStore.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && isZ) {
      e.preventDefault();
      historyStore.redo();
    } else if ((e.ctrlKey || e.metaKey) && isY) {
      e.preventDefault();
      historyStore.redo();
    }
  }

  // Expose a navigation guard used by Sidebar & other nav elements
  export async function guardedNavigate(href: string) {
    if (!unsavedChanges.isDirty) {
      router.goto(href);
      return;
    }
    const confirmed = await confirmDialog.ask({
      title: m.banner_unsaved_title(),
      description: m.banner_unsaved_desc({ page: unsavedChanges.pageLabel }),
      confirmLabel: m.banner_unsaved_leave(),
      variant: 'warning',
    });
    if (confirmed) {
      unsavedChanges.clear();
      router.goto(href);
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKeyDown} />

<a class="skip-link" href="#main-content">Aller au contenu</a>

<div class="app-shell flex min-h-screen bg-background text-on-background transition-colors duration-200">
  {#if !$isPhone}
    <Sidebar />
  {/if}

  <div class="app-content min-w-0 flex-1 flex flex-col transition-all duration-200 {$isMobile ? 'ml-0' : (collapsed ? 'ml-18' : 'ml-60')}">
    {#if $isPhone}
      <MobileTopBar />
    {:else}
      <Navbar />
    {/if}

    <main
      id="main-content"
      use:responsiveTables
      data-mobile-layout={mobilePageLayout}
      data-page={pageKey}
      class="app-main px-8 py-6 pb-20 max-w-[1400px] w-full mx-auto"
    >
      <DemoBanner />
      {#if !$isPhone}
        <Breadcrumbs />
      {/if}
      {#if pageStatus?.wip}
        <!-- Render WIP Overlay over blurred content -->
        <div class="relative w-full min-h-125">
          <div class="filter blur-sm pointer-events-none select-none opacity-20">
            {@render children?.()}
          </div>

          <div class="absolute inset-0 flex items-center justify-center p-6 z-10">
            <div class="max-w-md w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-8 text-center shadow-sm">
              <div class="w-12 h-12 rounded-lg bg-warning/10 text-warning flex items-center justify-center mb-4 mx-auto">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>

              <h2 class="text-lg font-semibold text-on-surface mb-1">
                {pageStatus.wipMessage ? m.banner_premium_title() : m.banner_wip_title()}
              </h2>
              <p class="text-sm text-on-surface-variant mb-5">
                {#if pageStatus.wipMessage}
                  {pageStatus.wipMessage}
                {:else}
                  {m.banner_wip_desc({ page: pageStatus.name })}
                {/if}
              </p>

              <a href="/" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium hover:opacity-90 transition-opacity">
                {m.banner_back_home()}
              </a>
            </div>
          </div>
        </div>
      {:else}
        <!-- Ni bandeau « bêta » ni fiche « Guide » au-dessus des pages : le
             premier repetait le menu, la seconde le titre et la description
             de la page. Le statut bêta se lit a cote du titre (ModulePage). -->
        {@render children?.()}
      {/if}
    </main>
  </div>

  {#if $isPhone}
    <MobileTabBar />
    <MobileNavSheet />
    <MobileAccountSheet />
    <MobileTabEditor />
  {/if}

  <ServerSwitcherModal />
  <UnsavedChangesBar />
  <TutorialWelcome />
  <GuideSpotlight />
  {#if DEMO_MODE}
    <DemoTour />
  {/if}
</div>
