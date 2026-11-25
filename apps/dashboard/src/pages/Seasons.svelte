<script lang="ts">
  import { onDestroy, onMount, type Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { isRewardOutcomeComplete, seasonProgress, type SeasonRewardOutcome, type SeasonStats } from '@kotbo/shared';
  import {
    deleteSeason,
    endSeason,
    fetchDiscordChannels,
    fetchSeasonLeaderboard,
    fetchSeasonsData,
    retrySeasonRewards,
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
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { StatTile } from '../lib/components/ui';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import SeasonEditorModal from '../lib/components/seasons/SeasonEditorModal.svelte';
  import SeasonStatsChart from '../lib/components/seasons/SeasonStatsChart.svelte';
  import { blockedSeasonRoles } from '../lib/components/seasons/seasonRoleBlockers';
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

  let statusOpen = $state(false);
  let recap = $state<SeasonStanding[] | null>(null);
  let recapFailed = $state(false);
  let retrying = $state<string | null>(null);
  const wide = new MediaQuery('min-width: 64rem');

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
    ((dashboardStore.state.discordRoles || []) as Array<{ id: string; name: string; position?: number }>).filter((role) => role.id !== authStore.selectedGuildId)
  );
  const botRoleAccess = $derived(data?.botRoleAccess ?? null);

  const active = $derived(data?.activeSeason ?? null);
  const nextUpcoming = $derived(
    [...(data?.seasons ?? [])].filter((season) => season.status === 'UPCOMING').sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null
  );
  const progress = $derived(active ? seasonProgress(new Date(active.startDate), new Date(active.endDate)) : null);
  const topXp = $derived(Math.max(1, data?.activeLeaderboard[0]?.xp ?? 1));
  const nextNumber = $derived((data?.seasons ?? []).reduce((max, season) => Math.max(max, season.number), 0) + 1);
  const lastEnded = $derived(
    [...(data?.seasons ?? [])].filter((season) => season.status === 'ENDED').sort((a, b) => b.endDate.localeCompare(a.endDate))[0] ?? null
  );

  /** Saisons closes avec leur bilan chiffré, de la plus ancienne à la plus récente. */
  const comparable = $derived(
    (data?.seasons ?? [])
      .filter((season): season is Season & { stats: SeasonStats } => season.status === 'ENDED' && !!season.stats)
      .sort((a, b) => a.number - b.number)
  );

  /** Récompenses de palier remises, regroupées par seuil : une puce par palier, pas par membre. */
  function tierGroups(season: Season): Array<{ tierXp: number; first: SeasonRewardOutcome; members: number; pending: number; problems: string }> {
    const groups = new Map<number, SeasonRewardOutcome[]>();
    for (const outcome of season.grantedRewards ?? []) {
      if (outcome.tierXp === undefined) continue;
      groups.set(outcome.tierXp, [...(groups.get(outcome.tierXp) ?? []), outcome]);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b).map(([tierXp, outcomes]) => {
      const missing = outcomes.filter((outcome) => !isRewardOutcomeComplete(outcome));
      return {
        tierXp,
        first: outcomes[0],
        members: outcomes.length,
        pending: missing.length,
        problems: [...new Set(missing.map(outcomeProblems))].join(' · '),
      };
    });
  }

  function channelName(channelId: string): string {
    return textChannels.find((channel) => channel.id === channelId)?.name ?? channelId;
  }

  /** Conseils sur la saison en cours, du plus utile au moins utile. */
  const advice = $derived.by(() => {
    if (!active) return [];
    const list: Array<{ id: string; variant: 'info' | 'warning'; title: string; text: string; lines?: string[]; action?: string }> = [];
    // Une seule saison tourne à la fois : celle dont le début est passé attend
    // la clôture de l'actuelle, sans quoi rien ne dirait pourquoi elle reste « à venir ».
    if (nextUpcoming && new Date(nextUpcoming.startDate).getTime() <= Date.now()) {
      list.push({ id: 'queued', variant: 'info', title: m.sea_advice_queued_title({ name: nextUpcoming.name }), text: m.sea_advice_queued_desc() });
    }
    const prizes = [...(active.rewards ?? []), ...(active.tiers ?? [])];
    const blocked = blockedSeasonRoles([active.topRoleId, ...prizes.map((prize) => prize.roleId)], roles, botRoleAccess);
    if (blocked.length > 0) {
      list.push({
        id: 'blocked',
        variant: 'warning',
        title: m.sea_advice_blocked_title(),
        text: m.sea_advice_blocked_desc(),
        lines: blocked.map((entry) => m.sea_blocked_line({ role: entry.name, reason: entry.reason })),
        action: m.sea_btn_edit(),
      });
    }
    const hasRewards = prizes.length > 0 || !!active.topRoleId;
    if (!hasRewards) list.push({ id: 'rewards', variant: 'info', title: m.sea_advice_no_rewards_title(), text: m.sea_advice_no_rewards_desc(), action: m.sea_advice_no_rewards_action() });
    if (hasRewards && !economyActive && prizes.some((prize) => prize.coins > 0)) {
      list.push({ id: 'economy', variant: 'warning', title: m.sea_advice_economy_off_title(), text: m.sea_rewards_economy_off() });
    }
    if (active.announceChannelId === null) list.push({ id: 'announce', variant: 'info', title: m.sea_advice_no_announce_title(), text: m.sea_advice_no_announce_desc(), action: m.sea_advice_no_announce_action() });
    if (new Date(active.endDate).getTime() - Date.now() < 24 * 60 * 60 * 1000) {
      list.push({ id: 'soon', variant: 'info', title: m.sea_advice_ends_soon_title(), text: m.sea_advice_ends_soon_desc({ date: formatDateTime(active.endDate) }) });
    }
    return list;
  });

  const tabItems = $derived<TabItem[]>([
    { id: 'current', label: m.sea_tab_current(), icon: 'Trophy' },
    { id: 'all', label: m.sea_tab_all(), icon: 'Clock', badge: data?.seasons.length || undefined },
  ]);

  const STATUS: Record<Season['status'], { label: () => string; cls: string }> = {
    UPCOMING: { label: () => m.sea_status_upcoming(), cls: 'bg-primary/10 text-primary border-primary/20' },
    ACTIVE: { label: () => m.sea_status_active(), cls: 'bg-success/10 text-on-success-container border-success/20' },
    ENDED: { label: () => m.sea_status_ended(), cls: 'bg-surface-container-high/40 text-on-surface-variant border-outline-variant/20' },
  };
  const PODIUM = ['bg-warning/15 text-on-warning-container', 'bg-surface-container-highest text-on-surface', 'bg-primary/10 text-primary'];

  function formatDateTime(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function roleName(roleId: string): string {
    return roles.find((role) => role.id === roleId)?.name ?? roleId;
  }

  const OUTCOME_TEXT: Record<NonNullable<SeasonRewardOutcome['roleStatus'] | SeasonRewardOutcome['coinsStatus']>, () => string> = {
    given: () => m.sea_outcome_given(),
    blocked: () => m.sea_outcome_blocked(),
    member_left: () => m.sea_outcome_member_left(),
    failed: () => m.sea_outcome_failed(),
    economy_off: () => m.sea_outcome_economy_off(),
  };

  /** Ce qui manque à une récompense, lisible : « Rôle refusé par Discord », etc. */
  function outcomeProblems(outcome: SeasonRewardOutcome): string {
    return [outcome.roleStatus, outcome.coinsStatus]
      .filter((status): status is NonNullable<typeof status> => !!status && status !== 'given')
      .map((status) => OUTCOME_TEXT[status]())
      .join(' · ');
  }

  function pendingOutcomes(season: Season): number {
    return (season.grantedRewards ?? []).filter((outcome) => !isRewardOutcomeComplete(outcome)).length;
  }

  function rewardLabel(reward: { roleId: string | null; coins: number }): string {
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
    await loadRecap();
  }

  /** Sans saison en cours, le podium de la dernière tient lieu de bilan. */
  let recapSeasonId: string | null = null;
  async function loadRecap() {
    if (!data || data.activeSeason || !lastEnded) {
      recap = null;
      recapSeasonId = null;
      recapFailed = false;
      return;
    }
    if (recapSeasonId === lastEnded.id && recap) return;
    recapSeasonId = lastEnded.id;
    recapFailed = false;
    const result = await fetchSeasonLeaderboard(lastEnded.id).catch(() => null);
    // Un échec ne doit pas se lire comme une saison sans classé.
    recapFailed = !result;
    recap = result ? result.leaderboard.slice(0, 3) : null;
  }

  async function handleRetry(season: Season) {
    retrying = season.id;
    try {
      if (await retrySeasonRewards(season.id)) await load(true);
    } finally {
      retrying = null;
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
    const rewardCount = (season.rewards?.length ?? 0) + (season.tiers?.length ?? 0) + (season.topRoleId ? 1 : 0);
    const confirmed = await confirmDialog.ask({
      title: m.sea_end_confirm_title({ name: season.name }),
      description: m.sea_end_confirm_desc(),
      confirmLabel: m.sea_btn_end_season(),
      variant: 'warning',
      impacts: [
        m.sea_end_impact_frozen(),
        rewardCount > 0 ? m.sea_end_impact_rewards({ count: rewardCount }) : m.sea_end_impact_no_rewards(),
        m.sea_end_impact_xp_kept(),
        ...(season.autoRenew ? [m.sea_end_impact_renew()] : []),
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

  let unsubscribeRealtime: (() => void) | null = null;

  onMount(async () => {
    // L'XP gagnée n'émet aucun événement : le filet d'une minute fait monter
    // le classement, les événements couvrent ouverture, clôture et réglages.
    unsubscribeRealtime = subscribeRealtime({
      reasons: ['seasons_updated'],
      fallbackMs: 60_000,
      onUpdate: () => load(true),
    });
    await load();
    const channels = await fetchDiscordChannels().catch(() => null);
    textChannels = channels?.textChannels ?? [];
  });

  onDestroy(() => unsubscribeRealtime?.());
</script>

{#snippet statusPanel()}
  {#if loading || !data}
    <Skeleton height="160px" />
  {:else}
    <dl class="space-y-2 text-sm">
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.sea_status_current()}</dt>
        <dd class="font-semibold text-right truncate">{active ? active.name : m.sea_status_none()}</dd>
      </div>
      {#if active && progress}
        <div class="flex items-center justify-between gap-3">
          <dt class="text-on-surface-variant shrink-0">{m.sea_stat_days_left()}</dt>
          <dd class="font-semibold">{progress.daysLeft}</dd>
        </div>
        <div class="flex items-center justify-between gap-3">
          <dt class="text-on-surface-variant shrink-0">{m.sea_status_rewards()}</dt>
          <dd class="font-semibold">{(active.rewards?.length ?? 0) + (active.tiers?.length ?? 0) + (active.topRoleId ? 1 : 0)}</dd>
        </div>
        <div class="flex items-center justify-between gap-3">
          <dt class="text-on-surface-variant shrink-0">{m.sea_announce_channel_label()}</dt>
          <dd class="font-semibold text-right truncate">{active.announceChannelId ? `#${channelName(active.announceChannelId)}` : m.sea_status_none()}</dd>
        </div>
        <div class="flex items-center justify-between gap-3">
          <dt class="text-on-surface-variant shrink-0">{m.sea_status_auto_renew()}</dt>
          <dd class="font-semibold">{active.autoRenew ? m.sea_status_on() : m.sea_status_off()}</dd>
        </div>
      {/if}
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.sea_status_next()}</dt>
        <dd class="font-semibold text-right truncate">{nextUpcoming ? m.sea_status_next_value({ name: nextUpcoming.name, date: formatDate(nextUpcoming.startDate) }) : m.sea_status_none()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.sea_status_last_ended()}</dt>
        <dd class="font-semibold text-right">{lastEnded ? formatDate(lastEnded.endDate) : m.sea_status_never()}</dd>
      </div>
    </dl>
  {/if}
{/snippet}

{#snippet adviceLines(lines: string[] | undefined)}
  {#if lines && lines.length > 0}
    <ul class="mt-1 list-disc pl-4 space-y-0.5">
      {#each lines as line (line)}<li>{line}</li>{/each}
    </ul>
  {/if}
{/snippet}

{#snippet statusPill(status: Season['status'])}
  <span class="text-2xs font-semibold px-2 py-0.5 rounded-full border {STATUS[status].cls}">{STATUS[status].label()}</span>
{/snippet}

<!-- Toute la ligne ouvre la fiche membre : viser le seul pseudo etait trop fin. -->
{#snippet memberRow(userId: string, name: string, cls: string, content: Snippet)}
  {@const open = memberCaseModal.opener(name)}
  <li>
    <svelte:element
      this={open ? 'button' : 'div'}
      type={open ? 'button' : undefined}
      role={open ? 'button' : undefined}
      title={open ? m.sx_open_member({ name }) : undefined}
      onclick={open ? () => open(userId) : undefined}
      class="w-full text-left rounded-lg text-sm transition-colors {open ? 'cursor-pointer hover:bg-surface-container-high/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30' : ''} {cls}"
    >
      {@render content()}
    </svelte:element>
  </li>
{/snippet}

{#snippet standingsList(entries: SeasonStanding[], scale: number)}
  <ol class="space-y-1">
    {#each entries as entry, i (entry.userId)}
      {#snippet row()}
        <span class="flex h-6 w-6 items-center justify-center rounded-full text-2xs font-bold {PODIUM[i] ?? 'text-on-surface-variant'}">
          {#if i === 0}<Papicon icon="Crown" size={13} />{:else}{entry.rank}{/if}
        </span>
        <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="xs" class="min-w-0" />
        <div class="season-row-bar h-2 bg-surface-container-high rounded-full overflow-hidden">
          <div class="h-2 rounded-full bg-primary transition-all duration-500" style="width: {Math.min(100, (entry.xp / scale) * 100)}%"></div>
        </div>
        <span class="season-row-meta text-2xs text-on-surface-variant text-right whitespace-nowrap">
          {m.sea_row_activity({ level: entry.level, messages: entry.messagesCount.toLocaleString(dateLocale()), voice: entry.voiceMinutes.toLocaleString(dateLocale()) })}
        </span>
        <span class="font-bold text-primary text-right text-xs whitespace-nowrap">+{entry.xp.toLocaleString(dateLocale())} XP</span>
      {/snippet}
      {@render memberRow(entry.userId, entry.displayName, `season-row grid items-center gap-2 px-2.5 py-2 ${i < 3 ? 'bg-surface-container-high/10' : ''}`, row)}
    {/each}
  </ol>
{/snippet}

{#snippet rankedList(entries: RankedStanding[])}
  <ol class="space-y-1">
    {#each entries as entry, i (entry.userId)}
      {#snippet row()}
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-bold {PODIUM[i] ?? 'text-on-surface-variant'}">{entry.rank}</span>
        <UserDisplay userId={entry.userId} name={entry.displayName} avatarUrl={entry.avatarUrl} size="xs" class="min-w-0 flex-1" />
        {#if entry.tier}
          <span class="text-xs font-medium truncate" style="color:{entry.tier.color}">{entry.tier.name}</span>
        {/if}
        <span class="text-xs text-on-surface-variant whitespace-nowrap">{entry.rp.toLocaleString(dateLocale())} RP</span>
      {/snippet}
      {@render memberRow(entry.userId, entry.displayName, `flex items-center gap-2 px-2.5 py-2 ${i < 3 ? 'bg-surface-container-high/10' : ''}`, row)}
    {/each}
  </ol>
{/snippet}

{#snippet outcomesSummary(season: Season)}
  {@const pending = pendingOutcomes(season)}
  <div class="space-y-2">
    <ul class="flex flex-wrap gap-2">
      {#each (season.grantedRewards ?? []).filter((outcome) => outcome.tierXp === undefined) as outcome (`${outcome.rank}-${outcome.userId}-${outcome.roleId}`)}
        {@const complete = isRewardOutcomeComplete(outcome)}
        <li
          class="text-xs px-2.5 py-1 rounded-full border flex items-center gap-1.5 {complete ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-warning border-warning/30'}"
          title={complete ? m.sea_outcome_given() : outcomeProblems(outcome)}
        >
          <Papicon icon={complete ? 'Check' : 'AlertTriangle'} size={12} />
          <span class="font-semibold">#{outcome.rank}</span> {rewardLabel(outcome)}
        </li>
      {/each}
      {#each tierGroups(season) as group (group.tierXp)}
        <li
          class="text-xs px-2.5 py-1 rounded-full border flex items-center gap-1.5 {group.pending === 0 ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-warning border-warning/30'}"
          title={group.pending === 0 ? m.sea_outcome_given() : group.problems}
        >
          <Papicon icon={group.pending === 0 ? 'Check' : 'AlertTriangle'} size={12} />
          <span class="font-semibold">{m.sea_tier_chip({ xp: group.tierXp.toLocaleString(dateLocale()) })}</span>
          {rewardLabel(group.first)} · {m.sea_tier_members({ count: group.members })}
        </li>
      {/each}
    </ul>
    {#if pending > 0}
      <div class="flex flex-wrap items-center gap-3">
        <p class="text-xs text-warning">{m.sea_outcomes_pending({ count: pending })}</p>
        {#if canManage}
          <Button size="sm" icon="RefreshCw" loading={retrying === season.id} onclick={() => handleRetry(season)}>{m.sea_btn_retry_rewards()}</Button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet rotateMark(rotate: boolean | undefined)}
  {#if rotate}
    <span class="inline-flex" title={m.sea_rotate_hint()}>
      <Papicon icon="RefreshCw" size={11} />
      <span class="sr-only">{m.sea_rotate_label()}</span>
    </span>
  {/if}
{/snippet}

{#snippet rewardsSummary(season: Season)}
  {#if season.status === 'ENDED' && (season.grantedRewards?.length ?? 0) > 0}
    {@render outcomesSummary(season)}
  {:else if (season.rewards?.length ?? 0) > 0 || (season.tiers?.length ?? 0) > 0 || season.topRoleId}
    <ul class="flex flex-wrap gap-2">
      {#if season.topRoleId}
        <li class="text-xs px-2.5 py-1 rounded-full bg-warning/10 text-on-warning-container border border-warning/20 flex items-center gap-1.5">
          <Papicon icon="Crown" size={12} /> {m.sea_top_role_chip({ role: roleName(season.topRoleId) })}
        </li>
      {/if}
      {#each season.rewards ?? [] as reward (reward.rank)}
        <li class="text-xs px-2.5 py-1 rounded-full bg-surface-container-high/40 border border-outline-variant/20 flex items-center gap-1.5">
          <span class="font-semibold">#{reward.rank}</span> {rewardLabel(reward)}
          {@render rotateMark(reward.rotate)}
        </li>
      {/each}
      {#each season.tiers ?? [] as tier (tier.minXp)}
        <li class="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center gap-1.5">
          <Papicon icon="Zap" size={12} />
          <span class="font-semibold">{m.sea_tier_chip({ xp: tier.minXp.toLocaleString(dateLocale()) })}</span> {rewardLabel(tier)}
          {@render rotateMark(tier.rotate)}
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

  {#if !wide.current}
    <div class="mb-4">
      <Button size="sm" icon="List" onclick={() => statusOpen = true}>{m.sea_status_title()}</Button>
    </div>
    <Modal bind:open={statusOpen} onClose={() => statusOpen = false} title={m.sea_status_title()}>
      {@render statusPanel()}
    </Modal>
  {/if}

  <!-- Sur grand écran, l'état du module reste à côté du contenu, quel que soit l'onglet. -->
  <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
    <div class="min-w-0">
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
            {#each advice as item (item.id)}
              {#if item.action && canManage}
                <Callout variant={item.variant} title={item.title}>
                  <p>{item.text}</p>
                  {@render adviceLines(item.lines)}
                  {#snippet actions()}
                    <Button size="sm" icon="Pencil" onclick={() => openEditor(active)}>{item.action}</Button>
                  {/snippet}
                </Callout>
              {:else}
                <Callout variant={item.variant} title={item.title}>
                  <p>{item.text}</p>
                  {@render adviceLines(item.lines)}
                </Callout>
              {/if}
            {/each}

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
                <StatTile icon="Users" tone="bg-primary/10 text-primary" value={(data.activeTotals?.participants ?? data.activeLeaderboard.length).toLocaleString(dateLocale())} label={m.sea_stat_participants()} />
                <StatTile icon="Zap" tone="bg-success/10 text-on-success-container" value={(data.activeTotals?.totalXp ?? 0).toLocaleString(dateLocale())} label={m.sea_stat_xp()} />
                <StatTile icon="Clock" tone="bg-warning/10 text-on-warning-container" value={String(progress.daysLeft)} label={m.sea_stat_days_left()} />
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
              {#if canManage}
                <Callout variant="info" title={m.sea_next_title({ name: nextUpcoming.name })}>
                  <p>{m.sea_next_desc({ date: formatDate(nextUpcoming.startDate) })}</p>
                  {#snippet actions()}
                    <Button size="sm" icon="Zap" onclick={() => handleStart(nextUpcoming)}>{m.sea_btn_start_now()}</Button>
                  {/snippet}
                </Callout>
              {:else}
                <Callout variant="info" title={m.sea_next_title({ name: nextUpcoming.name })}>
                  <p>{m.sea_next_desc({ date: formatDate(nextUpcoming.startDate) })}</p>
                </Callout>
              {/if}
            {/if}
            {#if lastEnded}
              <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <h2 class="text-lg font-semibold text-on-surface">{m.sea_recap_title({ name: lastEnded.name })}</h2>
                      <span class="text-xs text-on-surface-variant">#{lastEnded.number}</span>
                      {@render statusPill(lastEnded.status)}
                    </div>
                    <p class="flex items-center gap-1.5 text-xs text-on-surface-variant mt-1">
                      <Papicon icon="Calendar" size={13} /> {m.sea_recap_desc({ date: formatDate(lastEnded.endDate) })}
                    </p>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <Button size="sm" icon="List" onclick={() => openBoard(lastEnded)}>{m.sea_btn_view_ranking()}</Button>
                    {#if canManage && !nextUpcoming}
                      <Button size="sm" variant="primary" icon="Plus" onclick={() => openEditor(null)}>{m.sea_recap_cta()}</Button>
                    {/if}
                  </div>
                </div>

                {#if recapFailed}
                  <div class="flex flex-wrap items-center gap-3">
                    <p class="text-sm text-on-surface-variant">{m.sea_load_error()}</p>
                    <Button size="sm" icon="RefreshCw" onclick={() => loadRecap()}>{m.sea_retry()}</Button>
                  </div>
                {:else if recap === null}
                  <Skeleton height="120px" />
                {:else if recap.length === 0}
                  <p class="text-sm text-on-surface-variant">{m.sea_recap_empty()}</p>
                {:else}
                  {@render standingsList(recap, Math.max(1, recap[0]?.xp ?? 1))}
                {/if}

                <div class="space-y-2">
                  <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Award" size={15} /> {m.sea_recap_rewards()}</h3>
                  {@render rewardsSummary(lastEnded)}
                </div>
              </section>
            {:else}
              <EmptyState
                icon="flag"
                title={m.sea_no_active_title()}
                description={m.sea_empty_desc()}
                actionLabel={canManage && !nextUpcoming ? m.sea_empty_cta() : ''}
                onAction={canManage && !nextUpcoming ? () => openEditor(null) : undefined}
                reason={canManage ? (nextUpcoming ? 'instruction' : undefined) : 'read-only'}
              />
            {/if}
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
        {#if comparable.length >= 2}
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4 mb-6">
            <div>
              <h3 class="text-base font-semibold flex items-center gap-2.5"><Papicon icon="BarChart3" size={16} /> {m.sea_stats_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.sea_stats_desc()}</p>
            </div>
            <SeasonStatsChart seasons={comparable} />
          </section>
        {/if}
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
                    {#if season.status === 'ENDED'}
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
    </div>

    {#if wide.current}
      <aside class="sticky top-4 space-y-4" aria-label={m.sea_status_title()}>
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-4 rounded-xl space-y-3">
          <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="List" size={15} /> {m.sea_status_title()}</h3>
          {@render statusPanel()}
        </section>
      </aside>
    {/if}
  </div>
</ModulePage>

<SeasonEditorModal
  bind:open={editorOpen}
  season={editing}
  {roles}
  channels={textChannels}
  {economyActive}
  activeName={active?.name ?? null}
  {botRoleAccess}
  labels={data?.announcement ?? null}
  {nextNumber}
  onDone={() => load(true)}
/>

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
