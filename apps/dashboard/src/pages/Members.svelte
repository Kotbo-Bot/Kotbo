<script lang="ts">
  import { onMount } from 'svelte';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { fetchMemberCase, dashboardFetch } from '../lib/api';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { m, dateLocale } from '../lib/i18n';
  import { slide } from 'svelte/transition';
  import { Button, FilterPills } from '../lib/components/ui';

  const userIdFromUrl = $derived.by(() => {
    const parts = $router.path.split('/');
    // parts[0] is empty, parts[1] is 'members', parts[2] is the ID
    return parts[2] || undefined;
  });

  type MemberSearchResult = {
    id: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    isBot: boolean;
    lastSeenAt: string | null;
    messageCount: number;
    guildJoinedAt: string | null;
    guildLeftAt: string | null;
    isOnServer: boolean;
    presenceStatus?: string | null;
  };

  type MembersSearchResponse = {
    members: MemberSearchResult[];
    totalFound: number;
    totalPages: number;
    onServerCount: number;
    leftCount: number;
    botCount: number;
  };

  const sortOptions = $derived([
    { value: 'lastSeenAt', label: m.mb_sort_last_activity() },
    { value: 'messageCount', label: m.mb_sort_messages() },
    { value: 'guildJoinedAt', label: m.mb_sort_joined() },
  ] as const);

  let members = $state<MemberSearchResult[]>([]);
  let searchQuery = $state('');
  let loadingSearch = $state(false);
  let searchError = $state('');
  let totalFound = $state(0);
  let onServerCount = $state(0);
  let leftCount = $state(0);
  let botCount = $state(0);
  let page = $state(1);
  let limit = $state(24);
  let totalPages = $state(1);
  let sortBy = $state<'lastSeenAt' | 'messageCount' | 'guildJoinedAt'>('lastSeenAt');
  let sortOrder = $state<'asc' | 'desc'>('desc');
  let botFilter = $state<'human' | 'bot' | 'all'>('human');
  let serverStatus = $state<'on_server' | 'left' | 'all'>('on_server');
  let searchRequestId = 0;
  let filtersOpen = $state(false);

  // Ecarts au reglage par defaut, comptes sur le bouton « Filtres » : un filtre
  // replie ne doit pas pouvoir vider la liste sans qu'on le voie.
  const activeFilterCount = $derived(
    (botFilter !== 'human' ? 1 : 0) + (serverStatus !== 'on_server' ? 1 : 0) + (limit !== 24 ? 1 : 0),
  );

  let modalOpen = $state(false);
  let selectedUserId = $state<string | null>(null);
  let selectedUserName = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  const stats = $derived({
    total: totalFound,
    onServer: onServerCount,
    left: leftCount,
    bots: botCount,
  });

  function formatDate(value: string | null) {
    if (!value) return m.mb_never();
    return new Date(value).toLocaleDateString(dateLocale(), {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  function formatRelative(value: string | null) {
    if (!value) return m.mb_unknown();
    const diffMs = Date.now() - new Date(value).getTime();
    if (Number.isNaN(diffMs)) return m.mb_unknown();
    const minutes = Math.max(1, Math.floor(diffMs / 60000));
    if (minutes < 60) return m.mb_ago_minutes({ n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return m.mb_ago_hours({ n: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return m.mb_ago_days({ n: days });
    return formatDate(value);
  }

  function debounceSearch() {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void search(true);
    }, 320);
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  async function search(resetPage = false) {
    if (!authStore.selectedGuildId) return;

    const requestId = ++searchRequestId;
    if (resetPage) page = 1;
    loadingSearch = true;
    searchError = '';

    try {
      const params = new URLSearchParams({
        q: searchQuery.trim(),
        limit: String(limit),
        page: String(page),
        sortBy,
        sortOrder,
        botFilter,
        serverStatus,
      });

      const response = await dashboardFetch(`/members/search?${params.toString()}`);

      if (!response.ok) {
        throw new Error(m.mb_error_load());
      }

      const data = (await response.json()) as MembersSearchResponse;

      if (requestId !== searchRequestId) return;

      members = data.members ?? [];
      totalFound = data.totalFound ?? 0;
      onServerCount = data.onServerCount ?? 0;
      leftCount = data.leftCount ?? 0;
      botCount = data.botCount ?? 0;
      totalPages = data.totalPages ?? 1;
    } catch (error) {
      if (requestId !== searchRequestId) return;
      console.error('Erreur de recherche des membres:', error);
      searchError = error instanceof Error ? error.message : m.mb_error_search();
      members = [];
      totalFound = 0;
      onServerCount = 0;
      leftCount = 0;
      botCount = 0;
      totalPages = 1;
    } finally {
      if (requestId === searchRequestId) {
        loadingSearch = false;
      }
    }
  }

  /**
   * Le dossier membre appartient a la section Membres : la fenetre ne s'ouvre
   * pas pour un role a qui le centre de gestion l'a fermee, quelle que soit la
   * page qui la demande.
   */
  const canOpenMemberCase = $derived(canViewFeature('members'));

  async function openMemberCase(member: MemberSearchResult | { id: string, displayName?: string, username?: string }) {
    if (!canOpenMemberCase) return;
    if (!authStore.selectedGuildId) return;

    selectedUserId = member.id;
    selectedUserName = ('displayName' in member ? member.displayName : null) || ('username' in member ? member.username : null) || m.mb_member_fallback();
    modalOpen = true;
    loadingCase = true;
    caseError = '';
    caseData = null;

    if ($router.path !== `/members/${member.id}`) {
      router.goto(`/members/${member.id}`);
    }

    try {
      caseData = await fetchMemberCase(member.id, authStore.selectedGuildId);
      if (caseData?.profile) {
        selectedUserName = caseData.profile.displayName || caseData.profile.username || selectedUserName;
      }
    } catch (error) {
      caseError = error instanceof Error ? error.message : m.mb_case_load_error();
    } finally {
      loadingCase = false;
    }
  }

  $effect(() => {
    if (userIdFromUrl && userIdFromUrl !== selectedUserId && authStore.selectedGuildId) {
      void openMemberCase({ id: userIdFromUrl });
    } else if (!userIdFromUrl && modalOpen) {
      modalOpen = false;
      selectedUserId = null;
    }
  });

  function resetSearch() {
    searchQuery = '';
    sortBy = 'lastSeenAt';
    sortOrder = 'desc';
    botFilter = 'human';
    serverStatus = 'on_server';
    limit = 24;
    page = 1;
    void search(true);
  }

  function updateQuery(event: Event) {
    searchQuery = (event.currentTarget as HTMLInputElement).value;
    debounceSearch();
  }

  function changeFilter<T extends string>(setter: (value: T) => void, value: T) {
    setter(value);
    void search(true);
  }

  onMount(() => {
    void search();
  });

  import ModulePage from '../lib/components/ModulePage.svelte';
</script>

<svelte:head>
  <title>{m.mb_head_title()}</title>
</svelte:head>

<ModulePage
  title={m.mb_page_title()}
  description={m.mb_page_desc()}
  icon="users"
  featureKey="members"
>
  <!-- Recherche et tri restent visibles : c'est le geste courant. Le reste
       (type de compte, presence, taille de page) attend derriere « Filtres »,
       qui signale d'un compteur ce qui s'ecarte du reglage par defaut. -->
  <section class="space-y-3">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative flex-1 min-w-0">
        <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-on-surface-variant/60">
          <Papicon icon="search" size={16} />
        </span>
        <input
          type="search"
          value={searchQuery}
          oninput={updateQuery}
          placeholder={m.mb_search_placeholder()}
          aria-label={m.mb_search_placeholder()}
          class="w-full h-10 rounded-lg border border-outline-variant/40 bg-surface-container-low pl-9 pr-9 text-sm text-on-surface placeholder:text-on-surface-variant/50 outline-hidden focus:border-primary/40 focus:ring-2 focus:ring-primary/40"
        />
        {#if loadingSearch}
          <span class="absolute inset-y-0 right-3 flex items-center text-on-surface-variant">
            <Papicon icon="loader" size={14} class="animate-spin" />
          </span>
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <div class="relative flex-1 sm:flex-none">
          <select
            value={sortBy}
            aria-label={m.mb_sort_label()}
            onchange={(event) => changeFilter((value) => { sortBy = value; }, (event.currentTarget as HTMLSelectElement).value as typeof sortBy)}
            class="w-full h-10 appearance-none rounded-lg border border-outline-variant/40 bg-surface-container-low pl-3 pr-9 text-sm text-on-surface transition-colors hover:bg-surface-container focus:border-primary/40"
          >
            {#each sortOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <span class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60">
            <Papicon icon="chevron-down" size={14} />
          </span>
        </div>

        <Button
          variant="ghost"
          icon={sortOrder === 'asc' ? 'sort-asc' : 'sort-desc'}
          onclick={() => changeFilter((value) => { sortOrder = value; }, sortOrder === 'asc' ? 'desc' : 'asc')}
          title={sortOrder === 'asc' ? m.mb_sort_asc() : m.mb_sort_desc()}
          aria-label={sortOrder === 'asc' ? m.mb_sort_asc() : m.mb_sort_desc()}
        />

        <Button
          variant={filtersOpen ? 'secondary' : 'ghost'}
          icon="sliders-horizontal"
          onclick={() => (filtersOpen = !filtersOpen)}
          aria-expanded={filtersOpen}
          aria-controls="members-filters"
        >
          {m.mb_filters()}
          {#if activeFilterCount > 0}
            <span class="ml-0.5 rounded-full bg-primary px-1.5 text-2xs font-semibold text-on-primary tabular-nums">{activeFilterCount}</span>
          {/if}
        </Button>
      </div>
    </div>

    {#if filtersOpen}
      <div
        id="members-filters"
        transition:slide={{ duration: 160 }}
        class="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-outline-variant/30 bg-surface-container-low/60 px-4 py-3"
      >
        <FilterPills
          label={m.mb_filter_type_label()}
          value={botFilter}
          onchange={(value) => changeFilter((v) => { botFilter = v; }, value)}
          options={[
            { value: 'human', label: m.mb_filter_humans() },
            { value: 'bot', label: m.mb_filter_bots() },
            { value: 'all', label: m.common_all() },
          ]}
        />
        <FilterPills
          label={m.mb_filter_presence_label()}
          value={serverStatus}
          onchange={(value) => changeFilter((v) => { serverStatus = v; }, value)}
          options={[
            { value: 'on_server', label: m.mb_status_present() },
            { value: 'left', label: m.mb_status_left() },
            { value: 'all', label: m.common_all() },
          ]}
        />
        <label class="flex items-center gap-2 text-xs text-on-surface-variant">
          {m.mb_per_page()}
          <select
            value={limit}
            onchange={(event) => {
              limit = Number((event.currentTarget as HTMLSelectElement).value);
              void search(true);
            }}
            class="h-8 rounded-md border border-outline-variant/40 bg-surface-container-low px-2 text-xs text-on-surface outline-hidden"
          >
            <!-- Valeurs numeriques : avec des chaines, `limit` (number) ne
                 correspond a aucune option et le select s'affiche vide. -->
            <option value={12}>12</option>
            <option value={24}>24</option>
            <option value={48}>48</option>
          </select>
        </label>
        {#if activeFilterCount > 0}
          <Button variant="ghost" size="sm" icon="rotate-ccw" onclick={resetSearch} class="ml-auto">
            {m.mb_reset_filters()}
          </Button>
        {/if}
      </div>
    {/if}

    <p class="text-xs text-on-surface-variant">
      {m.mb_stat_online({ count: stats.onServer })}
      <span aria-hidden="true" class="mx-1.5 text-on-surface-variant/40">·</span>
      {m.mb_stat_left({ count: stats.left })}
      <span aria-hidden="true" class="mx-1.5 text-on-surface-variant/40">·</span>
      {stats.bots === 1 ? m.mb_stat_bots_one() : m.mb_stat_bots({ count: stats.bots })}
    </p>
  </section>

  {#if searchError}
    <div class="rounded-lg border border-error/20 bg-error/5 px-4 py-3 text-sm font-medium text-error flex items-center gap-3">
      <Papicon icon="alert-circle" size={18} />
      {searchError}
    </div>
  {/if}

  <!-- Grille de résultats (la coque porte deja le <main> de la page) -->
  <div>
    {#if loadingSearch && members.length === 0}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each Array(8) as _}
          <div class="animate-pulse rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4" aria-hidden="true">
            <div class="flex items-center gap-4">
              <div class="h-12 w-12 rounded-xl bg-on-surface/5"></div>
              <div class="flex-1 space-y-2">
                <div class="h-3 w-3/4 rounded-full bg-on-surface/5"></div>
                <div class="h-2 w-1/2 rounded-full bg-on-surface/5"></div>
              </div>
            </div>
            <div class="mt-4 space-y-2">
              <div class="h-2 rounded-full bg-on-surface/5"></div>
              <div class="h-2 rounded-full bg-on-surface/5"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if members.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-center">
        <div class="flex h-16 w-16 items-center justify-center rounded-lg bg-surface-container-low text-on-surface-variant/20">
          <Papicon icon="users" size={32} />
        </div>
        <h3 class="mt-6 text-xl font-bold text-on-surface">{m.mb_no_result()}</h3>
        <p class="mt-2 text-sm text-on-surface-variant/50 max-w-xs">
          {m.mb_no_result_desc()}
        </p>
        <button onclick={resetSearch} class="mt-6 text-body-sm font-medium text-primary hover:underline">
          {m.mb_reset_all()}
        </button>
      </div>
    {:else}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each members as member (member.id)}
          <button
            onclick={() => openMemberCase(member)}
            class={`group flex flex-col rounded-xl border ${member.isOnServer ? 'border-outline-variant/30 bg-surface-container-lowest' : 'border-error/20 bg-error/5'} p-4 text-left transition-colors hover:border-primary/30 hover:bg-surface-container-low`}
          >
            <div class="flex items-center gap-3">
              <div class="relative shrink-0">
                <img
                  src={memberAvatarSrc(member.avatarUrl, member.displayName || member.username, member.id)}
                  alt=""
                  class="h-11 w-11 rounded-full object-cover"
                />
                {#if member.isBot}
                  <div class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-on-primary">
                    <Papicon icon="bot" size={10} />
                  </div>
                {/if}
                <div class={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface-container-lowest ${member.presenceStatus === 'online' ? 'bg-success' : member.presenceStatus === 'idle' ? 'bg-warning' : member.presenceStatus === 'dnd' ? 'bg-error' : 'bg-on-surface-variant/40'}`}></div>
              </div>

              <div class="min-w-0 flex-1">
                <h3 class="truncate text-sm font-semibold text-on-surface group-hover:text-primary transition-colors">{member.displayName || m.mb_no_name()}</h3>
                <p class="truncate text-xs text-on-surface-variant">@{member.username || member.id.slice(0, 8)}</p>
              </div>
            </div>

            <!-- Valeurs lisibles, libelles en retrait : on lit « il y a 2 min »,
                 pas « Activite ». L'identifiant Discord brut n'a rien a faire
                 sur la carte ; la recherche l'accepte toujours. -->
            <dl class="mt-4 grid grid-cols-2 gap-3">
              <div>
                <dt class="text-2xs text-on-surface-variant/70">{m.mb_col_activity()}</dt>
                <dd class="text-sm text-on-surface">{formatRelative(member.lastSeenAt)}</dd>
              </div>
              <div>
                <dt class="text-2xs text-on-surface-variant/70">{m.mb_col_messages()}</dt>
                <dd class="text-sm text-on-surface tabular-nums">{member.messageCount.toLocaleString(dateLocale())}</dd>
              </div>
            </dl>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Pagination Minimaliste -->
  {#if totalPages > 1}
    <footer class="flex items-center justify-between border-t border-outline-variant/10 pt-8">
      <p class="text-xs font-bold text-on-surface-variant/40">
        {m.mb_pagination_count({ shown: members.length, total: totalFound })}
      </p>

      <div class="flex items-center gap-1">
        <button
          onclick={() => { if (page > 1) { page -= 1; void search(); } }}
          disabled={page === 1 || loadingSearch}
          class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container-low text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-30"
        >
          <Papicon icon="chevron-left" size={16} />
        </button>

        <div class="px-4 text-xs font-semibold text-on-surface">
          {page} <span class="mx-1 text-on-surface-variant/30">/</span> {totalPages}
        </div>

        <button
          onclick={() => { if (page < totalPages) { page += 1; void search(); } }}
          disabled={page === totalPages || loadingSearch}
          class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-container-low text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-30"
        >
          <Papicon icon="chevron-right" size={16} />
        </button>
      </div>
    </footer>
  {/if}

<MemberCaseModal
  open={modalOpen}
  userId={selectedUserId}
  userName={selectedUserName}
  {caseData}
  loading={loadingCase}
  error={caseError}
  onClose={() => {
    modalOpen = false;
    if ($router.path !== '/members') {
      router.goto('/members');
    }
  }}
  onSelectUser={(newUserId: string) => void openMemberCase({ id: newUserId })}
/>

</ModulePage>
