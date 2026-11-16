<script lang="ts">
  /**
   * Starlight : les messages qui font réagir passent à la une.
   *
   * Trois onglets, comme Suggestions et Réputation : la vue d'ensemble (chiffres
   * de la fenêtre, conseils, meilleurs messages, salons qui en produisent le
   * plus), la galerie paginée des messages passés à la une, et les réglages.
   * L'état du module reste à côté du contenu sur grand écran.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import {
    STARBOARD_BLOCKED_USERS_MAX,
    STARBOARD_BUSY_PER_DAY,
    STARBOARD_CHANNEL_THRESHOLDS_MAX,
    STARBOARD_MAX_AGE_DAYS,
    STARBOARD_STATS_DAYS,
    STARBOARD_THRESHOLD,
    defaultStarboardSettings,
    isDiscordMediaUrl,
    normalizeStarboardChannelThresholds,
    starboardAdvice,
    type StarboardAdvice,
    type StarboardPeriod,
    type StarboardSettings,
    type StarboardSort,
  } from '@kotbo/shared';
  import { m, dateLocale } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { toast } from '../lib/stores/toast.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
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
  import EmojiListInput from '../lib/components/EmojiListInput.svelte';
  import MemberSearchSelect from '../lib/components/MemberSearchSelect.svelte';
  import FormColorPicker from '../lib/components/FormColorPicker.svelte';
  import StarboardMessagePreview from '../lib/components/starboard/StarboardMessagePreview.svelte';
  import Callout from '../lib/components/ui/Callout.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Field from '../lib/components/ui/Field.svelte';
  import Tabs, { type TabItem } from '../lib/components/ui/Tabs.svelte';
  import FilterPills from '../lib/components/ui/FilterPills.svelte';
  import {
    blockStarboardEntry,
    fetchStarboardEntries,
    fetchStarboardOverview,
    unblockStarboardEntry,
    updateStarboardConfig,
    type StarboardEntryItem,
    type StarboardOverview,
  } from '../lib/api';

  type Tab = 'overview' | 'entries' | 'settings';

  let activeTab = $state<Tab>('overview');
  let loading = $state(true);
  let data = $state<StarboardOverview | null>(null);

  let savedConfig = $state<StarboardSettings>(defaultStarboardSettings());
  let config = $state<StarboardSettings>(defaultStarboardSettings());

  /**
   * Forme comparable : « aucun salon » s'écrit `''` dans le sélecteur et `null`
   * en base, et l'ordre des seuils par salon ne compte pas.
   */
  function comparable(source: StarboardSettings): string {
    return JSON.stringify({
      ...source,
      channelId: source.channelId || null,
      channelThresholds: Object.fromEntries(Object.entries(source.channelThresholds).sort(([a], [b]) => a.localeCompare(b))),
    });
  }

  let entries = $state<StarboardEntryItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let entriesLoading = $state(false);
  let period = $state<StarboardPeriod>('all');
  let sort = $state<StarboardSort>('recent');
  let channelFilter = $state('');
  let memberFilter = $state<{ id: string; name: string } | null>(null);
  /** Seule la dernière requête de la galerie a le droit d'écrire la liste. */
  let entriesRequest = 0;

  /** Liens d'images Discord expirés : la vignette est masquée plutôt que cassée. */
  let brokenImages = $state(new Set<string>());

  let statusOpen = $state(false);
  const wide = new MediaQuery('min-width: 64rem');

  const canConfigure = $derived(
    !!dashboardStore.state.featureAccess?.starboard?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  /** Même règle que la route de retrait : le droit « Modérer », ou la modération de contenu qu'il ne retire pas. */
  const canModerate = $derived(
    dashboardStore.state.featureAccess?.starboard?.canModerate === true
      || !!dashboardStore.state.access?.canManageSettings
      || (!!dashboardStore.state.access?.canModerateContent && dashboardStore.state.featureAccess?.starboard?.canModerate !== false)
  );

  const channels = $derived(
    (dashboardStore.state.discordChannels || []).map((channel: any) => ({
      id: channel.id as string,
      name: channelDisplayName(channel),
    }))
  );

  function channelName(channelId: string | null): string {
    if (!channelId) return m.starboard_channel_none();
    const channel = channels.find((candidate) => candidate.id === channelId);
    if (channel) return channel.name;
    // Les salons arrivent après le reste : rien à dire tant qu'ils ne sont pas là.
    return channels.length === 0 ? '-' : m.starboard_channel_unknown();
  }

  const configDirty = $derived(comparable(config) !== comparable(savedConfig));
  const thresholdValid = $derived(
    Number.isInteger(config.threshold) && config.threshold >= STARBOARD_THRESHOLD.min && config.threshold <= STARBOARD_THRESHOLD.max
  );
  const upvotesValid = $derived(config.upvoteEmojis.length > 0);
  const maxAgeValid = $derived(
    Number.isInteger(config.maxMessageAgeDays)
      && config.maxMessageAgeDays >= STARBOARD_MAX_AGE_DAYS.min && config.maxMessageAgeDays <= STARBOARD_MAX_AGE_DAYS.max
  );
  const channelThresholdsValid = $derived(!('error' in normalizeStarboardChannelThresholds(config.channelThresholds)));
  const blockedValid = $derived(config.blockedUserIds.length <= STARBOARD_BLOCKED_USERS_MAX);
  const settingsValid = $derived(thresholdValid && upvotesValid && maxAgeValid && channelThresholdsValid && blockedValid);

  /** Garde-fous en place, pour le panneau d'état. */
  function activeGuards(source: StarboardSettings): number {
    return [
      source.maxMessageAgeDays > 0,
      Object.keys(source.channelThresholds).length > 0,
      source.blockedUserIds.length > 0,
    ].filter(Boolean).length;
  }

  // ── Seuils par salon ──
  let newThresholdChannel = $state('');
  const thresholdRows = $derived(Object.entries(config.channelThresholds));
  const thresholdChannelOptions = $derived(channels.filter((channel) => !(channel.id in config.channelThresholds)));

  function addChannelThreshold() {
    if (!newThresholdChannel) return;
    config.channelThresholds = { ...config.channelThresholds, [newThresholdChannel]: config.threshold };
    newThresholdChannel = '';
  }

  function setChannelThreshold(channelId: string, value: number) {
    config.channelThresholds = { ...config.channelThresholds, [channelId]: value };
  }

  function removeChannelThreshold(channelId: string) {
    const { [channelId]: _removed, ...rest } = config.channelThresholds;
    config.channelThresholds = rest;
  }

  // ── Membres exclus ──
  let newBlockedMember = $state('');

  $effect(() => {
    const picked = newBlockedMember;
    if (!picked) return;
    untrack(() => {
      if (!config.blockedUserIds.includes(picked)) config.blockedUserIds = [...config.blockedUserIds, picked];
      newBlockedMember = '';
    });
  });

  function blockedMemberName(userId: string): string | null {
    return data?.blockedMembers.find((member) => member.userId === userId)?.name ?? null;
  }

  function blockedMemberAvatar(userId: string): string | null {
    return data?.blockedMembers.find((member) => member.userId === userId)?.avatarUrl ?? null;
  }

  const advice = $derived<StarboardAdvice[]>(data
    ? starboardAdvice({
      channelId: data.config.channelId,
      channelFound: data.health.channelFound,
      missingPermissions: data.health.missingPermissions,
      postedRecent: data.stats.postedRecent,
      lastPostedAt: data.stats.lastPostedAt,
    })
    : []);

  const tabItems = $derived<TabItem[]>([
    { id: 'overview', label: m.starboard_tab_overview(), icon: 'Star', badge: advice.length > 0 ? String(advice.length) : undefined },
    { id: 'entries', label: m.starboard_tab_entries(), icon: 'List' },
    { id: 'settings', label: m.starboard_tab_settings(), icon: 'Gears', badge: !settingsValid ? m.starboard_tab_to_fix() : configDirty ? m.starboard_tab_modified() : undefined },
  ]);

  const periodOptions = $derived([
    { value: 'week' as const, label: m.starboard_period_week() },
    { value: 'month' as const, label: m.starboard_period_month() },
    { value: 'all' as const, label: m.starboard_period_all() },
  ]);

  const sortOptions = $derived([
    { value: 'recent' as const, label: m.starboard_sort_recent() },
    { value: 'score' as const, label: m.starboard_sort_score() },
  ]);

  const PERMISSION_LABELS: Record<string, () => string> = {
    ViewChannel: () => m.starboard_permission_view(),
    SendMessages: () => m.starboard_permission_send(),
    EmbedLinks: () => m.starboard_permission_embed(),
    AddReactions: () => m.starboard_permission_react(),
  };
  const missingPermissionsText = $derived(
    (data?.health.missingPermissions ?? []).map((name) => PERMISSION_LABELS[name]?.() ?? name).join(', ')
  );

  const channelMax = $derived(Math.max(1, ...(data?.channelStats ?? []).map((stat) => stat.count)));

  const filtersActive = $derived(period !== 'all' || !!channelFilter || !!memberFilter);

  /** Clic sur un pseudo : ouvre sa fiche, seulement pour qui a accès à « Membres ». */
  function openMemberOnClick(name: string | null) {
    return memberCaseModal.canOpen ? (userId: string) => memberCaseModal.show(userId, name || userId) : null;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatScore(value: number | null): string {
    return value === null ? '-' : new Intl.NumberFormat(dateLocale(), { maximumFractionDigits: 1 }).format(value);
  }

  async function loadOverview(quiet = false) {
    if (!quiet) loading = true;
    try {
      const result = await fetchStarboardOverview();
      if (!result) {
        if (!quiet) toast.error(m.starboard_load_error());
        return;
      }
      data = result;
      // Un rechargement en temps réel ne doit pas écraser une saisie en cours.
      if (!configDirty) {
        savedConfig = structuredClone(result.config);
        config = structuredClone(result.config);
      }
    } finally {
      loading = false;
    }
  }

  async function loadEntries(reset: boolean) {
    const request = ++entriesRequest;
    entriesLoading = true;
    try {
      const page = await fetchStarboardEntries({
        period,
        sort,
        channelId: channelFilter || undefined,
        authorId: memberFilter?.id,
        cursor: reset ? undefined : nextCursor ?? undefined,
      });
      if (request !== entriesRequest || !page) return;
      entries = reset ? page.entries : [...entries, ...page.entries];
      nextCursor = page.nextCursor;
    } finally {
      if (request === entriesRequest) entriesLoading = false;
    }
  }

  function setPeriod(value: StarboardPeriod) {
    period = value;
    void loadEntries(true);
  }

  function setSort(value: StarboardSort) {
    sort = value;
    void loadEntries(true);
  }

  function setChannelFilter(value: string) {
    channelFilter = value;
    void loadEntries(true);
  }

  function clearFilters() {
    period = 'all';
    channelFilter = '';
    memberFilter = null;
    void loadEntries(true);
  }

  /** Depuis la vue d'ensemble : la galerie déjà filtrée. */
  function showEntries(filter: { channelId?: string; member?: { id: string; name: string }; best?: boolean }) {
    channelFilter = filter.channelId ?? '';
    memberFilter = filter.member ?? null;
    period = filter.best ? 'month' : 'all';
    sort = filter.best ? 'score' : 'recent';
    activeTab = 'entries';
    void loadEntries(true);
  }

  function markBroken(entryId: string) {
    brokenImages = new Set([...brokenImages, entryId]);
  }

  /** La réponse de la route met la carte à jour tout de suite ; le temps réel recale les compteurs. */
  function applyEntry(updated: StarboardEntryItem) {
    entries = entries.map((entry) => entry.id === updated.id ? updated : entry);
    if (data) data = { ...data, topEntries: data.topEntries.map((entry) => entry.id === updated.id ? updated : entry) };
    void loadOverview(true);
  }

  async function blockEntry(entry: StarboardEntryItem) {
    const confirmed = await confirmDialog.ask({
      title: m.starboard_block_title(),
      description: m.starboard_block_desc({ name: entry.authorName ?? m.starboard_member_left() }),
      confirmLabel: m.starboard_block_confirm(),
      variant: 'danger',
      impacts: [m.starboard_block_impact_discord(), m.starboard_block_impact_votes()],
    });
    if (!confirmed) return;
    const result = await blockStarboardEntry(entry.id);
    if (result?.entry) applyEntry(result.entry);
  }

  async function unblockEntry(entry: StarboardEntryItem) {
    const result = await unblockStarboardEntry(entry.id);
    if (result?.entry) applyEntry(result.entry);
  }

  /**
   * Geste immédiat depuis une carte : seule la liste des exclus part, sans
   * emporter une saisie en cours dans les réglages.
   */
  async function excludeMember(entry: StarboardEntryItem) {
    const name = entry.authorName ?? m.starboard_member_left();
    const confirmed = await confirmDialog.ask({
      title: m.starboard_exclude_title(),
      description: m.starboard_exclude_desc({ name }),
      confirmLabel: m.starboard_exclude_confirm(),
      variant: 'danger',
      impacts: [m.starboard_exclude_impact_discord(), m.starboard_exclude_impact_undo()],
    });
    if (!confirmed) return;
    const blockedUserIds = [...new Set([...savedConfig.blockedUserIds, entry.authorId])];
    const result = await updateStarboardConfig({ blockedUserIds });
    if (!result) return;
    savedConfig = { ...savedConfig, blockedUserIds: [...result.config.blockedUserIds] };
    config.blockedUserIds = [...new Set([...config.blockedUserIds, ...result.config.blockedUserIds])];
    void loadOverview(true);
  }

  /** Appelé par la barre « Modifications non enregistrées » du layout. */
  async function saveConfig(): Promise<boolean> {
    if (!settingsValid) {
      toast.error(m.starboard_settings_invalid());
      return false;
    }
    const result = await updateStarboardConfig({ ...$state.snapshot(config), channelId: config.channelId || null });
    if (!result) return false;
    savedConfig = structuredClone(result.config);
    config = structuredClone(result.config);
    return true;
  }

  $effect(() => {
    if (configDirty && canConfigure) {
      untrack(() => {
        unsavedChanges.register({
          id: 'starboard',
          label: m.starboard_page_title(),
          onSave: () => saveConfig(),
          onReset: () => { config = structuredClone($state.snapshot(savedConfig)); },
        });
      });
    } else if (!configDirty) {
      untrack(() => unsavedChanges.release('starboard'));
    }
  });

  let unsubscribeRealtime: (() => void) | null = null;

  onMount(async () => {
    unsubscribeRealtime = subscribeRealtime({
      reasons: ['starboard_updated'],
      onUpdate: () => {
        void loadOverview(true);
        void loadEntries(true);
      },
    });
    void dashboardStore.refresh();
    await loadOverview();
    await loadEntries(true);
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
    unsavedChanges.release('starboard');
  });
</script>

{#snippet statusPanel()}
  {#if loading || !data}
    <Skeleton height="160px" />
  {:else}
    <dl class="space-y-2 text-sm">
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.starboard_status_channel()}</dt>
        <dd class="font-semibold text-right truncate">{channelName(data.config.channelId)}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.starboard_status_threshold()}</dt>
        <dd class="font-semibold">{m.starboard_status_threshold_value({ count: data.config.threshold })}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.starboard_status_votes()}</dt>
        <dd class="font-semibold text-right">
          {data.config.downvoteEmojis.length > 0 ? m.starboard_status_votes_both() : m.starboard_status_votes_up_only()}
        </dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.starboard_status_scope()}</dt>
        <dd class="font-semibold text-right">
          {data.config.watchedChannels.length > 0 ? m.starboard_status_scope_some({ count: data.config.watchedChannels.length }) : m.starboard_status_scope_all()}
        </dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.starboard_status_guards()}</dt>
        <dd class="font-semibold">{activeGuards(data.config) > 0 ? m.starboard_guards_summary({ count: activeGuards(data.config) }) : m.starboard_status_none()}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.starboard_status_on_board()}</dt>
        <dd class="font-semibold">{data.stats.onBoard}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="text-on-surface-variant">{m.starboard_status_last()}</dt>
        <dd class="font-semibold text-right">{data.stats.lastPostedAt ? formatDate(data.stats.lastPostedAt) : m.starboard_status_never()}</dd>
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

