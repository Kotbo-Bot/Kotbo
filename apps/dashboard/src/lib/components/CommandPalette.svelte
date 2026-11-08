<script lang="ts">
  import { m } from '../i18n';
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
  import { fuzzyScore, moduleKeywords, normalize, score } from '../utils/paletteSearch';

  const GROUP_ICONS: Record<string, string> = {
    general: 'home',
    moderation: 'shield',
    security: 'shieldcheck',
    leveling: 'trophy',
    economy: 'coins',
    community: 'users',
    communication: 'megaphone',
    staff: 'briefcase',
    crossserver: 'link',
    config: 'sliders',
    integrations: 'link',
  };

  // Libelles de groupe : affiches, et cles de regroupement des resultats.
  const GROUP_ACCOUNT = m.cp_group_account();
  const GROUP_ACTIONS = m.cp_group_actions();
  const GROUP_ADMIN = m.cp_group_admin();
  const GROUP_PINNED = m.cp_group_pinned();
  const GROUP_RECENT = m.cp_group_recent();
  const GROUP_MISSING = m.cp_group_missing();

  interface PaletteItem {
    id: string;
    label: string;
    sublabel?: string;
    icon: string;
    group: string;
    keywords?: string;
    href?: string;
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
      sublabel: m.cp_page_in({ group }),
      icon: item.icon || fallbackIcon,
      group,
      keywords: moduleKeywords(item.href),
      href: item.href,
      action: () => router.goto(item.href)
    });

    for (const tab of tabsForPage(item.href)) {
      items.push({
        id: `${prefix}-${item.name}-${tab.id}`,
        label: `${item.name} › ${tab.label()}`,
        sublabel: m.cp_tab_of({ page: item.name }),
        icon: tab.icon || item.icon || fallbackIcon,
        group,
        keywords: moduleKeywords(tab.href),
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
      items.push({ id: 'admin-overview', label: m.cp_adm_overview(), sublabel: m.cp_adm_overview_sub(), icon: 'activity', group: GROUP_ADMIN, action: () => router.goto('/admin') });
      items.push({ id: 'admin-servers',  label: m.cp_adm_servers(), sublabel: m.cp_adm_servers_sub(), icon: 'Server', group: GROUP_ADMIN, action: () => router.goto('/admin/servers') });
      items.push({ id: 'admin-shards',   label: m.cp_adm_shards(), sublabel: m.cp_adm_shards_sub(), icon: 'Zap', group: GROUP_ADMIN, action: () => router.goto('/admin/shards') });
      items.push({ id: 'admin-analytics', label: m.cp_adm_analytics(), sublabel: m.cp_adm_analytics_sub(), icon: 'TrendingUp', group: GROUP_ADMIN, action: () => router.goto('/admin/analytics') });
      items.push({ id: 'admin-dashboard-usage', label: m.cp_adm_usage(), sublabel: m.cp_adm_usage_sub(), icon: 'Eye', group: GROUP_ADMIN, action: () => router.goto('/admin/analytics?tab=usage') });
      items.push({ id: 'admin-modules',  label: m.cp_adm_modules(), sublabel: m.cp_adm_modules_sub(), icon: 'Box', group: GROUP_ADMIN, action: () => router.goto('/admin/analytics?tab=modules') });
      items.push({ id: 'admin-broadcast', label: m.cp_adm_broadcast(), sublabel: m.cp_adm_broadcast_sub(), icon: 'Megaphone', group: GROUP_ADMIN, action: () => router.goto('/admin/broadcast') });
      items.push({ id: 'admin-security', label: m.cp_adm_security(), sublabel: m.cp_adm_security_sub(), icon: 'ShieldCheck', group: GROUP_ADMIN, action: () => router.goto('/admin/security') });
      items.push({ id: 'admin-content',  label: m.cp_adm_content(), sublabel: m.cp_adm_content_sub(), icon: 'filter', group: GROUP_ADMIN, action: () => router.goto('/admin/content') });
      items.push({ id: 'admin-activation', label: m.cp_adm_activation(), sublabel: m.cp_adm_activation_sub(), icon: 'Key', group: GROUP_ADMIN, action: () => router.goto('/admin/activation') });
      items.push({ id: 'admin-audit',    label: m.cp_adm_audit(), sublabel: m.cp_adm_audit_sub(), icon: 'ClipboardList', group: GROUP_ADMIN, action: () => router.goto('/admin/audit') });
      items.push({ id: 'admin-whitelabel', label: m.cp_adm_whitelabel(), sublabel: m.cp_adm_whitelabel_sub(), icon: 'Layers', group: GROUP_ADMIN, action: () => router.goto('/admin/whitelabel') });
      items.push({ id: 'admin-instances', label: m.cp_adm_instances(), sublabel: m.cp_adm_instances_sub(), icon: 'Server', group: GROUP_ADMIN, action: () => router.goto('/admin/instances') });
      items.push({ id: 'admin-gdpr',     label: m.cp_adm_gdpr(), sublabel: m.cp_adm_gdpr_sub(), icon: 'ShieldCheck', group: GROUP_ADMIN, action: () => router.goto('/admin/gdpr') });
      items.push({ id: 'admin-config',   label: m.cp_adm_config(), sublabel: m.cp_adm_config_sub(), icon: 'Settings', group: GROUP_ADMIN, action: () => router.goto('/admin/config') });
    }

    // Profil page. Son URL porte l'identifiant du membre : les onglets sont
    // donc construits à la main, `tabsForPage` ne travaillant que sur des
    // chemins fixes.
    const profileBase = authStore.user?.id ? `/profile/${authStore.user.id}` : '/profile';
    items.push({
      id: 'profile',
      label: m.cp_my_profile(),
      sublabel: m.cp_user_profile(),
      icon: 'user',
      group: GROUP_ACCOUNT,
      action: () => router.goto(profileBase)
    });
    for (const tab of tabsForPage('/profile')) {
      items.push({
        id: `profile-${tab.id}`,
        label: `${m.cp_my_profile()} › ${tab.label()}`,
        sublabel: m.cp_tab_of({ page: m.cp_my_profile() }),
        icon: tab.icon || 'user',
        group: GROUP_ACCOUNT,
        action: () => router.goto(`${profileBase}/${tab.id}`)
      });
    }

    for (const tab of tabsForPage('/userSettings')) {
      items.push({
        id: `usersettings-${tab.id}`,
        label: `${m.cp_preferences()} › ${tab.label()}`,
        sublabel: m.cp_tab_of({ page: m.cp_preferences() }),
        icon: tab.icon || 'settings',
        group: GROUP_ACCOUNT,
        action: () => router.goto(tab.href)
      });
    }

    // Theme Toggle action
    items.push({
      id: 'action-theme',
      label: themeStore.dark ? m.cp_theme_light() : m.cp_theme_dark(),
      sublabel: m.cp_appearance(),
      icon: themeStore.dark ? 'sun' : 'moon',
      group: GROUP_ACTIONS,
      action: () => themeStore.toggle()
    });

    // Feedback modal action
    items.push({
      id: 'action-feedback',
      label: m.cp_feedback(),
      sublabel: m.cp_feedback_sub(),
      icon: 'bug_report',
      group: GROUP_ACTIONS,
      action: () => feedbackModal.show()
    });

    // Logout action
    items.push({
      id: 'action-logout',
      label: m.cp_logout(),
      sublabel: GROUP_ACCOUNT,
      icon: 'log-out',
      group: GROUP_ACTIONS,
      action: () => authStore.logout()
    });

    return items;
  });

  /**
   * A pertinence egale, ce que la personne ouvre souvent passe devant : une
   * page epinglee ou consultee recemment l'emporte sur sa voisine.
   */
  const habitBonus = $derived.by(() => {
    const bonus = new Map<string, number>();
    navigationStore.recentItems.forEach((page, index) => bonus.set(page.href, 6 - index));
    for (const page of navigationStore.favoriteItems) bonus.set(page.href, (bonus.get(page.href) ?? 0) + 5);
    return bonus;
  });

  /**
   * Sans saisie, la palette listait toutes les pages et tous leurs onglets,
   * soit une centaine de lignes. Elle propose maintenant ce qu'on rouvre :
   * les pages epinglees, les dernieres consultees, puis les actions.
   */
  const suggestedItems = $derived.by((): Record<string, PaletteItem[]> => {
    const toItem = (page: { name: string; href: string; icon?: string }, group: string): PaletteItem => ({
      id: `${group}-${page.href}`,
      label: page.name,
      sublabel: m.cp_page(),
      icon: page.icon || 'home',
      group,
      action: () => router.goto(page.href),
    });
    const groups: Record<string, PaletteItem[]> = {};
    const pinned = navigationStore.favoriteItems.slice(0, 5);
    const pinnedHrefs = new Set(pinned.map((page) => page.href));
    const recent = navigationStore.recentItems.filter((page) => !pinnedHrefs.has(page.href)).slice(0, 5);
    if (pinned.length > 0) groups[GROUP_PINNED] = pinned.map((page) => toItem(page, GROUP_PINNED));
    if (recent.length > 0) groups[GROUP_RECENT] = recent.map((page) => toItem(page, GROUP_RECENT));
    if (pinned.length === 0 && recent.length === 0) {
      const general = navGroups.find((group) => group.key === 'general');
      if (general) groups[general.label] = general.items.map((page) => toItem(page, general.label));
    }
    groups[GROUP_ACTIONS] = allPaletteItems.filter((item) => item.group === GROUP_ACTIONS);
    return groups;
  });

  /** Resultats classes pour la saisie : exacts d'abord, sinon avec une faute toleree. */
  const ranked = $derived.by(() => {
    const q = normalize(query);
    if (!q) return [];

    const exact = allPaletteItems
      .map((item) => {
        const value = score(item, q);
        return { item, value: value > 0 ? value + (habitBonus.get(item.href ?? '') ?? 0) : 0 };
      })
      .filter((entry) => entry.value > 0)
      .sort((x, y) => y.value - x.value);

    if (exact.length > 0) return exact;
    return allPaletteItems
      .map((item) => ({ item, value: fuzzyScore(item, q) }))
      .filter((entry) => entry.value > 0)
      .sort((x, y) => y.value - x.value)
      .slice(0, 8);
  });

  /** La saisie ne mene a rien, meme en tolerant une faute de frappe. */
  const noMatch = $derived(normalize(query) !== '' && ranked.length === 0);

  const filteredItems = $derived(() => {
    if (!normalize(query)) return suggestedItems;

    // Rien du tout : plutot qu'un mur « aucun résultat », on garde la personne
    // dans le flux avec les pages qu'elle rouvre, et on lui propose de dire ce
    // qu'elle cherchait - c'est la liste de ce qui manque a Kotbo.
    if (noMatch) {
      const { [GROUP_ACTIONS]: _actions, ...fallback } = suggestedItems;
      return {
        ...fallback,
        [GROUP_MISSING]: [{
          id: 'action-missing',
          label: m.cp_suggest({ query: query.trim() }),
          sublabel: m.cp_suggest_sub(),
          icon: 'lightbulb',
          group: GROUP_MISSING,
          action: () => feedbackModal.show(),
        }],
      };
    }

    // Les groupes apparaissent dans l'ordre de leur meilleur resultat.
    const groups: Record<string, PaletteItem[]> = {};
    for (const { item } of ranked) {
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
      trackEvent('palette', noMatch ? 'search_empty' : 'search_hit');
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
      aria-label={m.common_close()}
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
          placeholder={m.cp_search_ph()}
          class="flex-1 bg-transparent text-sm text-on-surface placeholder-on-surface-variant/40 focus:outline-none"
        />
        <kbd class="hidden sm:flex px-1.5 py-0.5 rounded bg-surface-container border border-outline-variant text-2xs font-medium text-on-surface-variant/40 leading-none">
          ESC
        </kbd>
      </div>

      <!-- Results -->
      <div class="max-h-[60vh] overflow-y-auto py-1">
        {#if noMatch}
          <p class="flex items-center gap-2 px-3.5 pt-2 pb-1 text-sm text-on-surface-variant">
            <Papicon icon="SearchX" size={15} class="shrink-0" />
            {m.cp_no_result({ query: query.trim() })}
          </p>
        {/if}
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
 {isSelected ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant'}">
                  <Papicon icon={item.icon} size={13} />
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm leading-none truncate">{item.label}</p>
                  {#if item.sublabel}
                    <p class="text-2xs text-on-surface-variant mt-0.5 truncate">{item.sublabel}</p>
                  {/if}
                </div>
                {#if isSelected}
                  <kbd class="text-2xs text-primary/50 leading-none">↵</kbd>
                {/if}
              </button>
            {/each}
          </div>
        {/each}

      </div>

      <!-- Footer hint -->
      <div class="flex items-center gap-3 px-3 py-2 border-t border-outline-variant bg-surface-container">
        <div class="flex items-center gap-1 text-2xs text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-2xs">↑↓</kbd>
          {m.cp_hint_navigate()}
        </div>
        <div class="flex items-center gap-1 text-2xs text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-2xs">↵</kbd>
          {m.cp_hint_open()}
        </div>
        <div class="flex items-center gap-1 text-2xs text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-2xs">Esc</kbd>
          {m.common_close()}
        </div>
      </div>
    </div>
  </div>
{/if}
