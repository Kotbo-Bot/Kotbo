<script lang="ts">
  import { m } from '../i18n';
  import { onMount } from 'svelte';
  import { authStore } from '../stores/auth.svelte';
  import { themeStore } from '../stores/theme.svelte';
  import { feedbackModal } from '../stores/feedbackModal.svelte';
  import { onboardingStore } from '../stores/tutorial.svelte';
  import { API_BASE_URL } from '../api';
  import NotificationBell from './NotificationBell.svelte';
  import Papicon from './Papicon.svelte';
  import { sidebarStore } from '../stores/sidebar.svelte';
  import { resolveGuildIconSrc, resolveUserAvatarSrc } from '../discordMedia';
  import { serverSwitcherStore } from '../stores/serverSwitcher.svelte';
  import { isMobile } from '../stores/media.svelte';
  import { userPrefs } from '../stores/userPreferences.svelte';

  /**
   * `standalone` : rendue hors de MainLayout, sans barre laterale a cote.
   * Pleine largeur, et sans le bouton qui ouvrirait une navigation absente.
   */
  const { standalone = false }: { standalone?: boolean } = $props();

  const collapsed = $derived(sidebarStore.collapsed);

  let config = $state({ discordClientId: '' });
  let userMenuOpen = $state(false);
  let langMenuOpen = $state(false);
  const searchQuery = $state('');

  const languages = [
    { code: 'fr', flag: '🇫🇷', label: 'Français' },
    { code: 'en', flag: '🇬🇧', label: 'English' },
  ] as const;

  const currentLanguage = $derived(
    languages.find((lang) => lang.code === userPrefs.prefs.language) ?? languages[0]
  );
  onMount(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/config`);
        if (res.ok) {
          config = await res.json();
        }
      } catch (err) {
        console.error('Fetch config error:', err);
      }
    })();

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.user-menu-container')) {
        userMenuOpen = false;
      }
      if (!target.closest('.lang-menu-container')) {
        langMenuOpen = false;
      }
    };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  });

  const logout = () => {
    authStore.logout();
  };

  const getUserAvatar = () =>
    resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar);

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );


  const highestRole = $derived.by(() => {
    const roles = authStore.member?.roles;
    if (!roles) return '...';

    const sortedRoles = [...roles]
      .filter(r => r.name !== '@everyone' && !r.managed)
      .sort((a, b) => b.position - a.position);

    if (sortedRoles.length === 0) return 'Membre';

    let topRole = sortedRoles[0];
    if (topRole.name === 'Gérant' && sortedRoles.length > 1) {
      topRole = sortedRoles[1];
    }

    return topRole?.name || 'Membre';
  });

  const guildIconUrl = $derived(
    selectedGuild
      ? resolveGuildIconSrc(selectedGuild.id, selectedGuild.icon)
      : null
  );

  // Serveur apparié (staff ↔ principal) accessible pour la bascule rapide
  const pairedGuild = $derived(
    selectedGuild
      ? authStore.guilds.find(
          (g) => g.id === selectedGuild.pairedGuildId || g.pairedGuildId === selectedGuild.id,
        ) ?? null
      : null
  );

  function switchToPairedGuild() {
    if (!pairedGuild) return;
    authStore.setGuild(pairedGuild.id);
    window.location.reload();
  }

  function toggleUserMenu(e: MouseEvent) {
    e.stopPropagation();
    userMenuOpen = !userMenuOpen;
  }

  function startTutorial() {
    if (authStore.selectedGuildId) {
      onboardingStore.initialize(authStore.selectedGuildId);
    }
    onboardingStore.restart();
    userMenuOpen = false;
  }

  function openMobileServerSwitcher() {
    sidebarStore.closeMobile();
    serverSwitcherStore.show();
  }
</script>

<svelte:window />

<header class="app-navbar flex items-center justify-between px-6 bg-surface-container-lowest border-b border-outline-variant h-14 fixed top-0 right-0 z-40 transition-all duration-200 {$isMobile || standalone ? 'w-full' : collapsed ? 'w-[calc(100%-4.5rem)]' : 'w-[calc(100%-15rem)]'}">
  <div class="app-navbar__leading flex min-w-0 items-center gap-4 server-selector-container relative">
    {#if $isMobile}
      {#if !standalone}
      <button
        onclick={sidebarStore.toggleMobile}
        class="app-navbar__menu flex items-center justify-center w-8 h-8 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
        aria-label="Ouvrir la navigation"
        aria-controls="dashboard-sidebar"
        aria-expanded={sidebarStore.mobileOpen}
      >
        <Papicon icon="menu" size={18} />
      </button>
      {/if}

      <button
        type="button"
        onclick={openMobileServerSwitcher}
        disabled={authStore.guilds.length <= 1}
        class="app-navbar__mobile-context min-w-0 text-left disabled:cursor-default"
        aria-label={authStore.guilds.length > 1
          ? `Changer de serveur, serveur actuel ${selectedGuild?.name ?? ''}`
          : `Serveur ${selectedGuild?.name ?? ''}`}
      >
        {#if guildIconUrl}
          <img
            src={guildIconUrl}
            alt=""
            width="24"
            height="24"
            referrerpolicy="no-referrer"
            class="app-navbar__mobile-server-icon"
          >
        {:else}
          <span class="app-navbar__mobile-server-icon app-navbar__mobile-server-fallback">
            {selectedGuild?.name?.charAt(0) || '?'}
          </span>
        {/if}
        <span class="app-navbar__mobile-server-name">
          {selectedGuild?.name ?? 'Serveur'}
        </span>
        {#if authStore.guilds.length > 1}
          <Papicon icon="chevron-down" size={12} class="shrink-0" />
        {/if}
      </button>
    {/if}
    {#if !$isMobile}
      <button
        onclick={serverSwitcherStore.show}
        disabled={authStore.guilds.length <= 1}
        class="app-navbar__server min-w-0 flex items-center gap-2.5 bg-surface-container hover:bg-surface-container-high px-3 py-1.5 rounded-lg text-sm text-on-surface border border-outline-variant hover:border-outline transition-colors cursor-pointer disabled:cursor-default disabled:hover:bg-surface-container disabled:border-outline-variant group select-none"
      >
        {#if guildIconUrl}
          <img
            src={guildIconUrl}
            alt=""
            width="20"
            height="20"
            referrerpolicy="no-referrer"
            class="w-5 h-5 rounded object-cover"
          >
        {:else}
          <div class="w-5 h-5 rounded bg-primary/10 flex items-center justify-center text-[10px] font-medium text-primary">
            {selectedGuild?.name?.charAt(0) || '?'}
          </div>
        {/if}
        <span class="app-navbar__server-name truncate text-on-surface-variant font-medium text-sm transition-colors group-hover:text-on-surface">
          {#if selectedGuild?.name}
            {selectedGuild.name}
          {:else}
            <span class="h-4 w-20 bg-surface-container-high rounded animate-pulse inline-block align-middle"></span>
          {/if}
        </span>
        {#if authStore.guilds.length > 1}
          <Papicon icon="chevron-down" size={12} class="text-on-surface-variant/40" />
        {/if}
      </button>
    {/if}

    {#if pairedGuild}
      <button
        onclick={switchToPairedGuild}
        title="Basculer vers {pairedGuild.name}"
        class="app-navbar__paired flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20 hover:bg-blue-100 dark:hover:bg-blue-500/15 transition-colors select-none"
      >
        <Papicon icon="arrow-right" size={13} />
        <span class="hidden sm:inline">
          {selectedGuild?.isStaffServer ? m.navbar_main_server() : m.navbar_staff_server()}
        </span>
      </button>
    {/if}
  </div>

  <div class="app-navbar__actions flex shrink-0 items-center gap-3">

    {#if authStore.member?.roles}
      <div class="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-container border border-outline-variant">
        <Papicon icon={selectedGuild?.accessLevel === 'moderator' ? 'user' : selectedGuild?.accessLevel === 'admin' ? 'crown' : 'shield'} size={14} class="text-on-surface-variant" />
        <span class="text-2xs font-medium text-on-surface-variant">{highestRole}</span>
      </div>
    {/if}

    <button
      onclick={themeStore.toggle}
      class="app-navbar__secondary-action w-8 h-8 rounded-md border border-outline-variant bg-surface-container-lowest flex items-center justify-center transition-colors hover:bg-surface-container"
      aria-label={m.navbar_change_theme()}
      id="theme-toggle"
    >
      {#if themeStore.dark}
        <Papicon icon="sun" size={16} class="text-warning" />
      {:else}
        <Papicon icon="moon" size={16} class="text-on-surface-variant" />
      {/if}
    </button>

    <div class="app-navbar__secondary-action relative lang-menu-container">
      <button
        onclick={() => (langMenuOpen = !langMenuOpen)}
        class="w-8 h-8 rounded-md border border-outline-variant bg-surface-container-lowest flex items-center justify-center transition-colors hover:bg-surface-container text-sm font-semibold select-none cursor-pointer"
        title={m.navbar_lang_switch()}
        aria-label={m.navbar_lang_switch()}
        aria-haspopup="listbox"
        aria-expanded={langMenuOpen}
      >
        {currentLanguage.flag}
      </button>

      {#if langMenuOpen}
        <div
          class="absolute right-0 mt-2 w-40 rounded-lg border border-outline-variant bg-surface-container-lowest shadow-lg py-1 z-50"
          role="listbox"
        >
          {#each languages as lang}
            <button
              role="option"
              aria-selected={userPrefs.prefs.language === lang.code}
              onclick={() => {
                userPrefs.set('language', lang.code);
                langMenuOpen = false;
              }}
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors hover:bg-surface-container cursor-pointer {userPrefs.prefs.language === lang.code ? 'bg-surface-container font-semibold' : ''}"
            >
              <span class="text-base leading-none">{lang.flag}</span>
              <span class="flex-1">{lang.label}</span>
              {#if userPrefs.prefs.language === lang.code}
                <Papicon icon="Check" size={14} class="text-primary" />
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <NotificationBell />

    <div class="flex items-center gap-2 group user-menu-container relative">
      <button
        onclick={toggleUserMenu}
        class="app-navbar__profile flex items-center gap-2 hover:bg-surface-container p-1 rounded-lg transition-colors group/avatar"
        aria-label="Ouvrir le menu du profil"
        aria-expanded={userMenuOpen}
      >
        <div class="w-8 h-8 shrink-0 rounded-md overflow-hidden ring-1 ring-outline-variant">
          {#if !authStore.user}
            <div class="w-full h-full bg-surface-container-high animate-pulse"></div>
          {:else}
            <img class="w-full h-full object-cover" src={getUserAvatar()} alt="Avatar"/>
          {/if}
        </div>
        <div class="hidden sm:flex flex-col items-start">
          <span class="text-xs font-medium text-on-surface leading-none">
            {#if authStore.user?.username}
              {authStore.user?.username}
            {:else}
              <div class="h-3 w-16 bg-surface-container-high rounded animate-pulse"></div>
            {/if}
          </span>
        </div>
        <Papicon icon="chevron-down" size={12} class="text-on-surface-variant/40 transition-transform duration-150 {userMenuOpen ? 'rotate-180' : ''}" />
      </button>

      {#if userMenuOpen}
        <div class="absolute right-0 top-12 w-52 rounded-lg border border-outline-variant bg-surface-container-lowest shadow-lg overflow-hidden animate-in fade-in slide-up duration-150 z-50">
          <div class="px-3 py-2.5 border-b border-outline-variant">
            <p class="text-xs font-medium text-on-surface truncate">{authStore.user?.username}</p>
            <p class="text-2xs text-on-surface-variant mt-0.5">ID: {authStore.user?.id?.slice(0, 10)}...</p>
          </div>
          <div class="py-1">
            <button
              type="button"
              class="flex items-center gap-2.5 px-3 py-2 w-full text-left text-sm text-primary transition-colors hover:bg-surface-container cursor-pointer"
              onclick={startTutorial}
            >
              <Papicon icon="school" size={16} />
              {m.navbar_tutorial()}
            </button>
            <a
              href={authStore.user?.id ? `/profile/${authStore.user.id}` : '/profile'}
              class="flex items-center gap-2.5 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => userMenuOpen = false}
            >
              <Papicon icon="user" size={16} />
              {m.navbar_my_profile()}
            </a>
            <a
              href="/me"
              class="flex items-center gap-2.5 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => userMenuOpen = false}
            >
              <Papicon icon="edit" size={16} />
              {m.me_title()}
            </a>
            <a
              href="/activity"
              class="flex items-center gap-2.5 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => userMenuOpen = false}
            >
              <Papicon icon="history" size={16} />
              {m.navbar_my_activity()}
            </a>
            <a
              href="/userSettings"
              class="flex items-center gap-2.5 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => userMenuOpen = false}
            >
              <Papicon icon="settings" size={16} />
              {m.navbar_settings()}
            </a>
          </div>
          <div class="border-t border-outline-variant py-1">
            <a
              href="https://docs.kotbo.fr/"
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-center gap-2.5 px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => userMenuOpen = false}
            >
              <Papicon icon="pronote" size={16} />
              {m.navbar_documentation()}
            </a>
            <button
              type="button"
              class="flex items-center gap-2.5 px-3 py-2 w-full text-left text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface cursor-pointer"
              onclick={() => {
                    userMenuOpen = false;
                    feedbackModal.show();
                  }
                }
            >
              <Papicon icon="bug_report" size={16} />
              {m.navbar_feedback()}
            </button>
            <button
              type="button"
              onclick={logout}
              class="flex items-center gap-2.5 px-3 py-2 w-full text-left text-sm font-medium text-error transition-colors hover:bg-error/10"
            >
              <Papicon icon="log-out" size={16} />
              {m.navbar_logout()}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</header>
<div class="app-navbar-spacer h-14"></div>
