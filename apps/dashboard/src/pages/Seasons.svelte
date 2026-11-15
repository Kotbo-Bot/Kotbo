<script lang="ts">
  import { onMount } from 'svelte';
  import { seasonProgress } from '@kotbo/shared';
  import {
    deleteSeason,
    endSeason,
    fetchDiscordChannels,
    fetchSeasonLeaderboard,
    fetchSeasonsData,
    startSeason,
    type RankedStanding,
    type Season,
    type SeasonStanding,
    type SeasonsData,
  } from '../lib/api';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { memberCaseModal } from '../lib/stores/memberCaseModal.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import SeasonEditorModal from '../lib/components/seasons/SeasonEditorModal.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Tabs, { type TabItem } from '../lib/components/ui/Tabs.svelte';
  import { m, dateLocale } from '../lib/i18n';

  type Tab = 'current' | 'all';

  let activeTab = $state<Tab>('current');
  let loading = $state(true);
  let data = $state<SeasonsData | null>(null);

  let textChannels = $state<Array<{ id: string; name: string }>>([]);
  let editorOpen = $state(false);
  let editing = $state<Season | null>(null);

  let boardOpen = $state(false);
  let boardSeason = $state<Season | null>(null);
  let boardLoading = $state(false);
  let board = $state<SeasonStanding[]>([]);
  let boardRanked = $state<RankedStanding[]>([]);

  const canManage = $derived(
    !!dashboardStore.state.featureAccess?.seasons?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );
  /** Module absent de la liste = actif, même lecture que ModulePage. */
  const economyActive = $derived.by(() => {
    const entry = ((dashboardStore.state.modules as unknown as Array<{ id: string; status?: string }> | undefined) ?? []).find((mod) => mod.id === 'economy');
    return !entry || entry.status === 'active';
  });
  /** @everyone porte l'id du serveur : il n'a rien à faire dans une récompense. */
  const roles = $derived(
    ((dashboardStore.state.discordRoles || []) as Array<{ id: string; name: string }>).filter((role) => role.id !== authStore.selectedGuildId)
  );

  const active = $derived(data?.activeSeason ?? null);
  const nextUpcoming = $derived(
    [...(data?.seasons ?? [])].filter((season) => season.status === 'UPCOMING').sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null
  );
  const progress = $derived(active ? seasonProgress(new Date(active.startDate), new Date(active.endDate)) : null);
  const topXp = $derived(Math.max(1, data?.activeLeaderboard[0]?.xp ?? 1));

  const tabItems = $derived<TabItem[]>([
    { id: 'current', label: m.sea_tab_current(), icon: 'Trophy' },
    { id: 'all', label: m.sea_tab_all(), icon: 'Clock', badge: data?.seasons.length || undefined },
  ]);

  const STATUS: Record<Season['status'], { label: () => string; cls: string }> = {
    UPCOMING: { label: () => m.sea_status_upcoming(), cls: 'bg-primary/10 text-primary border-primary/20' },
    ACTIVE: { label: () => m.sea_status_active(), cls: 'bg-success/10 text-success border-success/20' },
    ENDED: { label: () => m.sea_status_ended(), cls: 'bg-surface-container-high/40 text-on-surface-variant border-outline-variant/20' },
    ARCHIVED: { label: () => m.sea_status_archived(), cls: 'bg-surface-container-high/40 text-on-surface-variant border-outline-variant/20' },
  };
  const PODIUM = ['bg-warning/15 text-warning', 'bg-surface-container-highest text-on-surface', 'bg-primary/10 text-primary'];

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function roleName(roleId: string): string {
    return roles.find((role) => role.id === roleId)?.name ?? roleId;
  }

  function rewardLabel(reward: Season['rewards'][number]): string {
    const parts = [
      reward.roleId ? `@${roleName(reward.roleId)}` : null,
      reward.coins > 0 ? m.sea_reward_coins_value({ coins: reward.coins.toLocaleString(dateLocale()) }) : null,
    ].filter(Boolean);
    return parts.join(' + ');
  }

  async function load(quiet = false) {
    if (!quiet) loading = true;
    try {
      data = await fetchSeasonsData();
    } catch {
      data = null;
    } finally {
      loading = false;
    }
  }

  function openEditor(season: Season | null) {
    editing = season;
    editorOpen = true;
  }

  async function handleStart(season: Season) {
    const confirmed = await confirmDialog.ask({
      title: m.sea_start_confirm_title({ name: season.name }),
      description: m.sea_start_confirm_desc(),
      confirmLabel: m.sea_btn_start(),
    });
    if (confirmed && await startSeason(season.id)) await load(true);
  }

  async function handleEnd(season: Season) {
    const rewardCount = (season.rewards?.length ?? 0) + (season.topRoleId ? 1 : 0);
    const confirmed = await confirmDialog.ask({
      title: m.sea_end_confirm_title({ name: season.name }),
      description: m.sea_end_confirm_desc(),
      confirmLabel: m.sea_btn_end_season(),
      variant: 'warning',
      impacts: [
        m.sea_end_impact_frozen(),
        rewardCount > 0 ? m.sea_end_impact_rewards({ count: rewardCount }) : m.sea_end_impact_no_rewards(),
        m.sea_end_impact_xp_kept(),
      ],
    });
    if (confirmed && await endSeason(season.id)) await load(true);
  }

  async function handleDelete(season: Season) {
    const confirmed = await confirmDialog.ask({
      title: m.sea_delete_confirm_title({ name: season.name }),
      description: m.sea_delete_confirm_desc(),
      confirmLabel: m.sea_btn_delete(),
      variant: 'danger',
    });
    if (confirmed && await deleteSeason(season.id)) await load(true);
  }

  async function openBoard(season: Season) {
    boardSeason = season;
    boardOpen = true;
    boardLoading = true;
    board = [];
    boardRanked = [];
    try {
      const result = await fetchSeasonLeaderboard(season.id);
      board = result?.leaderboard ?? [];
      boardRanked = result?.rankedStandings ?? [];
    } finally {
      boardLoading = false;
    }
  }

  onMount(async () => {
    await load();
    const channels = await fetchDiscordChannels().catch(() => null);
    textChannels = channels?.textChannels ?? [];
  });
