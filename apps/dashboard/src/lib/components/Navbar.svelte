<script lang="ts">
  import { m } from "../i18n";
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import { authStore } from "../stores/auth.svelte";
  import { themeStore } from "../stores/theme.svelte";
  import { feedbackModal } from "../stores/feedbackModal.svelte";
  import { onboardingStore } from "../stores/tutorial.svelte";
  import { API_BASE_URL } from "../api";
  import NotificationBell from "./NotificationBell.svelte";
  import Papicon from "./Papicon.svelte";
  import { sidebarStore } from "../stores/sidebar.svelte";
  import { resolveGuildIconSrc, resolveUserAvatarSrc } from "../discordMedia";
  import { serverSwitcherStore } from "../stores/serverSwitcher.svelte";
  import { searchStore } from "../stores/search.svelte";
  import { isMobile } from "../stores/media.svelte";
  import { userPrefs } from "../stores/userPreferences.svelte";
  import { brandingStore } from "../stores/branding.svelte";
  import { TOPGG_VOTE_URL } from "../config/links";

  /**
   * `standalone` : rendue hors de MainLayout, sans barre laterale a cote.
   * Pleine largeur, et sans le bouton qui ouvrirait une navigation absente.
   */
  const { standalone = false }: { standalone?: boolean } = $props();

  const collapsed = $derived(sidebarStore.collapsed);

  let config = $state({ discordClientId: "" });
  let userMenuOpen = $state(false);

  const languages = [
    { code: "fr", flag: "🇫🇷", label: "Français" },
    { code: "en", flag: "🇬🇧", label: "English" },
  ] as const;

  onMount(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/config`);
        if (res.ok) {
          config = await res.json();
        }
      } catch (err) {
        console.error("Fetch config error:", err);
      }
    })();

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".user-menu-container")) {
        userMenuOpen = false;
      }
    };
    const handleCloseMenus = (e: Event) => {
      const detail = (e as CustomEvent<{ except?: string }>).detail;
      if (detail?.except !== "profile") userMenuOpen = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n")
      ) {
        userMenuOpen = false;
      }
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("kotbo:close-navbar-menus", handleCloseMenus);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("kotbo:close-navbar-menus", handleCloseMenus);
      window.removeEventListener("keydown", handleKeyDown);
    };
  });

  $effect(() => {
    if (searchStore.open || serverSwitcherStore.open) {
      userMenuOpen = false;
    }
  });

  const logout = () => {
    authStore.logout();
  };

  const getUserAvatar = () =>
    resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar);

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId),
  );

  const highestRole = $derived.by(() => {
    const roles = authStore.member?.roles;
    if (!roles) return "...";

    const sortedRoles = [...roles]
      .filter((r) => r.name !== "@everyone" && !r.managed)
      .sort((a, b) => b.position - a.position);

    if (sortedRoles.length === 0) return m.wfp_role();

    let topRole = sortedRoles[0];
    if (topRole.name === "Gérant" && sortedRoles.length > 1) {
      topRole = sortedRoles[1];
    }

    return topRole?.name || m.wfp_role();
  });

  const guildIconUrl = $derived(
    selectedGuild
      ? resolveGuildIconSrc(selectedGuild.id, selectedGuild.icon)
      : null,
  );

  // Serveur apparié (staff ↔ principal) accessible pour la bascule rapide
  const pairedGuild = $derived(
    selectedGuild
      ? (authStore.guilds.find(
          (g) =>
            g.id === selectedGuild.pairedGuildId ||
            g.pairedGuildId === selectedGuild.id,
        ) ?? null)
      : null,
  );

  function switchToPairedGuild() {
    if (!pairedGuild) return;
    authStore.setGuild(pairedGuild.id);
    window.location.reload();
  }

  function toggleUserMenu(e: MouseEvent) {
    e.stopPropagation();
    const next = !userMenuOpen;
    if (next) {
      searchStore.close();
      serverSwitcherStore.close();
      window.dispatchEvent(
        new CustomEvent("kotbo:close-navbar-menus", {
          detail: { except: "profile" },
        }),
      );
    }
    userMenuOpen = next;
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

<header
  class="app-navbar flex items-center justify-between px-6 bg-surface-container-lowest border-b border-outline-variant h-14 fixed top-0 right-0 z-40 {$isMobile ||
  standalone
    ? 'w-full'
    : ''} {sidebarStore.isResizing
    ? 'transition-none'
    : 'transition-[width] duration-200'}"
  style={!$isMobile && !standalone
    ? `width: calc(100% - ${collapsed ? "4.5rem" : `${sidebarStore.width}px`});`
    : ""}
>
  <div
    class="app-navbar__leading flex min-w-0 items-center gap-4 server-selector-container relative"
  >
    {#if $isMobile}
      {#if !standalone}
        <button
          onclick={sidebarStore.toggleMobile}
          class="app-navbar__menu flex items-center justify-center w-8 h-8 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors"
          aria-label={m.nbx_open_nav()}
          aria-controls="dashboard-sidebar"
          aria-expanded={sidebarStore.mobileOpen}
        >
          <Papicon icon="menu" size={18} />
        </button>
      {/if}

      <button
        type="button"
        onclick={openMobileServerSwitcher}
        class="app-navbar__mobile-context min-w-0 text-left cursor-pointer"
        aria-label={m.nbx_switch_current({ name: selectedGuild?.name ?? "" })}
      >
        {#if guildIconUrl}
          <img
            src={guildIconUrl}
            alt=""
            width="24"
            height="24"
            referrerpolicy="no-referrer"
            class="app-navbar__mobile-server-icon"
          />
        {:else}
          <span
            class="app-navbar__mobile-server-icon app-navbar__mobile-server-fallback"
          >
            {selectedGuild?.name?.charAt(0) || "?"}
          </span>
        {/if}
        <span class="app-navbar__mobile-server-name">
          {selectedGuild?.name ?? m.sbx_server()}
        </span>
        <Papicon icon="chevron-down" size={12} class="shrink-0" />
      </button>
    {/if}
    {#if !$isMobile}
      <button
        onclick={serverSwitcherStore.show}
        aria-keyshortcuts="Control+G"
        class="app-navbar__server min-w-0 flex items-center gap-2 bg-surface-container-low hover:bg-surface-container pl-2 pr-2.5 py-1 rounded-full text-sm text-on-surface border border-outline-variant hover:border-outline transition-colors cursor-pointer group select-none"
      >
        {#if guildIconUrl}
          <img
            src={guildIconUrl}
            alt=""
            width="22"
            height="22"
            referrerpolicy="no-referrer"
            class="w-[22px] h-[22px] rounded-full object-cover shrink-0"
          />
        {:else}
          <div
            class="w-[22px] h-[22px] rounded-full bg-primary/12 flex items-center justify-center text-[10px] font-semibold text-primary shrink-0"
          >
            {selectedGuild?.name?.charAt(0) || "?"}
          </div>
        {/if}
        <span
          class="app-navbar__server-name truncate text-on-surface font-medium text-sm"
        >
          {#if selectedGuild?.name}
            {selectedGuild.name}
          {:else}
            <span
              class="h-4 w-20 bg-surface-container-high rounded animate-pulse inline-block align-middle"
            ></span>
          {/if}
        </span>
        <kbd class="kbd-key hidden md:inline-flex">Ctrl G</kbd>
        <Papicon
          icon="chevron-down"
          size={12}
          class="text-on-surface-variant shrink-0"
        />
      </button>
    {/if}

    {#if pairedGuild}
      <button
        onclick={switchToPairedGuild}
        title="Basculer vers {pairedGuild.name}"
        class="app-navbar__paired flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 transition-colors select-none cursor-pointer"
      >
        <Papicon icon="arrow-right" size={13} />
        <span class="hidden sm:inline">
          {selectedGuild?.isStaffServer
            ? m.navbar_main_server()
            : m.navbar_staff_server()}
        </span>
      </button>
    {/if}
  </div>

  <div class="app-navbar__actions flex shrink-0 items-center gap-2">
    <!-- A droite, deux choses : ce qui attend une reponse, et soi. Le role
         Discord, le theme et la langue occupaient trois cases de plus sur
         chaque page ; theme et langue vivent dans le menu du profil. -->
    <NotificationBell />

    <div class="flex items-center gap-2 group user-menu-container relative">
      <button
        onclick={toggleUserMenu}
        class="app-navbar__profile flex items-center gap-2 bg-surface-container-low hover:bg-surface-container pl-1.5 pr-3 py-1 rounded-full border border-outline-variant hover:border-outline transition-colors group/avatar cursor-pointer select-none"
        aria-label={authStore.user?.username
          ? m.nbx_open_profile_named({ name: authStore.user.username })
          : m.nbx_open_profile()}
        aria-haspopup="menu"
        aria-expanded={userMenuOpen}
      >
        <div
          class="w-7 h-7 shrink-0 rounded-full overflow-hidden ring-1 ring-outline-variant"
        >
          {#if !authStore.user}
            <div
              class="w-full h-full bg-surface-container-high animate-pulse"
            ></div>
          {:else}
            <img
              class="w-full h-full object-cover"
              src={getUserAvatar()}
              alt=""
            />
          {/if}
        </div>
        <div class="hidden sm:flex flex-col items-start">
          <span class="text-sm font-medium text-on-surface leading-none">
            {#if authStore.user?.username}
              {authStore.user?.username}
            {:else}
              <div
                class="h-3.5 w-16 bg-surface-container-high rounded animate-pulse"
              ></div>
            {/if}
          </span>
        </div>
        <Papicon
          icon="chevron-down"
          size={12}
          class="text-on-surface-variant transition-transform duration-150 {userMenuOpen
            ? 'rotate-180'
            : ''}"
        />
      </button>

      {#if userMenuOpen}
        <div
          transition:fly={{ y: -6, duration: 150 }}
          role="menu"
          aria-label={m.nav_account()}
          class="tafac-panel absolute right-0 top-12 w-76 max-h-[calc(100dvh-5rem)] overflow-y-auto z-50"
        >
          <!-- Identite -->
          <div
            class="flex items-center gap-3 px-4 py-3.5 border-b border-outline-variant bg-surface-container-low/50"
          >
            <div
              class="w-10 h-10 shrink-0 rounded-full overflow-hidden ring-1 ring-outline-variant bg-surface-container"
            >
              {#if authStore.user}
                <img
                  class="w-full h-full object-cover"
                  src={getUserAvatar()}
                  alt=""
                />
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <p
                class="font-headline text-base font-bold text-on-surface truncate leading-tight"
              >
                {authStore.user?.username ?? "…"}
              </p>
              {#if selectedGuild?.name}
                <p class="text-xs text-on-surface-variant mt-0.5 truncate">
                  {highestRole} · {selectedGuild.name}
                </p>
              {/if}
            </div>
          </div>

          <!-- Compte & navigation -->
          <div class="p-2 space-y-0.5">
            <button
              type="button"
              role="menuitem"
              class="group/item flex items-center gap-2.5 px-2.5 py-2 w-full rounded-xl text-left text-sm font-semibold bg-primary-container/65 text-on-primary-container transition-colors hover:bg-primary-container cursor-pointer mb-1"
              onclick={startTutorial}
            >
              <span
                class="w-7 h-7 rounded-lg bg-surface-container-lowest/75 dark:bg-primary/15 text-on-primary-container flex items-center justify-center shrink-0"
              >
                <Papicon icon="school" size={15} />
              </span>
              <span class="truncate">{m.navbar_tutorial()}</span>
            </button>
            <a
              href={authStore.user?.id
                ? `/profile/${authStore.user.id}`
                : "/profile"}
              role="menuitem"
              class="group/item flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => (userMenuOpen = false)}
            >
              <span
                class="w-7 h-7 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center shrink-0 transition-colors group-hover/item:bg-primary/12 group-hover/item:text-primary"
              >
                <Papicon icon="user" size={15} />
              </span>
              <span class="truncate">{m.navbar_my_profile()}</span>
            </a>
            <a
              href="/me"
              role="menuitem"
              class="group/item flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => (userMenuOpen = false)}
            >
              <span
                class="w-7 h-7 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center shrink-0 transition-colors group-hover/item:bg-primary/12 group-hover/item:text-primary"
              >
                <Papicon icon="edit" size={15} />
              </span>
              <span class="truncate">{m.me_title()}</span>
            </a>
            <a
              href="/userSettings"
              role="menuitem"
              class="group/item flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => (userMenuOpen = false)}
            >
              <span
                class="w-7 h-7 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center shrink-0 transition-colors group-hover/item:bg-primary/12 group-hover/item:text-primary"
              >
                <Papicon icon="settings" size={15} />
              </span>
              <span class="truncate">{m.navbar_settings()}</span>
            </a>
          </div>

          <!-- Apparence : theme et langue -->
          <div class="border-t border-outline-variant px-4 py-3 space-y-2.5">
            <div class="flex items-center justify-between gap-3">
              <span class="text-body-sm font-medium text-on-surface-variant"
                >{m.nav_theme()}</span
              >
              <div
                class="inline-flex rounded-full bg-surface-container p-0.5 border border-outline-variant"
                role="group"
                aria-label={m.nav_theme()}
              >
                <button
                  type="button"
                  onclick={() => {
                    if (themeStore.dark) themeStore.toggle();
                  }}
                  aria-pressed={!themeStore.dark}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold transition-colors cursor-pointer {!themeStore.dark
                    ? 'bg-surface-container-lowest dark:bg-surface-container-highest text-on-surface shadow-xs ring-1 ring-outline-variant'
                    : 'text-on-surface-variant hover:text-on-surface'}"
                >
                  <Papicon icon="sun" size={12} />
                  {m.nav_theme_light_short()}
                </button>
                <button
                  type="button"
                  onclick={() => {
                    if (!themeStore.dark) themeStore.toggle();
                  }}
                  aria-pressed={themeStore.dark}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold transition-colors cursor-pointer {themeStore.dark
                    ? 'bg-surface-container-lowest dark:bg-surface-container-highest text-on-surface shadow-xs ring-1 ring-outline-variant'
                    : 'text-on-surface-variant hover:text-on-surface'}"
                >
                  <Papicon icon="moon" size={12} />
                  {m.nav_theme_dark_short()}
                </button>
              </div>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-body-sm font-medium text-on-surface-variant"
                >{m.nav_language()}</span
              >
              <div
                class="inline-flex rounded-full bg-surface-container p-0.5 border border-outline-variant"
                role="group"
                aria-label={m.nav_language()}
              >
                {#each languages as lang (lang.code)}
                  <button
                    type="button"
                    onclick={() => userPrefs.set("language", lang.code)}
                    aria-pressed={userPrefs.prefs.language === lang.code}
                    title={lang.label}
                    class="px-3 py-1 rounded-full text-xs font-semibold uppercase transition-colors cursor-pointer {userPrefs
                      .prefs.language === lang.code
                      ? 'bg-surface-container-lowest dark:bg-surface-container-highest text-on-surface shadow-xs ring-1 ring-outline-variant'
                      : 'text-on-surface-variant hover:text-on-surface'}"
                    >{lang.code}</button
                  >
                {/each}
              </div>
            </div>
          </div>

          <!-- Ressources & retour -->
          <div class="border-t border-outline-variant p-2 space-y-0.5">
            <a
              href="https://docs.kotbo.fr/"
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              class="group/item flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              onclick={() => (userMenuOpen = false)}
            >
              <span
                class="w-7 h-7 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center shrink-0 transition-colors group-hover/item:bg-primary/12 group-hover/item:text-primary"
              >
                <Papicon icon="pronote" size={15} />
              </span>
              <span class="flex-1 truncate">{m.navbar_documentation()}</span>
              <Papicon
                icon="external-link"
                size={13}
                class="shrink-0 text-on-surface-variant/50 group-hover/item:text-on-surface-variant transition-colors"
              />
            </a>
            {#if brandingStore.loaded && !brandingStore.isWhiteLabel}
              <a
                href={TOPGG_VOTE_URL}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                class="group/item flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
                onclick={() => (userMenuOpen = false)}
              >
                <span
                  class="w-7 h-7 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center shrink-0 transition-colors group-hover/item:bg-primary/12 group-hover/item:text-primary"
                >
                  <Papicon icon="star" size={15} />
                </span>
                <span class="flex-1 truncate">{m.navbar_vote_topgg()}</span>
                <Papicon
                  icon="external-link"
                  size={13}
                  class="shrink-0 text-on-surface-variant/50 group-hover/item:text-on-surface-variant transition-colors"
                />
              </a>
            {/if}
            <button
              type="button"
              role="menuitem"
              class="group/item flex items-center gap-2.5 px-2.5 py-2 w-full rounded-xl text-left text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface cursor-pointer"
              onclick={() => {
                userMenuOpen = false;
                feedbackModal.show();
              }}
            >
              <span
                class="w-7 h-7 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center shrink-0 transition-colors group-hover/item:bg-primary/12 group-hover/item:text-primary"
              >
                <Papicon icon="bug_report" size={15} />
              </span>
              <span class="truncate">{m.navbar_feedback()}</span>
            </button>
          </div>

          <!-- Deconnexion -->
          <div class="border-t border-outline-variant p-2">
            <button
              type="button"
              role="menuitem"
              onclick={logout}
              class="group/item flex items-center gap-2.5 px-2.5 py-2 w-full rounded-xl text-left text-sm font-semibold text-error transition-colors hover:bg-error/10 cursor-pointer"
            >
              <span
                class="w-7 h-7 rounded-lg bg-error/10 text-on-error-container flex items-center justify-center shrink-0 transition-colors group-hover/item:bg-error/15"
              >
                <Papicon icon="log-out" size={15} />
              </span>
              <span class="truncate">{m.navbar_logout()}</span>
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</header>
<div class="app-navbar-spacer h-14"></div>
