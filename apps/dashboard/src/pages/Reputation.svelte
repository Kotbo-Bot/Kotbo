<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { router } from 'tinro';
  import {
    REPUTATION_COINS_PER_REP,
    REPUTATION_DAILY_LIMIT,
    REPUTATION_EXCLUDED_MAX,
    REPUTATION_MIN_ACCOUNT_AGE_DAYS,
    REPUTATION_MIN_MEMBER_DAYS,
    REPUTATION_SAME_MEMBER_COOLDOWN_DAYS,
    REPUTATION_XP_PER_REP,
    REPUTATION_TIERS_MAX,
    REPUTATION_TIER_THRESHOLD,
    validateReputationTiers,
    type ReputationPeriod,
    type ReputationTierError,
  } from '@kotbo/shared';
  import {
    deleteReputationVote,
    fetchDiscordChannels,
    fetchReputationData,
    fetchReputationVotes,
    resetReputation,
    updateReputationConfig,
    type ReputationConfig,
    type ReputationData,
    type ReputationVote,
  } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { memberCaseModal } from '../lib/stores/memberCaseModal.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import EmojiListInput from '../lib/components/EmojiListInput.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import MemberSearchSelect from '../lib/components/MemberSearchSelect.svelte';
  import ReputationAdjustModal from '../lib/components/ReputationAdjustModal.svelte';
  import ReputationTierAnnouncementPreview from '../lib/components/ReputationTierAnnouncementPreview.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Field from '../lib/components/ui/Field.svelte';
  import Tabs, { type TabItem } from '../lib/components/ui/Tabs.svelte';
  import FilterPills from '../lib/components/ui/FilterPills.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import { DEFAULT_REPUTATION_CONFIG } from '../lib/reputationData';

  type Tab = 'overview' | 'history' | 'tiers' | 'settings';

  let activeTab = $state<Tab>('overview');
  let loading = $state(true);
  let data = $state<ReputationData | null>(null);
  let period = $state<ReputationPeriod>('all');

  function cloneConfig(source: ReputationConfig): ReputationConfig {
    return {
      ...source,
      excludedRoleIds: [...source.excludedRoleIds],
      excludedChannelIds: [...source.excludedChannelIds],
      tiers: source.tiers.map((tier) => ({ ...tier })),
    };
  }

  /** Forme comparable : « aucun salon » s'écrit `''` dans le sélecteur et `null` en base. */
  function comparable(source: ReputationConfig): string {
    return JSON.stringify({
      dailyLimit: source.dailyLimit,
      reactionEnabled: source.reactionEnabled,
      reactionEmoji: source.reactionEmoji || null,
      xpPerRep: source.xpPerRep,
      coinsPerRep: source.coinsPerRep,
      announceChannelId: source.announceChannelId || null,
      minAccountAgeDays: source.minAccountAgeDays,
      minMemberDays: source.minMemberDays,
      sameMemberCooldownDays: source.sameMemberCooldownDays,
      excludedRoleIds: [...source.excludedRoleIds].sort(),
      excludedChannelIds: [...source.excludedChannelIds].sort(),
      tiers: tiersKey(source.tiers),
    });
  }

  let savedConfig = $state<ReputationConfig>(cloneConfig(DEFAULT_REPUTATION_CONFIG));
  let config = $state<ReputationConfig>(cloneConfig(DEFAULT_REPUTATION_CONFIG));
  let textChannels = $state<Array<{ id: string; name: string }>>([]);

  let votes = $state<ReputationVote[]>([]);
  let nextCursor = $state<string | null>(null);
  let historyPeriod = $state<ReputationPeriod>('all');
  let historyMember = $state<{ id: string; name: string } | null>(null);
  let historyLoading = $state(false);
  /** Seule la dernière requête d'historique a le droit d'écrire la liste. */
  let historyRequest = 0;

  let statusOpen = $state(false);
  const wide = new MediaQuery('min-width: 64rem');

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.reputation?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const configDirty = $derived(comparable(config) !== comparable(savedConfig));
  function inRange(value: number, range: { min: number; max: number }): boolean {
    return Number.isInteger(value) && value >= range.min && value <= range.max;
  }

  const dailyLimitValid = $derived(inRange(config.dailyLimit, REPUTATION_DAILY_LIMIT));
  const xpValid = $derived(inRange(config.xpPerRep, REPUTATION_XP_PER_REP));
  const coinsValid = $derived(inRange(config.coinsPerRep, REPUTATION_COINS_PER_REP));
  /** Même règle que l'API : l'option allumée sans emoji ne ferait rien. */
  const reactionValid = $derived(!config.reactionEnabled || !!config.reactionEmoji);
  const accountAgeValid = $derived(inRange(config.minAccountAgeDays, REPUTATION_MIN_ACCOUNT_AGE_DAYS));
  const memberDaysValid = $derived(inRange(config.minMemberDays, REPUTATION_MIN_MEMBER_DAYS));
  const cooldownValid = $derived(inRange(config.sameMemberCooldownDays, REPUTATION_SAME_MEMBER_COOLDOWN_DAYS));
  const excludedValid = $derived(
    config.excludedRoleIds.length <= REPUTATION_EXCLUDED_MAX && config.excludedChannelIds.length <= REPUTATION_EXCLUDED_MAX
  );
  const guardsValid = $derived(accountAgeValid && memberDaysValid && cooldownValid && excludedValid);
  const settingsValid = $derived(dailyLimitValid && xpValid && coinsValid && reactionValid && guardsValid);

  /** Garde-fous en place, pour le résumé du bloc replié et le panneau d'état. */
  function activeGuards(source: ReputationConfig): number {
    return [
      source.minAccountAgeDays > 0,
      source.minMemberDays > 0,
      source.sameMemberCooldownDays > 1,
      source.excludedRoleIds.length > 0,
      source.excludedChannelIds.length > 0,
    ].filter(Boolean).length;
  }
  const guardCount = $derived(activeGuards(config));

  /** Module absent de la liste = actif, même lecture que ModulePage. */
  function isModuleActive(key: string): boolean {
    const entry = ((dashboardStore.state.modules as unknown as Array<{ id: string; status?: string }> | undefined) ?? []).find((mod) => mod.id === key);
    return !entry || entry.status === 'active';
  }
  const levelingActive = $derived(isModuleActive('leveling'));
  const economyActive = $derived(isModuleActive('economy'));

  function tiersKey(tiers: ReputationConfig['tiers']): string {
    return JSON.stringify(tiers.map(({ threshold, roleId }) => ({ threshold, roleId })));
  }
  const tiersDirty = $derived(tiersKey(config.tiers) !== tiersKey(savedConfig.tiers));

  /** Mêmes règles que l'API, pour le dire avant l'enregistrement. */
  const tiersCheck = $derived(validateReputationTiers(config.tiers));
  const TIER_ERROR_TEXT: Record<ReputationTierError, () => string> = {
    NOT_ARRAY: () => m.rep_tiers_error_role(),
    TOO_MANY: () => m.rep_tiers_error_too_many({ max: REPUTATION_TIERS_MAX }),
    BAD_THRESHOLD: () => m.rep_tiers_error_threshold({ min: REPUTATION_TIER_THRESHOLD.min, max: REPUTATION_TIER_THRESHOLD.max }),
    BAD_ROLE: () => m.rep_tiers_error_role(),
    DUPLICATE_THRESHOLD: () => m.rep_tiers_error_duplicate_threshold(),
    DUPLICATE_ROLE: () => m.rep_tiers_error_duplicate_role(),
  };
  const tiersError = $derived('error' in tiersCheck ? TIER_ERROR_TEXT[tiersCheck.error]() : null);

  /** @everyone porte l'id du serveur : il n'a rien à faire dans un palier. */
  const assignableRoles = $derived(
    (dashboardStore.state.discordRoles || []).filter((role: { id: string }) => role.id !== authStore.selectedGuildId)
  );

  function roleName(roleId: string): string {
    return assignableRoles.find((role: { id: string; name: string }) => role.id === roleId)?.name ?? roleId;
  }

  const unmanageableRoleNames = $derived(
    (data?.unmanageableTierRoleIds ?? []).map((roleId) => roleName(roleId))
  );

  /** Palier montré dans l'aperçu : le plus haut qui a un rôle. */
  const previewTier = $derived(
    [...config.tiers].filter((tier) => tier.roleId).sort((a, b) => b.threshold - a.threshold)[0] ?? null
  );

  const tabItems = $derived<TabItem[]>([
    { id: 'overview', label: m.rep_tab_overview(), icon: 'Crown' },
    { id: 'history', label: m.rep_tab_history(), icon: 'Clock' },
    { id: 'tiers', label: m.rep_tab_tiers(), icon: 'Award', badge: tiersError ? m.rep_tab_to_fix() : undefined },
    { id: 'settings', label: m.rep_tab_settings(), icon: 'Gears', badge: !settingsValid ? m.rep_tab_to_fix() : configDirty ? m.rep_tab_modified() : undefined },
  ]);

  const periodOptions = $derived([
    { value: 'week' as const, label: m.rep_period_week() },
    { value: 'month' as const, label: m.rep_period_month() },
    { value: 'all' as const, label: m.rep_period_all() },
  ]);

  /** Pastille du podium : or, argent, bronze ; rien au-delà, le numéro suffit. */
  const PODIUM = ['rep-podium-gold', 'rep-podium-silver', 'rep-podium-bronze'];

  /** Fenêtre d'ajustement : membre déjà choisi depuis le classement, sinon cherché dedans. */
  let adjustOpen = $state(false);
  let adjustMember = $state<{ id: string; name: string } | null>(null);
  let resetMemberId = $state('');
  let resetMemberName = $state('');

  function openAdjust(target: { id: string; name: string } | null) {
    adjustMember = target;
    adjustOpen = true;
  }

  async function resetMember() {
    if (!resetMemberId) return;
    const confirmed = await confirmDialog.ask({
      title: m.rep_reset_member_title(),
      description: m.rep_reset_member_desc({ name: resetMemberName || resetMemberId }),
      confirmLabel: m.rep_reset_member_confirm(),
      variant: 'danger',
      impacts: [m.rep_reset_impact_tiers(), m.rep_reset_impact_gains_kept()],
    });
    if (!confirmed) return;
    const result = await resetReputation({ scope: 'member', userId: resetMemberId });
    if (result) {
      resetMemberId = '';
      resetMemberName = '';
    }
  }

  async function resetGuild() {
    const confirmed = await confirmDialog.ask({
      title: m.rep_reset_guild_title(),
      description: m.rep_reset_guild_desc({ count: data?.stats.totalVotes ?? 0 }),
      confirmLabel: m.rep_reset_guild_confirm(),
      variant: 'danger',
      requireInput: m.rep_reset_guild_word(),
      impacts: [m.rep_reset_impact_tiers(), m.rep_reset_impact_gains_kept(), m.rep_reset_impact_irreversible()],
    });
    if (!confirmed) return;
    await resetReputation({ scope: 'guild' });
  }

  /** Plus de votes cumulés mais aucun cette semaine : le module s'endort. */
  const quietWeek = $derived(!!data && data.stats.totalVotes > 0 && data.stats.votesLast7Days === 0);

  /** Clic sur un pseudo : ouvre sa fiche, seulement pour qui a accès à « Membres ». */
  function openMemberOnClick(name: string | null | undefined) {
    return memberCaseModal.canOpen ? (userId: string) => memberCaseModal.show(userId, name || userId) : null;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function loadOverview(quiet = false) {
    if (!quiet) loading = true;
    try {
      const result = await fetchReputationData(period);
      if (!result) {
        toast.error(m.rep_load_error());
        return;
      }
      data = result;
      // Un rechargement en temps réel ne doit pas écraser une saisie en cours.
      if (!configDirty) {
        savedConfig = cloneConfig(result.config);
        config = cloneConfig(result.config);
      }
    } finally {
      loading = false;
    }
  }

  async function loadHistory(reset: boolean) {
    const request = ++historyRequest;
    historyLoading = true;
    try {
      const page = await fetchReputationVotes({
        period: historyPeriod,
        userId: historyMember?.id,
        cursor: reset ? undefined : nextCursor ?? undefined,
      });
      if (request !== historyRequest || !page) return;
      votes = reset ? page.votes : [...votes, ...page.votes];
      nextCursor = page.nextCursor;
      nameMemberFromVotes();
    } finally {
      if (request === historyRequest) historyLoading = false;
    }
  }

  function setPeriod(value: ReputationPeriod) {
    period = value;
    void loadOverview(true);
  }

  function setHistoryPeriod(value: ReputationPeriod) {
    historyPeriod = value;
    void loadHistory(true);
  }

  function showMemberHistory(userId: string, name: string | null) {
    historyMember = { id: userId, name: name || userId };
    activeTab = 'history';
    void loadHistory(true);
  }

  const SNOWFLAKE_RE = /^\d{17,20}$/;

  /**
   * `?member=<id>` ouvre l'historique filtré sur ce membre (lien « Voir
   * l'historique » de sa fiche). Seul l'identifiant passe par l'adresse : le
   * pseudo vient du classement, ou des votes une fois chargés.
   */
  function applyMemberQuery(raw: unknown) {
    if (typeof raw !== 'string' || !SNOWFLAKE_RE.test(raw) || raw === historyMember?.id) return;
    const entry = data?.leaderboard.entries.find((candidate) => candidate.userId === raw);
    showMemberHistory(raw, entry?.displayName ?? null);
  }

  /** Pseudo du membre filtré, lu dans un vote quand l'adresse n'a donné que son identifiant. */
  function nameMemberFromVotes() {
    const member = historyMember;
    if (!member || member.name !== member.id) return;
    const vote = votes.find((candidate) => candidate.giverId === member.id || candidate.receiverId === member.id);
    const name = vote?.giverId === member.id ? vote.giverName : vote?.receiverName;
    if (name) historyMember = { ...member, name };
  }

  function clearMemberFilter() {
    historyMember = null;
    void loadHistory(true);
  }

  async function removeVote(vote: ReputationVote) {
    const adjustment = vote.kind === 'ADJUSTMENT';
    const confirmed = await confirmDialog.ask({
      title: adjustment ? m.rep_delete_adjustment_title() : m.rep_delete_vote_title(),
      description: adjustment
        ? m.rep_delete_adjustment_desc({ points: vote.value ?? 0, receiver: vote.receiverName || vote.receiverId })
        : m.rep_delete_vote_desc({
          giver: vote.giverName || vote.giverId,
          receiver: vote.receiverName || vote.receiverId,
        }),
      confirmLabel: m.rep_delete_vote_confirm(),
      variant: 'danger',
      impacts: adjustment ? [] : [m.rep_delete_vote_impact_gains()],
    });
    if (!confirmed) return;
    const result = await deleteReputationVote(vote.id);
    if (result?.deleted) votes = votes.filter((v) => v.id !== vote.id);
  }

  function addTier() {
    const highest = config.tiers.reduce((max, tier) => Math.max(max, tier.threshold), 0);
    config.tiers = [...config.tiers, { threshold: Math.min(highest + 10, REPUTATION_TIER_THRESHOLD.max), roleId: '' }];
  }

  function removeTier(index: number) {
    config.tiers = config.tiers.filter((_, i) => i !== index);
  }

  /** Appelé par la barre « Modifications non enregistrées » du layout. */
  async function saveConfig(): Promise<boolean> {
    if (!settingsValid || (tiersDirty && !('tiers' in tiersCheck))) {
      toast.error(tiersError ?? m.rep_settings_invalid());
      return false;
    }
    const result = await updateReputationConfig({
      dailyLimit: config.dailyLimit,
      reactionEnabled: config.reactionEnabled,
      reactionEmoji: config.reactionEmoji || null,
      xpPerRep: config.xpPerRep,
      coinsPerRep: config.coinsPerRep,
      announceChannelId: config.announceChannelId || null,
      minAccountAgeDays: config.minAccountAgeDays,
      minMemberDays: config.minMemberDays,
      sameMemberCooldownDays: config.sameMemberCooldownDays,
      excludedRoleIds: config.excludedRoleIds,
      excludedChannelIds: config.excludedChannelIds,
      // Paliers inchangés : non renvoyés. Un rôle supprimé depuis ferait refuser
      // par l'API tout l'enregistrement, même d'un simple réglage voisin.
      ...(tiersDirty && 'tiers' in tiersCheck ? { tiers: tiersCheck.tiers } : {}),
    });
    if (!result) return false;
    savedConfig = cloneConfig(result.config);
    config = cloneConfig(result.config);
    return true;
  }

  $effect(() => {
    if (configDirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'reputation',
          label: m.rep_unsaved_label(),
          onSave: () => saveConfig(),
          onReset: () => { config = cloneConfig(savedConfig); },
        });
      });
    } else if (!configDirty) {
      untrack(() => unsavedChanges.release('reputation'));
    }
  });

  let unsubscribeRealtime: (() => void) | null = null;
  let unsubscribeRouter: (() => void) | null = null;
  let destroyed = false;

  onMount(async () => {
    unsubscribeRealtime = subscribeRealtime({
      reasons: ['reputation_updated'],
      onUpdate: () => {
        void loadOverview(true);
        void loadHistory(true);
      },
    });
    await loadOverview();
    await loadHistory(true);
    // Après le premier chargement : le classement sert à nommer le membre demandé.
    if (!destroyed) unsubscribeRouter = router.subscribe((route) => applyMemberQuery(route.query?.member));
    const channels = await fetchDiscordChannels().catch(() => null);
    textChannels = channels?.textChannels ?? [];
  });

  onDestroy(() => {
    destroyed = true;
    unsubscribeRealtime?.();
    unsubscribeRouter?.();
    unsavedChanges.release('reputation');
  });
