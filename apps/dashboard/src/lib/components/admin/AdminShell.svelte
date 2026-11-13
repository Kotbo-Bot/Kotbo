<script lang="ts" module>
  // Compteur partage : en passant d'une page admin a l'autre, la coquille
  // suivante se monte avant que la precedente ait fini de se demonter.
  let mounted = 0;
</script>

<script lang="ts">
  /**
   * Coquille de la console admin.
   *
   * Plein ecran, hors du cadre du dashboard serveur. Le langage visuel est
   * celui de tafac.fr (cf. admin-theme.css) : une barre de navigation en
   * pilule, de grands titres, une seule teinte, des cartes tres arrondies.
   *
   * Deux niveaux de navigation seulement : l'espace (barre du haut), puis la
   * vue dans cet espace (pilules sous le titre).
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
  }: {
    /** Titre de l'onglet du navigateur ; a l'ecran, l'espace et la vue active nomment deja la page. */
    title?: string;
    description?: string;
    /** Remplace le nom de l'espace en grand titre (fiche d'un serveur, par exemple). */
    heading?: string;
    /** Page de detail : lien de retour affiche a la place des vues de l'espace. */
    backHref?: string;
    backLabel?: string;
    /** Visuel place devant le grand titre (icone du serveur). */
    lead?: Snippet;
    actions?: Snippet;
    children?: Snippet;
  } = $props();

  onMount(() => {
    mounted += 1;
    document.documentElement.classList.add('admin-theme');
    const stopHealth = watchAdminHealth();
    return () => {
      stopHealth();
      mounted -= 1;
      // Une image plus tard : si une autre page admin a pris le relais, on garde le theme.
      requestAnimationFrame(() => {
        if (mounted === 0) document.documentElement.classList.remove('admin-theme');
      });
    };
  });

  const space = $derived(spaceForPath($router.path));
  const activeTab = $derived(space.tabs.find((tab) => tabMatches(tab, $router.path)) ?? space.tabs[0]);

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
</script>

<div class="min-h-screen bg-background text-on-surface">
  <a class="skip-link" href="#main-content">{m.mlx_skip()}</a>

  <header class="topbar sticky top-0 z-30">
    <div class="mx-auto max-w-[1360px] h-[68px] px-4 sm:px-8 flex items-center justify-between gap-4">
      <a href="/admin" class="flex items-baseline gap-2 min-w-0 rounded-lg focus-visible:outline-2 focus-visible:outline-primary">
        <span class="font-headline text-[22px] font-bold tracking-tight leading-none truncate">{brandingStore.brandName}</span>
        <span class="text-xs font-semibold text-on-surface-variant">admin</span>
      </a>

      <!-- Les six espaces, dans une pilule centree -->
      <nav class="navpill hidden lg:flex items-center gap-0.5 p-1 rounded-full" aria-label="Espaces de la console admin">
        {#each ADMIN_SPACES as item (item.id)}
          {@const active = item.id === space.id}
          <a
            href={item.tabs[0].path}
            aria-current={active ? 'page' : undefined}
            class="admin-press h-9 px-4 inline-flex items-center rounded-full text-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary
              {active ? 'bg-on-surface text-background' : 'text-on-surface hover:bg-on-surface/6'}"
          >
            {item.label}
          </a>
        {/each}
      </nav>

      <div class="flex items-center gap-2">
        <a
          href="/admin/shards"
          title={health ? `${health.onlineShardCount}/${health.shardCount} shards · ${health.averageShardPing} ms · mémoire ${heapPercent} %` : status.label}
          class="admin-press hidden sm:inline-flex items-center gap-2 h-9 px-3 rounded-full text-body-sm font-semibold text-on-surface-variant hover:bg-on-surface/6 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
        >
          <span class="w-2 h-2 rounded-full {statusDot[status.tone]}"></span>
          {status.label}
        </a>
        <button
          type="button"
          onclick={() => searchStore.show()}
          aria-label={m.d4_search_or_navigate()}
          title="{m.d4_search_or_navigate()} (⌘K)"
          class="admin-press w-9 h-9 rounded-full inline-flex items-center justify-center text-on-surface hover:bg-on-surface/6 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <Papicon icon="Search" size={16} />
        </button>
        <a
          href="/"
          class="admin-press h-9 px-4 inline-flex items-center rounded-full bg-on-surface/6 hover:bg-on-surface/10 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary"
        >
          {m.d4_dashboard()}
        </a>
      </div>
    </div>
  </header>

  <div class="mx-auto max-w-[1360px] px-4 sm:px-8">
    <div class="pt-8 sm:pt-12 pb-6">
      {#if backHref}
        <a
          href={backHref}
          class="admin-press inline-flex items-center gap-1.5 h-8 pl-2 pr-3 -ml-2 mb-4 rounded-full text-body-sm font-semibold text-on-surface-variant hover:bg-on-surface/6 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
        >
          <Papicon icon="ArrowLeft" size={14} />
          {backLabel || space.label}
        </a>
      {/if}

      <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div class="flex items-center gap-4 min-w-0">
          {@render lead?.()}
          <div class="min-w-0">
            <h1 class="font-headline text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05] truncate">{heading || space.label}</h1>
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
        <nav class="tabs flex gap-1 mt-6 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto" aria-label="Vues de l’espace {space.label}">
          {#each space.tabs as tab (tab.path)}
            {@const active = tab === activeTab}
            <a
              href={tab.path}
              aria-current={active ? 'page' : undefined}
              class="admin-press shrink-0 inline-flex items-center h-9 px-3.5 rounded-full text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-primary
                {active ? 'bg-on-surface/8 text-on-surface' : 'text-on-surface-variant hover:bg-on-surface/5 hover:text-on-surface'}"
            >
              {tab.label}
            </a>
          {/each}
        </nav>
      {/if}
    </div>

    <!-- La marge basse laisse la place a la barre d'onglets sur telephone. -->
    <main id="main-content" tabindex="-1" class="space-y-5 pb-28 lg:pb-16 focus:outline-none">
      {@render children?.()}
    </main>
  </div>

  <!-- Telephone : les six espaces sous le pouce -->
  <nav
    class="topbar lg:hidden fixed bottom-0 inset-x-0 z-30 grid grid-cols-6 pb-[env(safe-area-inset-bottom)]"
    aria-label="Espaces de la console admin"
  >
    {#each ADMIN_SPACES as item (item.id)}
      {@const active = item.id === space.id}
      <a
        href={item.tabs[0].path}
        aria-current={active ? 'page' : undefined}
        aria-label={item.label}
        class="admin-press flex flex-col items-center justify-center gap-1 h-14 min-w-0 {active ? 'text-on-surface' : 'text-on-surface-variant'}"
      >
        <span class="w-10 h-7 rounded-full flex items-center justify-center {active ? 'bg-on-surface text-background' : ''}">
          <Papicon icon={item.icon} size={16} />
        </span>
        <span class="text-2xs font-semibold truncate max-w-full px-0.5" aria-hidden="true">{item.label}</span>
      </a>
    {/each}
  </nav>
</div>

<style>
  .topbar {
    background: var(--admin-glass);
    backdrop-filter: blur(18px) saturate(1.4);
    -webkit-backdrop-filter: blur(18px) saturate(1.4);
  }
  .navpill {
    background: var(--surface);
    border: 1px solid var(--admin-line);
    box-shadow: var(--admin-shadow);
  }
  .tabs {
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
</style>
