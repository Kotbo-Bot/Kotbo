<script lang="ts">
  import { dialogFocus } from '../actions/dialogFocus';
  import { portal } from '../actions/portal';
  import { tick } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { serverSwitcherStore } from '../stores/serverSwitcher.svelte';
  import { resolveGuildIconSrc } from '../discordMedia';
  import { m } from '../i18n';

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement>();
  let expandedGroups = $state<Set<string>>(new Set());

  const open = $derived(serverSwitcherStore.open);

  type GuildGroup = { main: any; staffChild: any | null };

  // shortcut: favoris stockés par navigateur (localStorage), pas synchronisés entre appareils.
  const FAV_KEY = 'kotbo:favoriteGuilds';
  function readFavs(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]');
      return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }
  let favorites = $state<string[]>(readFavs());

  function toggleFavorite(guildId: string, e: Event) {
    e.stopPropagation();
    favorites = favorites.includes(guildId)
      ? favorites.filter((id) => id !== guildId)
      : [...favorites, guildId];
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    } catch {}
  }

  // Un serveur staff est imbriqué sous son serveur principal plutôt que listé à plat.
  const guildGroups = $derived.by((): GuildGroup[] => {
    const staffChildByMainId = new Map(
      authStore.guilds
        .filter((g) => g.isStaffServer && g.pairedGuildId)
        .map((g) => [g.pairedGuildId, g]),
    );

    // Un serveur staff n'a sa propre ligne top-level que si son principal n'est pas accessible.
    const groups = authStore.guilds
      .filter((g) => !g.isStaffServer || !authStore.guilds.some((m) => m.id === g.pairedGuildId))
      .map((main) => ({ main, staffChild: staffChildByMainId.get(main.id) ?? null }));
    // Les favoris passent en premier (tri stable : l'ordre d'origine est conservé dans chaque moitié).
    const isFav = (g: GuildGroup) => favorites.includes(g.main.id);
    return [...groups.filter(isFav), ...groups.filter((g) => !isFav(g))];
  });

  const filteredGroups = $derived.by(() => {
    const q = query.toLowerCase().trim();
    if (!q) return guildGroups;
    return guildGroups.filter(
      ({ main, staffChild }) =>
        main.name.toLowerCase().includes(q) || staffChild?.name.toLowerCase().includes(q),
    );
  });

  // Liste à plat des lignes visibles (principal + staff imbriqué déplié) pour la navigation clavier.
  const visibleRows = $derived.by(() => {
    const q = query.toLowerCase().trim();
    const rows: Array<{ guild: any; nested: boolean }> = [];
    for (const { main, staffChild } of filteredGroups) {
      rows.push({ guild: main, nested: false });
      const forceExpand = !!q && staffChild?.name.toLowerCase().includes(q);
      if (staffChild && (expandedGroups.has(main.id) || forceExpand)) {
        rows.push({ guild: staffChild, nested: true });
      }
    }
    return rows;
  });

  $effect(() => {
    if (open) {
      query = '';
      selectedIndex = 0;
      setTimeout(() => inputEl?.focus(), 50);
    }
  });

  let listEl = $state<HTMLDivElement>();
  /** Au clavier, la ligne choisie doit rester à l'écran. */
  $effect(() => {
    void selectedIndex;
    void tick().then(() => listEl?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  });

  function close() {
    serverSwitcherStore.close();
  }

  function toggleGroup(mainGuildId: string): void {
    const next = new Set(expandedGroups);
    if (next.has(mainGuildId)) next.delete(mainGuildId);
    else next.add(mainGuildId);
    expandedGroups = next;
  }

  /**
   * « Ajouter a un serveur » : cette liste ne montre que les serveurs deja
   * equipes, donc rien n'y menait jusqu'ici vers ceux qui restent a equiper.
   * La page /servers, elle, les connait tous.
   */
  function goToServers() {
    close();
    router.goto('/servers');
  }

  function selectGuild(guildId: string) {
    if (guildId === authStore.selectedGuildId) {
      close();
      return;
    }
    authStore.setGuild(guildId);
    close();
    window.location.reload();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    const items = visibleRows;

    if (e.key === 'Escape') {
      close();
      return;
    }
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
      selectGuild(items[selectedIndex].guild.id);
    }
  }
</script>

