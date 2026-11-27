<script lang="ts">
  import { dialogFocus } from '../actions/dialogFocus';
  import { portal } from '../actions/portal';
  import { tick } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { m } from '../i18n';
  import { guardedNavigate } from '../navigationGuard';
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
  import { contentScore, fuzzyScore, moduleKeywords, normalize, pageWords, score, type SearchIndex } from '../utils/paletteSearch';
import { getLocale } from '../i18n';

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
  const GROUP_ACCOUNT = $derived(m.cp_group_account());
  const GROUP_ACTIONS = $derived(m.cp_group_actions());
  const GROUP_ADMIN = $derived(m.cp_group_admin());
  const GROUP_PINNED = $derived(m.cp_group_pinned());
  const GROUP_RECENT = $derived(m.cp_group_recent());
  const GROUP_MISSING = $derived(m.cp_group_missing());

  interface PaletteItem {
    id: string;
    label: string;
    sublabel?: string;
    icon: string;
    group: string;
    keywords?: string;
    /** Chemin dont le texte est cherché (page ou onglet). */
    contentPath?: string;
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
      contentPath: item.href,
      href: item.href,
      action: () => guardedNavigate(item.href)
    });

    for (const tab of tabsForPage(item.href)) {
      items.push({
        id: `${prefix}-${item.name}-${tab.id}`,
        label: `${item.name} › ${tab.label()}`,
        sublabel: m.cp_tab_of({ page: item.name }),
        icon: tab.icon || item.icon || fallbackIcon,
        group,
        keywords: moduleKeywords(tab.href),
        contentPath: tab.href,
        action: () => guardedNavigate(tab.href)
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
      items.push({ id: 'admin-overview', label: m.cp_adm_overview(), sublabel: m.cp_adm_overview_sub(), icon: 'activity', group: GROUP_ADMIN, action: () => guardedNavigate('/admin') });
      items.push({ id: 'admin-servers',  label: m.cp_adm_servers(), sublabel: m.cp_adm_servers_sub(), icon: 'Server', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/servers') });
      items.push({ id: 'admin-shards',   label: m.cp_adm_shards(), sublabel: m.cp_adm_shards_sub(), icon: 'Zap', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/shards') });
      items.push({ id: 'admin-analytics', label: m.cp_adm_analytics(), sublabel: m.cp_adm_analytics_sub(), icon: 'TrendingUp', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/analytics') });
      items.push({ id: 'admin-dashboard-usage', label: m.cp_adm_usage(), sublabel: m.cp_adm_usage_sub(), icon: 'Eye', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/analytics/usage') });
      items.push({ id: 'admin-modules',  label: m.cp_adm_modules(), sublabel: m.cp_adm_modules_sub(), icon: 'Box', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/analytics/modules') });
      items.push({ id: 'admin-broadcast', label: m.cp_adm_broadcast(), sublabel: m.cp_adm_broadcast_sub(), icon: 'Megaphone', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/broadcast') });
      items.push({ id: 'admin-security', label: m.cp_adm_security(), sublabel: m.cp_adm_security_sub(), icon: 'ShieldCheck', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/security') });
      items.push({ id: 'admin-content',  label: m.cp_adm_content(), sublabel: m.cp_adm_content_sub(), icon: 'filter', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/content') });
      items.push({ id: 'admin-activation', label: m.cp_adm_activation(), sublabel: m.cp_adm_activation_sub(), icon: 'Key', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/activation') });
      items.push({ id: 'admin-audit',    label: m.cp_adm_audit(), sublabel: m.cp_adm_audit_sub(), icon: 'ClipboardList', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/audit') });
      items.push({ id: 'admin-whitelabel', label: m.cp_adm_whitelabel(), sublabel: m.cp_adm_whitelabel_sub(), icon: 'Layers', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/whitelabel') });
      items.push({ id: 'admin-instances', label: m.cp_adm_instances(), sublabel: m.cp_adm_instances_sub(), icon: 'Server', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/instances') });
      items.push({ id: 'admin-gdpr',     label: m.cp_adm_gdpr(), sublabel: m.cp_adm_gdpr_sub(), icon: 'ShieldCheck', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/gdpr') });
      items.push({ id: 'admin-config',   label: m.cp_adm_config(), sublabel: m.cp_adm_config_sub(), icon: 'Settings', group: GROUP_ADMIN, action: () => guardedNavigate('/admin/config') });
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
      action: () => guardedNavigate(profileBase)
    });
    for (const tab of tabsForPage('/profile')) {
      items.push({
        id: `profile-${tab.id}`,
        label: `${m.cp_my_profile()} › ${tab.label()}`,
        sublabel: m.cp_tab_of({ page: m.cp_my_profile() }),
        icon: tab.icon || 'user',
        group: GROUP_ACCOUNT,
        action: () => guardedNavigate(`${profileBase}/${tab.id}`)
      });
    }

    for (const tab of tabsForPage('/userSettings')) {
      items.push({
        id: `usersettings-${tab.id}`,
        label: `${m.cp_preferences()} › ${tab.label()}`,
        sublabel: m.cp_tab_of({ page: m.cp_preferences() }),
        icon: tab.icon || 'settings',
        group: GROUP_ACCOUNT,
        action: () => guardedNavigate(tab.href)
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
      action: () => guardedNavigate(page.href),
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

  // Texte des pages : un gros fichier, charge a la premiere saisie plutot qu'au demarrage.
  let searchIndex = $state<SearchIndex | null>(null);
  let indexRequested = false;
  $effect(() => {
    if (indexRequested || !normalize(query)) return;
    indexRequested = true;
    import('../generated/searchIndex.json').then((module) => (searchIndex = module.default as SearchIndex)).catch(() => (indexRequested = false));
  });

  /** Resultats classes pour la saisie : exacts d'abord, sinon avec une faute toleree. */
  const ranked = $derived.by(() => {
    const q = normalize(query);
    if (!q) return [];

    const exact = allPaletteItems
      .map((item) => {
        let value = score(item, q);
        // Ni le nom ni les mots-cles : on cherche alors dans le texte de la page.
        if (value === 0 && searchIndex && item.contentPath && !item.label.includes('›')) {
          value = contentScore(pageWords(searchIndex, item.contentPath, getLocale() === 'fr' ? 'fr' : 'en'), q);
        }
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

  let listEl = $state<HTMLDivElement>();
  /** Au clavier, la ligne choisie doit rester à l'écran. */
  $effect(() => {
    void selectedIndex;
    void tick().then(() => listEl?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
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
    class="command-palette layer-command fixed inset-0 flex items-start justify-center pt-[15vh] px-4"
    use:portal
    use:dialogFocus={{}}
    role="dialog"
    aria-modal="true"
    aria-label={m.a11y_command_palette()}
    tabindex="-1"
    onkeydown={(e) => { if (e.key === 'Escape') close(); }}
  >
    <!-- Backdrop -->
    <button
      type="button"
      class="absolute inset-0 bg-black/40 border-none cursor-default w-full h-full text-left p-0"
      onclick={close}
      aria-label={m.common_close()}
      transition:fade={{ duration: 100 }}
    ></button>

    <!-- Palette panel -->
    <div
      class="command-palette__panel tafac-panel relative z-10 w-full max-w-xl overflow-hidden"
      role="document"
      transition:scale={{ start: 0.98, duration: 150 }}
    >
      <div class="flex items-center gap-2 p-3">
        <label class="flex flex-1 min-w-0 items-center gap-2.5 rounded-full bg-surface-container pl-4">
          <Papicon icon="Search" size={16} class="text-on-surface-variant shrink-0" />
          <input aria-label={m.cp_search_ph()}
            bind:this={inputEl}
            bind:value={query}
            oninput={() => selectedIndex = 0}
            onkeydown={handleKeydown}
            type="text"
            placeholder={m.cp_search_ph()}
            class="min-h-11 flex-1 min-w-0 rounded-r-full bg-transparent pr-4 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        </label>
        <button type="button" class="kbd-key hidden sm:inline-flex cursor-pointer" onclick={close} aria-label={m.common_close()}>Esc</button>
      </div>

      <!-- Results -->
      <div bind:this={listEl} class="max-h-[55vh] overflow-y-auto pb-1.5">
        {#if noMatch}
          <p class="flex items-center gap-2 px-4 pt-2 pb-1 text-sm text-on-surface-variant">
            <Papicon icon="SearchX" size={15} class="shrink-0" />
            {m.cp_no_result({ query: query.trim() })}
          </p>
        {/if}
        {#each Object.entries(filteredItems()) as [group, items]}
          <div class="px-1.5 pb-1">
            <p class="text-xs font-semibold text-on-surface-variant px-2.5 py-1.5">{group}</p>
            {#each items as item}
              {@const globalIdx = flatItems().indexOf(item)}
              {@const isSelected = globalIdx === selectedIndex}
              <button
                type="button"
                onclick={() => runItem(item)}
                onmouseenter={() => selectedIndex = globalIdx}
                data-selected={isSelected}
                class="pick-row"
              >
                <span class="icon-disc" aria-hidden="true"><Papicon icon={item.icon} size={15} /></span>
                <span class="flex-1 min-w-0">
                  <span class="pick-row__label truncate">{item.label}</span>
                  {#if item.sublabel}
                    <span class="pick-row__desc truncate">{item.sublabel}</span>
                  {/if}
                </span>
                {#if isSelected}
                  <kbd class="kbd-key hidden sm:inline-flex">↵</kbd>
                {/if}
              </button>
            {/each}
          </div>
        {/each}

      </div>

      <!-- Footer hint -->
      <div class="hidden sm:flex items-center gap-4 px-4 py-2.5 border-t border-outline-variant bg-surface-container-low">
        <div class="flex items-center gap-1.5 text-2xs text-on-surface-variant">
          <kbd class="kbd-key">↑↓</kbd>
          {m.cp_hint_navigate()}
        </div>
        <div class="flex items-center gap-1.5 text-2xs text-on-surface-variant">
          <kbd class="kbd-key">↵</kbd>
          {m.cp_hint_open()}
        </div>
        <div class="flex items-center gap-1.5 text-2xs text-on-surface-variant">
          <kbd class="kbd-key">Esc</kbd>
          {m.common_close()}
        </div>
      </div>
    </div>
  </div>
{/if}
