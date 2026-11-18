<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import {
    SUGGESTION_ALLOWED_ROLES_MAX,
    SUGGESTION_COOLDOWN_MINUTES,
    SUGGESTION_MIN_ACCOUNT_AGE_DAYS,
    SUGGESTION_MIN_MEMBER_DAYS,
    SUGGESTION_STALE_DAYS,
    SUGGESTION_VOTE_THRESHOLD,
    SUGGESTION_CATEGORIES_MAX,
    SUGGESTION_CATEGORY_NAME_MAX,
    SUGGESTION_REWARD_COINS,
    SUGGESTION_REWARD_XP,
    normalizeSuggestionCategories,
    SUGGESTION_STATS_DAYS,
    isSuggestionStale,
    type SuggestionStatus,
  } from '@kotbo/shared';
  import {
    deleteSuggestion,
    fetchDiscordChannels,
    fetchSuggestionList,
    fetchSuggestionsOverview,
    refreshSuggestionMessages,
    updateSuggestionConfig,
    type SuggestionConfig,
    type SuggestionItem,
    type SuggestionsOverview,
  } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { memberCaseModal } from '../lib/stores/memberCaseModal.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import Modal from '../lib/components/Modal.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import DoingListPin from '../lib/components/doingLists/DoingListPin.svelte';
  import SuggestionDecisionModal from '../lib/components/suggestions/SuggestionDecisionModal.svelte';
  import SuggestionMessagePreview from '../lib/components/suggestions/SuggestionMessagePreview.svelte';
  import SuggestionVotersModal from '../lib/components/suggestions/SuggestionVotersModal.svelte';
  import { SUGGESTION_STATUS_TONE, suggestionStatusLabel } from '../lib/components/suggestions/suggestionStatus';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Field from '../lib/components/ui/Field.svelte';
  import Tabs, { type TabItem } from '../lib/components/ui/Tabs.svelte';
  import FilterPills from '../lib/components/ui/FilterPills.svelte';
  import { m, dateLocale } from '../lib/i18n';
  import {
    DEFAULT_SUGGESTION_CONFIG,
    sortSuggestionQueue,
    suggestionScore,
    type SuggestionQueueSort,
  } from '../lib/suggestionData';

  type Tab = 'queue' | 'all' | 'settings';
  type HistoryStatus = SuggestionStatus | 'ALL';

  let activeTab = $state<Tab>('queue');
  let loading = $state(true);
  let data = $state<SuggestionsOverview | null>(null);
  let queueSort = $state<SuggestionQueueSort>('score');

  function cloneConfig(source: SuggestionConfig): SuggestionConfig {
    return { ...source, allowedRoleIds: [...source.allowedRoleIds] };
  }

  /** Forme comparable : « aucun salon » s'écrit `''` dans le sélecteur et `null` en base. */
  function comparable(source: SuggestionConfig): string {
    return JSON.stringify({
      ...source,
      channelId: source.channelId || null,
      allowedRoleIds: [...source.allowedRoleIds].sort(),
    });
  }

  let savedConfig = $state<SuggestionConfig>(cloneConfig(DEFAULT_SUGGESTION_CONFIG));
  let config = $state<SuggestionConfig>(cloneConfig(DEFAULT_SUGGESTION_CONFIG));
  let textChannels = $state<Array<{ id: string; name: string }>>([]);
  let previewStatus = $state<SuggestionStatus>('PENDING');

  let history = $state<SuggestionItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let historyStatus = $state<HistoryStatus>('ALL');
  let historyMember = $state<{ id: string; name: string } | null>(null);
  /** `''` : toutes ; `NO_CATEGORY` : sans catégorie ; sinon le nom. */
  const NO_CATEGORY = '__none__';
  let historyCategory = $state('');
  let historyLoading = $state(false);
  /** Seule la dernière requête d'historique a le droit d'écrire la liste. */
  let historyRequest = 0;

  let decisionOpen = $state(false);
  let decisionTarget = $state<SuggestionItem | null>(null);

  let votersOpen = $state(false);
  let votersTarget = $state<SuggestionItem | null>(null);
  function openVoters(suggestion: SuggestionItem) {
    votersTarget = suggestion;
    votersOpen = true;
  }

  let statusOpen = $state(false);
  const wide = new MediaQuery('min-width: 64rem');

  /** Même règle que la route de décision : le droit « Modérer », ou la modération de contenu qu'il ne retire pas. */
  const canModerate = $derived(
    dashboardStore.state.featureAccess?.suggestions?.canModerate === true
      || !!dashboardStore.state.access?.canManageSettings
      || (!!dashboardStore.state.access?.canModerateContent && dashboardStore.state.featureAccess?.suggestions?.canModerate !== false)
  );

  const canConfigure = $derived(
    !!dashboardStore.state.featureAccess?.suggestions?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const canDelete = $derived(
    !!dashboardStore.state.featureAccess?.suggestions?.canDelete
      || !!dashboardStore.state.access?.canManageSettings
  );

  const configDirty = $derived(comparable(config) !== comparable(savedConfig));

  function inRange(value: number, range: { min: number; max: number }): boolean {
    return Number.isInteger(value) && value >= range.min && value <= range.max;
  }

  const rolesValid = $derived(config.allowedRoleIds.length <= SUGGESTION_ALLOWED_ROLES_MAX);
  const thresholdValid = $derived(config.voteThreshold === null || inRange(config.voteThreshold, SUGGESTION_VOTE_THRESHOLD));
  const cooldownValid = $derived(inRange(config.cooldownMinutes, SUGGESTION_COOLDOWN_MINUTES));
  const accountAgeValid = $derived(inRange(config.minAccountAgeDays, SUGGESTION_MIN_ACCOUNT_AGE_DAYS));
  const memberDaysValid = $derived(inRange(config.minMemberDays, SUGGESTION_MIN_MEMBER_DAYS));
  const guardsValid = $derived(cooldownValid && accountAgeValid && memberDaysValid);
  const rewardXpValid = $derived(inRange(config.rewardXp, SUGGESTION_REWARD_XP));
  const rewardCoinsValid = $derived(inRange(config.rewardCoins, SUGGESTION_REWARD_COINS));
  const categoriesCheck = $derived(normalizeSuggestionCategories(config.categories));
  const categoriesValid = $derived(!('error' in categoriesCheck));
  const settingsValid = $derived(rolesValid && thresholdValid && guardsValid && rewardXpValid && rewardCoinsValid && categoriesValid);

  /** Module absent de la liste = actif, même lecture que ModulePage. */
  function isModuleActive(key: string): boolean {
    const entry = ((dashboardStore.state.modules as unknown as Array<{ id: string; status?: string }> | undefined) ?? []).find((mod) => mod.id === key);
    return !entry || entry.status === 'active';
  }
  const levelingActive = $derived(isModuleActive('leveling'));
  const economyActive = $derived(isModuleActive('economy'));

  /**
   * Catégories du filtre : celles du serveur, plus celles qui ne le sont plus
   * mais portent encore des suggestions (le bilan les montre, le filtre aussi).
   */
  const filterCategories = $derived([
    ...new Set([
      ...(data?.config.categories ?? []),
      ...(data?.categoryStats ?? []).map((stat) => stat.category).filter((name): name is string => name !== null),
    ]),
  ]);

  let newCategory = $state('');
  function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    config.categories = [...config.categories, name];
    newCategory = '';
  }
  function removeCategory(index: number) {
    config.categories = config.categories.filter((_, i) => i !== index);
  }

  /** Garde-fous en place, pour le résumé du bloc replié et le panneau d'état. */
  function activeGuards(source: SuggestionConfig): number {
    return [source.cooldownMinutes > 0, source.minAccountAgeDays > 0, source.minMemberDays > 0].filter(Boolean).length;
  }
  const guardCount = $derived(activeGuards(config));

  /** Seuil allumé : une valeur par défaut raisonnable à ajuster ; éteint : `null`. */
  const DEFAULT_THRESHOLD = 10;
  function toggleThreshold(enabled: boolean) {
    config.voteThreshold = enabled ? DEFAULT_THRESHOLD : null;
    if (!enabled) config.pinAtThreshold = false;
  }

  let refreshing = $state(false);
  async function republishMessages() {
    refreshing = true;
    try {
      const result = await refreshSuggestionMessages();
      if (result) toast.success(m.suggestions_refresh_started({ count: result.total }));
    } finally {
      refreshing = false;
    }
  }

  async function removeSuggestion(suggestion: SuggestionItem) {
    const confirmed = await confirmDialog.ask({
      title: m.suggestions_delete_title(),
      description: m.suggestions_delete_desc({ name: suggestion.username || suggestion.userId }),
      confirmLabel: m.suggestions_delete_confirm(),
      variant: 'danger',
      impacts: [m.suggestions_delete_impact_discord(), m.suggestions_delete_impact_irreversible()],
    });
    if (!confirmed) return;
    const result = await deleteSuggestion(suggestion.id);
    if (!result?.deleted) return;
    history = history.filter((item) => item.id !== suggestion.id);
    if (data) data = { ...data, queue: data.queue.filter((item) => item.id !== suggestion.id) };
    void loadOverview(true);
  }

  /** @everyone porte l'id du serveur : l'autoriser revient à ne rien restreindre. */
  const assignableRoles = $derived(
    (dashboardStore.state.discordRoles || []).filter((role: { id: string }) => role.id !== authStore.selectedGuildId)
  );

  function channelName(channelId: string | null): string {
    if (!channelId) return m.suggestions_channel_fallback();
    const channel = textChannels.find((candidate) => candidate.id === channelId);
    if (channel) return `#${channel.name}`;
    // Les salons arrivent après les suggestions : rien à dire tant qu'ils ne sont pas là.
    return textChannels.length === 0 ? '-' : m.suggestions_channel_unknown();
  }

  const queue = $derived(data ? sortSuggestionQueue(data.queue, queueSort) : []);
  /** Repère de « en souffrance » : l'heure d'ouverture de la page suffit. */
  const now = new Date();

  const tabItems = $derived<TabItem[]>([
    { id: 'queue', label: m.suggestions_tab_queue(), icon: 'Inbox', badge: data && data.stats.pending > 0 ? String(data.stats.pending) : undefined },
    { id: 'all', label: m.suggestions_tab_all(), icon: 'List' },
    { id: 'settings', label: m.suggestions_tab_settings(), icon: 'Gears', badge: !settingsValid ? m.suggestions_tab_to_fix() : configDirty ? m.suggestions_tab_modified() : undefined },
  ]);

  const sortOptions = $derived([
    { value: 'score' as const, label: m.suggestions_sort_score() },
    { value: 'oldest' as const, label: m.suggestions_sort_oldest() },
    { value: 'recent' as const, label: m.suggestions_sort_recent() },
  ]);

  const STATUSES: SuggestionStatus[] = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'IMPLEMENTED', 'REJECTED'];

  const historyStatusOptions = $derived([
    { value: 'ALL' as const, label: m.suggestions_filter_all() },
    ...STATUSES.map((value) => ({ value, label: suggestionStatusLabel(value) })),
  ]);

  const previewStatusOptions = $derived(STATUSES.map((value) => ({ value, label: suggestionStatusLabel(value) })));

  /** Des suggestions déjà proposées mais aucune sur la fenêtre : le module s'endort. */
  const quietModule = $derived(!!data && !!data.stats.lastCreatedAt && data.stats.createdRecent === 0);

  /** Clic sur un pseudo : ouvre sa fiche, seulement pour qui a accès à « Membres ». */
  function openMemberOnClick(name: string | null | undefined) {
    return memberCaseModal.canOpen ? (userId: string) => memberCaseModal.show(userId, name || userId) : null;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatDelay(hours: number | null): string {
    if (hours === null) return '-';
    if (hours < 1) return m.suggestions_delay_under_hour();
    if (hours < 48) return m.suggestions_delay_hours({ count: Math.round(hours) });
    return m.suggestions_delay_days({ count: Math.round(hours / 24) });
  }

  function formatRate(rate: number | null): string {
    return rate === null ? '-' : new Intl.NumberFormat(dateLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(rate);
  }

  async function loadOverview(quiet = false) {
    if (!quiet) loading = true;
    try {
      const result = await fetchSuggestionsOverview();
      if (!result) {
        toast.error(m.suggestions_load_error());
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
      const page = await fetchSuggestionList({
        status: historyStatus === 'ALL' ? undefined : historyStatus,
        category: historyCategory === '' ? undefined : historyCategory === NO_CATEGORY ? null : historyCategory,
        userId: historyMember?.id,
        cursor: reset ? undefined : nextCursor ?? undefined,
      });
      if (request !== historyRequest || !page) return;
      history = reset ? page.suggestions : [...history, ...page.suggestions];
      nextCursor = page.nextCursor;
    } finally {
      if (request === historyRequest) historyLoading = false;
    }
  }

  function setHistoryCategory(value: string) {
    historyCategory = value;
    void loadHistory(true);
  }

  /** Depuis le bilan par catégorie : l'historique filtré sur elle. */
  function showCategory(category: string | null) {
    historyCategory = category === null ? NO_CATEGORY : category;
    historyStatus = 'ALL';
    activeTab = 'all';
    void loadHistory(true);
  }

  function setHistoryStatus(value: HistoryStatus) {
    historyStatus = value;
    void loadHistory(true);
  }

  function showMemberHistory(suggestion: SuggestionItem) {
    historyMember = { id: suggestion.userId, name: suggestion.username || suggestion.userId };
    historyStatus = 'ALL';
    activeTab = 'all';
    void loadHistory(true);
  }

  function clearMemberFilter() {
    historyMember = null;
    void loadHistory(true);
  }

  function openDecision(suggestion: SuggestionItem) {
    decisionTarget = suggestion;
    decisionOpen = true;
  }

  /** La réponse de la route met la carte à jour tout de suite ; le temps réel recale les compteurs. */
  function applyDecision(updated: SuggestionItem) {
    history = history.map((item) => item.id === updated.id ? updated : item);
    if (data) {
      data = {
        ...data,
        queue: updated.status === 'PENDING'
          ? [...data.queue.filter((item) => item.id !== updated.id), updated]
          : data.queue.filter((item) => item.id !== updated.id),
      };
    }
    void loadOverview(true);
  }

  /** Appelé par la barre « Modifications non enregistrées » du layout. */
  async function saveConfig(): Promise<boolean> {
    if (!settingsValid) {
      toast.error(m.suggestions_settings_invalid());
      return false;
    }
    // Rôles inchangés : non renvoyés. Un rôle supprimé depuis sur Discord ferait
    // refuser par l'API tout l'enregistrement, même d'un réglage voisin.
    const { allowedRoleIds, ...rest } = config;
    const rolesChanged = [...allowedRoleIds].sort().join() !== [...savedConfig.allowedRoleIds].sort().join();
    const result = await updateSuggestionConfig({
      ...rest,
      channelId: config.channelId || null,
      ...(rolesChanged ? { allowedRoleIds } : {}),
    });
    if (!result) return false;
    savedConfig = cloneConfig(result.config);
    config = cloneConfig(result.config);
    return true;
  }

  $effect(() => {
    if (configDirty && canConfigure) {
      untrack(() => {
        unsavedChanges.register({
          id: 'suggestions',
          label: m.suggestions_page_title(),
          onSave: () => saveConfig(),
          onReset: () => { config = cloneConfig(savedConfig); },
        });
      });
    } else if (!configDirty) {
      untrack(() => unsavedChanges.release('suggestions'));
    }
  });

  let unsubscribeRealtime: (() => void) | null = null;

  onMount(async () => {
    unsubscribeRealtime = subscribeRealtime({
      reasons: ['suggestions_updated'],
      onUpdate: () => {
        void loadOverview(true);
        void loadHistory(true);
      },
    });
    await loadOverview();
    await loadHistory(true);
    const channels = await fetchDiscordChannels().catch(() => null);
    textChannels = channels?.textChannels ?? [];
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
    unsavedChanges.release('suggestions');
  });
</script>

{#snippet statusPanel()}
  {#if loading || !data}
    <Skeleton height="160px" />
  {:else}
    <dl class="space-y-2 text-sm">
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_channel()}</dt>
        <dd class="font-semibold text-right truncate">{channelName(data.config.channelId)}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_pending_label()}</dt>
        <dd class="font-semibold">{data.stats.pending}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_comment()}</dt>
        <dd class="font-semibold">{data.config.requireComment ? m.suggestions_status_required() : m.suggestions_status_optional()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_votes_after()}</dt>
        <dd class="font-semibold">{data.config.voteWhileApproved ? m.suggestions_status_open() : m.suggestions_status_closed()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_who()}</dt>
        <dd class="font-semibold text-right">{data.config.allowedRoleIds.length > 0 ? m.suggestions_status_roles({ count: data.config.allowedRoleIds.length }) : m.suggestions_status_everyone()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_threshold()}</dt>
        <dd class="font-semibold">{data.config.voteThreshold ? m.suggestions_status_threshold_value({ count: data.config.voteThreshold }) : m.suggestions_status_none()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_guards()}</dt>
        <dd class="font-semibold">{activeGuards(data.config) > 0 ? m.suggestions_guards_summary({ count: activeGuards(data.config) }) : m.suggestions_status_none()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant shrink-0">{m.suggestions_status_last()}</dt>
        <dd class="font-semibold text-right">{data.stats.lastCreatedAt ? formatDate(data.stats.lastCreatedAt) : m.suggestions_status_never()}</dd>
      </div>
    </dl>
  {/if}
{/snippet}

{#snippet statTile(icon: string, tone: string, value: string, label: string)}
  <div class="bg-surface-container-high/30 rounded-xl p-4 flex items-center gap-3">
    <div class="h-9 w-9 rounded-lg flex items-center justify-center shrink-0 {tone}">
      <Papicon {icon} size={20} />
    </div>
    <div class="flex flex-col min-w-0">
      <span class="text-xl font-bold text-on-surface">{value}</span>
      <span class="text-xs font-medium text-on-surface-variant">{label}</span>
    </div>
  </div>
{/snippet}

{#snippet suggestionCard(suggestion: SuggestionItem)}
  {@const score = suggestionScore(suggestion)}
  {@const stale = suggestion.status === 'PENDING' && isSuggestionStale(suggestion.createdAt, now)}
  <li class="bg-surface-container-high/20 border rounded-xl p-4 space-y-3 {stale ? 'border-warning/30' : 'border-outline-variant/10'}">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <UserDisplay
        userId={suggestion.userId}
        name={suggestion.username}
        avatarUrl={suggestion.avatarUrl}
        subtitle={formatDate(suggestion.createdAt)}
        size="sm"
        class="min-w-0"
        onClick={openMemberOnClick(suggestion.username)}
      />
      <div class="flex flex-wrap items-center gap-2">
        {#if suggestion.thresholdReachedAt && suggestion.status === 'PENDING'}
          <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-success/10 text-on-success-container border border-success/20 inline-flex items-center gap-1">
            <Papicon icon="TrendingUp" size={11} /> {m.suggestions_threshold_badge()}
          </span>
        {/if}
        {#if stale}
          <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-warning/10 text-on-warning-container border border-warning/20">{m.suggestions_stale_badge()}</span>
        {/if}
        <span class="text-2xs font-semibold px-2 py-0.5 rounded-full border {SUGGESTION_STATUS_TONE[suggestion.status]}">{suggestionStatusLabel(suggestion.status)}</span>
      </div>
    </div>

    {#if suggestion.title || suggestion.category}
      <div class="flex flex-wrap items-center gap-2">
        {#if suggestion.category}
          <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-surface-container-high/60 text-on-surface-variant inline-flex items-center gap-1">
            <Papicon icon="Tag" size={11} /> {suggestion.category}
          </span>
        {/if}
        {#if suggestion.title}
          <p class="text-sm font-semibold break-words">{suggestion.title}</p>
        {/if}
      </div>
    {/if}
    <p class="text-sm leading-relaxed whitespace-pre-wrap break-words">{suggestion.content}</p>

    {#if suggestion.responseText}
      <div class="rounded-lg bg-secondary/5 border border-secondary/15 px-3 py-2 space-y-1">
        <p class="text-xs font-semibold text-secondary flex items-center gap-1.5">
          <Papicon icon="MessageSquare" size={12} />
          {suggestion.respondedByName ? m.suggestions_response_by({ name: suggestion.respondedByName }) : m.suggestions_staff_response()}
        </p>
        <p class="text-sm text-on-surface-variant whitespace-pre-wrap break-words">{suggestion.responseText}</p>
      </div>
    {/if}

    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant">
        <span class="font-bold {score > 0 ? 'text-success' : score < 0 ? 'text-error' : ''}" title={m.suggestions_score_title()}>
          {score > 0 ? `+${score}` : score}
        </span>
        <span class="inline-flex items-center gap-1"><Papicon icon="ThumbsUp" size={12} /> {suggestion.upvotes}</span>
        <span class="inline-flex items-center gap-1"><Papicon icon="ThumbsDown" size={12} /> {suggestion.downvotes}</span>
        {#if suggestion.messageUrl}
          <a href={suggestion.messageUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-primary hover:underline">
            <Papicon icon="ExternalLink" size={11} /> {m.suggestions_open_message()}
          </a>
        {/if}
        {#if suggestion.threadUrl}
          <a href={suggestion.threadUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-primary hover:underline">
            <Papicon icon="MessageSquare" size={11} /> {m.suggestions_open_thread()}
          </a>
        {/if}
        {#if suggestion.rewarded && (suggestion.rewarded.xp > 0 || suggestion.rewarded.coins > 0)}
          <span class="inline-flex items-center gap-1 text-success" title={m.suggestions_rewarded_title()}>
            <Papicon icon="Gift" size={11} /> {m.suggestions_rewarded({ xp: suggestion.rewarded.xp, coins: suggestion.rewarded.coins })}
          </span>
        {/if}
      </div>
      <div class="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          icon="User"
          aria-label={m.suggestions_member_history({ name: suggestion.username || suggestion.userId })}
          onclick={() => showMemberHistory(suggestion)}
        />
        {#if data?.config.showVoters && canModerate}
          <Button
            variant="ghost"
            size="sm"
            icon="Users"
            aria-label={m.suggestions_voters_title()}
            onclick={() => openVoters(suggestion)}
          />
        {/if}
        <DoingListPin module="suggestions" sourceId={suggestion.id} />
        {#if canDelete}
          <Button
            variant="ghost"
            size="sm"
            icon="Trash"
            aria-label={m.suggestions_delete_title()}
            onclick={() => removeSuggestion(suggestion)}
          />
        {/if}
        {#if canModerate}
          <Button
            size="sm"
            variant={suggestion.status === 'PENDING' ? 'primary' : 'secondary'}
            icon={suggestion.status === 'PENDING' ? 'Gavel' : 'Pencil'}
            onclick={() => openDecision(suggestion)}
          >
            {suggestion.status === 'PENDING' ? m.suggestions_btn_decide() : m.suggestions_btn_revise()}
          </Button>
        {/if}
      </div>
    </div>
  </li>
{/snippet}

<ModulePage
  title={m.suggestions_page_title()}
  description={m.suggestions_page_desc()}
  icon="thumbs-up"
  featureKey="suggestions"
>
  {#if !wide.current}
    <div class="mb-4">
      <Button size="sm" icon="List" onclick={() => statusOpen = true}>{m.suggestions_status_title()}</Button>
    </div>
    <Modal bind:open={statusOpen} onClose={() => statusOpen = false} title={m.suggestions_status_title()}>
      {@render statusPanel()}
    </Modal>
  {/if}

  <!-- Sur grand écran, l'état du module reste à côté du contenu, quel que soit l'onglet. -->
  <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
    <div class="min-w-0">
      <Tabs label={m.suggestions_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => activeTab = id as Tab} class="mb-6" />

      {#if loading}
        <div class="space-y-6">
          <Skeleton height="80px" />
          <Skeleton height="300px" />
        </div>
      {:else if !data}
        <EmptyState icon="thumbs-up" title={m.suggestions_load_error()} actionLabel={m.suggestions_retry()} onAction={() => loadOverview()} />
      {:else if activeTab === 'queue'}
        <div class="space-y-6">
          <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {@render statTile('Inbox', 'bg-warning/10 text-on-warning-container', String(data.stats.pending), m.suggestions_stat_pending())}
            {@render statTile('Clock', 'bg-primary/10 text-primary', formatDelay(data.stats.avgResponseHours), m.suggestions_stat_delay({ days: SUGGESTION_STATS_DAYS }))}
            {@render statTile('Check', 'bg-success/10 text-on-success-container', formatRate(data.stats.acceptanceRate), m.suggestions_stat_acceptance({ days: SUGGESTION_STATS_DAYS }))}
            {@render statTile('Lightbulb', 'bg-secondary/10 text-secondary', String(data.stats.createdRecent), m.suggestions_stat_created({ days: SUGGESTION_STATS_DAYS }))}
          </div>

          {#if !data.config.channelId}
            <Callout variant="info" title={m.suggestions_advice_channel_title()}>
              <p>{m.suggestions_advice_channel_desc()}</p>
              {#snippet actions()}
                <Button size="sm" icon="Gears" onclick={() => activeTab = 'settings'}>{m.suggestions_advice_channel_action()}</Button>
              {/snippet}
            </Callout>
          {/if}

          {#if data.stats.stalePending > 0}
            <Callout variant="warning" title={m.suggestions_advice_stale_title({ count: data.stats.stalePending })}>
              <p>{m.suggestions_advice_stale_desc({ days: SUGGESTION_STALE_DAYS })}</p>
              {#snippet actions()}
                <Button size="sm" icon="ArrowDown" onclick={() => queueSort = 'oldest'}>{m.suggestions_advice_stale_action()}</Button>
              {/snippet}
            </Callout>
          {/if}

          {#if quietModule}
            <Callout variant="info" title={m.suggestions_advice_quiet_title()}>
              <p>{m.suggestions_advice_quiet_desc({ days: SUGGESTION_STATS_DAYS })}</p>
            </Callout>
          {/if}

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="text-base font-semibold flex items-center gap-2.5">
                <Papicon icon="Inbox" size={16} />
                {m.suggestions_queue_title()}
              </h3>
              <FilterPills label={m.suggestions_sort_label()} options={sortOptions} value={queueSort} onchange={(value) => queueSort = value} />
            </div>

            {#if queue.length === 0}
              <EmptyState
                icon="thumbs-up"
                title={m.suggestions_queue_empty_title()}
                description={data.stats.lastCreatedAt ? m.suggestions_queue_empty_desc() : m.suggestions_empty_desc()}
                reason={data.stats.lastCreatedAt ? 'all-clear' : 'accumulating'}
              />
            {:else}
              <ul class="space-y-3">
                {#each queue as suggestion (suggestion.id)}
                  {@render suggestionCard(suggestion)}
                {/each}
              </ul>
              {#if data.queueTruncated}
                <p class="text-xs text-on-surface-variant text-center">{m.suggestions_queue_truncated({ shown: data.queue.length, total: data.stats.pending })}</p>
              {/if}
            {/if}
          </section>

          {#if data.categoryStats.some((stat) => stat.category !== null)}
            <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
              <h3 class="text-base font-semibold flex items-center gap-2.5">
                <Papicon icon="Tag" size={16} />
                {m.suggestions_categories_stats_title()}
              </h3>
              <ul class="space-y-2">
                {#each data.categoryStats as stat (stat.category ?? NO_CATEGORY)}
                  <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                    <div class="min-w-0 space-y-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-medium truncate">{stat.category ?? m.suggestions_category_none()}</span>
                        <span class="text-xs text-on-surface-variant shrink-0">{m.suggestions_categories_stats_line({ total: stat.total, pending: stat.pending, accepted: stat.accepted })}</span>
                      </div>
                      <div class="h-2 bg-surface-container-high rounded-full overflow-hidden flex" aria-hidden="true">
                        <div class="h-2 bg-success" style="width: {stat.total ? (stat.accepted / stat.total) * 100 : 0}%"></div>
                        <div class="h-2 bg-warning" style="width: {stat.total ? (stat.pending / stat.total) * 100 : 0}%"></div>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" icon="List" aria-label={m.suggestions_category_show({ name: stat.category ?? m.suggestions_category_none() })} onclick={() => showCategory(stat.category)} />
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>
      {:else if activeTab === 'all'}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="List" size={16} />
              {m.suggestions_all_title()}
            </h3>
            <div class="flex flex-wrap items-center gap-3">
              {#if filterCategories.length > 0 || historyCategory}
                <label class="sr-only" for="suggestions-category-filter">{m.suggestions_category_filter_label()}</label>
                <select id="suggestions-category-filter" class="input w-auto" value={historyCategory} onchange={(event) => setHistoryCategory(event.currentTarget.value)}>
                  <option value="">{m.suggestions_category_all()}</option>
                  {#each filterCategories as name (name)}
                    <option value={name}>{name}</option>
                  {/each}
                  <option value={NO_CATEGORY}>{m.suggestions_category_none()}</option>
                </select>
              {/if}
              <FilterPills label={m.suggestions_filter_label()} options={historyStatusOptions} value={historyStatus} onchange={setHistoryStatus} />
            </div>
          </div>

          {#if historyMember}
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="text-on-surface-variant">{m.suggestions_member_filter({ name: historyMember.name })}</span>
              <Button variant="ghost" size="sm" icon="X" onclick={clearMemberFilter}>{m.suggestions_member_filter_clear()}</Button>
            </div>
          {/if}

          {#if history.length === 0 && !historyLoading}
            <EmptyState
              icon="thumbs-up"
              title={m.suggestions_empty_title()}
              description={historyMember || historyStatus !== 'ALL' || historyCategory ? undefined : m.suggestions_empty_desc()}
              reason={historyMember || historyStatus !== 'ALL' || historyCategory ? 'nothing-matches' : 'accumulating'}
            />
          {:else}
            <ul class="space-y-3">
              {#each history as suggestion (suggestion.id)}
                {@render suggestionCard(suggestion)}
              {/each}
            </ul>
          {/if}

          {#if nextCursor || historyLoading}
            <div class="flex justify-center">
              <Button size="sm" icon="ChevronDown" loading={historyLoading} onclick={() => loadHistory(false)}>{m.suggestions_load_more()}</Button>
            </div>
          {/if}
        </section>
      {:else}
        <div class="space-y-6">
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Send" size={18} /> {m.suggestions_publish_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.suggestions_publish_desc()}</p>
            </div>

            <Field id="suggestions-channel" label={m.suggestions_channel_label()} hint={m.suggestions_channel_hint()}>
              {#snippet children(id, describedBy)}
                <SearchableSelect {describedBy}
                  {id}
                  bind:value={config.channelId}
                  options={[{ id: '', name: m.suggestions_channel_fallback() }, ...textChannels.map((channel) => ({ id: channel.id, name: `#${channel.name}` }))]}
                  placeholder={m.suggestions_channel_placeholder()}
                  disabled={!canConfigure}
                />
              {/snippet}
            </Field>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.suggestions_thread_label()}</p>
                <p class="text-xs text-on-surface-variant">{m.suggestions_thread_hint()}</p>
              </div>
              <ToggleSwitch
                checked={config.createThread}
                onToggle={(value) => config.createThread = value}
                disabled={!canConfigure}
                ariaLabel={m.suggestions_thread_label()}
              />
            </div>

            {#if data.messageLabels}
              <div class="space-y-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.suggestions_preview_heading()}</p>
                  <FilterPills label={m.suggestions_preview_status_label()} options={previewStatusOptions} value={previewStatus} onchange={(value) => previewStatus = value} />
                </div>
                <SuggestionMessagePreview labels={data.messageLabels} status={previewStatus} voteWhileApproved={config.voteWhileApproved} />
              </div>
            {/if}
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Gavel" size={18} /> {m.suggestions_decisions_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.suggestions_decisions_desc()}</p>
            </div>

            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm font-semibold">{m.suggestions_require_comment_label()}</p>
                <p class="text-xs text-on-surface-variant">{m.suggestions_require_comment_hint()}</p>
              </div>
              <ToggleSwitch
                checked={config.requireComment}
                onToggle={(value) => config.requireComment = value}
                disabled={!canConfigure}
                ariaLabel={m.suggestions_require_comment_label()}
              />
            </div>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.suggestions_vote_approved_label()}</p>
                <p class="text-xs text-on-surface-variant">{m.suggestions_vote_approved_hint()}</p>
              </div>
              <ToggleSwitch
                checked={config.voteWhileApproved}
                onToggle={(value) => config.voteWhileApproved = value}
                disabled={!canConfigure}
                ariaLabel={m.suggestions_vote_approved_label()}
              />
            </div>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.suggestions_notify_label()}</p>
                <p class="text-xs text-on-surface-variant">{m.suggestions_notify_hint()}</p>
              </div>
              <ToggleSwitch
                checked={config.notifyAuthor}
                onToggle={(value) => config.notifyAuthor = value}
                disabled={!canConfigure}
                ariaLabel={m.suggestions_notify_label()}
              />
            </div>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.suggestions_show_voters_label()}</p>
                <p class="text-xs text-on-surface-variant">{m.suggestions_show_voters_hint()}</p>
              </div>
              <ToggleSwitch
                checked={config.showVoters}
                onToggle={(value) => config.showVoters = value}
                disabled={!canConfigure}
                ariaLabel={m.suggestions_show_voters_label()}
              />
            </div>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Gift" size={18} /> {m.suggestions_reward_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.suggestions_reward_desc()}</p>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field
                id="suggestions-reward-xp"
                label={m.suggestions_reward_xp_label()}
                hint={levelingActive ? m.suggestions_range_hint({ min: SUGGESTION_REWARD_XP.min, max: SUGGESTION_REWARD_XP.max }) : m.suggestions_reward_xp_module_off()}
                error={rewardXpValid ? undefined : m.suggestions_range_error({ min: SUGGESTION_REWARD_XP.min, max: SUGGESTION_REWARD_XP.max })}
              >
                {#snippet children(id, describedBy)}
                  <input {id} type="number" class="input max-w-40" min={SUGGESTION_REWARD_XP.min} max={SUGGESTION_REWARD_XP.max} bind:value={config.rewardXp} aria-describedby={describedBy} disabled={!canConfigure} />
                {/snippet}
              </Field>
              <Field
                id="suggestions-reward-coins"
                label={m.suggestions_reward_coins_label()}
                hint={economyActive ? m.suggestions_range_hint({ min: SUGGESTION_REWARD_COINS.min, max: SUGGESTION_REWARD_COINS.max }) : m.suggestions_reward_coins_module_off()}
                error={rewardCoinsValid ? undefined : m.suggestions_range_error({ min: SUGGESTION_REWARD_COINS.min, max: SUGGESTION_REWARD_COINS.max })}
              >
                {#snippet children(id, describedBy)}
                  <input {id} type="number" class="input max-w-40" min={SUGGESTION_REWARD_COINS.min} max={SUGGESTION_REWARD_COINS.max} bind:value={config.rewardCoins} aria-describedby={describedBy} disabled={!canConfigure} />
                {/snippet}
              </Field>
            </div>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Tag" size={18} /> {m.suggestions_categories_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.suggestions_categories_desc({ max: SUGGESTION_CATEGORIES_MAX })}</p>
            </div>

            {#if config.categories.length > 0}
              <ul class="flex flex-wrap gap-2">
                {#each config.categories as name, index (index)}
                  <li class="inline-flex items-center gap-1 rounded-full bg-surface-container-high/60 pl-3 pr-1 py-0.5 text-sm">
                    {name}
                    {#if canConfigure}
                      <Button variant="ghost" size="sm" icon="X" aria-label={m.suggestions_category_remove({ name })} onclick={() => removeCategory(index)} />
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}

            {#if canConfigure}
              <Field
                id="suggestions-new-category"
                label={m.suggestions_category_add_label()}
                error={'error' in categoriesCheck ? (categoriesCheck.error === 'TOO_MANY' ? m.suggestions_categories_too_many({ max: SUGGESTION_CATEGORIES_MAX }) : m.suggestions_categories_too_long({ max: SUGGESTION_CATEGORY_NAME_MAX })) : undefined}
              >
                {#snippet children(id, describedBy)}
                  <div class="flex flex-wrap gap-2">
                    <input
                      {id}
                      type="text"
                      class="input max-w-64"
                      maxlength={SUGGESTION_CATEGORY_NAME_MAX}
                      placeholder={m.suggestions_category_add_placeholder()}
                      bind:value={newCategory}
                      aria-describedby={describedBy}
                      onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCategory(); } }}
                    />
                    <Button size="sm" icon="Plus" disabled={!newCategory.trim() || config.categories.length >= SUGGESTION_CATEGORIES_MAX} onclick={addCategory}>{m.suggestions_category_add()}</Button>
                  </div>
                {/snippet}
              </Field>
            {/if}
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="flex items-start justify-between gap-4 border-b border-outline-variant/15 pb-3">
              <div>
                <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="TrendingUp" size={18} /> {m.suggestions_threshold_heading()}</h3>
                <p class="text-xs text-on-surface-variant mt-1">{m.suggestions_threshold_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.voteThreshold !== null}
                onToggle={toggleThreshold}
                disabled={!canConfigure}
                ariaLabel={m.suggestions_threshold_heading()}
              />
            </div>

            {#if config.voteThreshold !== null}
              <Field
                id="suggestions-threshold"
                label={m.suggestions_threshold_label()}
                hint={m.suggestions_range_hint({ min: SUGGESTION_VOTE_THRESHOLD.min, max: SUGGESTION_VOTE_THRESHOLD.max })}
                error={thresholdValid ? undefined : m.suggestions_range_error({ min: SUGGESTION_VOTE_THRESHOLD.min, max: SUGGESTION_VOTE_THRESHOLD.max })}
              >
                {#snippet children(id, describedBy)}
                  <input
                    {id}
                    type="number"
                    class="input max-w-32"
                    min={SUGGESTION_VOTE_THRESHOLD.min}
                    max={SUGGESTION_VOTE_THRESHOLD.max}
                    bind:value={config.voteThreshold}
                    aria-describedby={describedBy}
                    disabled={!canConfigure}
                  />
                {/snippet}
              </Field>

              <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
                <div>
                  <p class="text-sm font-semibold">{m.suggestions_pin_label()}</p>
                  <p class="text-xs text-on-surface-variant">{m.suggestions_pin_hint()}</p>
                </div>
                <ToggleSwitch
                  checked={config.pinAtThreshold}
                  onToggle={(value) => config.pinAtThreshold = value}
                  disabled={!canConfigure}
                  ariaLabel={m.suggestions_pin_label()}
                />
              </div>
            {/if}
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Users" size={18} /> {m.suggestions_who_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.suggestions_who_desc()}</p>
            </div>

            <Field
              id="suggestions-allowed-roles"
              label={m.suggestions_roles_label()}
              hint={m.suggestions_roles_hint()}
              error={rolesValid ? undefined : m.suggestions_roles_too_many({ max: SUGGESTION_ALLOWED_ROLES_MAX })}
            >
              {#snippet children(id, describedBy)}
                <MultiSelect {describedBy}
                  {id}
                  bind:values={config.allowedRoleIds}
                  options={assignableRoles.map((role: { id: string; name: string }) => ({ id: role.id, name: `@${role.name}` }))}
                  placeholder={m.suggestions_roles_everyone()}
                  disabled={!canConfigure}
                />
              {/snippet}
            </Field>

            <!-- Replié par défaut, comme dans Réputation : le résumé dit ce qui est en place. -->
            <details class="group border border-outline-variant/15 rounded-xl">
              <summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span class="text-sm font-semibold flex items-center gap-2">
                  <span class="transition-transform group-open:rotate-90"><Papicon icon="ChevronRight" size={14} /></span>
                  <Papicon icon="ShieldCheck" size={15} />
                  {m.suggestions_guards_heading()}
                </span>
                <span class="text-2xs font-semibold px-2 py-0.5 rounded-full {!guardsValid ? 'bg-error/10 text-error border border-error/20' : guardCount > 0 ? 'bg-success/10 text-success border border-success/20' : 'bg-surface-container-high/60 text-on-surface-variant'}">
                  {!guardsValid ? m.suggestions_tab_to_fix() : guardCount > 0 ? m.suggestions_guards_summary({ count: guardCount }) : m.suggestions_guards_off()}
                </span>
              </summary>

              <div class="px-4 pb-4 space-y-4">
                <p class="text-xs text-on-surface-variant">{m.suggestions_guards_desc()}</p>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field
                    id="suggestions-cooldown"
                    label={m.suggestions_guards_cooldown_label()}
                    hint={m.suggestions_guards_cooldown_hint()}
                    error={cooldownValid ? undefined : m.suggestions_range_error({ min: SUGGESTION_COOLDOWN_MINUTES.min, max: SUGGESTION_COOLDOWN_MINUTES.max })}
                  >
                    {#snippet children(id, describedBy)}
                      <input {id} type="number" class="input" min={SUGGESTION_COOLDOWN_MINUTES.min} max={SUGGESTION_COOLDOWN_MINUTES.max} bind:value={config.cooldownMinutes} aria-describedby={describedBy} disabled={!canConfigure} />
                    {/snippet}
                  </Field>
                  <Field
                    id="suggestions-account-age"
                    label={m.suggestions_guards_account_label()}
                    hint={m.suggestions_guards_days_hint()}
                    error={accountAgeValid ? undefined : m.suggestions_range_error({ min: SUGGESTION_MIN_ACCOUNT_AGE_DAYS.min, max: SUGGESTION_MIN_ACCOUNT_AGE_DAYS.max })}
                  >
                    {#snippet children(id, describedBy)}
                      <input {id} type="number" class="input" min={SUGGESTION_MIN_ACCOUNT_AGE_DAYS.min} max={SUGGESTION_MIN_ACCOUNT_AGE_DAYS.max} bind:value={config.minAccountAgeDays} aria-describedby={describedBy} disabled={!canConfigure} />
                    {/snippet}
                  </Field>
                  <Field
                    id="suggestions-member-days"
                    label={m.suggestions_guards_member_label()}
                    hint={m.suggestions_guards_days_hint()}
                    error={memberDaysValid ? undefined : m.suggestions_range_error({ min: SUGGESTION_MIN_MEMBER_DAYS.min, max: SUGGESTION_MIN_MEMBER_DAYS.max })}
                  >
                    {#snippet children(id, describedBy)}
                      <input {id} type="number" class="input" min={SUGGESTION_MIN_MEMBER_DAYS.min} max={SUGGESTION_MIN_MEMBER_DAYS.max} bind:value={config.minMemberDays} aria-describedby={describedBy} disabled={!canConfigure} />
                    {/snippet}
                  </Field>
                </div>
              </div>
            </details>
          </section>

          {#if canConfigure}
            <!-- Geste ponctuel, à part des réglages : rien ici ne passe par la barre d'enregistrement. -->
            <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl flex flex-wrap items-center justify-between gap-4">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="RefreshCw" size={15} /> {m.suggestions_refresh_heading()}</h3>
                <p class="text-xs text-on-surface-variant mt-1">{m.suggestions_refresh_desc()}</p>
              </div>
              <Button size="sm" icon="RefreshCw" loading={refreshing} onclick={republishMessages}>{m.suggestions_refresh_action()}</Button>
            </section>
          {/if}
        </div>
      {/if}
    </div>

    {#if wide.current}
      <aside class="sticky top-4 space-y-4" aria-label={m.suggestions_status_title()}>
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-4 rounded-xl space-y-3">
          <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="List" size={15} /> {m.suggestions_status_title()}</h3>
          {@render statusPanel()}
        </section>
      </aside>
    {/if}
  </div>

  {#if canModerate && data?.config.showVoters}
    <SuggestionVotersModal bind:open={votersOpen} suggestion={votersTarget} />
  {/if}

  {#if canModerate}
    <SuggestionDecisionModal
      bind:open={decisionOpen}
      suggestion={decisionTarget}
      requireComment={data?.config.requireComment ?? true}
      onDone={applyDecision}
    />
  {/if}
</ModulePage>