</script>

{#snippet statusPanel()}
  {#if loading || !data}
    <Skeleton height="140px" />
  {:else}
    <dl class="space-y-2 text-sm">
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.rep_status_daily_limit()}</dt>
        <dd class="font-semibold">{m.rep_status_daily_limit_value({ count: data.config.dailyLimit })}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.rep_votes_last_7_days()}</dt>
        <dd class="font-semibold">{data.stats.votesLast7Days}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.rep_status_active_givers()}</dt>
        <dd class="font-semibold">{data.stats.activeGivers7Days}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.rep_status_tiers()}</dt>
        <dd class="font-semibold">{data.config.tiers.length}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.rep_status_guards()}</dt>
        <dd class="font-semibold">{activeGuards(data.config) > 0 ? m.rep_guards_summary({ count: activeGuards(data.config) }) : m.rep_guards_off()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.rep_status_last_vote()}</dt>
        <dd class="font-semibold text-right">{data.stats.lastVoteAt ? formatDate(data.stats.lastVoteAt) : m.rep_status_never()}</dd>
      </div>
    </dl>
  {/if}
{/snippet}

{#snippet statTile(icon: string, tone: string, value: number, label: string)}
  <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
    <div class="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 {tone}">
      <Papicon {icon} size={20} />
    </div>
    <div class="flex flex-col">
      <span class="text-xl font-bold text-on-surface">{value}</span>
      <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    </div>
  </div>
{/snippet}

<ModulePage
  title={m.rep_page_title()}
  description={m.rep_page_desc()}
  icon="star"
  featureKey="reputation"
>
  {#if !wide.current}
    <div class="mb-4">
      <Button size="sm" icon="List" onclick={() => statusOpen = true}>{m.rep_status_title()}</Button>
    </div>
    <Modal bind:open={statusOpen} onClose={() => statusOpen = false} title={m.rep_status_title()}>
      {@render statusPanel()}
    </Modal>
  {/if}

  <!-- Sur grand écran, l'état du module reste à côté du contenu, quel que soit l'onglet. -->
  <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
    <div class="min-w-0">
      <Tabs label={m.rep_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => activeTab = id as Tab} class="mb-6" />

      {#if loading}
        <div class="space-y-6">
          <Skeleton height="80px" />
          <Skeleton height="300px" />
        </div>
      {:else if !data}
        <EmptyState icon="star" title={m.rep_load_error()} actionLabel={m.rep_retry()} onAction={() => loadOverview()} />
      {:else if activeTab === 'overview'}
        <div class="space-y-6">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {@render statTile('Heart', 'bg-primary/10 text-primary', data.stats.totalVotes, m.rep_total_votes())}
            {@render statTile('Star', 'bg-warning/10 text-warning', data.stats.votesLast7Days, m.rep_votes_last_7_days())}
            {@render statTile('Users', 'bg-success/10 text-success', data.stats.activeGivers7Days, m.rep_status_active_givers())}
          </div>

          {#if data.config.tiers.length === 0}
            <Callout variant="info" title={m.rep_advice_no_tiers_title()}>
              <p>{m.rep_advice_no_tiers_desc()}</p>
              {#snippet actions()}
                <Button size="sm" icon="Award" onclick={() => activeTab = 'tiers'}>{m.rep_advice_no_tiers_action()}</Button>
              {/snippet}
            </Callout>
          {/if}

          {#if quietWeek}
            <Callout variant="info" title={m.rep_advice_quiet_title()}>
              <p>{m.rep_advice_quiet_desc()}</p>
            </Callout>
          {/if}

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="text-base font-semibold flex items-center gap-2.5">
                <Papicon icon="Crown" size={16} />
                {m.rep_ranking_title()}
              </h3>
              <FilterPills label={m.rep_period_label()} options={periodOptions} value={period} onchange={setPeriod} />
            </div>

            {#if data.leaderboard.entries.length === 0}
              <EmptyState
                icon="star"
                title={m.rep_no_votes_title()}
                description={period === 'all' ? m.rep_no_votes_desc() : m.rep_no_votes_period_desc()}
                reason={period === 'all' ? 'accumulating' : 'nothing-matches'}
              />
            {:else}
              <ol class="space-y-1">
                {#each data.leaderboard.entries as entry, i (entry.userId)}
                  <li class="reputation-leaderboard-row grid items-center gap-2 px-2.5 py-2 rounded-lg text-sm transition-colors hover:bg-surface-container-high/20 {i < 3 ? 'bg-surface-container-high/10' : ''}">
                    <span class="flex h-6 w-6 items-center justify-center rounded-full {PODIUM[i] ?? ''}" aria-hidden="true">
                      {#if i === 0}<Papicon icon="Crown" size={13} />{/if}
                    </span>
                    <span class="font-semibold text-on-surface-variant text-xs">#{entry.rank}</span>
                    <UserDisplay
                      userId={entry.userId}
                      name={entry.displayName}
                      avatarUrl={entry.avatarUrl}
                      onClick={openMemberOnClick(entry.displayName)}
                      size="xs"
                    />
                    <div class="h-2 bg-surface-container-high rounded-full overflow-hidden">
                      <div
                        class="h-2 rounded-full transition-all duration-500 bg-success"
                        style="width: {Math.min(100, (entry.totalRep / Math.max(data.leaderboard.entries[0]?.totalRep ?? 1, 1)) * 100)}%"
                      ></div>
                    </div>
                    <span class="font-bold text-success text-right text-xs">+{entry.totalRep}</span>
                    <div class="flex items-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="Clock"
                        aria-label={m.rep_show_member_history({ name: entry.displayName || entry.userId })}
                        onclick={() => showMemberHistory(entry.userId, entry.displayName)}
                      />
                      {#if canManageSettings}
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="SlidersHorizontal"
                          aria-label={m.rep_adjust_member_aria({ name: entry.displayName || entry.userId })}
                          onclick={() => openAdjust({ id: entry.userId, name: entry.displayName || entry.userId })}
                        />
                      {/if}
                    </div>
                  </li>
                {/each}
              </ol>
            {/if}
          </section>
        </div>
      {:else if activeTab === 'history'}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="Clock" size={16} />
              {m.rep_recent_votes_title()}
            </h3>
            <FilterPills label={m.rep_period_label()} options={periodOptions} value={historyPeriod} onchange={setHistoryPeriod} />
          </div>

          {#if historyMember}
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="text-on-surface-variant">{m.rep_history_member_filter({ name: historyMember.name })}</span>
              <Button variant="ghost" size="sm" icon="X" onclick={clearMemberFilter}>{m.rep_history_clear_filter()}</Button>
            </div>
          {/if}

          {#if votes.length === 0 && !historyLoading}
            <EmptyState
              icon="heart"
              title={m.rep_no_recent_title()}
              reason={historyMember || historyPeriod !== 'all' ? 'nothing-matches' : 'accumulating'}
            />
          {:else}
            <ul class="space-y-2">
              {#each votes as vote (vote.id)}
                <li class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-3 space-y-2">
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex items-center gap-2 flex-wrap min-w-0">
                      {#if vote.kind === 'ADJUSTMENT'}
                        <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {(vote.value ?? 0) > 0 ? 'bg-success/10 text-success border border-success/20' : 'bg-error/10 text-error border border-error/20'}">
                          {m.rep_history_adjustment({ points: (vote.value ?? 0) > 0 ? `+${vote.value}` : `${vote.value}` })}
                        </span>
                      {/if}
                      <UserDisplay
                        userId={vote.giverId}
                        name={vote.giverName}
                        avatarUrl={vote.giverAvatarUrl}
                        onClick={openMemberOnClick(vote.giverName)}
                        size="xs"
                        class="max-w-40"
                      />
                      <span class="text-primary flex items-center"><Papicon icon="ArrowRight" size={14} /></span>
                      <UserDisplay
                        userId={vote.receiverId}
                        name={vote.receiverName}
                        avatarUrl={vote.receiverAvatarUrl}
                        onClick={openMemberOnClick(vote.receiverName)}
                        size="xs"
                        class="max-w-40"
                      />
                    </div>
                    {#if canManageSettings}
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="Trash"
                        aria-label={vote.kind === 'ADJUSTMENT' ? m.rep_delete_adjustment_title() : m.rep_delete_vote_title()}
                        onclick={() => removeVote(vote)}
                      />
                    {/if}
                  </div>
                  {#if vote.reason}
                    <p class="text-xs text-on-surface-variant italic">{vote.reason}</p>
                  {/if}
                  <div class="flex flex-wrap items-center gap-3 text-2xs text-on-surface-variant">
                    <span>{formatDate(vote.createdAt)}</span>
                    {#if vote.messageUrl}
                      <a href={vote.messageUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-primary hover:underline">
                        <Papicon icon="ExternalLink" size={11} /> {m.rep_history_open_message()}
                      </a>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}

          {#if nextCursor || historyLoading}
            <div class="flex justify-center">
              <Button size="sm" icon="ChevronDown" loading={historyLoading} onclick={() => loadHistory(false)}>{m.rep_history_load_more()}</Button>
            </div>
          {/if}
        </section>
      {:else if activeTab === 'tiers'}
        <div class="space-y-6">
          {#if unmanageableRoleNames.length > 0}
            <Callout variant="warning" title={m.rep_tiers_unmanageable_title()}>
              <p>{m.rep_tiers_unmanageable_desc({ roles: unmanageableRoleNames.map((name) => `@${name}`).join(', ') })}</p>
            </Callout>
          {/if}

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Award" size={18} /> {m.rep_tiers_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.rep_tiers_desc()}</p>
            </div>

            {#if config.tiers.length === 0}
              <EmptyState
                icon="award"
                title={m.rep_tiers_empty_title()}
                description={m.rep_tiers_empty_desc()}
                actionLabel={canManageSettings ? m.rep_tiers_add() : ''}
                onAction={canManageSettings ? addTier : undefined}
                reason={canManageSettings ? undefined : 'read-only'}
              />
            {:else}
              <ul class="space-y-3">
                {#each config.tiers as tier, index (index)}
                  <li class="rep-tier-row grid items-end gap-3">
                    <Field id="rep-tier-threshold-{index}" label={m.rep_tiers_threshold_label()}>
                      {#snippet children(id)}
                        <input
                          {id}
                          type="number"
                          class="input"
                          min={REPUTATION_TIER_THRESHOLD.min}
                          max={REPUTATION_TIER_THRESHOLD.max}
                          bind:value={tier.threshold}
                          disabled={!canManageSettings}
                        />
                      {/snippet}
                    </Field>
                    <Field id="rep-tier-role-{index}" label={m.rep_tiers_role_label()}>
                      {#snippet children(id)}
                        <SearchableSelect
                          {id}
                          bind:value={tier.roleId}
                          options={assignableRoles.map((role: { id: string; name: string }) => ({ id: role.id, name: `@${role.name}` }))}
                          placeholder={m.rep_tiers_role_placeholder()}
                          disabled={!canManageSettings}
                        />
                      {/snippet}
                    </Field>
                    {#if canManageSettings}
                      <Button
                        variant="ghost"
                        icon="Trash"
                        aria-label={m.rep_tiers_remove({ threshold: tier.threshold })}
                        onclick={() => removeTier(index)}
                      />
                    {/if}
                  </li>
                {/each}
              </ul>

              {#if tiersError}
                <p class="text-xs text-error" role="alert">{tiersError}</p>
              {/if}

              {#if canManageSettings}
                <Button
                  size="sm"
                  icon="Plus"
                  disabled={config.tiers.length >= REPUTATION_TIERS_MAX}
                  disabledReason={m.rep_tiers_error_too_many({ max: REPUTATION_TIERS_MAX })}
                  onclick={addTier}
                >
                  {m.rep_tiers_add()}
                </Button>
              {/if}
            {/if}
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <Field id="rep-announce-channel" label={m.rep_announce_channel_label()} hint={m.rep_announce_channel_hint()}>
              {#snippet children(id)}
                <SearchableSelect
                  {id}
                  bind:value={config.announceChannelId}
                  options={[{ id: '', name: m.rep_announce_channel_none() }, ...textChannels.map((channel) => ({ id: channel.id, name: `#${channel.name}` }))]}
                  placeholder={m.rep_announce_channel_placeholder()}
                  disabled={!canManageSettings}
                />
              {/snippet}
            </Field>

            {#if config.announceChannelId && previewTier && data.announcement}
              <div class="space-y-2">
                <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.rep_announce_preview_heading()}</p>
                <ReputationTierAnnouncementPreview
                  labels={data.announcement}
                  threshold={previewTier.threshold}
                  roleName={roleName(previewTier.roleId)}
                />
              </div>
            {/if}
          </section>
        </div>
      {:else}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-6">
          <div class="border-b border-outline-variant/15 pb-3">
            <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Gears" size={18} /> {m.rep_settings_heading()}</h3>
            <p class="text-xs text-on-surface-variant mt-1">{m.rep_settings_desc()}</p>
          </div>

          <Field
            id="rep-daily-limit"
            label={m.rep_daily_limit_label()}
            hint={m.rep_daily_limit_hint({ min: REPUTATION_DAILY_LIMIT.min, max: REPUTATION_DAILY_LIMIT.max })}
            error={dailyLimitValid ? undefined : m.rep_daily_limit_error({ min: REPUTATION_DAILY_LIMIT.min, max: REPUTATION_DAILY_LIMIT.max })}
          >
            {#snippet children(id, describedBy)}
              <input
                {id}
                type="number"
                class="input max-w-32"
                min={REPUTATION_DAILY_LIMIT.min}
                max={REPUTATION_DAILY_LIMIT.max}
                bind:value={config.dailyLimit}
                aria-describedby={describedBy}
                disabled={!canManageSettings}
              />
            {/snippet}
          </Field>

          <!-- Replié par défaut, comme les options facultatives de Drops : le résumé dit ce qui est en place. -->
          <details class="group border border-outline-variant/15 rounded-xl">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span class="text-sm font-semibold flex items-center gap-2">
                <span class="transition-transform group-open:rotate-90"><Papicon icon="ChevronRight" size={14} /></span>
                <Papicon icon="ShieldCheck" size={15} />
                {m.rep_guards_heading()}
              </span>
              <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {!guardsValid ? 'bg-error/10 text-error border border-error/20' : guardCount > 0 ? 'bg-success/10 text-success border border-success/20' : 'bg-surface-container-high/60 text-on-surface-variant'}">
                {!guardsValid ? m.rep_tab_to_fix() : guardCount > 0 ? m.rep_guards_summary({ count: guardCount }) : m.rep_guards_off()}
              </span>
            </summary>

            <div class="px-4 pb-4 space-y-5">
              <p class="text-xs text-on-surface-variant">{m.rep_guards_desc()}</p>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Field
                  id="rep-min-account-age"
                  label={m.rep_guards_account_age_label()}
                  hint={m.rep_guards_days_hint()}
                  error={accountAgeValid ? undefined : m.rep_rewards_range_error({ min: REPUTATION_MIN_ACCOUNT_AGE_DAYS.min, max: REPUTATION_MIN_ACCOUNT_AGE_DAYS.max })}
                >
                  {#snippet children(id, describedBy)}
                    <input {id} type="number" class="input" min={REPUTATION_MIN_ACCOUNT_AGE_DAYS.min} max={REPUTATION_MIN_ACCOUNT_AGE_DAYS.max} bind:value={config.minAccountAgeDays} aria-describedby={describedBy} disabled={!canManageSettings} />
                  {/snippet}
                </Field>
                <Field
                  id="rep-min-member-days"
                  label={m.rep_guards_member_days_label()}
                  hint={m.rep_guards_days_hint()}
                  error={memberDaysValid ? undefined : m.rep_rewards_range_error({ min: REPUTATION_MIN_MEMBER_DAYS.min, max: REPUTATION_MIN_MEMBER_DAYS.max })}
                >
                  {#snippet children(id, describedBy)}
                    <input {id} type="number" class="input" min={REPUTATION_MIN_MEMBER_DAYS.min} max={REPUTATION_MIN_MEMBER_DAYS.max} bind:value={config.minMemberDays} aria-describedby={describedBy} disabled={!canManageSettings} />
                  {/snippet}
                </Field>
                <Field
                  id="rep-same-member-cooldown"
                  label={m.rep_guards_cooldown_label()}
                  hint={m.rep_guards_cooldown_hint()}
                  error={cooldownValid ? undefined : m.rep_rewards_range_error({ min: REPUTATION_SAME_MEMBER_COOLDOWN_DAYS.min, max: REPUTATION_SAME_MEMBER_COOLDOWN_DAYS.max })}
                >
                  {#snippet children(id, describedBy)}
                    <input {id} type="number" class="input" min={REPUTATION_SAME_MEMBER_COOLDOWN_DAYS.min} max={REPUTATION_SAME_MEMBER_COOLDOWN_DAYS.max} bind:value={config.sameMemberCooldownDays} aria-describedby={describedBy} disabled={!canManageSettings} />
                  {/snippet}
                </Field>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  id="rep-excluded-roles"
                  label={m.rep_guards_roles_label()}
                  hint={m.rep_guards_roles_hint()}
                  error={config.excludedRoleIds.length <= REPUTATION_EXCLUDED_MAX ? undefined : m.rep_guards_too_many({ max: REPUTATION_EXCLUDED_MAX })}
                >
                  {#snippet children(id)}
                    <MultiSelect
                      {id}
                      bind:values={config.excludedRoleIds}
                      options={assignableRoles.map((role: { id: string; name: string }) => ({ id: role.id, name: `@${role.name}` }))}
                      placeholder={m.rep_guards_none()}
                      disabled={!canManageSettings}
                    />
                  {/snippet}
                </Field>
                <Field
                  id="rep-excluded-channels"
                  label={m.rep_guards_channels_label()}
                  hint={m.rep_guards_channels_hint()}
                  error={config.excludedChannelIds.length <= REPUTATION_EXCLUDED_MAX ? undefined : m.rep_guards_too_many({ max: REPUTATION_EXCLUDED_MAX })}
                >
                  {#snippet children(id)}
                    <MultiSelect
                      {id}
                      bind:values={config.excludedChannelIds}
                      options={textChannels.map((channel) => ({ id: channel.id, name: `#${channel.name}` }))}
                      placeholder={m.rep_guards_none()}
                      disabled={!canManageSettings}
                    />
                  {/snippet}
                </Field>
              </div>
            </div>
          </details>
        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5 mt-6">
          <div class="flex items-start justify-between gap-4 border-b border-outline-variant/15 pb-3">
            <div>
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Heart" size={18} /> {m.rep_reaction_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.rep_reaction_desc()}</p>
            </div>
            <ToggleSwitch
              checked={config.reactionEnabled}
              onToggle={(value) => config.reactionEnabled = value}
              disabled={!canManageSettings}
              ariaLabel={m.rep_reaction_toggle()}
            />
          </div>

          <Field
            id="rep-reaction-emoji"
            label={m.rep_reaction_emoji_label()}
            hint={m.rep_reaction_emoji_hint()}
            error={reactionValid ? undefined : m.rep_reaction_emoji_required()}
          >
            {#snippet children(id)}
              <EmojiListInput
                {id}
                max={1}
                bind:values={() => (config.reactionEmoji ? [config.reactionEmoji] : []), (values) => config.reactionEmoji = values[0] ?? null}
                placeholder={m.rep_reaction_emoji_placeholder()}
                disabled={!canManageSettings}
              />
            {/snippet}
          </Field>
        </section>

        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5 mt-6">
          <div class="border-b border-outline-variant/15 pb-3">
            <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Coins" size={18} /> {m.rep_rewards_heading()}</h3>
            <p class="text-xs text-on-surface-variant mt-1">{m.rep_rewards_desc()}</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Field
              id="rep-xp-per-rep"
              label={m.rep_rewards_xp_label()}
              hint={levelingActive ? m.rep_rewards_range_hint({ min: REPUTATION_XP_PER_REP.min, max: REPUTATION_XP_PER_REP.max }) : m.rep_rewards_xp_module_off()}
              error={xpValid ? undefined : m.rep_rewards_range_error({ min: REPUTATION_XP_PER_REP.min, max: REPUTATION_XP_PER_REP.max })}
            >
              {#snippet children(id, describedBy)}
                <input
                  {id}
                  type="number"
                  class="input max-w-40"
                  min={REPUTATION_XP_PER_REP.min}
                  max={REPUTATION_XP_PER_REP.max}
                  bind:value={config.xpPerRep}
                  aria-describedby={describedBy}
                  disabled={!canManageSettings}
                />
              {/snippet}
            </Field>
            <Field
              id="rep-coins-per-rep"
              label={m.rep_rewards_coins_label()}
              hint={economyActive ? m.rep_rewards_range_hint({ min: REPUTATION_COINS_PER_REP.min, max: REPUTATION_COINS_PER_REP.max }) : m.rep_rewards_coins_module_off()}
              error={coinsValid ? undefined : m.rep_rewards_range_error({ min: REPUTATION_COINS_PER_REP.min, max: REPUTATION_COINS_PER_REP.max })}
            >
              {#snippet children(id, describedBy)}
                <input
                  {id}
                  type="number"
                  class="input max-w-40"
                  min={REPUTATION_COINS_PER_REP.min}
                  max={REPUTATION_COINS_PER_REP.max}
                  bind:value={config.coinsPerRep}
                  aria-describedby={describedBy}
                  disabled={!canManageSettings}
                />
              {/snippet}
            </Field>
          </div>
        </section>

        {#if canManageSettings}
          <!-- Gestes du staff, à part des réglages : rien ici ne passe par la barre d'enregistrement. -->
          <details class="group bg-surface-container-low/40 border border-outline-variant/30 rounded-xl mt-6">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 [&::-webkit-details-marker]:hidden">
              <span class="text-lg font-semibold flex items-center gap-2">
                <span class="transition-transform group-open:rotate-90"><Papicon icon="ChevronRight" size={16} /></span>
                <Papicon icon="SlidersHorizontal" size={18} />
                {m.rep_staff_heading()}
              </span>
              <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-surface-container-high/60 text-on-surface-variant">{m.rep_staff_badge()}</span>
            </summary>

            <div class="px-6 pb-6 space-y-6">
              <p class="text-xs text-on-surface-variant">{m.rep_staff_desc()}</p>

              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold">{m.rep_adjust_title()}</p>
                  <p class="text-xs text-on-surface-variant">{m.rep_staff_adjust_desc()}</p>
                </div>
                <Button size="sm" icon="SlidersHorizontal" onclick={() => openAdjust(null)}>{m.rep_staff_adjust_action()}</Button>
              </div>

              <div class="space-y-3 border-t border-outline-variant/15 pt-5">
                <div>
                  <p class="text-sm font-semibold">{m.rep_reset_member_title()}</p>
                  <p class="text-xs text-on-surface-variant">{m.rep_staff_reset_member_desc()}</p>
                </div>
                <div class="flex flex-wrap items-end gap-3">
                  <div class="min-w-56 flex-1">
                    <MemberSearchSelect
                      id="rep-reset-member"
                      bind:value={resetMemberId}
                      placeholder={m.rep_adjust_member_placeholder()}
                      onselect={(member) => resetMemberName = member.displayName || member.username}
                    />
                  </div>
                  <Button size="sm" variant="danger" icon="RotateCcw" disabled={!resetMemberId} onclick={resetMember}>{m.rep_reset_member_confirm()}</Button>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-between gap-3 border-t border-error/20 pt-5">
                <div>
                  <p class="text-sm font-semibold text-error">{m.rep_reset_guild_title()}</p>
                  <p class="text-xs text-on-surface-variant">{m.rep_staff_reset_guild_desc()}</p>
                </div>
                <Button size="sm" variant="danger" icon="AlertTriangle" onclick={resetGuild}>{m.rep_reset_guild_confirm()}</Button>
              </div>
            </div>
          </details>
        {/if}
      {/if}
    </div>

    {#if wide.current}
      <aside class="sticky top-4 space-y-4" aria-label={m.rep_status_title()}>
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-4 rounded-xl space-y-3">
          <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="List" size={15} /> {m.rep_status_title()}</h3>
          {@render statusPanel()}
        </section>
      </aside>
    {/if}
  </div>

  {#if canManageSettings}
    <ReputationAdjustModal bind:open={adjustOpen} member={adjustMember} />
  {/if}
</ModulePage>

<style>
  .rep-podium-gold {
    background: color-mix(in srgb, var(--color-warning) 22%, transparent);
    color: var(--color-warning);
  }

  .rep-podium-silver {
    background: color-mix(in srgb, var(--color-on-surface-variant) 18%, transparent);
  }

  .rep-podium-bronze {
    background: color-mix(in srgb, var(--color-tertiary) 20%, transparent);
  }

  .reputation-leaderboard-row {
    grid-template-columns: 28px 36px minmax(0, 1fr) 80px 60px auto;
  }

  .rep-tier-row {
    grid-template-columns: 8rem minmax(0, 1fr) auto;
  }

  @media (max-width: 479px) {
    .rep-tier-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .rep-tier-row > :nth-child(2) {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }

  /* La barre part en premier : le nombre à côté porte déjà la valeur. */
  @media (max-width: 767px) {
    .reputation-leaderboard-row {
      gap: 0.375rem;
      grid-template-columns: 1.5rem 2rem minmax(0, 1fr) auto auto;
    }

    .reputation-leaderboard-row > :nth-child(3) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .reputation-leaderboard-row > :nth-child(4) {
      display: none;
    }
  }
</style>