</script>

{#snippet statTile(icon: string, tone: string, value: string, label: string)}
  <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
    <div class="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 {tone}">
      <Papicon {icon} size={20} />
    </div>
    <div class="flex flex-col min-w-0">
      <span class="text-xl font-bold text-on-surface truncate">{value}</span>
      <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    </div>
  </div>
{/snippet}

{#snippet statusPill(status: Season['status'])}
  <span class="text-2xs font-semibold px-2 py-0.5 rounded-full border {STATUS[status].cls}">{STATUS[status].label()}</span>
{/snippet}

{#snippet standingsList(entries: SeasonStanding[], scale: number)}
  <ol class="space-y-1">
    {#each entries as entry, i (entry.userId)}
      <li class="season-row grid items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors hover:bg-surface-container-high/20 {i < 3 ? 'bg-surface-container-high/10' : ''}">
        <span class="flex h-6 w-6 items-center justify-center rounded-full text-2xs font-bold {PODIUM[i] ?? 'text-on-surface-variant'}">
          {#if i === 0}<Papicon icon="Crown" size={13} />{:else}{entry.rank}{/if}
        </span>
        <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="xs" class="min-w-0" onClick={memberCaseModal.opener(entry.displayName)} />
        <div class="season-row-bar h-2 bg-surface-container-high rounded-full overflow-hidden">
          <div class="h-2 rounded-full bg-primary transition-all duration-500" style="width: {Math.min(100, (entry.xp / scale) * 100)}%"></div>
        </div>
        <span class="season-row-meta text-2xs text-on-surface-variant text-right whitespace-nowrap">
          {m.sea_row_activity({ level: entry.level, messages: entry.messagesCount.toLocaleString(dateLocale()), voice: entry.voiceMinutes.toLocaleString(dateLocale()) })}
        </span>
        <span class="font-bold text-primary text-right text-xs whitespace-nowrap">+{entry.xp.toLocaleString(dateLocale())} XP</span>
      </li>
    {/each}
  </ol>
{/snippet}

{#snippet rankedList(entries: RankedStanding[])}
  <ol class="space-y-1">
    {#each entries as entry, i (entry.userId)}
      <li class="flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm {i < 3 ? 'bg-surface-container-high/10' : ''}">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-bold {PODIUM[i] ?? 'text-on-surface-variant'}">{entry.rank}</span>
        <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="xs" class="min-w-0 flex-1" onClick={memberCaseModal.opener(entry.displayName)} />
        {#if entry.tier}
          <span class="text-xs font-medium truncate" style="color:{entry.tier.color}">{entry.tier.name}</span>
        {/if}
        <span class="text-xs text-on-surface-variant whitespace-nowrap">{entry.rp.toLocaleString(dateLocale())} RP</span>
      </li>
    {/each}
  </ol>
{/snippet}

{#snippet rewardsSummary(season: Season)}
  {#if (season.rewards?.length ?? 0) > 0 || season.topRoleId}
    <ul class="flex flex-wrap gap-2">
      {#if season.topRoleId}
        <li class="text-xs px-2.5 py-1 rounded-full bg-warning/10 text-warning border border-warning/20 flex items-center gap-1.5">
          <Papicon icon="Crown" size={12} /> {m.sea_top_role_chip({ role: roleName(season.topRoleId) })}
        </li>
      {/if}
      {#each season.rewards ?? [] as reward (reward.rank)}
        <li class="text-xs px-2.5 py-1 rounded-full bg-surface-container-high/40 border border-outline-variant/20">
          <span class="font-semibold">#{reward.rank}</span> {rewardLabel(reward)}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-xs text-on-surface-variant">{m.sea_rewards_none()}</p>
  {/if}
{/snippet}

<ModulePage
  title={m.sea_page_title()}
  description={m.sea_page_desc()}
  icon="flag"
  featureKey="seasons"
>
  {#snippet actions()}
    {#if canManage}
      <Button variant="primary" icon="Plus" onclick={() => openEditor(null)}>{m.sea_btn_new_season()}</Button>
    {/if}
  {/snippet}

  <Tabs label={m.sea_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => activeTab = id as Tab} class="mb-6" />

  {#if loading}
    <div class="space-y-6">
      <Skeleton height="160px" />
      <Skeleton height="320px" />
    </div>
  {:else if !data}
    <EmptyState icon="flag" title={m.sea_load_error()} actionLabel={m.sea_retry()} onAction={() => load()} />
  {:else if activeTab === 'current'}
    {#if active && progress}
      <div class="space-y-6">
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-lg font-semibold text-on-surface">{active.name}</h2>
                <span class="text-xs text-on-surface-variant">#{active.number}</span>
                {@render statusPill(active.status)}
              </div>
              <p class="flex items-center gap-1.5 text-xs text-on-surface-variant mt-1">
                <Papicon icon="Calendar" size={13} />
                {m.sea_period({ start: formatDate(active.startDate), end: formatDate(active.endDate) })}
              </p>
            </div>
            {#if canManage}
              <div class="flex flex-wrap gap-2">
                <Button size="sm" icon="Pencil" onclick={() => openEditor(active)}>{m.sea_btn_edit()}</Button>
                <Button size="sm" variant="danger" icon="Flag" onclick={() => handleEnd(active)}>{m.sea_btn_end_season()}</Button>
              </div>
            {/if}
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs text-on-surface-variant">
              <span>{m.sea_progress({ percent: progress.percent })}</span>
              <span>{m.sea_days_left({ count: progress.daysLeft })}</span>
            </div>
            <div class="h-2 bg-surface-container-high rounded-full overflow-hidden" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label={m.sea_progress_aria()}>
              <div class="h-2 rounded-full bg-success transition-all duration-500" style="width: {progress.percent}%"></div>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {@render statTile('Users', 'bg-primary/10 text-primary', (data.activeTotals?.participants ?? data.activeLeaderboard.length).toLocaleString(dateLocale()), m.sea_stat_participants())}
            {@render statTile('Zap', 'bg-success/10 text-success', (data.activeTotals?.totalXp ?? 0).toLocaleString(dateLocale()), m.sea_stat_xp())}
            {@render statTile('Clock', 'bg-warning/10 text-warning', String(progress.daysLeft), m.sea_stat_days_left())}
          </div>

          <div class="space-y-2">
            <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Award" size={15} /> {m.sea_rewards_heading()}</h3>
            {@render rewardsSummary(active)}
          </div>
        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
          <div>
            <h3 class="text-base font-semibold flex items-center gap-2.5"><Papicon icon="Crown" size={16} /> {m.sea_current_ranking()}</h3>
            <p class="text-xs text-on-surface-variant mt-1">{m.sea_ranking_hint()}</p>
          </div>
          {#if data.activeLeaderboard.length === 0}
            <EmptyState icon="trophy" title={m.sea_ranking_empty_title()} description={m.sea_ranking_empty_desc()} reason="accumulating" />
          {:else}
            {@render standingsList(data.activeLeaderboard, topXp)}
          {/if}
        </section>

        {#if (data.activeRankedLeaderboard?.length ?? 0) > 0}
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
            <div>
              <h3 class="text-base font-semibold flex items-center gap-2.5"><Papicon icon="Shield" size={16} /> {m.sea_current_ranking_rp()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.sea_ranking_rp_hint()}</p>
            </div>
            {@render rankedList(data.activeRankedLeaderboard ?? [])}
          </section>
        {/if}
      </div>
    {:else}
      <div class="space-y-6">
        {#if nextUpcoming}
          <Callout variant="info" title={m.sea_next_title({ name: nextUpcoming.name })}>
            <p>{m.sea_next_desc({ date: formatDate(nextUpcoming.startDate) })}</p>
            {#snippet actions()}
              {#if canManage}
                <Button size="sm" icon="Zap" onclick={() => handleStart(nextUpcoming)}>{m.sea_btn_start_now()}</Button>
              {/if}
            {/snippet}
          </Callout>
        {/if}
        <EmptyState
          icon="flag"
          title={m.sea_no_active_title()}
          description={m.sea_empty_desc()}
          actionLabel={canManage && !nextUpcoming ? m.sea_empty_cta() : ''}
          onAction={canManage && !nextUpcoming ? () => openEditor(null) : undefined}
          reason={canManage ? (nextUpcoming ? 'instruction' : undefined) : 'read-only'}
        />
      </div>
    {/if}
  {:else if data.seasons.length === 0}
    <EmptyState
      icon="flag"
      title={m.sea_empty_title()}
      description={m.sea_empty_desc()}
      actionLabel={canManage ? m.sea_empty_cta() : ''}
      onAction={canManage ? () => openEditor(null) : undefined}
      reason={canManage ? undefined : 'read-only'}
    />
  {:else}
    <ul class="space-y-3">
      {#each data.seasons as season (season.id)}
        <li class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-4 space-y-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs font-semibold text-on-surface-variant">#{season.number}</span>
                <h3 class="text-sm font-semibold text-on-surface">{season.name}</h3>
                {@render statusPill(season.status)}
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-variant">
                <span class="flex items-center gap-1"><Papicon icon="Calendar" size={13} /> {m.sea_period({ start: formatDate(season.startDate), end: formatDate(season.endDate) })}</span>
                {#if season.status === 'ENDED' || season.status === 'ARCHIVED'}
                  <span class="flex items-center gap-1"><Papicon icon="Users" size={13} /> {m.sea_participants_count({ count: season._count?.snapshots ?? 0 })}</span>
                {/if}
              </div>
            </div>
            <div class="flex flex-wrap gap-2">
              {#if season.status === 'ACTIVE'}
                <Button size="sm" icon="Trophy" onclick={() => activeTab = 'current'}>{m.sea_btn_view_current()}</Button>
              {:else if season.status === 'UPCOMING'}
                {#if canManage}
                  <Button size="sm" icon="Zap" disabled={!!active} disabledReason={m.sea_start_blocked()} onclick={() => handleStart(season)}>{m.sea_btn_start()}</Button>
                  <Button size="sm" variant="ghost" icon="Pencil" aria-label={m.sea_btn_edit()} onclick={() => openEditor(season)} />
                  <Button size="sm" variant="ghost" icon="Trash" aria-label={m.sea_btn_delete()} onclick={() => handleDelete(season)} />
                {/if}
              {:else}
                <Button size="sm" icon="List" onclick={() => openBoard(season)}>{m.sea_btn_view_ranking()}</Button>
              {/if}
            </div>
          </div>
          {@render rewardsSummary(season)}
        </li>
      {/each}
    </ul>
  {/if}
</ModulePage>

<SeasonEditorModal bind:open={editorOpen} season={editing} {roles} channels={textChannels} {economyActive} onDone={() => load(true)} />

<Modal
  bind:open={boardOpen}
  onClose={() => boardOpen = false}
  title={boardSeason ? m.sea_board_title({ name: boardSeason.name }) : m.sea_current_ranking()}
  subtitle={boardSeason ? m.sea_period({ start: formatDate(boardSeason.startDate), end: formatDate(boardSeason.endDate) }) : undefined}
  size="lg"
>
  {#if boardLoading}
    <Skeleton height="240px" />
  {:else if board.length === 0}
    <EmptyState icon="trophy" title={m.sea_board_empty()} reason="nothing-matches" />
  {:else}
    <div class="space-y-6">
      {@render standingsList(board, Math.max(1, board[0]?.xp ?? 1))}
      {#if boardRanked.length > 0}
        <div class="space-y-3">
          <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Shield" size={15} /> {m.sea_current_ranking_rp()}</h3>
          {@render rankedList(boardRanked)}
        </div>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .season-row {
    grid-template-columns: 1.5rem minmax(0, 1fr) minmax(4rem, 8rem) auto 5.5rem;
  }

  /* Sur un telephone : rang, nom et score ; la barre et le detail s'effacent. */
  @media (max-width: 767px) {
    .season-row {
      grid-template-columns: 1.5rem minmax(0, 1fr) auto;
    }

    .season-row-bar,
    .season-row-meta {
      display: none;
    }
  }
</style>
