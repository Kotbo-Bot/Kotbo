<script lang="ts">
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { themeStore } from '../stores/theme.svelte';
  import { feedbackModal } from '../stores/feedbackModal.svelte';
  import { searchStore } from '../stores/search.svelte';
  import { serverSwitcherStore } from '../stores/serverSwitcher.svelte';
  import { onboardingStore } from '../stores/tutorial.svelte';
  import { navigationStore } from '../stores/navigation.svelte';
  import { tabsForPage } from '../config/pageTabs';
  import { markNavigationSource, trackEvent } from '../telemetry/telemetry';

  const GROUP_ICONS: Record<string, string> = {
    general: 'home',
    moderation: 'shield',
    security: 'shieldcheck',
    leveling: 'trophy',
    economy: 'coins',
    community: 'users',
    staff: 'briefcase',
    crossserver: 'link',
    config: 'sliders',
  };

  interface PaletteItem {
    id: string;
    label: string;
    sublabel?: string;
    icon: string;
    group: string;
    action: () => void;
  }

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement>();

  const open = $derived(searchStore.open);

  // Ne pas refiltrer ici : une copie locale des regles de visibilite finit par
  // diverger de la barre laterale et exposer des pages que le compte ne peut
  // pas ouvrir.
  const navGroups = $derived(navigationStore.groups);

  // ─── Éléments de la palette ────────────────────────────────────────────────
  /**
   * Une page suivie de ses onglets.
   *
   * Les onglets sont des destinations à part entière : `/economy/bestiaire`
   * n'est atteignable que par la page Économie, et rien dans la palette ne
   * laissait deviner qu'il existait. Le libellé de la page reste dans le
   * sous-titre de l'onglet pour que « bestiaire » comme « économie » y mènent.
   */
  const pushPageWithTabs = (
    items: PaletteItem[],
    item: { name: string; href: string; icon?: string },
    prefix: string,
    group: string,
    fallbackIcon: string,
  ) => {
    items.push({
      id: `${prefix}-${item.name}`,
      label: item.name,
      sublabel: `Page · ${group}`,
      icon: item.icon || fallbackIcon,
      group,
      action: () => router.goto(item.href)
    });

    for (const tab of tabsForPage(item.href)) {
      items.push({
        id: `${prefix}-${item.name}-${tab.id}`,
        label: `${item.name} › ${tab.label()}`,
        sublabel: `Onglet · ${item.name}`,
        icon: tab.icon || item.icon || fallbackIcon,
        group,
        action: () => router.goto(tab.href)
      });
    }
  };

  const allPaletteItems = $derived.by(() => {
    const items: PaletteItem[] = [];

    for (const group of navGroups) {
      for (const item of group.items) {
        pushPageWithTabs(items, item, group.key, group.label, GROUP_ICONS[group.key] ?? 'home');
      }
    }

    // Admin Items (only if isBotAdmin is true)
    if (authStore.isBotAdmin) {
      items.push({ id: 'admin-overview', label: "Console d'administration", sublabel: 'Admin · Vue d\'ensemble', icon: 'activity', group: 'Administration', action: () => router.goto('/admin') });
      items.push({ id: 'admin-servers',  label: 'Serveurs', sublabel: 'Admin · Liste des serveurs', icon: 'Server', group: 'Administration', action: () => router.goto('/admin/servers') });
      items.push({ id: 'admin-shards',   label: 'Shards', sublabel: 'Admin · Status des fragments', icon: 'Zap', group: 'Administration', action: () => router.goto('/admin/shards') });
      items.push({ id: 'admin-analytics', label: 'Analytics', sublabel: 'Admin · Acquisition, revenus, rétention', icon: 'TrendingUp', group: 'Administration', action: () => router.goto('/admin/analytics') });
      items.push({ id: 'admin-dashboard-usage', label: 'Usage du dashboard', sublabel: 'Admin · Pages et modules consultés', icon: 'Eye', group: 'Administration', action: () => router.goto('/admin/analytics?tab=usage') });
      items.push({ id: 'admin-modules',  label: 'Modules système', sublabel: 'Admin · Activation, usage et performance', icon: 'Box', group: 'Administration', action: () => router.goto('/admin/analytics?tab=modules') });
      items.push({ id: 'admin-broadcast', label: 'Broadcast', sublabel: 'Admin · Annonces globales', icon: 'Megaphone', group: 'Administration', action: () => router.goto('/admin/broadcast') });
      items.push({ id: 'admin-security', label: 'Sécurité & Blacklist', sublabel: 'Admin · Accès globaux', icon: 'ShieldCheck', group: 'Administration', action: () => router.goto('/admin/security') });
      items.push({ id: 'admin-content',  label: 'Mots globaux', sublabel: 'Admin · Filtrage', icon: 'filter', group: 'Administration', action: () => router.goto('/admin/content') });
      items.push({ id: 'admin-activation', label: "Codes d'activation", sublabel: 'Admin · Licences', icon: 'Key', group: 'Administration', action: () => router.goto('/admin/activation') });
      items.push({ id: 'admin-audit',    label: "Journal d'audit", sublabel: 'Admin · Traçabilité', icon: 'ClipboardList', group: 'Administration', action: () => router.goto('/admin/audit') });
      items.push({ id: 'admin-whitelabel', label: 'Marque blanche', sublabel: 'Admin · Instances', icon: 'Layers', group: 'Administration', action: () => router.goto('/admin/whitelabel') });
      items.push({ id: 'admin-instances', label: 'Instances self-host', sublabel: 'Admin · Télémétrie et bannissement', icon: 'Server', group: 'Administration', action: () => router.goto('/admin/instances') });
      items.push({ id: 'admin-gdpr',     label: 'Export RGPD', sublabel: 'Admin · Conformité', icon: 'ShieldCheck', group: 'Administration', action: () => router.goto('/admin/gdpr') });
      items.push({ id: 'admin-config',   label: 'Configuration avancée', sublabel: 'Admin · Système', icon: 'Settings', group: 'Administration', action: () => router.goto('/admin/config') });
    }

    // Profil page. Son URL porte l'identifiant du membre : les onglets sont
    // donc construits à la main, `tabsForPage` ne travaillant que sur des
    // chemins fixes.
    const profileBase = authStore.user?.id ? `/profile/${authStore.user.id}` : '/profile';
    items.push({
      id: 'profile',
      label: 'Mon Profil',
      sublabel: 'Profil utilisateur',
      icon: 'user',
      group: 'Compte',
      action: () => router.goto(profileBase)
    });
    for (const tab of tabsForPage('/profile')) {
      items.push({
        id: `profile-${tab.id}`,
        label: `Mon Profil › ${tab.label()}`,
        sublabel: 'Onglet · Mon Profil',
        icon: tab.icon || 'user',
        group: 'Compte',
        action: () => router.goto(`${profileBase}/${tab.id}`)
      });
    }

    for (const tab of tabsForPage('/userSettings')) {
      items.push({
        id: `usersettings-${tab.id}`,
        label: `Préférences › ${tab.label()}`,
        sublabel: 'Onglet · Préférences',
        icon: tab.icon || 'settings',
        group: 'Compte',
        action: () => router.goto(tab.href)
      });
    }

    // Theme Toggle action
    items.push({
      id: 'action-theme',
      label: 'Basculer le thème (Sombre / Clair)',
      sublabel: themeStore.dark ? 'Activer le mode clair' : 'Activer le mode sombre',
      icon: themeStore.dark ? 'sun' : 'moon',
      group: 'Actions',
      action: () => themeStore.toggle()
    });

    // Feedback modal action
    items.push({
      id: 'action-feedback',
      label: 'Envoyer un retour / signaler un bug',
      sublabel: 'Feedback & suggestions',
      icon: 'bug_report',
      group: 'Actions',
      action: () => feedbackModal.show()
    });

    // Logout action
    items.push({
      id: 'action-logout',
      label: 'Déconnexion',
      sublabel: 'Se déconnecter du dashboard',
      icon: 'log-out',
      group: 'Actions',
      action: () => authStore.logout()
    });

    return items;
  });

  const filteredItems = $derived(() => {
    const q = query.toLowerCase().trim();
    const matched = q
      ? allPaletteItems.filter(item =>
          item.label.toLowerCase().includes(q) ||
          item.sublabel?.toLowerCase().includes(q) ||
          item.group.toLowerCase().includes(q)
        )
      : allPaletteItems;

    // Group by group label
    const groups: Record<string, PaletteItem[]> = {};
    for (const item of matched) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    }
    return groups;
  });

  const flatItems = $derived(() => Object.values(filteredItems()).flat());

  $effect(() => {
    if (open) {
      query = '';
      selectedIndex = 0;
      setTimeout(() => inputEl?.focus(), 50);
      trackEvent('palette', 'open');
    }
  });

  // Télémétrie : une recherche compte une fois la frappe posée, avec ou sans
  // résultat. Le texte cherché ne part jamais.
  $effect(() => {
    const q = query.trim();
    if (!open || q.length < 2) return;
    const timer = setTimeout(() => {
      trackEvent('palette', flatItems().length > 0 ? 'search_hit' : 'search_empty');
    }, 800);
    return () => clearTimeout(timer);
  });

  function close() {
    searchStore.close();
  }

  function runItem(item: PaletteItem) {
    markNavigationSource('palette');
    trackEvent('palette', `select:${item.group}`);
    item.action();
    close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    const items = flatItems();

    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    }
    if (e.key === 'Enter' && items[selectedIndex]) {
      e.preventDefault();
      runItem(items[selectedIndex]);
    }
  }

  /**
   * « / » et Ctrl+K ouvrent la meme recherche. Ils visaient avant un champ de
   * la barre laterale (`.sidebar input`) qui n'existait plus, et un double
   * Ctrl+K basculait sur la palette : deux recherches, deux gestes, pour les
   * memes pages. La barre laterale n'a plus de champ ; tout passe par ici.
   */
  function handleGlobalKeydown(e: KeyboardEvent) {
    const active = document.activeElement;
    const isEditing = active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.getAttribute('contenteditable') === 'true'
    );

    const isSlash = e.key === '/' && !open && !isEditing;
    const isCtrlK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
    if (!isSlash && !isCtrlK) return;

    e.preventDefault();
    serverSwitcherStore.close();
    if (isCtrlK) onboardingStore.markShortcutUsed();
    searchStore.toggle();
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if open}
  <div
    class="command-palette fixed inset-0 z-100 flex items-start justify-center pt-[15vh] px-4"
    role="dialog"
    aria-modal="true"
    aria-label="Palette de commandes"
    tabindex="-1"
    onkeydown={(e) => { if (e.key === 'Escape') close(); }}
  >
    <!-- Backdrop -->
    <button
      type="button"
      class="absolute inset-0 bg-black/40 animate-in fade-in duration-100 border-none cursor-default w-full h-full text-left p-0"
      onclick={close}
      aria-label="Fermer"
    ></button>

    <!-- Palette panel -->
    <div
      class="command-palette__panel relative z-10 w-full max-w-xl bg-surface-container-lowest border border-outline-variant rounded-xl shadow-lg overflow-hidden animate-in fade-in slide-up duration-150"
      role="document"
    >
      <!-- Search input -->
      <div class="flex items-center gap-2.5 px-3 py-2.5 border-b border-outline-variant">
        <Papicon icon="Search" size={15} class="text-on-surface-variant/40 shrink-0" />
        <input
          bind:this={inputEl}
          bind:value={query}
          oninput={() => selectedIndex = 0}
          onkeydown={handleKeydown}
          type="text"
          placeholder="Chercher une page, une action..."
          class="flex-1 bg-transparent text-sm text-on-surface placeholder-on-surface-variant/40 focus:outline-none"
        />
        <kbd class="hidden sm:flex px-1.5 py-0.5 rounded bg-surface-container border border-outline-variant text-2xs font-medium text-on-surface-variant/40 leading-none">
          ESC
        </kbd>
      </div>

      <!-- Results -->
      <div class="max-h-[60vh] overflow-y-auto py-1">
        {#each Object.entries(filteredItems()) as [group, items]}
          <div class="px-1 pb-0.5">
            <p class="text-xs font-medium text-on-surface-variant px-2.5 py-1.5">{group}</p>
            {#each items as item}
              {@const globalIdx = flatItems().indexOf(item)}
              {@const isSelected = globalIdx === selectedIndex}
              <button
                onclick={() => runItem(item)}
                onmouseenter={() => selectedIndex = globalIdx}
                class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors duration-100
 {isSelected ? 'bg-primary/8 text-primary' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'}"
              >
                <div class="w-6 h-6 rounded-md flex items-center justify-center shrink-0 transition-colors
 {isSelected ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant/50'}">
                  <Papicon icon={item.icon} size={13} />
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm leading-none truncate">{item.label}</p>
                  {#if item.sublabel}
                    <p class="text-2xs text-on-surface-variant/50 mt-0.5 truncate">{item.sublabel}</p>
                  {/if}
                </div>
                {#if isSelected}
                  <kbd class="text-2xs text-primary/50 leading-none">↵</kbd>
                {/if}
              </button>
            {/each}
          </div>
        {/each}

        {#if flatItems().length === 0}
          <div class="flex flex-col items-center py-8 gap-1.5 text-center">
            <Papicon icon="SearchX" size={24} class="text-on-surface-variant/30" />
            <p class="text-sm text-on-surface-variant/50">Aucun résultat pour «{query}»</p>
          </div>
        {/if}
      </div>

      <!-- Footer hint -->
      <div class="flex items-center gap-3 px-3 py-2 border-t border-outline-variant bg-surface-container">
        <div class="flex items-center gap-1 text-2xs text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-2xs">↑↓</kbd>
          Naviguer
        </div>
        <div class="flex items-center gap-1 text-2xs text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-2xs">↵</kbd>
          Ouvrir
        </div>
        <div class="flex items-center gap-1 text-2xs text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-2xs">Esc</kbd>
          Fermer
        </div>
      </div>
    </div>
  </div>
{/if}
