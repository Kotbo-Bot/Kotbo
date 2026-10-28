<script lang="ts">
  import { onMount } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import MultiSelect from '../MultiSelect.svelte';
  import { Button, Callout, Field, SectionCard, SettingsRow, ToggleSwitch, EmptyState } from '../ui';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import { diffLines, diffStats, errorMessage, toSideBySide } from '@kotbo/shared';
  import {
    fetchAuditEvents,
    fetchAuditConfig,
    fetchAuditExecutors,
    updateAuditConfig,
    type AuditChange,
    type AuditEvent,
    type AuditEventType,
    type AuditLoggerConfig,
  } from '../../api';

  const canManageSettings = $derived(!!dashboardStore.state.access?.canManageSettings);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);
  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  let loading = $state(true);
  let loadingEvents = $state(false);
  let error = $state('');

  let events = $state<AuditEvent[]>([]);
  let total = $state(0);
  let page = $state(1);
  const pageSize = 25;
  const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));

  let executors = $state<{ id: string; name: string; count: number }[]>([]);
  let config = $state<AuditLoggerConfig | null>(null);
  let expanded = $state<Set<string>>(new Set());

  // ── Filtres ───────────────────────────────────────────────────────────────
  let filterType = $state<AuditEventType | ''>('');
  let filterExecutor = $state('');
  let filterSearch = $state('');
  let filterFrom = $state('');
  let filterTo = $state('');

  // ── Configuration ─────────────────────────────────────────────────────────
  let saving = $state(false);
  let showConfig = $state(false);
  let form = $state({
    enabled: false,
    retentionDays: 90,
    captureMessages: true,
    captureMembers: true,
    captureRoles: true,
    captureChannels: true,
    ignoredChannelIds: [] as string[],
    ignoredUserIds: [] as string[],
  });

  const TYPE_META: Record<AuditEventType, { label: () => string; icon: string; color: string }> = {
    MESSAGE_UPDATE: { label: () => m.audit_type_message_update(), icon: 'ChatCircleDots', color: '#6366f1' },
    MEMBER_UPDATE: { label: () => m.audit_type_member_update(), icon: 'Users', color: '#10b981' },
    ROLE_UPDATE: { label: () => m.audit_type_role_update(), icon: 'Shield', color: '#f97316' },
    CHANNEL_UPDATE: { label: () => m.audit_type_channel_update(), icon: 'Hash', color: '#0ea5e9' },
    CHANNEL_PERMISSIONS_UPDATE: { label: () => m.audit_type_channel_permissions_update(), icon: 'Lock', color: '#a855f7' },
  };

  const ALL_TYPES = Object.keys(TYPE_META) as AuditEventType[];

  function applyConfig(next: AuditLoggerConfig) {
    config = next;
    form = {
      enabled: next.enabled,
      retentionDays: next.retentionDays,
      captureMessages: next.captureMessages,
      captureMembers: next.captureMembers,
      captureRoles: next.captureRoles,
      captureChannels: next.captureChannels,
      ignoredChannelIds: [...next.ignoredChannelIds],
      ignoredUserIds: [...next.ignoredUserIds],
    };
  }

  async function loadEvents() {
    loadingEvents = true;
    try {
      const result = await fetchAuditEvents({
        eventType: filterType || undefined,
        executorId: filterExecutor || undefined,
        search: filterSearch.trim() || undefined,
        from: filterFrom || undefined,
        to: filterTo || undefined,
        page,
        pageSize,
      });
      if (result) {
        events = result.events;
        total = result.total;
      }
    } catch (e) {
      toast.error(errorMessage(e) || m.audit_error());
    } finally {
      loadingEvents = false;
    }
  }

  onMount(async () => {
    loading = true;
    try {
      const [configResult, executorsResult] = await Promise.all([
        fetchAuditConfig(),
        fetchAuditExecutors(),
      ]);
      if (configResult?.config) applyConfig(configResult.config);
      if (executorsResult?.executors) executors = executorsResult.executors;
      await loadEvents();
    } catch (e) {
      error = errorMessage(e) || m.audit_error();
    } finally {
      loading = false;
    }
  });

  let searchTimer: ReturnType<typeof setTimeout>;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      loadEvents();
    }, 350);
  }

  function applyFilters() {
    page = 1;
    loadEvents();
  }

  function resetFilters() {
    filterType = '';
    filterExecutor = '';
    filterSearch = '';
    filterFrom = '';
    filterTo = '';
    applyFilters();
  }

  function changePage(delta: number) {
    const next = page + delta;
    if (next < 1 || next > totalPages) return;
    page = next;
    loadEvents();
  }

  function toggleExpanded(id: string) {
    // Réassignation nécessaire : Svelte ne suit pas les mutations internes d'un Set
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  async function saveConfig() {
    if (!canManageSettings || saving) return;
    saving = true;
    try {
      const result = await updateAuditConfig(form);
      if (result?.config) applyConfig(result.config);
      toast.success(m.audit_saved());
    } catch (e) {
      toast.error(errorMessage(e) || m.audit_error());
    } finally {
      saving = false;
    }
  }

  function formatDateTime(value: string): string {
    return new Date(value).toLocaleString(dateLocale(), {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function displayValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return m.audit_empty_value();
    if (typeof value === 'boolean') return value ? 'Oui / Yes' : 'Non / No';
    return String(value);
  }

  /** Un changement de contenu textuel mérite un diff ligne à ligne, pas un simple avant/après. */
  function isTextDiff(change: AuditChange): boolean {
    return change.field === 'content';
  }

  function isListDiff(change: AuditChange): boolean {
    return Boolean(change.added?.length || change.removed?.length || change.reset?.length);
  }
</script>

{#if loading}
  <div class="space-y-3">
    {#each Array(5) as _}
      <div class="h-20 rounded-xl bg-surface-container animate-pulse"></div>
    {/each}
  </div>
{:else if error}
  <Callout variant="danger">{error}</Callout>
{:else}
  <div class="space-y-6">
    <!-- En-tête -->
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-base font-semibold text-on-surface">{m.audit_title()}</h2>
        <p class="text-body-sm text-on-surface-variant mt-1 max-w-2xl">{m.audit_subtitle()}</p>
      </div>
      {#if canManageSettings}
        <Button icon="Settings" onclick={() => (showConfig = !showConfig)} aria-expanded={showConfig}>
          {m.audit_config_title()}
        </Button>
      {/if}
    </div>

    {#if config && !config.enabled}
      <Callout variant="warning">{m.audit_disabled_notice()}</Callout>
    {/if}

    <!-- Configuration -->
    {#if showConfig && canManageSettings && config}
      <SectionCard title={m.audit_config_title()} icon="Settings" flush>
        <div class="divide-y divide-outline-variant">
          <SettingsRow label={m.audit_config_enabled()}>
            <ToggleSwitch checked={form.enabled} ariaLabel={m.audit_config_enabled()} onToggle={(v: boolean) => (form.enabled = v)} />
          </SettingsRow>
          {#each [
            { key: 'captureMessages' as const, label: m.audit_capture_messages() },
            { key: 'captureMembers' as const, label: m.audit_capture_members() },
            { key: 'captureRoles' as const, label: m.audit_capture_roles() },
            { key: 'captureChannels' as const, label: m.audit_capture_channels() },
          ] as toggle}
            <SettingsRow label={toggle.label}>
              <ToggleSwitch checked={form[toggle.key]} ariaLabel={toggle.label} onToggle={(v: boolean) => (form[toggle.key] = v)} />
            </SettingsRow>
          {/each}
          <div class="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
            <Field label={m.audit_retention_days()} hint={m.audit_retention_help()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} class="input" type="number" min="0" max="3650" bind:value={form.retentionDays} />
              {/snippet}
            </Field>
            <Field label={m.audit_ignored_channels()}>
              {#snippet children(id)}
                <MultiSelect
                  {id}
                  bind:values={form.ignoredChannelIds}
                  options={availableChannels.map((c: any) => ({ id: c.id, name: `#${c.name}` }))}
                />
              {/snippet}
            </Field>
            <Field label={m.audit_ignored_users()} hint={m.audit_ignored_help()}>
              {#snippet children(id)}
                <MultiSelect
                  {id}
                  bind:values={form.ignoredUserIds}
                  options={availableRoles.map((r: any) => ({ id: r.id, name: `@${r.name}` }))}
                />
              {/snippet}
            </Field>
          </div>
          <div class="flex justify-end p-4">
            <Button variant="primary" icon="Check" loading={saving} onclick={saveConfig}>
              {saving ? m.audit_saving() : m.audit_save()}
            </Button>
          </div>
        </div>
      </SectionCard>
    {/if}

    <!-- Filtres -->
    <div class="section-card p-4 space-y-3">
      <div class="flex flex-wrap items-end gap-3">
        <input
          type="search"
          class="input flex-1 min-w-48"
          bind:value={filterSearch}
          oninput={onSearchInput}
          placeholder={m.audit_filter_search()}
          aria-label={m.audit_filter_search()}
        />

        <select class="input w-auto" bind:value={filterType} onchange={applyFilters} aria-label={m.audit_filter_all_types()}>
          <option value="">{m.audit_filter_all_types()}</option>
          {#each ALL_TYPES as type}
            <option value={type}>{TYPE_META[type].label()}</option>
          {/each}
        </select>

        <select class="input w-auto" bind:value={filterExecutor} onchange={applyFilters} aria-label={m.audit_filter_all_executors()}>
          <option value="">{m.audit_filter_all_executors()}</option>
          {#each executors as executor}
            <option value={executor.id}>{executor.name} ({executor.count})</option>
          {/each}
        </select>

        <label class="flex items-center gap-2 text-body-sm text-on-surface-variant">
          {m.audit_filter_from()}
          <input type="date" class="input w-auto" bind:value={filterFrom} onchange={applyFilters} />
        </label>

        <label class="flex items-center gap-2 text-body-sm text-on-surface-variant">
          {m.audit_filter_to()}
          <input type="date" class="input w-auto" bind:value={filterTo} onchange={applyFilters} />
        </label>

        <Button variant="ghost" icon="RotateCcw" onclick={resetFilters}>{m.audit_filter_reset()}</Button>
      </div>
      <p class="text-xs text-on-surface-variant">{m.audit_total_events({ n: total })}</p>
    </div>

    <!-- Journal -->
    {#if loadingEvents}
      <div class="space-y-3">
        {#each Array(4) as _}
          <div class="h-20 rounded-xl bg-surface-container animate-pulse"></div>
        {/each}
      </div>
    {:else if events.length === 0}
      <div class="section-card">
        <EmptyState
          icon="GitCompare"
          title={m.audit_no_events()}
          reason={filterSearch || filterType || filterExecutor || filterFrom || filterTo ? 'nothing-matches' : 'accumulating'}
        />
      </div>
    {:else}
      <div class="space-y-3">
        {#each events as event (event.id)}
          {@const meta = TYPE_META[event.eventType]}
          {@const isOpen = expanded.has(event.id)}
          <article class="section-card overflow-hidden">
            <header class="p-4 flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background: {meta.color}18">
                  <Papicon icon={meta.icon} size={16} style="color: {meta.color}" />
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-semibold text-on-surface">{meta.label()}</span>
                    <span class="text-sm text-on-surface-variant truncate">{event.targetName || event.targetId}</span>
                  </div>
                  <div class="text-2xs text-on-surface-variant mt-0.5">
                    {formatDateTime(event.createdAt)}
                    · {m.audit_by()} {event.executorName || m.audit_unknown_executor()}
                    {#if event.channelName}· #{event.channelName}{/if}
                  </div>
                </div>
              </div>

              <Button size="sm" variant="ghost" icon={isOpen ? 'ChevronUp' : 'ChevronDown'} aria-expanded={isOpen} onclick={() => toggleExpanded(event.id)}>
                {isOpen ? m.audit_hide_diff() : m.audit_view_diff()}
              </Button>
            </header>

            {#if isOpen}
              <div class="px-4 pb-4 space-y-4 border-t border-outline-variant pt-4">
                {#if event.reason}
                  <p class="text-xs text-on-surface-variant">
                    <span class="font-semibold">{m.audit_reason()} :</span> {event.reason}
                  </p>
                {/if}

                {#each event.changes as change}
                  <div class="space-y-2">
                    <h4 class="text-xs font-semibold text-on-surface-variant">
                      {change.label}
                    </h4>

                    {#if isTextDiff(change)}
                      <!-- Diff textuel ligne à ligne, côte à côte -->
                      {@const lines = diffLines(String(change.before ?? ''), String(change.after ?? ''))}
                      {@const stats = diffStats(lines)}
                      {@const rows = toSideBySide(lines)}
                      <p class="text-2xs text-on-surface-variant">
                        <span class="text-success">+{stats.added}</span>
                        <span class="text-error ml-2">−{stats.removed}</span>
                      </p>
                      <div class="rounded-lg border border-outline-variant overflow-x-auto">
                        <table class="w-full font-mono text-xs border-collapse">
                          <thead>
                            <tr class="text-xs text-on-surface-variant bg-surface-container">
                              <th class="text-left font-medium px-3 py-2 w-1/2">{m.audit_before()}</th>
                              <th class="text-left font-medium px-3 py-2 w-1/2 border-l border-outline-variant">{m.audit_after()}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {#each rows as row}
                              <tr>
                                <td class="px-3 py-1 align-top whitespace-pre-wrap wrap-break-word {row.before?.type === 'removed' ? 'bg-error/10 text-error' : 'text-on-surface-variant'}">
                                  {#if row.before}<span class="select-none text-on-surface-variant/30 mr-2">{row.before.beforeLine ?? ''}</span>{row.before.content}{/if}
                                </td>
                                <td class="px-3 py-1 align-top whitespace-pre-wrap wrap-break-word border-l border-outline-variant {row.after?.type === 'added' ? 'bg-success/10 text-success' : 'text-on-surface-variant'}">
                                  {#if row.after}<span class="select-none text-on-surface-variant/30 mr-2">{row.after.afterLine ?? ''}</span>{row.after.content}{/if}
                                </td>
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                    {:else if isListDiff(change)}
                      <!-- Listes : rôles gagnés/perdus, permissions accordées/refusées -->
                      <div class="flex flex-wrap gap-1.5">
                        {#each change.added ?? [] as item}
                          <span class="badge badge-success font-mono">+ {item}</span>
                        {/each}
                        {#each change.removed ?? [] as item}
                          <span class="badge badge-danger font-mono">− {item}</span>
                        {/each}
                        {#each change.reset ?? [] as item}
                          <span class="badge badge-neutral font-mono">± {item}</span>
                        {/each}
                      </div>
                    {:else}
                      <!-- Champ scalaire : ancienne valeur barrée, nouvelle en vert -->
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div class="px-3 py-2 rounded-lg bg-error/10 border border-error/20 text-xs text-error wrap-break-word">
                          <span class="block text-xs text-on-surface-variant mb-0.5">{m.audit_before()}</span>
                          {displayValue(change.before)}
                        </div>
                        <div class="px-3 py-2 rounded-lg bg-success/10 border border-success/20 text-xs text-success wrap-break-word">
                          <span class="block text-xs text-on-surface-variant mb-0.5">{m.audit_after()}</span>
                          {displayValue(change.after)}
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </article>
        {/each}
      </div>

      <div class="flex items-center justify-between">
        <span class="text-xs text-on-surface-variant">{m.audit_page_of({ page, pages: totalPages })}</span>
        <div class="flex gap-2">
          <Button size="sm" icon="ChevronLeft" disabled={page <= 1} onclick={() => changePage(-1)}>{m.audit_previous()}</Button>
          <Button size="sm" iconRight="ChevronRight" disabled={page >= totalPages} onclick={() => changePage(1)}>{m.audit_next()}</Button>
        </div>
      </div>
    {/if}
  </div>
{/if}