{#if open}
  <div
    class="server-switcher-modal layer-command fixed inset-0 flex items-start justify-center pt-[15vh] px-4"
    use:portal
    use:dialogFocus={{}}
    role="dialog"
    aria-modal="true"
    aria-label={m.d7_server_switcher()}
    tabindex="-1"
    onkeydown={(e) => { if (e.key === 'Escape') close(); }}
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/40 border-none cursor-default w-full h-full text-left p-0"
      onclick={close}
      aria-label={m.d7_close()}
      transition:fade={{ duration: 100 }}
    ></button>

    <div
      class="server-switcher-modal__panel tafac-panel relative z-10 w-full max-w-md overflow-hidden"
      role="document"
      transition:scale={{ start: 0.98, duration: 150 }}
    >
      <div class="flex items-center gap-2 p-3">
        <label class="flex flex-1 min-w-0 items-center gap-2.5 rounded-full bg-surface-container pl-4">
          <Papicon icon="Search" size={16} class="text-on-surface-variant shrink-0" />
          <input aria-label={m.d7_search_server()}
            bind:this={inputEl}
            bind:value={query}
            oninput={() => selectedIndex = 0}
            onkeydown={handleKeydown}
            type="text"
            placeholder={m.d7_search_server()}
            class="min-h-11 flex-1 min-w-0 rounded-r-full bg-transparent pr-4 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        </label>
        <button type="button" class="kbd-key hidden sm:inline-flex cursor-pointer" onclick={close} aria-label={m.common_close()}>Esc</button>
      </div>

      <div bind:this={listEl} class="max-h-[50vh] overflow-y-auto px-1.5 pb-1.5">
        <p class="text-xs font-semibold text-on-surface-variant px-2.5 py-1.5">
          {m.d7_servers_count({ count: filteredGroups.length })}
        </p>

        {#each visibleRows as row, idx (row.guild.id)}
          {@const guild = row.guild}
          {@const isSelected = idx === selectedIndex}
          {@const isActive = guild.id === authStore.selectedGuildId}
          {@const iconUrl = resolveGuildIconSrc(guild.id, guild.icon)}
          {@const group = row.nested ? null : filteredGroups.find((g) => g.main.id === guild.id)}
          {@const isExpanded = expandedGroups.has(guild.id)}

          <div class="flex w-full items-center gap-1">
            {#if row.nested}
              <div class="w-5 shrink-0"></div>
            {:else if group?.staffChild}
              <button
                type="button"
                onclick={(e) => { e.stopPropagation(); toggleGroup(guild.id); }}
                class="w-5 h-5 shrink-0 flex items-center justify-center rounded-md text-on-surface-variant hover:text-on-surface transition-transform duration-150 {isExpanded ? 'rotate-90' : ''}"
                aria-label={isExpanded ? m.d7_collapse() : m.d7_show_linked_staff()}
              >
                <Papicon icon="ChevronRight" size={12} />
              </button>
            {:else}
              <div class="w-5 shrink-0"></div>
            {/if}

            <button
              type="button"
              onclick={() => selectGuild(guild.id)}
              onmouseenter={() => selectedIndex = idx}
              data-selected={isSelected}
              aria-current={isActive ? 'true' : undefined}
              class="pick-row flex-1"
            >
              {#if iconUrl}
                <img src={iconUrl} alt="" referrerpolicy="no-referrer" class="w-9 h-9 rounded-full object-cover shrink-0" />
              {:else}
                <span class="icon-disc text-sm font-bold" aria-hidden="true">{guild.name.charAt(0).toUpperCase()}</span>
              {/if}

              <span class="flex-1 min-w-0">
                <span class="flex items-center gap-1.5">
                  <span class="pick-row__label truncate">{guild.name}</span>
                  {#if guild.isStaffServer}
                    <span class="shrink-0 text-2xs font-medium px-2 py-0.5 rounded-full border border-outline-variant text-on-surface-variant">{m.d7_staff()}</span>
                  {/if}
                </span>
                <span class="pick-row__desc truncate">
                  {guild.accessLevel === 'admin' ? m.d7_admin() : guild.accessLevel === 'moderator' ? m.d7_moderator() : m.d7_member()}
                </span>
              </span>

              {#if isActive}
                <span class="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-semibold text-primary">
                  <Papicon icon="check" size={11} /> {m.d7_current()}
                </span>
              {/if}
            </button>

            {#if !row.nested}
              {@const isFav = favorites.includes(guild.id)}
              <button
                type="button"
                onclick={(e) => toggleFavorite(guild.id, e)}
                aria-label={m.nav_favorite({ name: guild.name })}
                aria-pressed={isFav}
                class="w-9 h-9 shrink-0 flex items-center justify-center rounded-full cursor-pointer transition-colors duration-150
                  {isFav ? 'text-warning' : 'text-on-surface-variant hover:text-warning hover:bg-surface-container'}"
              >
                <Papicon icon="star" size={13} class={isFav ? 'fill-current' : ''} />
              </button>
            {/if}
          </div>
        {:else}
          <div class="flex flex-col items-center py-8 gap-1.5 text-center">
            <Papicon icon="SearchX" size={24} class="text-on-surface-variant" />
            <p class="text-sm text-on-surface-variant">{m.d7_no_server_found()}</p>
          </div>
        {/each}
      </div>

      <div class="border-t border-outline-variant p-1.5">
        <button type="button" onclick={goToServers} class="pick-row">
          <span class="icon-disc" aria-hidden="true"><Papicon icon="Plus" size={15} /></span>
          <span class="min-w-0 flex-1">
            <span class="pick-row__label truncate">{m.d7_add_to_server()}</span>
            <span class="pick-row__desc truncate">{m.d7_add_to_server_hint()}</span>
          </span>
          <Papicon icon="ChevronRight" size={14} class="shrink-0 text-on-surface-variant" />
        </button>
      </div>

      <div class="hidden sm:flex items-center gap-4 px-4 py-2.5 border-t border-outline-variant bg-surface-container-low">
        <div class="flex items-center gap-1.5 text-2xs text-on-surface-variant">
          <kbd class="kbd-key">↑↓</kbd>
          {m.d7_navigate()}
        </div>
        <div class="flex items-center gap-1.5 text-2xs text-on-surface-variant">
          <kbd class="kbd-key">↵</kbd>
          {m.d7_select()}
        </div>
      </div>
    </div>
  </div>
{/if}
