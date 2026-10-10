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
  {#snippet actions()}
    <div class="flex items-center gap-4">
      <div class="flex -space-x-3">
        {#each members.slice(0, 5) as member}
          <img
            src={memberAvatarSrc(member.avatarUrl, member.displayName || member.username, member.id)}
            alt=""
            class="h-8 w-8 rounded-full border-2 border-surface-container object-cover"
          />
        {/each}
        {#if totalFound > 5}
          <div class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-surface-container bg-surface-container-high text-2xs font-bold text-on-surface-variant">
            +{totalFound - 5}
          </div>
        {/if}
      </div>
      <div class="h-8 w-px bg-outline-variant/20"></div>
      <div class="text-right">
        <div class="text-lg font-semibold text-on-surface">{onServerCount.toLocaleString(dateLocale())}</div>
        <div class="text-xs font-semibold text-on-surface-variant/40">{m.mb_total_members()}</div>
      </div>
    </div>
  {/snippet}

  <!-- Barre d'Action Ergonomique -->
  <section class="sticky top-0 z-10 -mx-4 space-y-4 rounded-b-4xl bg-surface/80 px-4 pb-6 pt-2 md:top-4 md:mx-0 md:rounded-xl md:pt-4">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
      <div class="relative flex-1">
        <span class="pointer-events-none absolute inset-y-0 left-4 flex items-center text-on-surface-variant/40">
          <Papicon icon="search" size={18} />
        </span>
        <input
          type="search"
          value={searchQuery}
          oninput={updateQuery}
          placeholder={m.mb_search_placeholder()}
          class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-low/70 py-3.5 pl-12 pr-12 text-sm text-on-surface placeholder:text-on-surface-variant/30 outline-hidden transition-all focus:border-primary/30 focus:bg-surface-container focus:ring-4 focus:ring-primary/5"
        />
        {#if loadingSearch}
          <span class="absolute inset-y-0 right-4 flex items-center text-primary/60">
            <Papicon icon="loader" size={16} class="animate-spin" />
          </span>
        {/if}
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="group relative">
          <select
            value={sortBy}
            onchange={(event) => changeFilter((value) => { sortBy = value; }, (event.currentTarget as HTMLSelectElement).value as typeof sortBy)}
            class="appearance-none rounded-lg border border-outline-variant/10 bg-surface-container-low/70 py-3.5 pl-4 pr-10 text-xs font-bold text-on-surface-variant transition-colors hover:bg-surface-container focus:border-primary/30"
          >
            {#each sortOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <span class="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
            <Papicon icon="chevron-down" size={14} />
          </span>
        </div>

        <button
          onclick={() => changeFilter((value) => { sortOrder = value; }, sortOrder === 'asc' ? 'desc' : 'asc')}
          class="inline-flex h-11.5 w-11.5 items-center justify-center rounded-lg border border-outline-variant/10 bg-surface-container-low/70 text-on-surface-variant transition-colors hover:bg-surface-container"
          title={sortOrder === 'asc' ? m.mb_sort_asc() : m.mb_sort_desc()}
        >
          <Papicon icon={sortOrder === 'asc' ? 'sort-asc' : 'sort-desc'} size={18} />
        </button>

        <div class="h-8 w-px bg-outline-variant/20 mx-1 hidden sm:block"></div>

        <div class="flex rounded-lg border border-outline-variant/10 bg-surface-container-low/70 p-1">
          <button
            onclick={() => { botFilter = 'human'; void search(true); }}
            class={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${botFilter === 'human' ? 'bg-surface text-primary shadow-xs' : 'text-on-surface-variant/60 hover:text-on-surface'}`}
          >
            {m.mb_filter_humans()}
          </button>
          <button
            onclick={() => { botFilter = 'bot'; void search(true); }}
            class={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${botFilter === 'bot' ? 'bg-surface text-primary shadow-xs' : 'text-on-surface-variant/60 hover:text-on-surface'}`}
          >
            {m.mb_filter_bots()}
          </button>
          <button
            onclick={() => { botFilter = 'all'; void search(true); }}
            class={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${botFilter === 'all' ? 'bg-surface text-primary shadow-xs' : 'text-on-surface-variant/60 hover:text-on-surface'}`}
          >
            {m.common_all()}
          </button>
        </div>

        <div class="flex rounded-lg border border-outline-variant/10 bg-surface-container-low/70 p-1">
          <button
            onclick={() => { serverStatus = 'on_server'; void search(true); }}
            class={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${serverStatus === 'on_server' ? 'bg-surface text-primary shadow-xs' : 'text-on-surface-variant/60 hover:text-on-surface'}`}
          >
            {m.mb_status_present()}
          </button>
          <button
            onclick={() => { serverStatus = 'left'; void search(true); }}
            class={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${serverStatus === 'left' ? 'bg-surface text-primary shadow-xs' : 'text-on-surface-variant/60 hover:text-on-surface'}`}
          >
            {m.mb_status_left()}
          </button>
          <button
            onclick={() => { serverStatus = 'all'; void search(true); }}
            class={`rounded-xl px-4 py-2 text-xs font-bold transition-all ${serverStatus === 'all' ? 'bg-surface text-primary shadow-xs' : 'text-on-surface-variant/60 hover:text-on-surface'}`}
          >
            {m.common_all()}
          </button>
        </div>

        <button
          onclick={resetSearch}
          class="inline-flex h-11.5 w-11.5 items-center justify-center rounded-lg border border-outline-variant/10 bg-surface-container-low/70 text-on-surface-variant transition-colors hover:bg-surface-container hover:text-error"
          title={m.mb_reset_filters()}
        >
          <Papicon icon="rotate-ccw" size={18} />
        </button>
      </div>
    </div>

    <!-- Quick Stats Bar -->
    <div class="flex flex-wrap items-center gap-4 px-2">
      <div class="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant/40">
        <div class="h-1.5 w-1.5 rounded-full bg-emerald-500"></div>
        {m.mb_stat_online({ count: stats.onServer })}
      </div>
      <div class="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant/40">
        <div class="h-1.5 w-1.5 rounded-full bg-amber-500"></div>
        {m.mb_stat_left({ count: stats.left })}
      </div>
      <div class="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant/40">
        <div class="h-1.5 w-1.5 rounded-full bg-primary/50"></div>
        {m.mb_stat_bots({ count: stats.bots })}
      </div>
      <div class="ml-auto flex items-center gap-2">
        <span class="text-xs font-semibold text-on-surface-variant/40">{m.mb_per_page()}</span>
        <select
          value={limit}
          onchange={(event) => {
            limit = Number((event.currentTarget as HTMLSelectElement).value);
            void search(true);
          }}
          class="bg-transparent text-2xs font-bold text-on-surface-variant outline-hidden"
        >
          <!-- Valeurs numeriques : avec des chaines, `limit` (number) ne
               correspond a aucune option et le select s'affiche vide. -->
          <option value={12}>12</option>
          <option value={24}>24</option>
          <option value={48}>48</option>
        </select>
      </div>
    </div>
  </section>

  {#if searchError}
    <div class="rounded-lg border border-error/20 bg-error/5 px-4 py-3 text-sm font-medium text-error flex items-center gap-3">
      <Papicon icon="alert-circle" size={18} />
      {searchError}
    </div>
  {/if}

  <!-- Grille de Résultats Sobres -->
  <main>
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
            class={`group flex flex-col rounded-xl border ${member.isOnServer ? 'border-outline-variant/10 bg-surface-container-low/40' : 'border-error/10 bg-error/5'} p-4 text-left transition-all duration-300 hover:border-primary/20 hover:bg-surface-container-low hover:shadow-xl hover:shadow-primary/5`}
          >
            <div class="flex items-start gap-4">
              <div class="relative">
                <img
                  src={memberAvatarSrc(member.avatarUrl, member.displayName || member.username, member.id)}
                  alt=""
                  class="h-12 w-12 rounded-xl object-cover grayscale-[0.2] transition-all group-hover:grayscale-0"
                />
                {#if member.isBot}
                  <div class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-white">
                    <Papicon icon="bot" size={10} />
                  </div>
                {/if}
                <div class={`absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-surface-container-low ${member.presenceStatus === 'online' ? 'bg-emerald-500' : member.presenceStatus === 'idle' ? 'bg-amber-500' : member.presenceStatus === 'dnd' ? 'bg-rose-500' : 'bg-slate-400'}`}></div>
              </div>

              <div class="min-w-0 flex-1">
                <h3 class="truncate text-base font-bold text-on-surface">{member.displayName || m.mb_no_name()}</h3>
                <p class="truncate text-2xs font-bold tracking-wider text-on-surface-variant/40">@{member.username || member.id.slice(0, 8)}</p>
              </div>
            </div>

            <div class="mt-6 grid grid-cols-2 gap-3">
              <div class="space-y-0.5">
                <div class="text-xs font-semibold text-on-surface-variant/30">{m.mb_col_activity()}</div>
                <div class="text-2xs font-bold text-on-surface-variant/70">{formatRelative(member.lastSeenAt)}</div>
              </div>
              <div class="space-y-0.5">
                <div class="text-xs font-semibold text-on-surface-variant/30">{m.mb_col_messages()}</div>
                <div class="text-2xs font-bold text-on-surface-variant/70">{member.messageCount.toLocaleString(dateLocale())}</div>
              </div>
            </div>

            <div class="mt-4 flex items-center justify-between border-t border-outline-variant/5 pt-3">
              <span class="text-2xs font-bold text-on-surface-variant/30">{member.id.slice(0, 14)}…</span>
              <span class="text-xs font-semibold text-primary/0 transition-all group-hover:text-primary">
                {m.mb_open_case()} <Papicon icon="arrow-right" size={10} />
              </span>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </main>

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
