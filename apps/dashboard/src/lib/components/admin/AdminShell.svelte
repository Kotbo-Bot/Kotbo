<script lang="ts">
  /**
   * Coquille de la console admin.
   *
   * Elle occupe tout l'ecran : la console ne se rend plus dans le cadre du
   * dashboard serveur, dont la barre laterale et l'en-tete parlaient d'un
   * serveur sans rapport avec ce qu'on fait ici.
   *
   * Le langage visuel reprend celui de Papillon : fond gris doux et cartes
   * pleines, grands titres, une couleur par espace portee par une pastille
   * d'icone, onglets en pilules, barre d'onglets en bas sur telephone.
   */
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import Papicon from '../Papicon.svelte';
  import { brandingStore } from '../../stores/branding.svelte';
  import { searchStore } from '../../stores/search.svelte';
  import { m } from '../../i18n';
  import { ADMIN_SPACES, spaceForPath, tabMatches } from './adminNav';
  import { adminHealth, watchAdminHealth } from './adminHealth.svelte';

  const {
    title = '',
    description = '',
    actions,
    children,
  }: {
    /** Sert au titre de l'onglet du navigateur ; a l'ecran, l'espace et l'onglet actif nomment deja la page. */
    title?: string;
    description?: string;
    actions?: Snippet;
    children?: Snippet;
  } = $props();

  onMount(watchAdminHealth);

  const space = $derived(spaceForPath($router.path));
  const activeTab = $derived(space.tabs.find((tab) => tabMatches(tab, $router.path)) ?? space.tabs[0]);

  $effect(() => {
    document.title = `${title || activeTab.label} · Admin · ${brandingStore.brandName}`;
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
</script>

<div class="admin-console min-h-screen bg-surface-container-low text-on-surface" style="--space: {space.color}">
  <a class="skip-link" href="#main-content">{m.mlx_skip()}</a>

  <!-- Barre laterale : six espaces, pas dix-sept pages -->
  <aside class="hidden lg:flex fixed inset-y-0 left-0 z-30 w-60 flex-col gap-4 p-3 border-r border-outline-variant/60 bg-surface">
    <a href="/admin" class="flex items-center gap-2.5 px-2 pt-2 rounded-xl focus-visible:outline-2 focus-visible:outline-primary">
      <span class="w-9 h-9 rounded-[11px] bg-on-surface text-surface flex items-center justify-center">
        <Papicon icon="Lock" size={16} />
      </span>
      <span class="min-w-0">
        <span class="block font-headline text-[15px] font-bold leading-tight truncate">{brandingStore.brandName}</span>
        <span class="block text-xs text-on-surface-variant leading-tight">{m.d4_admin_console()}</span>
      </span>
    </a>

    <button
      type="button"
      onclick={() => searchStore.show()}
      class="pressable flex items-center gap-2.5 h-10 px-3 rounded-xl bg-on-surface/5 hover:bg-on-surface/8 text-on-surface-variant text-body-sm focus-visible:outline-2 focus-visible:outline-primary"
    >
      <Papicon icon="Search" size={15} />
      <span class="flex-1 text-left">Rechercher</span>
      <kbd class="font-mono text-xs px-1.5 py-0.5 rounded-md bg-on-surface/8">⌘K</kbd>
    </button>

    <nav class="flex flex-col gap-0.5" aria-label="Espaces de la console admin">
      {#each ADMIN_SPACES as item (item.id)}
        {@const active = item.id === space.id}
        <a
          href={item.tabs[0].path}
          aria-current={active ? 'page' : undefined}
          style="--c: {item.color}"
          class="pressable nav-item flex items-center gap-3 h-11 px-2 rounded-xl text-[15px] focus-visible:outline-2 focus-visible:outline-primary
            {active ? 'nav-item--active font-semibold text-on-surface' : 'font-medium text-on-surface-variant hover:bg-on-surface/5 hover:text-on-surface'}"
        >
          <span class="tile w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0">
            <Papicon icon={item.icon} size={15} />
          </span>
          {item.label}
        </a>
      {/each}
    </nav>

    <div class="mt-auto flex flex-col gap-2">
      <a
        href="/admin/shards"
        class="pressable block rounded-2xl p-3 bg-on-surface/5 hover:bg-on-surface/8 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span class="flex items-center gap-2 text-body-sm font-semibold">
          <span class="w-2 h-2 rounded-full {statusDot[status.tone]}"></span>
          {status.label}
        </span>
        {#if health}
          <span class="block mt-1 text-xs text-on-surface-variant tabular-nums">
            {health.onlineShardCount}/{health.shardCount} shards · {health.averageShardPing} ms · mém. {heapPercent} %
          </span>
        {/if}
      </a>
      <a
        href="/"
        class="pressable flex items-center gap-2.5 h-10 px-3 rounded-xl text-body-sm font-medium text-on-surface-variant hover:bg-on-surface/5 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Papicon icon="ArrowLeft" size={15} />
        {m.d4_dashboard()}
      </a>
    </div>
  </aside>

  <div class="lg:pl-60 relative">
    <!-- Lavis a la couleur de l'espace : on sait ou l'on est sans lire. -->
    <div class="wash absolute inset-x-0 top-0 h-64 pointer-events-none" aria-hidden="true"></div>

    <div class="relative mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-10">
      <!-- Sur telephone, pas de barre laterale : recherche et retour montent ici. -->
      <div class="lg:hidden flex items-center justify-between pt-3">
        <span class="flex items-center gap-2 text-body-sm font-semibold">
          <span class="w-2 h-2 rounded-full {statusDot[status.tone]}"></span>
          {status.label}
        </span>
        <span class="flex items-center gap-1">
          <button
            type="button"
            onclick={() => searchStore.show()}
            aria-label={m.d4_search_or_navigate()}
            class="pressable w-10 h-10 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-on-surface/8"
          >
            <Papicon icon="Search" size={17} />
          </button>
          <a href="/" aria-label={m.d4_dashboard()} class="pressable w-10 h-10 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-on-surface/8">
            <Papicon icon="X" size={17} />
          </a>
        </span>
      </div>

      <header class="pt-4 lg:pt-10 pb-5">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div class="flex items-center gap-3 min-w-0">
            <span class="tile tile--current w-11 h-11 rounded-[14px] flex items-center justify-center shrink-0">
              <Papicon icon={space.icon} size={22} />
            </span>
            <h1 class="font-headline text-[28px] sm:text-[32px] font-bold tracking-tight leading-none truncate">{space.label}</h1>
          </div>
          {#if actions}
            <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
          {/if}
        </div>

        {#if space.tabs.length > 1}
          <nav class="tabs flex gap-1.5 mt-5 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto" aria-label="Vues de l’espace {space.label}">
            {#each space.tabs as tab (tab.path)}
              {@const active = tab === activeTab}
              <a
                href={tab.path}
                aria-current={active ? 'page' : undefined}
                class="pressable shrink-0 inline-flex items-center h-9 px-4 rounded-full text-body-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-primary
                  {active ? 'bg-on-surface text-surface' : 'bg-on-surface/6 text-on-surface-variant hover:bg-on-surface/10 hover:text-on-surface'}"
              >
                {tab.label}
              </a>
            {/each}
          </nav>
        {/if}

        {#if description}
          <p class="text-body-sm text-on-surface-variant mt-4 max-w-2xl leading-relaxed">{description}</p>
        {/if}
      </header>

      <!-- La marge basse laisse la place a la barre d'onglets sur telephone. -->
      <main id="main-content" tabindex="-1" class="space-y-5 pb-28 lg:pb-14 focus:outline-none">
        {@render children?.()}
      </main>
    </div>
  </div>

  <!-- Telephone : les six espaces sous le pouce -->
  <nav
    class="lg:hidden fixed bottom-0 inset-x-0 z-30 grid grid-cols-6 border-t border-outline-variant/60 bg-surface/92 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]"
    aria-label="Espaces de la console admin"
  >
    {#each ADMIN_SPACES as item (item.id)}
      {@const active = item.id === space.id}
      <a
        href={item.tabs[0].path}
        aria-current={active ? 'page' : undefined}
        aria-label={item.label}
        style="--c: {item.color}"
        class="pressable nav-item flex flex-col items-center justify-center gap-1 h-14 min-w-0 {active ? 'text-on-surface' : 'text-on-surface-variant'}"
      >
        <span class="w-9 h-7 rounded-full flex items-center justify-center {active ? 'tile' : ''}">
          <Papicon icon={item.icon} size={17} />
        </span>
        <span class="text-2xs font-semibold truncate max-w-full px-0.5" aria-hidden="true">{item.label}</span>
      </a>
    {/each}
  </nav>
</div>

<style>
  .tile {
    background: var(--c, var(--space));
    color: #fff;
  }
  .tile--current {
    background: var(--space);
    box-shadow: 0 6px 16px -6px color-mix(in srgb, var(--space) 70%, transparent);
  }
  .nav-item--active {
    background: color-mix(in srgb, var(--c) 13%, transparent);
  }
  .wash {
    background: linear-gradient(180deg, color-mix(in srgb, var(--space) 13%, transparent), transparent);
    transition: background 0.3s ease;
  }
  /* Le leger enfoncement au clic qui rend l'interface « physique ». */
  .pressable {
    transition: transform 0.12s ease, background-color 0.15s ease, color 0.15s ease;
  }
  .pressable:active {
    transform: scale(0.97);
  }
  .tabs {
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .pressable,
    .wash {
      transition: none;
    }
    .pressable:active {
      transform: none;
    }
  }
</style>
