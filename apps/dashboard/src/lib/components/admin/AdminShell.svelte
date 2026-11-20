<script lang="ts" module>
  import type { Snippet } from 'svelte';

  // Compteur partage : en passant d'une page admin a l'autre, la coquille
  // suivante se monte avant que la precedente ait fini de se demonter.
  let mounted = 0;

  export const ADMIN_SHELL_HOST_KEY = Symbol('admin-shell-host');

  export interface AdminShellHeaderProps {
    title?: string;
    description?: string;
    heading?: string;
    backHref?: string;
    backLabel?: string;
    lead?: Snippet;
    actions?: Snippet;
  }

  export interface AdminShellHostContext {
    setHeader: (next: AdminShellHeaderProps) => void;
    clearHeader: () => void;
  }
</script>

<script lang="ts">
  /**
   * Coquille de la console admin.
   *
   * Plein ecran, hors du cadre du dashboard serveur. La structure est celle du
   * tableau de bord de tafac (cf. admin-theme.css) : une barre laterale
   * flottante en carte arrondie, aux entrees en pilule ; un bandeau teinte
   * derriere le titre de la page ; sur petit ecran, une barre d'onglets
   * flottante en bas.
   *
   * Deux niveaux de navigation seulement : l'espace (barre laterale), puis la
   * vue dans cet espace (pilules sous le titre).
   */
  import { getContext, onMount, untrack } from 'svelte';
  import { router } from 'tinro';
  import Papicon from '../Papicon.svelte';
  import { brandingStore } from '../../stores/branding.svelte';
  import { searchStore } from '../../stores/search.svelte';
  import { authStore } from '../../stores/auth.svelte';
  import { resolveUserAvatarSrc } from '../../discordMedia';
  import { prefetchRoute } from '../../lazyRoutes';
  import { m } from '../../i18n';
  import { ADMIN_SPACES, spaceForPath, tabForPath } from './adminNav';
  import { adminHealth, watchAdminHealth } from './adminHealth.svelte';
  import './admin-theme.css';

  const {
    title = '',
    description = '',
    heading = '',
    backHref = '',
    backLabel = '',
    lead,
    actions,
    children,
    isHost = false,
  }: AdminShellHeaderProps & {
    children?: Snippet;
    isHost?: boolean;
  } = $props();

  const host = untrack(() => (isHost ? undefined : getContext<AdminShellHostContext | undefined>(ADMIN_SHELL_HOST_KEY)));

  $effect(() => {
    if (!host) return;
    host.setHeader({ title, description, heading, backHref, backLabel, lead, actions });
  });

  onMount(() => {
    if (host) {
      return () => host.clearHeader();
    }
    mounted += 1;
    document.documentElement.classList.add('admin-theme');
    const stopHealth = watchAdminHealth();
    // Precharge en douceur les entrees principales pour une navigation instantanee.
    const idleTimer = setTimeout(() => {
      for (const s of ADMIN_SPACES) prefetchRoute(s.tabs[0].path);
    }, 350);
    return () => {
      clearTimeout(idleTimer);
      stopHealth();
      mounted -= 1;
      // Une image plus tard : si une autre page admin a pris le relais, on garde le theme.
      requestAnimationFrame(() => {
        if (mounted === 0) document.documentElement.classList.remove('admin-theme');
      });
    };
  });

  const space = $derived(spaceForPath($router.path));
  const activeTab = $derived(tabForPath(space, $router.path));

  $effect(() => {
    document.title = `${title || heading || activeTab.label} · Admin · ${brandingStore.brandName}`;
  });

  // ── Sante, resumee en une phrase ──────────────────────────────────────────
  const health = $derived(adminHealth.data);
  const heapPercent = $derived(health ? Math.round((health.heapUsed / health.heapTotal) * 100) : 0);
  const offlineShards = $derived(health ? health.shardCount - health.onlineShardCount : 0);

  const status = $derived.by<{ tone: 'ok' | 'warn' | 'bad'; label: string }>(() => {
    if (adminHealth.error) return { tone: 'bad', label: 'API injoignable' };
    if (!health) return { tone: 'ok', label: 'Vérification…' };
    if (offlineShards > 0) return { tone: 'bad', label: `${offlineShards} shard${offlineShards > 1 ? 's' : ''} hors ligne` };
    if (heapPercent > 85) return { tone: 'warn', label: `Mémoire à ${heapPercent} %` };
    if (health.averageShardPing > 250) return { tone: 'warn', label: `Latence ${health.averageShardPing} ms` };
    return { tone: 'ok', label: 'Tout va bien' };
  });

  const statusDot = { ok: 'bg-success', warn: 'bg-warning', bad: 'bg-error' } as const;
  const userAvatar = $derived(resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar));