{#snippet entryCard(entry: StarboardEntryItem)}
  {@const name = entry.authorName ?? m.starboard_member_left()}
  <li class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-4 space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <UserDisplay
        userId={entry.authorId}
        {name}
        avatarUrl={entry.avatarUrl}
        subtitle={`${formatDate(entry.createdAt)} · ${channelName(entry.channelId)}`}
        size="sm"
        class="min-w-0"
        onClick={openMemberOnClick(entry.authorName)}
      />
      {#if entry.blocked}
        <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-error/10 text-error border border-error/20" title={m.starboard_entry_blocked_title()}>
          {m.starboard_entry_blocked()}
        </span>
      {:else if !entry.onBoard}
        <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-surface-container-high/60 text-on-surface-variant" title={m.starboard_entry_removed_title()}>
          {m.starboard_entry_removed()}
        </span>
      {/if}
    </div>

    <div class="flex gap-3">
      <!-- Une image hors de Discord n'est jamais chargée : elle exposerait l'adresse du lecteur au site d'origine. -->
      {#if entry.imageUrl && isDiscordMediaUrl(entry.imageUrl) && !brokenImages.has(entry.id)}
        <img
          src={entry.imageUrl}
          alt=""
          loading="lazy"
          class="h-20 w-20 rounded-lg object-cover shrink-0 bg-surface-container"
          onerror={() => markBroken(entry.id)}
        />
      {/if}
      {#if entry.excerpt}
        <p class="text-sm leading-relaxed whitespace-pre-wrap break-words line-clamp-4 min-w-0">{entry.excerpt}</p>
      {:else}
        <p class="text-sm italic text-on-surface-variant">{m.starboard_entry_no_text()}</p>
      {/if}
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant">
        <span class="font-bold text-on-surface inline-flex items-center gap-1" title={m.starboard_entry_score_title()}>
          <Papicon icon="Star" size={12} /> {entry.score}
        </span>
        {#if entry.peakScore > entry.score}
          <span title={m.starboard_entry_peak_title()}>{m.starboard_entry_peak({ score: entry.peakScore })}</span>
        {/if}
        <span class="inline-flex items-center gap-1"><Papicon icon="ThumbsUp" size={12} /> {entry.upvotes}</span>
        {#if entry.downvotes > 0}
          <span class="inline-flex items-center gap-1"><Papicon icon="ThumbsDown" size={12} /> {entry.downvotes}</span>
        {/if}
        <a href={entry.messageUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-primary hover:underline">
          <Papicon icon="ExternalLink" size={11} /> {m.starboard_open_message()}
        </a>
        {#if entry.starUrl}
          <a href={entry.starUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-primary hover:underline">
            <Papicon icon="Star" size={11} /> {m.starboard_open_star()}
          </a>
        {/if}
      </div>
      <div class="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          icon="User"
          aria-label={m.starboard_member_history({ name })}
          onclick={() => showEntries({ member: { id: entry.authorId, name } })}
        />
        {#if canConfigure && !savedConfig.blockedUserIds.includes(entry.authorId)}
          <Button variant="ghost" size="sm" icon="UserX" aria-label={m.starboard_exclude_title()} onclick={() => excludeMember(entry)} />
        {/if}
        {#if canModerate}
          {#if entry.blocked}
            <Button size="sm" variant="secondary" icon="RotateCcw" onclick={() => unblockEntry(entry)}>{m.starboard_unblock_action()}</Button>
          {:else}
            <Button size="sm" variant="secondary" icon="EyeOff" onclick={() => blockEntry(entry)}>{m.starboard_block_action()}</Button>
          {/if}
        {/if}
      </div>
    </div>
  </li>
{/snippet}

{#snippet adviceCallout(code: StarboardAdvice)}
  {#if code === 'NO_CHANNEL'}
    <Callout variant="warning" title={m.starboard_advice_no_channel_title()}>
      <p>{m.starboard_advice_no_channel_desc()}</p>
      {#snippet actions()}
        <Button size="sm" icon="Gears" onclick={() => activeTab = 'settings'}>{m.starboard_advice_channel_action()}</Button>
      {/snippet}
    </Callout>
  {:else if code === 'CHANNEL_GONE'}
    <Callout variant="danger" title={m.starboard_advice_channel_gone_title()}>
      <p>{m.starboard_advice_channel_gone_desc()}</p>
      {#snippet actions()}
        <Button size="sm" icon="Gears" onclick={() => activeTab = 'settings'}>{m.starboard_advice_channel_action()}</Button>
      {/snippet}
    </Callout>
  {:else if code === 'MISSING_PERMISSIONS'}
    <Callout variant="danger" title={m.starboard_advice_permissions_title()}>
      <p>{m.starboard_advice_permissions_desc({ permissions: missingPermissionsText, channel: channelName(data?.config.channelId ?? null) })}</p>
    </Callout>
  {:else if code === 'QUIET'}
    <Callout variant="info" title={m.starboard_advice_quiet_title({ days: STARBOARD_STATS_DAYS })}>
      <p>{m.starboard_advice_quiet_desc()}</p>
      {#snippet actions()}
        <Button size="sm" icon="Gears" onclick={() => activeTab = 'settings'}>{m.starboard_advice_threshold_action()}</Button>
      {/snippet}
    </Callout>
  {:else if code === 'BUSY'}
    <Callout variant="info" title={m.starboard_advice_busy_title()}>
      <p>{m.starboard_advice_busy_desc({ count: STARBOARD_BUSY_PER_DAY })}</p>
      {#snippet actions()}
        <Button size="sm" icon="Gears" onclick={() => activeTab = 'settings'}>{m.starboard_advice_threshold_action()}</Button>
      {/snippet}
    </Callout>
  {/if}
{/snippet}

<ModulePage
  title={m.starboard_page_title()}
  description={m.starboard_page_desc()}
  icon="star"
  featureKey="starboard"
>
  {#if !wide.current}
    <div class="mb-4">
      <Button size="sm" icon="List" onclick={() => statusOpen = true}>{m.starboard_status_title()}</Button>
    </div>
    <Modal bind:open={statusOpen} onClose={() => statusOpen = false} title={m.starboard_status_title()}>
      {@render statusPanel()}
    </Modal>
  {/if}

  <!-- Sur grand écran, l'état du module reste à côté du contenu, quel que soit l'onglet. -->
  <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6">
    <div class="min-w-0">
      <Tabs label={m.starboard_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => activeTab = id as Tab} class="mb-6" />

      {#if loading}
        <div class="space-y-6">
          <Skeleton height="80px" />
          <Skeleton height="300px" />
        </div>
      {:else if !data}
        <EmptyState icon="star" title={m.starboard_load_error()} actionLabel={m.starboard_retry()} onAction={() => loadOverview()} />
      {:else if activeTab === 'overview'}
        <div class="space-y-6">
          <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {@render statTile('Star', 'bg-warning/10 text-warning', String(data.stats.postedRecent), m.starboard_stat_posted({ days: STARBOARD_STATS_DAYS }))}
            {@render statTile('TrendingUp', 'bg-primary/10 text-primary', formatScore(data.stats.avgPeakRecent), m.starboard_stat_avg({ days: STARBOARD_STATS_DAYS }))}
            {@render statTile('Trophy', 'bg-success/10 text-success', formatScore(data.stats.bestPeakRecent), m.starboard_stat_best({ days: STARBOARD_STATS_DAYS }))}
            {@render statTile('Eye', 'bg-secondary/10 text-secondary', String(data.stats.onBoard), m.starboard_stat_on_board())}
          </div>

          {#each advice as code (code)}
            {@render adviceCallout(code)}
          {/each}

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="text-base font-semibold flex items-center gap-2.5">
                <Papicon icon="Trophy" size={16} />
                {m.starboard_top_title({ days: STARBOARD_STATS_DAYS })}
              </h3>
              {#if data.topEntries.length > 0}
                <Button variant="ghost" size="sm" icon="List" onclick={() => showEntries({ best: true })}>{m.starboard_see_all()}</Button>
              {/if}
            </div>

            {#if data.topEntries.length === 0}
              <EmptyState
                icon="star"
                title={m.starboard_top_empty_title()}
                description={m.starboard_top_empty_desc({ count: data.config.threshold })}
                reason="accumulating"
              />
            {:else}
              <ul class="space-y-3">
                {#each data.topEntries as entry (entry.id)}
                  {@render entryCard(entry)}
                {/each}
              </ul>
            {/if}
          </section>

          {#if data.channelStats.length > 0}
            <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
              <h3 class="text-base font-semibold flex items-center gap-2.5">
                <Papicon icon="Hash" size={16} />
                {m.starboard_channels_title({ days: STARBOARD_STATS_DAYS })}
              </h3>
              <ul class="space-y-2">
                {#each data.channelStats as stat (stat.channelId)}
                  <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                    <div class="min-w-0 space-y-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-medium truncate">{channelName(stat.channelId)}</span>
                        <span class="text-xs text-on-surface-variant shrink-0">{m.starboard_channels_line({ count: stat.count })}</span>
                      </div>
                      <div class="h-2 bg-surface-container-high rounded-full overflow-hidden" aria-hidden="true">
                        <div class="h-2 bg-warning" style="width: {(stat.count / channelMax) * 100}%"></div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="List"
                      aria-label={m.starboard_channel_show({ name: channelName(stat.channelId) })}
                      onclick={() => showEntries({ channelId: stat.channelId })}
                    />
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>
      {:else if activeTab === 'entries'}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="List" size={16} />
              {m.starboard_entries_title()}
            </h3>
            <div class="flex flex-wrap items-center gap-3">
              <label class="sr-only" for="starboard-channel-filter">{m.starboard_channel_filter_label()}</label>
              <select id="starboard-channel-filter" class="input w-auto" value={channelFilter} onchange={(event) => setChannelFilter(event.currentTarget.value)}>
                <option value="">{m.starboard_channel_filter_all()}</option>
                {#each channels as channel (channel.id)}
                  <option value={channel.id}>{channel.name}</option>
                {/each}
              </select>
              <FilterPills label={m.starboard_period_label()} options={periodOptions} value={period} onchange={setPeriod} />
              <FilterPills label={m.starboard_sort_label()} options={sortOptions} value={sort} onchange={setSort} />
            </div>
          </div>

          {#if memberFilter}
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="text-on-surface-variant">{m.starboard_member_filter({ name: memberFilter.name })}</span>
              <Button variant="ghost" size="sm" icon="X" onclick={() => { memberFilter = null; void loadEntries(true); }}>{m.starboard_member_filter_clear()}</Button>
            </div>
          {/if}

          {#if entries.length === 0 && !entriesLoading}
            {#if filtersActive}
              <EmptyState
                icon="star"
                title={m.starboard_entries_empty_title()}
                actionLabel={m.starboard_filters_clear()}
                onAction={clearFilters}
              />
            {:else}
              <EmptyState
                icon="star"
                title={m.starboard_entries_empty_title()}
                description={m.starboard_top_empty_desc({ count: data.config.threshold })}
                reason="accumulating"
              />
            {/if}
          {:else}
            <ul class="space-y-3">
              {#each entries as entry (entry.id)}
                {@render entryCard(entry)}
              {/each}
            </ul>
          {/if}

          {#if nextCursor || entriesLoading}
            <div class="flex justify-center">
              <Button size="sm" icon="ChevronDown" loading={entriesLoading} onclick={() => loadEntries(false)}>{m.starboard_load_more()}</Button>
            </div>
          {/if}
        </section>
      {:else}
        <div class="space-y-6">
          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Send" size={18} /> {m.starboard_section_publication_title()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.starboard_section_publication_desc()}</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div class="md:col-span-2">
                <Field id="starboard-channel" label={m.starboard_channel_label()} hint={m.starboard_channel_hint()}>
                  {#snippet children(id)}
                    <SearchableSelect
                      {id}
                      bind:value={config.channelId}
                      options={channels}
                      placeholder={m.starboard_channel_placeholder()}
                      disabled={!canConfigure}
                    />
                  {/snippet}
                </Field>
              </div>
              <Field
                id="starboard-threshold"
                label={m.starboard_threshold_label()}
                hint={m.starboard_threshold_hint()}
                error={thresholdValid ? undefined : m.starboard_range_error({ min: STARBOARD_THRESHOLD.min, max: STARBOARD_THRESHOLD.max })}
              >
                {#snippet children(id, describedBy)}
                  <input
                    {id}
                    type="number"
                    class="input max-w-32"
                    min={STARBOARD_THRESHOLD.min}
                    max={STARBOARD_THRESHOLD.max}
                    bind:value={config.threshold}
                    aria-describedby={describedBy}
                    disabled={!canConfigure}
                  />
                {/snippet}
              </Field>
            </div>

            <div class="flex items-center justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <p class="text-sm font-semibold">{m.starboard_color_label()}</p>
              <FormColorPicker bind:value={config.embedColor} />
            </div>

            {#if data.messageLabels}
              <div class="space-y-2">
                <p class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Eye" size={13} /> {m.starboard_preview_heading()}</p>
                <StarboardMessagePreview
                  labels={data.messageLabels}
                  color={config.embedColor}
                  upvoteEmoji={config.upvoteEmojis[0]}
                  hasDownvotes={config.downvoteEmojis.length > 0}
                  threshold={thresholdValid ? config.threshold : savedConfig.threshold}
                />
              </div>
            {/if}
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="ThumbsUp" size={18} /> {m.starboard_section_votes_title()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.starboard_section_votes_desc()}</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field
                id="starboard-upvotes"
                label={m.starboard_upvotes_label()}
                hint={m.starboard_upvotes_hint()}
                error={upvotesValid ? undefined : m.starboard_upvotes_required()}
              >
                {#snippet children(id)}
                  <EmojiListInput
                    {id}
                    bind:values={config.upvoteEmojis}
                    accentClass="bg-success/10 border-success/25 hover:bg-success/20"
                    placeholder={m.starboard_emoji_placeholder()}
                    disabled={!canConfigure}
                  />
                {/snippet}
              </Field>
              <Field id="starboard-downvotes" label={m.starboard_downvotes_label()} hint={m.starboard_downvotes_hint()}>
                {#snippet children(id)}
                  <EmojiListInput
                    {id}
                    bind:values={config.downvoteEmojis}
                    accentClass="bg-error/10 border-error/25 hover:bg-error/20"
                    placeholder={m.starboard_emoji_placeholder()}
                    disabled={!canConfigure}
                  />
                {/snippet}
              </Field>
            </div>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.starboard_count_embed_title()}</p>
                <p class="text-xs text-on-surface-variant">{m.starboard_count_embed_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.countEmbedReactions}
                onToggle={(value) => config.countEmbedReactions = value}
                disabled={!canConfigure}
                ariaLabel={m.starboard_count_embed_title()}
              />
            </div>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.starboard_ignore_author_title()}</p>
                <p class="text-xs text-on-surface-variant">{m.starboard_ignore_author_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.ignoreAuthorVotes}
                onToggle={(value) => config.ignoreAuthorVotes = value}
                disabled={!canConfigure}
                ariaLabel={m.starboard_ignore_author_title()}
              />
            </div>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.starboard_remove_below_title()}</p>
                <p class="text-xs text-on-surface-variant">{m.starboard_remove_below_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.removeBelowThreshold}
                onToggle={(value) => config.removeBelowThreshold = value}
                disabled={!canConfigure}
                ariaLabel={m.starboard_remove_below_title()}
              />
            </div>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Hash" size={18} /> {m.starboard_section_scope_title()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.starboard_section_scope_desc()}</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Field id="starboard-watched" label={m.starboard_watched_label()} hint={m.starboard_watched_hint()}>
                {#snippet children(id)}
                  <MultiSelect {id} bind:values={config.watchedChannels} options={channels} disabled={!canConfigure} />
                {/snippet}
              </Field>
              <Field id="starboard-ignored" label={m.starboard_ignored_label()} hint={m.starboard_ignored_hint()}>
                {#snippet children(id)}
                  <MultiSelect
                    {id}
                    bind:values={config.ignoredChannels}
                    options={channels}
                    accentClass="bg-error/20 text-error border-error/40"
                    disabled={!canConfigure}
                  />
                {/snippet}
              </Field>
            </div>

            <div class="flex items-start justify-between gap-4 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.starboard_allow_bots_title()}</p>
                <p class="text-xs text-on-surface-variant">{m.starboard_allow_bots_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.allowBots}
                onToggle={(value) => config.allowBots = value}
                disabled={!canConfigure}
                ariaLabel={m.starboard_allow_bots_title()}
              />
            </div>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="ShieldCheck" size={18} /> {m.starboard_guards_heading()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.starboard_guards_desc()}</p>
            </div>

            <Callout variant="info" title={m.starboard_nsfw_title()}>
              <p>{m.starboard_nsfw_desc()}</p>
            </Callout>

            <Field
              id="starboard-max-age"
              label={m.starboard_max_age_label()}
              hint={m.starboard_max_age_hint()}
              error={maxAgeValid ? undefined : m.starboard_range_error({ min: STARBOARD_MAX_AGE_DAYS.min, max: STARBOARD_MAX_AGE_DAYS.max })}
            >
              {#snippet children(id, describedBy)}
                <input
                  {id}
                  type="number"
                  class="input max-w-32"
                  min={STARBOARD_MAX_AGE_DAYS.min}
                  max={STARBOARD_MAX_AGE_DAYS.max}
                  bind:value={config.maxMessageAgeDays}
                  aria-describedby={describedBy}
                  disabled={!canConfigure}
                />
              {/snippet}
            </Field>

            <div class="space-y-3 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.starboard_channel_thresholds_label()}</p>
                <p class="text-xs text-on-surface-variant">{m.starboard_channel_thresholds_hint({ max: STARBOARD_CHANNEL_THRESHOLDS_MAX })}</p>
              </div>
              {#if thresholdRows.length > 0}
                <ul class="space-y-2">
                  {#each thresholdRows as [channelId, value] (channelId)}
                    {@const valid = Number.isInteger(value) && value >= STARBOARD_THRESHOLD.min && value <= STARBOARD_THRESHOLD.max}
                    <li class="flex flex-wrap items-center gap-3">
                      <span class="text-sm font-medium min-w-0 flex-1 truncate">{channelName(channelId)}</span>
                      <input
                        type="number"
                        class="input max-w-28 {valid ? '' : 'border-error'}"
                        min={STARBOARD_THRESHOLD.min}
                        max={STARBOARD_THRESHOLD.max}
                        value={value}
                        aria-label={m.starboard_channel_threshold_input({ name: channelName(channelId) })}
                        aria-invalid={!valid}
                        oninput={(event) => setChannelThreshold(channelId, event.currentTarget.valueAsNumber)}
                        disabled={!canConfigure}
                      />
                      {#if canConfigure}
                        <Button variant="ghost" size="sm" icon="X" aria-label={m.starboard_channel_threshold_remove({ name: channelName(channelId) })} onclick={() => removeChannelThreshold(channelId)} />
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if !channelThresholdsValid}
                <p class="text-xs text-error">{m.starboard_channel_thresholds_invalid({ min: STARBOARD_THRESHOLD.min, max: STARBOARD_THRESHOLD.max, count: STARBOARD_CHANNEL_THRESHOLDS_MAX })}</p>
              {/if}
              {#if canConfigure && thresholdRows.length < STARBOARD_CHANNEL_THRESHOLDS_MAX}
                <div class="flex flex-wrap items-center gap-2">
                  <label class="sr-only" for="starboard-threshold-channel">{m.starboard_channel_threshold_add_label()}</label>
                  <select id="starboard-threshold-channel" class="input w-auto" bind:value={newThresholdChannel}>
                    <option value="">{m.starboard_channel_threshold_pick()}</option>
                    {#each thresholdChannelOptions as channel (channel.id)}
                      <option value={channel.id}>{channel.name}</option>
                    {/each}
                  </select>
                  <Button size="sm" icon="Plus" disabled={!newThresholdChannel} onclick={addChannelThreshold}>{m.starboard_channel_threshold_add()}</Button>
                </div>
              {/if}
            </div>

            <div class="space-y-3 border-t border-outline-variant/15 pt-5">
              <div>
                <p class="text-sm font-semibold">{m.starboard_blocked_label()}</p>
                <p class="text-xs text-on-surface-variant">{m.starboard_blocked_hint()}</p>
              </div>
              {#if config.blockedUserIds.length > 0}
                <ul class="flex flex-wrap gap-2">
                  {#each config.blockedUserIds as userId (userId)}
                    <li class="inline-flex items-center gap-1 rounded-full bg-surface-container-high/60 pl-2 pr-1 py-0.5">
                      <UserDisplay {userId} name={blockedMemberName(userId)} avatarUrl={blockedMemberAvatar(userId)} size="sm" />
                      {#if canConfigure}
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="X"
                          aria-label={m.starboard_blocked_remove({ name: blockedMemberName(userId) ?? userId })}
                          onclick={() => config.blockedUserIds = config.blockedUserIds.filter((id) => id !== userId)}
                        />
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if !blockedValid}
                <p class="text-xs text-error">{m.starboard_blocked_too_many({ max: STARBOARD_BLOCKED_USERS_MAX })}</p>
              {/if}
              {#if canConfigure}
                <MemberSearchSelect id="starboard-blocked-member" bind:value={newBlockedMember} placeholder={m.starboard_blocked_placeholder()} />
              {/if}
            </div>
          </section>

          <section class="bg-surface-container-low/40 border border-outline-variant/30 p-6 rounded-xl space-y-5">
            <div class="border-b border-outline-variant/15 pb-3">
              <h3 class="text-lg font-semibold flex items-center gap-2"><Papicon icon="Sparkles" size={18} /> {m.starboard_section_autoreact_title()}</h3>
              <p class="text-xs text-on-surface-variant mt-1">{m.starboard_section_autoreact_desc()}</p>
            </div>

            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-sm font-semibold">{m.starboard_autoreact_embed_title()}</p>
                <p class="text-xs text-on-surface-variant">{m.starboard_autoreact_embed_desc()}</p>
              </div>
              <ToggleSwitch
                checked={config.autoReactEmbed}
                onToggle={(value) => config.autoReactEmbed = value}
                disabled={!canConfigure}
                ariaLabel={m.starboard_autoreact_embed_title()}
              />
            </div>

            <Field id="starboard-autoreact-channels" label={m.starboard_autoreact_channels_label()} hint={m.starboard_autoreact_channels_hint()}>
              {#snippet children(id)}
                <MultiSelect {id} bind:values={config.autoReactChannels} options={channels} disabled={!canConfigure} />
              {/snippet}
            </Field>
          </section>
        </div>
      {/if}
    </div>

    {#if wide.current}
      <aside class="sticky top-4 space-y-4" aria-label={m.starboard_status_title()}>
        <section class="bg-surface-container-low/40 border border-outline-variant/30 p-4 rounded-xl space-y-3">
          <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="List" size={15} /> {m.starboard_status_title()}</h3>
          {@render statusPanel()}
        </section>
      </aside>
    {/if}
  </div>
</ModulePage>
