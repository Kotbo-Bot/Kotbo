<script lang="ts">
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { pageTabItems } from '../lib/config/pageTabs';
  import { Tabs, Button, Callout, Field, SectionCard, SettingsGroup, SettingsRow, ToggleSwitch, EmptyState } from '../lib/components/ui';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { hideUserIds, parseDetailsMetadata } from '../lib/logDetails';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import AuditDiffViewer from '../lib/components/logs/AuditDiffViewer.svelte';
  import LogDetails from '../lib/components/logs/LogDetails.svelte';
  import ColumnSortFilter, { type ColumnFilterOption } from '../lib/components/sanctions/ColumnSortFilter.svelte';
  import {
    fetchMemberCase,
    runMemberCaseAction,
    updateGlobalSettings,
    fetchFeatureConfigurations,
    updateFeatureConfiguration,
    fetchLogEventConfigs,
    updateLogEventConfigs,
  } from '../lib/api';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';


  type LogsSortField = 'date' | 'user' | 'module' | 'action' | 'type';


  let searchQuery = $state('');
  let filters = $state({
    users: [] as string[],
    modules: [] as string[],
    actions: [] as string[],
    types: [] as string[],
    channels: [] as string[],
  });
  let caseModalOpen = $state(false);
  let selectedCaseUser = $state<{ name: string; id: string | null } | null>(null);

  let selectedCaseData = $state<any>(null);
  let selectedCaseLoading = $state(false);
  let selectedCaseError = $state('');
  let memberActionReason = $state(m.lg_member_action_reason());
  let memberActionDuration = $state('30m');
  let memberActionBusy = $state(false);
  let memberActionFeedback = $state('');
  let memberActionIsError = $state(false);
  let sortField = $state<LogsSortField>('date');
  let sortDirection = $state<'asc' | 'desc'>('desc');

  const saveAction = createAsyncActionState();
  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.logs?.canConfigure
      || !!dashboardStore.state.featureAccess?.settings?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  let selectedLogChannelId = $state('');
  let ignoredChannelIds = $state<string[]>([]);

  $effect(() => {
    selectedLogChannelId = dashboardStore.state.logChannelId || '';
  });

  $effect(() => {
    ignoredChannelIds = [...(dashboardStore.state.logIgnoredChannelIds || [])];
  });

  const ignoredChannelsDirty = $derived(
    ignoredChannelIds.join(',') !== (dashboardStore.state.logIgnoredChannelIds || []).join(','),
  );

  // Les salons vocaux de l'etat guilde n'ont pas de champ `type` : sans lui,
  // channelDisplayName les afficherait avec un dièse.
  const ignorableChannels = $derived([
    ...(dashboardStore.state.discordChannels || []),
    ...(dashboardStore.state.discordVoiceChannels || []).map((c: any) => ({ ...c, type: 'voice' })),
  ]);

  const logCategories = [
    {
      id: 'messages',
      label: m.lg_cat_messages(),
      icon: 'Chat',
      events: [
        { type: 'message_delete', label: m.lg_ev_message_delete(), desc: m.lg_ev_message_delete_d() },
        { type: 'message_edit', label: m.lg_ev_message_edit(), desc: m.lg_ev_message_edit_d() },
        { type: 'message_bulk_delete', label: m.lg_ev_bulk_delete(), desc: m.lg_ev_bulk_delete_d() }
      ]
    },
    {
      id: 'members',
      label: m.lg_cat_members(),
      icon: 'Users',
      events: [
        { type: 'member_join', label: m.lg_ev_member_join(), desc: m.lg_ev_member_join_d() },
        { type: 'member_leave', label: m.lg_ev_member_leave(), desc: m.lg_ev_member_leave_d() },
        { type: 'member_roles_update', label: m.lg_ev_roles_update(), desc: m.lg_ev_roles_update_d() },
        { type: 'member_timeout', label: m.lg_ev_member_timeout(), desc: m.lg_ev_member_timeout_d() }
      ]
    },
    {
      id: 'moderation',
      label: m.lg_cat_moderation(),
      icon: 'Shield',
      events: [
        { type: 'moderation_kick', label: m.lg_ev_kick(), desc: m.lg_ev_kick_d() },
        { type: 'moderation_ban', label: m.lg_ev_ban(), desc: m.lg_ev_ban_d() },
        { type: 'moderation_unban', label: m.lg_ev_unban(), desc: m.lg_ev_unban_d() },
        { type: 'moderation_timeout', label: m.lg_ev_timeout_audit(), desc: m.lg_ev_timeout_audit_d() }
      ]
    },
    {
      id: 'voice',
      label: m.lg_cat_voice(),
      icon: 'Microphone',
      events: [
        { type: 'voice_join', label: m.lg_ev_voice_join(), desc: m.lg_ev_voice_join_d() },
        { type: 'voice_leave', label: m.lg_ev_voice_leave(), desc: m.lg_ev_voice_leave_d() },
        { type: 'voice_move', label: m.lg_ev_voice_move(), desc: m.lg_ev_voice_move_d() },
        { type: 'voice_panel', label: m.lg_ev_voice_panel(), desc: m.lg_ev_voice_panel_d() }
      ]
    },
    {
      id: 'lifecycle',
      label: m.lg_cat_lifecycle(),
      icon: 'Folder',
      events: [
        { type: 'channel_lifecycle', label: m.lg_ev_channel_lifecycle(), desc: m.lg_ev_channel_lifecycle_d() },
        { type: 'role_lifecycle', label: m.lg_ev_role_lifecycle(), desc: m.lg_ev_role_lifecycle_d() }
      ]
    }
  ];

  let logsConfig = $state<any>(null);
  let loadingConfig = $state(false);
  let eventConfigs = $state<Array<{ eventType: string; enabled: boolean; channelId: string | null }>>([]);
  let savedEventConfigs = $state<Array<{ eventType: string; enabled: boolean; channelId: string | null }>>([]);

  $effect(() => {
    const current = JSON.stringify(eventConfigs);
    const saved = JSON.stringify(savedEventConfigs);
    const dirty = current !== saved;

    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'logs',
          label: m.lg_page_title(),
          onSave: () => handleSaveEventConfigs(),
          onReset: () => {
            eventConfigs = JSON.parse(JSON.stringify(savedEventConfigs));
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('logs');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('logs');
  });

  onMount(async () => {
    void dashboardStore.ensureFullState();
    loadingConfig = true;
    try {
      const [configs, eventConfigsRes] = await Promise.all([
        fetchFeatureConfigurations(),
        fetchLogEventConfigs()
      ]);
      logsConfig = configs?.features?.find((c: any) => c.featureKey === 'logs') || null;
      eventConfigs = eventConfigsRes?.configs || [];
      savedEventConfigs = JSON.parse(JSON.stringify(eventConfigs));
    } catch (err) {
      console.error('Error fetching logs config:', err);
    } finally {
      loadingConfig = false;
    }
  });

  async function handleSaveEventConfigs(): Promise<boolean> {
    let success = false;
    await saveAction.run(async () => {
      const ok = await updateLogEventConfigs(eventConfigs);
      if (!ok) throw new Error(m.sc_api_error());
      savedEventConfigs = JSON.parse(JSON.stringify(eventConfigs));
      success = true;
      return true;
    }, { successMessage: m.lg_events_saved() });
    return success;
  }

  async function handleLogChannelChange() {
    const channelId = selectedLogChannelId || '';
    
    await saveAction.run(async () => {
      const ok = await updateGlobalSettings({ logChannelId: channelId });
      if (!ok) throw new Error(m.sc_api_error());
      
      // Also update the feature config channelId if logsConfig exists
      if (logsConfig) {
        await updateFeatureConfiguration('logs', { channelId });
        logsConfig.channelId = channelId;
      }

      await dashboardStore.refresh();
      return true;
    }, { successMessage: m.lg_log_channel_updated() });
  }

  async function handleIgnoredChannelsSave() {
    await saveAction.run(async () => {
      const ok = await updateGlobalSettings({ logIgnoredChannelIds: ignoredChannelIds });
      if (!ok) throw new Error(m.sc_api_error());
      await dashboardStore.refresh();
      return true;
    }, { successMessage: m.lg_ignored_channels_updated() });
  }

  // Filter to only Discord logs
  const discordLogs = $derived((dashboardStore.state.auditTrail as any[]).filter(entry => entry.source === 'discord'));

  const logLabels = $derived({
    details: m.lg_details(),
    unknownChannel: m.lg_unknown_channel_name(),
    unknownRole: 'role-inconnu',
  });

  function getLogChannelId(entry: { details: string; channelId: string | null }) {
    return parseDetailsMetadata(entry.details, '', logLabels).extractedChannelId ?? entry.channelId;
  }

  function displayUser(entry: { user: string; details: string }) {
    const parsed = parseDetailsMetadata(entry.details, entry.user, logLabels);
    if (!parsed.extractedUser) {
      return hideUserIds(entry.user).trim() || entry.user;
    }
    const normalized = parsed.extractedUser.replace(/\s*\(<@!?\d{15,25}>\)\s*$/, '').trim();
    return normalized || hideUserIds(entry.user).trim() || entry.user;
  }

  const uniqueUsers = $derived([...new Set(discordLogs.map((entry) => displayUser(entry)))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueModules = $derived([...new Set(discordLogs.map((entry) => entry.module))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueActions = $derived([...new Set(discordLogs.map((entry) => entry.action))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueTypes = $derived([...new Set(discordLogs.map((entry) => entry.eventType))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueChannels = $derived(
    [...new Set(discordLogs.map((entry) => getLogChannelId(entry)).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'fr'))
  );

  const userFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueUsers.map((user) => ({ value: user, label: user }))
  );
  const moduleFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueModules.map((moduleName) => ({ value: moduleName, label: moduleName }))
  );
  const actionFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueActions.map((actionName) => ({ value: actionName, label: actionName }))
  );
  const typeFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueTypes.map((eventType) => ({ value: eventType, label: eventType }))
  );
  const channelFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueChannels.map((channelId) => ({ value: channelId, label: formatChannelLabel(channelId) }))
  );

  const hasActiveFiltersOrSort = $derived(
    filters.users.length > 0
      || filters.modules.length > 0
      || filters.actions.length > 0
      || filters.types.length > 0
      || filters.channels.length > 0
      || sortField !== 'date'
      || sortDirection !== 'desc'
  );

  function toggleFilter(filterType: 'users' | 'modules' | 'actions' | 'types' | 'channels', value: string) {
    const list = filters[filterType];
    if (list.includes(value)) {
      filters[filterType] = list.filter((entry) => entry !== value);
      return;
    }
    filters[filterType] = [...list, value];
  }

  function toggleSort(field: LogsSortField) {
    if (sortField === field) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortField = field;
    sortDirection = 'asc';
  }

  function sortDirectionFor(field: LogsSortField) {
    return sortField === field ? sortDirection : null;
  }

  function resetFiltersAndSort() {
    filters = {
      users: [],
      modules: [],
      actions: [],
      types: [],
      channels: [],
    };
    sortField = 'date';
    sortDirection = 'desc';
  }

  function formatChannelLabel(channelId: string | null | undefined) {
    if (!channelId) return m.lg_not_specified();
    const channel = dashboardStore.state.discordChannels.find((item) => item.id === channelId);
    if (!channel) return m.lg_unknown_channel();
    return channelDisplayName(channel);
  }



  function parseDurationToMs(input: string) {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return null;
    const match = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*(s|sec|secs|seconde|secondes|m|min|mins|minute|minutes|h|heure|heures|d|j|jour|jours|w|semaine|semaines)$/i);
    if (!match) return null;
    const value = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = match[2].toLowerCase();
    const unitMs: Record<string, number> = {
      s: 1000,
      sec: 1000,
      secs: 1000,
      seconde: 1000,
      secondes: 1000,
      m: 60 * 1000,
      min: 60 * 1000,
      mins: 60 * 1000,
      minute: 60 * 1000,
      minutes: 60 * 1000,
      h: 60 * 60 * 1000,
      heure: 60 * 60 * 1000,
      heures: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      j: 24 * 60 * 60 * 1000,
      jour: 24 * 60 * 60 * 1000,
      jours: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      semaine: 7 * 24 * 60 * 60 * 1000,
      semaines: 7 * 24 * 60 * 60 * 1000,
    };
    return Math.round(value * (unitMs[unit] ?? 0)) || null;
  }


  async function loadMemberCase(userId: string) {
    selectedCaseLoading = true;
    selectedCaseError = '';
    try {
      selectedCaseData = await fetchMemberCase(userId);
    } catch (error) {
      selectedCaseError = error instanceof Error ? error.message : m.sc_member_load_error();
      selectedCaseData = null;
    } finally {
      selectedCaseLoading = false;
    }
  }

  async function executeMemberAction(action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') {
    if (!selectedCaseUser?.id) return;
    const userId = selectedCaseUser.id;

    const reason = memberActionReason.trim() || m.lg_member_action_reason();
    const durationMs = action === 'TIMEOUT' ? parseDurationToMs(memberActionDuration) : null;

    if (action === 'TIMEOUT' && !durationMs) {
      memberActionFeedback = m.lg_invalid_timeout();
      memberActionIsError = true;
      return;
    }

    memberActionBusy = true;
    memberActionFeedback = '';
    memberActionIsError = false;

    try {
      await runMemberCaseAction(userId, action, { reason, durationMs: durationMs ?? undefined });
      memberActionFeedback = m.sc_action_applied();
      await loadMemberCase(userId);
    } catch (error) {
      memberActionIsError = true;
      memberActionFeedback = error instanceof Error ? error.message : m.sc_action_failed();
    } finally {
      memberActionBusy = false;
    }
  }

  /**
   * Le dossier membre est la fiche de la section Membres : un role a qui le
   * centre de gestion l'a fermee ne doit pas la rouvrir depuis un journal.
   */
  const canOpenMemberCase = $derived(canViewFeature('members'));

  function openCaseModal(entry: { user: string; details: string; action: string }) {
    if (!canOpenMemberCase) return;
    const parsed = parseDetailsMetadata(entry.details, entry.user, logLabels);
    selectedCaseUser = {
      name: displayUser(entry),
      id: parsed.extractedUserId,
    };
    selectedCaseData = null;
    selectedCaseError = '';
    memberActionReason = m.lg_action_from_log({ action: entry.action });
    memberActionDuration = '30m';
    memberActionFeedback = '';
    memberActionIsError = false;
    caseModalOpen = true;

    if (parsed.extractedUserId) {
      void loadMemberCase(parsed.extractedUserId);
    }
  }

  function closeCaseModal() {
    caseModalOpen = false;
    selectedCaseUser = null;
    selectedCaseData = null;
    selectedCaseError = '';
  }

  const sanctions = $derived((dashboardStore.state.sanctions as any[]) || []);

  const filteredLogs = $derived(
    [...discordLogs]
    .filter(log => {
      const matchesSearch = searchQuery === '' || 
        log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.details.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.module.toLowerCase().includes(searchQuery.toLowerCase()) ||
        displayUser(log).toLowerCase().includes(searchQuery.toLowerCase());
      const matchesModule = filters.modules.length === 0 || filters.modules.includes(log.module);
      const matchesAction = filters.actions.length === 0 || filters.actions.includes(log.action);
      const matchesType = filters.types.length === 0 || filters.types.includes(log.eventType);
      const matchesUser = filters.users.length === 0 || filters.users.includes(displayUser(log));
      const matchesChannel = filters.channels.length === 0 || filters.channels.includes(getLogChannelId(log) ?? '');
      return matchesSearch && matchesModule && matchesAction && matchesType && matchesUser && matchesChannel;
    })
    .sort((left, right) => {
      let result = 0;
      switch (sortField) {
        case 'date':
          result = new Date(left.dateIso).getTime() - new Date(right.dateIso).getTime();
          break;
        case 'user':
          result = displayUser(left).localeCompare(displayUser(right), 'fr');
          break;
        case 'module':
          result = left.module.localeCompare(right.module, 'fr');
          break;
        case 'action':
          result = left.action.localeCompare(right.action, 'fr');
          break;
        case 'type':
          result = left.eventType.localeCompare(right.eventType, 'fr');
          break;
      }
      return sortDirection === 'asc' ? result : -result;
    })
  );

  const logsTabs = ['logs', 'audit', 'config'] as const;
  let activeTab = $state<'logs' | 'audit' | 'config'>('logs');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/logs', logsTabs, 'logs') as typeof activeTab;
  });

  const stats = $derived([
    { label: m.lg_discord_events(), val: discordLogs.length, sub: m.lg_total(), icon: 'List' },
    { label: m.nav_modules(), val: new Set(discordLogs.map(l => l.module)).size, sub: m.lg_sources(), icon: 'Grid' },
    { label: m.lg_users(), val: new Set(discordLogs.map(l => l.user)).size, sub: m.lg_unique(), icon: 'Users' }
  ]);
</script>


<ModulePage 
  title={m.lg_page_title()}
  description={m.lg_page_desc()}
  icon="List"
  featureKey="logs"
>
  {#snippet actions()}
    <RefreshButton
      onClick={() => dashboardStore.refresh()}
      loading={dashboardStore.state.loading}
      label={m.common_refresh()}
    />
  {/snippet}

  <Tabs
    label={m.lg_page_title()}
    tabs={pageTabItems('/logs', (id) => id !== 'config' || canManageSettings)}
    active={activeTab}
    onchange={(id) => gotoTab('/logs', id, 'logs')}
  />

{#if activeTab === 'audit'}
  <!-- Audit structurel : autonome, charge ses propres données -->
  <AuditDiffViewer />
{/if}

{#if activeTab === 'config' && canManageSettings}
<div class="space-y-6">
  <SectionCard title={m.lg_page_title()} icon="Settings" flush>
    <div class="divide-y divide-outline-variant">
      <div data-guide="logs-channel">
        <SettingsRow label={m.lg_default_channel()} description={m.lg_default_channel_desc()}>
          <div class="w-full sm:w-72">
            <SearchableSelect bind:value={selectedLogChannelId} on:change={() => handleLogChannelChange()} options={(dashboardStore.state.discordChannels || []).map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.lg_select_channel_ph()} />
          </div>
        </SettingsRow>
      </div>

      <SettingsRow label={m.lg_ignored_channels()} description={m.lg_ignored_channels_desc()} stacked>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div class="min-w-0 flex-1">
            <MultiSelect
              id="log-ignored-channels"
              bind:values={ignoredChannelIds}
              options={ignorableChannels.map((c: any) => ({ id: c.id, name: channelDisplayName(c) }))}
            />
          </div>
          {#if ignoredChannelsDirty}
            <Button variant="primary" icon="Check" loading={saveAction.state.loading} onclick={handleIgnoredChannelsSave}>{m.common_save()}</Button>
          {/if}
        </div>
      </SettingsRow>

      {#if logsConfig}
        <div class="p-4">
          <RolePermissionSettings featureKey="logs" roleAccess={logsConfig.roleAccessByRole} />
        </div>
      {/if}
    </div>
  </SectionCard>

  {#if saveAction.state.message}
    <Callout variant="success">{saveAction.state.message}</Callout>
  {/if}

  <SettingsGroup title={m.lg_per_event_config()} description={m.lg_per_event_desc()}>
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {#each logCategories as cat}
        <SectionCard title={cat.label} description={m.lg_manage_category_alerts()} icon={cat.icon} flush>
          <div class="divide-y divide-outline-variant">
            {#each cat.events as ev}
              {@const confIdx = eventConfigs.findIndex(c => c.eventType === ev.type)}
              {#if confIdx !== -1}
                <div>
                  <SettingsRow label={ev.label} description={ev.desc}>
                    <ToggleSwitch
                      checked={eventConfigs[confIdx].enabled}
                      ariaLabel={ev.label}
                      onToggle={(v: boolean) => {
                        eventConfigs[confIdx].enabled = v;
                        eventConfigs = [...eventConfigs];
                      }}
                    />
                  </SettingsRow>
                  {#if eventConfigs[confIdx].enabled}
                    <Field label={m.lg_dest_channel()} class="px-4 pb-4">
                      {#snippet children(id, describedBy)}
                        <select {id} aria-describedby={describedBy} class="input" bind:value={eventConfigs[confIdx].channelId}>
                          <option value={null}>{m.lg_default_log_channel()}</option>
                          {#each dashboardStore.state.discordChannels as c}
                            <option value={c.id}>#{c.name}</option>
                          {/each}
                        </select>
                      {/snippet}
                    </Field>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        </SectionCard>
      {/each}
    </div>
  </SettingsGroup>
</div>
{/if}

{#if activeTab === 'logs'}
<div class="space-y-6">
  <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
    {#each stats as kpi}
      <MetricCard label={kpi.label} value={kpi.val} note={kpi.sub} icon={kpi.icon} />
    {/each}
  </div>

  <SectionCard flush>
    <div class="flex flex-col gap-3 border-b border-outline-variant p-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="relative w-full sm:max-w-md">
        <Papicon icon="search" size={16} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
        <input
          type="search"
          class="input pl-9"
          bind:value={searchQuery}
          placeholder={m.lg_search_ph()}
          aria-label={m.lg_quick_search()}
        />
      </div>
      <div class="flex items-center gap-2">
        <span class="badge badge-neutral">{m.lg_events_count({ a: filteredLogs.length, b: discordLogs.length })}</span>
        {#if hasActiveFiltersOrSort}
          <Button variant="ghost" size="sm" icon="RotateCcw" onclick={resetFiltersAndSort}>{m.common_reset()}</Button>
        {/if}
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="data-table">
        <thead>
          <tr>
            <th>
              <ColumnSortFilter
                label={m.lg_col_time()}
                sortDirection={sortDirectionFor('date')}
                onToggleSort={() => toggleSort('date')}
              />
            </th>
            <th>
              <ColumnSortFilter
                label={m.lg_col_actor()}
                sortDirection={sortDirectionFor('user')}
                onToggleSort={() => toggleSort('user')}
                options={userFilterOptions}
                selectedValues={filters.users}
                onToggleValue={(value) => toggleFilter('users', value)}
                searchable={true}
              />
            </th>
            <th>
              <ColumnSortFilter
                label={m.lg_col_channel()}
                options={channelFilterOptions}
                selectedValues={filters.channels}
                onToggleValue={(value) => toggleFilter('channels', value)}
                searchable={true}
              />
            </th>
            <th>
              <ColumnSortFilter
                label={m.lg_col_category()}
                sortDirection={sortDirectionFor('module')}
                onToggleSort={() => toggleSort('module')}
                options={moduleFilterOptions}
                selectedValues={filters.modules}
                onToggleValue={(value) => toggleFilter('modules', value)}
              />
            </th>
            <th>
              <ColumnSortFilter
                label={m.lg_col_action()}
                sortDirection={sortDirectionFor('action')}
                onToggleSort={() => toggleSort('action')}
                options={actionFilterOptions}
                selectedValues={filters.actions}
                onToggleValue={(value) => toggleFilter('actions', value)}
                searchable={true}
              />
            </th>
            <th>{m.lg_col_details()}</th>
            <th>
              <ColumnSortFilter
                label={m.lg_col_type()}
                sortDirection={sortDirectionFor('type')}
                onToggleSort={() => toggleSort('type')}
                options={typeFilterOptions}
                selectedValues={filters.types}
                onToggleValue={(value) => toggleFilter('types', value)}
              />
            </th>
          </tr>
        </thead>
        <tbody>
          {#each filteredLogs as entry}
            <tr>
              <td class="whitespace-nowrap">
                <p class="text-body-sm font-medium text-on-surface">{new Date(entry.dateIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
                <p class="text-2xs text-on-surface-variant">{new Date(entry.dateIso).toLocaleDateString()}</p>
              </td>
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  class="max-w-40"
                  disabled={!canOpenMemberCase}
                  disabledReason={m.common_reason_no_permission()}
                  title={canOpenMemberCase ? m.lg_open_case() : undefined}
                  onclick={() => openCaseModal(entry)}
                >
                  <span class="truncate">{displayUser(entry)}</span>
                </Button>
              </td>
              <td class="max-w-xs text-body-sm text-on-surface-variant">
                {formatChannelLabel(getLogChannelId(entry))}
              </td>
              <td class="text-body-sm text-on-surface-variant">{entry.module}</td>
              <td class="text-body-sm font-medium text-on-surface">{entry.action}</td>
              <td class="max-w-sm">
                <LogDetails details={entry.details} channelId={getLogChannelId(entry)} compact />
              </td>
              <td>
                <span class="badge {entry.eventType === 'Automatique' ? 'badge-info' : 'badge-warning'}">
                  {entry.eventType === 'Automatique' ? m.lg_type_auto() : entry.eventType}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if filteredLogs.length === 0}
      <EmptyState
        icon="List"
        title={m.lg_no_events()}
        description={m.lg_no_events_hint()}
        reason={discordLogs.length > 0 ? 'nothing-matches' : 'accumulating'}
      />
    {/if}
  </SectionCard>
</div>
{/if}

{#if caseModalOpen && selectedCaseUser}
  <MemberCaseModal 
    open={caseModalOpen}
    userId={selectedCaseUser?.id}
    caseData={selectedCaseData}
    loading={selectedCaseLoading}
    error={selectedCaseError}
    actionReason={memberActionReason}
    actionDuration={memberActionDuration}
    actionBusy={memberActionBusy}
    actionFeedback={memberActionFeedback}
    actionIsError={memberActionIsError}
    onAction={executeMemberAction}
    onClose={closeCaseModal}
    onSelectUser={(userId) => {
      selectedCaseUser = { name: m.common_loading(), id: userId };
      void loadMemberCase(userId);
    }}
  />
{/if}

</ModulePage>