</script>

{#if host}
  {@render children?.()}
{:else}
<div class="admin-console admin-wash min-h-screen bg-background text-on-surface">
  <a class="skip-link" href="#main-content">{m.mlx_skip()}</a>

  <!-- Barre laterale flottante : les six espaces -->
  <aside class="sidebar hidden lg:flex fixed top-3 left-3 bottom-3 z-30 w-[264px] flex-col justify-between gap-6 p-5 overflow-y-auto" aria-label="Navigation de la console admin">
    <div class="flex flex-col gap-6">
      <a href="/admin" onpointerenter={() => prefetchRoute('/admin')} class="flex items-baseline gap-2 px-3 pt-1 rounded-lg focus-visible:outline-2 focus-visible:outline-primary">
        <span class="font-headline text-[24px] font-bold tracking-tight leading-none truncate">{brandingStore.brandName}</span>
        <span class="text-xs font-semibold text-on-surface-variant">admin</span>
      </a>

      <nav class="flex flex-col gap-0.5">
        {#each ADMIN_SPACES as item (item.id)}
          {@const active = item.id === space.id}
          <a
            href={item.tabs[0].path}
            onpointerenter={() => prefetchRoute(item.tabs[0].path)}
            onfocus={() => prefetchRoute(item.tabs[0].path)}
            aria-current={active ? 'page' : undefined}
            class="navitem admin-press flex items-center gap-2.5 h-10 px-3 rounded-full text-base font-medium leading-6 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-primary
              {active ? 'navitem--active' : 'hover:bg-on-surface/8'}"
          >
            <Papicon icon={item.icon} size={18} />
            {item.label}
          </a>
        {/each}
      </nav>
    </div>

    <div class="flex flex-col gap-1">
      <button
        type="button"
        onclick={() => searchStore.show()}
        class="admin-press flex items-center gap-2.5 h-10 px-3 rounded-full text-base font-medium text-left hover:bg-on-surface/8 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Papicon icon="Search" size={18} />
        <span class="flex-1">Rechercher</span>
        <kbd class="font-mono text-xs text-on-surface-variant">⌘K</kbd>
      </button>
      <a href="/" class="admin-press flex items-center gap-2.5 h-10 px-3 rounded-full text-base font-medium hover:bg-on-surface/8 focus-visible:outline-2 focus-visible:outline-primary">
        <Papicon icon="ArrowLeft" size={18} />
        {m.d4_dashboard()}
      </a>
      <div class="h-px bg-on-surface/8 my-2"></div>
      <a
        href="/admin/shards"
        class="admin-press flex items-center gap-2.5 min-h-10 px-3 py-1.5 rounded-2xl hover:bg-on-surface/8 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span class="w-2 h-2 shrink-0 rounded-full {statusDot[status.tone]}"></span>
        <span class="min-w-0">
          <span class="block text-sm font-semibold leading-tight">{status.label}</span>
          {#if health}
            <span class="block text-xs text-on-surface-variant tabular-nums truncate">
              {health.onlineShardCount}/{health.shardCount} shards · {health.averageShardPing} ms · {heapPercent} %
            </span>
          {/if}
        </span>
      </a>
      {#if authStore.user}
        <div class="flex items-center gap-2.5 px-3 pt-2 pb-0.5 min-w-0">
          {#if userAvatar}
            <img
              src={userAvatar}
              alt=""
              class="w-7 h-7 rounded-full object-cover shrink-0 border border-outline-variant/40"
            />
          {:else}
            <span class="w-7 h-7 rounded-full shrink-0 bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">
              {(authStore.user.username ?? 'A').slice(0, 1).toUpperCase()}
            </span>
          {/if}
          <div class="min-w-0">
            <p class="text-xs font-semibold text-on-surface truncate">{authStore.user.username}</p>
            <p class="text-2xs text-on-surface-variant leading-tight">Super-admin</p>
          </div>
        </div>
      {/if}
    </div>
  </aside>

  <div class="lg:pl-[288px]">
    <!-- Bandeau teinte derriere l'en-tete de page -->
    <div class="band">
      <div class="mx-auto max-w-[1320px] px-4 sm:px-6 pt-5 lg:pt-9 pb-5">
        <!-- Petit ecran : pas de barre laterale, etat et raccourcis montent ici. -->
        <div class="lg:hidden flex items-center justify-between mb-4">
          <a href="/admin" class="flex items-baseline gap-2">
            <span class="font-headline text-xl font-bold tracking-tight leading-none">{brandingStore.brandName}</span>
            <span class="text-xs font-semibold text-on-surface-variant">admin</span>
          </a>
          <span class="flex items-center gap-1">
            <span class="w-2 h-2 rounded-full mr-1 {statusDot[status.tone]}" title={status.label}></span>
            <button
              type="button"
              onclick={() => searchStore.show()}
              aria-label={m.d4_search_or_navigate()}
              class="admin-press w-10 h-10 rounded-full flex items-center justify-center hover:bg-on-surface/8"
            >
              <Papicon icon="Search" size={18} />
            </button>
            <a href="/" aria-label={m.d4_dashboard()} class="admin-press w-10 h-10 rounded-full flex items-center justify-center hover:bg-on-surface/8">
              <Papicon icon="X" size={18} />
            </a>
          </span>
        </div>

        {#if backHref}
          <a
            href={backHref}
            class="admin-press inline-flex items-center gap-1.5 h-8 pl-2 pr-3 -ml-2 mb-3 rounded-full text-body-sm font-semibold text-on-surface-variant hover:bg-on-surface/8 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Papicon icon="ArrowLeft" size={14} />
            {backLabel || space.label}
          </a>
        {/if}

        <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div class="flex items-center gap-4 min-w-0">
            {@render lead?.()}
            <div class="min-w-0">
              <h1 class="font-headline text-[32px] sm:text-[40px] font-bold tracking-[-0.02em] leading-[1.05] truncate">{heading || space.label}</h1>
              {#if description}
                <p class="text-[15px] text-on-surface-variant mt-2 max-w-2xl leading-relaxed">{description}</p>
              {/if}
            </div>
          </div>
          {#if actions}
            <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
          {/if}
        </div>

        {#if !backHref && space.tabs.length > 1}
          <nav class="tabs flex gap-1 mt-5 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto" aria-label="Vues de l’espace {space.label}">
            {#each space.tabs as tab (tab.path)}
              {@const active = tab === activeTab}
              <a
                href={tab.path}
                onpointerenter={() => prefetchRoute(tab.path)}
                onfocus={() => prefetchRoute(tab.path)}
                aria-current={active ? 'page' : undefined}
                class="navitem admin-press shrink-0 inline-flex items-center h-9 px-3.5 rounded-full text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-primary
                  {active ? 'navitem--active' : 'text-on-surface-variant hover:bg-on-surface/8 hover:text-on-surface'}"
              >
                {tab.label}
              </a>
            {/each}
          </nav>
        {/if}
      </div>
    </div>

    <!-- La marge basse laisse la place a la barre d'onglets flottante. -->
    <main id="main-content" tabindex="-1" class="mx-auto max-w-[1320px] px-4 sm:px-6 pt-6 pb-32 lg:pb-16 space-y-5 focus:outline-none">
      {@render children?.()}
    </main>
  </div>

  <!-- Petit ecran : les six espaces dans une pilule flottante -->
  <nav class="lg:hidden pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+14px)] z-30 flex justify-center px-3" aria-label="Espaces de la console admin">
    <div class="tabbar pointer-events-auto flex items-center gap-1 w-full max-w-[520px] rounded-full p-1.5">
      {#each ADMIN_SPACES as item (item.id)}
        {@const active = item.id === space.id}
        <a
          href={item.tabs[0].path}
          onpointerenter={() => prefetchRoute(item.tabs[0].path)}
          aria-current={active ? 'page' : undefined}
          aria-label={item.label}
          class="admin-press flex h-[54px] flex-1 basis-0 min-w-0 px-1 flex-col items-center justify-center gap-[3px] rounded-full
            {active ? 'tabbar-item--active' : 'text-on-surface-variant'}"
        >
          <Papicon icon={item.icon} size={19} />
          <span class="text-2xs font-semibold leading-none truncate max-w-full" aria-hidden="true">{item.label}</span>
        </a>
      {/each}
    </div>
  </nav>
</div>
{/if}

<style>
  .sidebar {
    background: var(--admin-sidebar);
    border: 1px solid var(--admin-line);
    border-radius: 31px;
    box-shadow: var(--admin-sidebar-shadow);
  }
  /* Entree active : une pastille de la couleur des cartes, soulevee d'un rien. */
  .navitem--active {
    background: var(--surface);
    border: 1px solid var(--admin-edge);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  }
  .navitem {
    border: 1px solid transparent;
  }
  .band {
    background: var(--admin-band);
    border-bottom: 1px solid var(--admin-band-line);
  }
  .tabbar {
    background: var(--admin-glass);
    border: 1px solid var(--admin-edge);
    backdrop-filter: blur(22px) saturate(1.8);
    -webkit-backdrop-filter: blur(22px) saturate(1.8);
    box-shadow: 0 14px 34px -10px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.08);
  }
  .tabbar-item--active {
    background: var(--surface);
    color: var(--on-surface);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  }
  .tabs {
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
</style>
