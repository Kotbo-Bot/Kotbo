<script lang="ts">
  import { explainDisabled } from '../../actions/explainDisabled';
  import { onMount } from 'svelte';
  import Papicon from '../Papicon.svelte';
  import MultiSelect from '../MultiSelect.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m, dateLocale } from '../../i18n';
  import { errorMessage } from '@kotbo/shared';
  import {
    fetchGhostOverview,
    fetchGhostMembers,
    fetchGhostPruneRuns,
    updateGhostConfig,
    recomputeGhostStatuses,
    previewGhostPrune,
    executeGhostPrune,
    type GhostConfig,
    type GhostDistribution,
    type GhostMemberRow,
    type GhostPrunePreview,
    type GhostPruneRun,
    type GhostStatus,
    type ProtectionReason,
  } from '../../api';

  const { onOpenMember }: {
    /** Ouvre la fiche modération d'un membre (montée par la page parente). */
    onOpenMember?: (userId: string, name: string) => void;
  } = $props();

  const canManageSettings = $derived(!!dashboardStore.state.access?.canManageSettings);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  // ── Chargement initial ────────────────────────────────────────────────────
  let loading = $state(true);
  let error = $state('');
  let distribution = $state<GhostDistribution | null>(null);
  let config = $state<GhostConfig | null>(null);
  let runs = $state<GhostPruneRun[]>([]);

  // ── Tableau des membres ───────────────────────────────────────────────────
  let members = $state<GhostMemberRow[]>([]);
  let membersTotal = $state(0);
  let loadingMembers = $state(false);
  let statusFilter = $state<GhostStatus | ''>('');
  let search = $state('');
  let page = $state(1);
  const pageSize = 25;
  const totalPages = $derived(Math.max(1, Math.ceil(membersTotal / pageSize)));

  // ── Configuration ─────────────────────────────────────────────────────────
  let saving = $state(false);
  let form = $state({
    enabled: false,
    inactiveDays: 60,
    spectatorWindowDays: 30,
    gracePeriodDays: 30,
    maxPruneBatch: 50,
    protectStaff: true,
    protectBoosters: true,
    protectedRoleIds: [] as string[],
    pruneReason: '',
  });

  // ── Nettoyage ─────────────────────────────────────────────────────────────
  let pruneOpen = $state(false);
  let pruneStatuses = $state<GhostStatus[]>(['INACTIVE']);
  let preview = $state<GhostPrunePreview | null>(null);
  let previewing = $state(false);
  let pruning = $state(false);
  let confirmInput = $state('');
  let recomputing = $state(false);

  const confirmMatches = $derived(
    !!preview && confirmInput.trim() === String(preview.candidates.length) && preview.candidates.length > 0,
  );

  const STATUS_META: Record<GhostStatus, { label: () => string; desc: () => string; color: string; icon: string }> = {
    ACTIVE: { label: () => m.ghost_status_active(), desc: () => m.ghost_status_active_desc(), color: '#10b981', icon: 'ChatCircleDots' },
    SPECTATOR: { label: () => m.ghost_status_spectator(), desc: () => m.ghost_status_spectator_desc(), color: '#6366f1', icon: 'Eye' },
    INACTIVE: { label: () => m.ghost_status_inactive(), desc: () => m.ghost_status_inactive_desc(), color: '#f97316', icon: 'Ghost' },
    NEW: { label: () => m.ghost_status_new(), desc: () => m.ghost_status_new_desc(), color: '#a855f7', icon: 'Sparkles' },
  };

  const PROTECTION_LABELS: Record<ProtectionReason, () => string> = {
    STAFF: () => m.ghost_protection_staff(),
    BOOSTER: () => m.ghost_protection_booster(),
    PROTECTED_ROLE: () => m.ghost_protection_protected_role(),
    GRACE_PERIOD: () => m.ghost_protection_grace_period(),
    BOT: () => m.ghost_protection_bot(),
  };

  const ORDERED_STATUSES: GhostStatus[] = ['ACTIVE', 'SPECTATOR', 'INACTIVE', 'NEW'];

  function applyConfig(next: GhostConfig) {
    config = next;
    form = {
      enabled: next.enabled,
      inactiveDays: next.inactiveDays,
      spectatorWindowDays: next.spectatorWindowDays,
      gracePeriodDays: next.gracePeriodDays,
      maxPruneBatch: next.maxPruneBatch,
      protectStaff: next.protectStaff,
      protectBoosters: next.protectBoosters,
      protectedRoleIds: [...next.protectedRoleIds],
      pruneReason: next.pruneReason,
    };
  }

  async function loadOverview() {
    try {
      const result = await fetchGhostOverview();
      if (!result) return;
      distribution = result.distribution;
      applyConfig(result.config);
    } catch (e) {
      error = errorMessage(e) || m.ghost_error();
    }
  }

  async function loadMembers() {
    loadingMembers = true;
    try {
      const result = await fetchGhostMembers({
        status: statusFilter || undefined,
        search: search.trim() || undefined,
        page,
        pageSize,
      });
      if (result) {
        members = result.members;
        membersTotal = result.total;
      }
    } catch (e) {
      toast.error(errorMessage(e) || m.ghost_error());
    } finally {
      loadingMembers = false;
    }
  }

  async function loadRuns() {
    try {
      const result = await fetchGhostPruneRuns();
      if (result) runs = result.runs;
    } catch {
      // L'historique est secondaire : son échec ne doit pas bloquer la page.
    }
  }

  onMount(async () => {
    loading = true;
    await Promise.all([loadOverview(), loadMembers(), loadRuns()]);
    loading = false;
  });

  let searchTimer: ReturnType<typeof setTimeout>;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      loadMembers();
    }, 350);
  }

  function selectStatus(status: GhostStatus | '') {
    statusFilter = status;
    page = 1;
    loadMembers();
  }

  function changePage(delta: number) {
    const next = page + delta;
    if (next < 1 || next > totalPages) return;
    page = next;
    loadMembers();
  }

  async function saveConfig() {
    if (!canManageSettings || saving) return;
    saving = true;
    try {
      const result = await updateGhostConfig(form);
      if (result?.config) applyConfig(result.config);
      toast.success(m.ghost_saved());
    } catch (e) {
      toast.error(errorMessage(e) || m.ghost_error());
    } finally {
      saving = false;
    }
  }

  async function runRecompute() {
    if (!canManageSettings || recomputing) return;
    recomputing = true;
    try {
      const result = await recomputeGhostStatuses();
      const total = result
        ? Object.values(result.counts).reduce((sum, n) => sum + n, 0)
        : 0;
      toast.success(m.ghost_recompute_done({ n: total }));
      await Promise.all([loadOverview(), loadMembers()]);
    } catch (e) {
      toast.error(errorMessage(e) || m.ghost_error());
    } finally {
      recomputing = false;
    }
  }

  function openPrune() {
    pruneOpen = true;
    preview = null;
    confirmInput = '';
    pruneStatuses = ['INACTIVE'];
  }

  function togglePruneStatus(status: GhostStatus) {
    pruneStatuses = pruneStatuses.includes(status)
      ? pruneStatuses.filter((s) => s !== status)
      : [...pruneStatuses, status];
    // Toute modification de la cible invalide la prévisualisation en cours.
    preview = null;
    confirmInput = '';
  }

  async function runPreview() {
    if (previewing || pruneStatuses.length === 0) return;
    previewing = true;
    confirmInput = '';
    try {
      preview = await previewGhostPrune(pruneStatuses);
    } catch (e) {
      toast.error(errorMessage(e) || m.ghost_error());
    } finally {
      previewing = false;
    }
  }

  async function runPrune() {
    if (!preview || !confirmMatches || pruning) return;
    pruning = true;
    try {
      const result = await executeGhostPrune({
        statuses: pruneStatuses,
        userIds: preview.candidates.map((c) => c.userId),
        confirmCount: preview.candidates.length,
        reason: form.pruneReason || undefined,
      });

      if (!result) return;
      if (result.status === 'COMPLETED') toast.success(m.ghost_prune_done({ n: result.successCount }));
      else if (result.status === 'PARTIAL') toast.warning(m.ghost_prune_partial({ n: result.successCount, f: result.failureCount }));
      else toast.error(m.ghost_prune_failed());

      pruneOpen = false;
      preview = null;
      confirmInput = '';
      await Promise.all([loadOverview(), loadMembers(), loadRuns()]);
    } catch (e) {
      toast.error(errorMessage(e) || m.ghost_error());
    } finally {
      pruning = false;
    }
  }

  function formatDate(value: string | null): string {
    if (!value) return m.ghost_never();
    return new Date(value).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatVoice(seconds: number): string {
    if (seconds < 60) return '-';
    const hours = Math.floor(seconds / 3600);
    if (hours > 0) return `${hours} h`;
    return `${Math.floor(seconds / 60)} min`;
  }

  function sharePct(count: number): number {
    if (!distribution || distribution.total === 0) return 0;
    return Math.round((count / distribution.total) * 100);
  }
</script>

{#if loading}
  <div class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {#each Array(4) as _}
        <div class="h-28 rounded-2xl bg-surface-container-high/40 animate-pulse"></div>
      {/each}
    </div>
    <div class="h-64 rounded-2xl bg-surface-container-high/40 animate-pulse"></div>
  </div>
{:else if error}
  <div class="p-6 rounded-2xl bg-error/10 border border-error/20 text-red-300 flex items-center gap-3">
    <Papicon icon="Warning" size={20} />
    <span>{error}</span>
  </div>
{:else}
  <div class="space-y-6">
    <!-- En-tête -->
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-xl font-bold text-on-surface flex items-center gap-2">
          <Papicon icon="Ghost" size={22} class="text-primary" />
          {m.ghost_title()}
        </h2>
        <p class="text-sm text-on-surface-variant mt-1 max-w-2xl">{m.ghost_subtitle()}</p>
        <p class="text-xs text-on-surface-variant mt-2">
          {distribution?.lastComputedAt
            ? m.ghost_last_computed({ date: formatDate(distribution.lastComputedAt) })
            : m.ghost_never_computed()}
        </p>
      </div>

      {#if canManageSettings}
        <div class="flex items-center gap-2">
          <button
            onclick={runRecompute}
            disabled={recomputing}
            class="px-4 py-2.5 rounded-xl text-xs font-semibold bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-all disabled:opacity-50 flex items-center gap-2"
          >
            <Papicon icon={recomputing ? 'Loader' : 'Refresh'} size={14} class={recomputing ? 'animate-spin' : ''} />
            {recomputing ? m.ghost_recomputing() : m.ghost_recompute()}
          </button>
          <button
            onclick={openPrune}
            class="px-4 py-2.5 rounded-xl text-xs font-semibold bg-error/15 text-red-300 border border-error/25 hover:bg-error/25 transition-all flex items-center gap-2"
          >
            <Papicon icon="Trash" size={14} />
            {m.ghost_prune_open()}
          </button>
        </div>
      {/if}
    </div>

    <!-- Répartition -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {#each ORDERED_STATUSES as status}
        {@const meta = STATUS_META[status]}
        {@const count = distribution?.counts[status] ?? 0}
        <button
          onclick={() => selectStatus(statusFilter === status ? '' : status)}
          class="text-left p-4 rounded-2xl border transition-all duration-300 {statusFilter === status
            ? 'bg-surface-container-highest border-primary/40 shadow-lg'
            : 'bg-surface-container-high/50 border-outline-variant/10 hover:border-outline-variant/30'}"
        >
          <div class="flex items-center justify-between mb-2">
            <div class="p-2 rounded-xl" style="background: {meta.color}18">
              <Papicon icon={meta.icon} size={16} style="color: {meta.color}" />
            </div>
            <span class="text-xs font-semibold text-on-surface-variant">{sharePct(count)} %</span>
          </div>
          <div class="text-2xl font-bold text-on-surface">{count.toLocaleString(dateLocale())}</div>
          <div class="text-xs font-medium text-on-surface-variant/80 mt-0.5">{meta.label()}</div>
          <div class="text-2xs text-on-surface-variant mt-1 leading-snug">{meta.desc()}</div>
          <div class="mt-3 h-1.5 rounded-full bg-surface-container-highest overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500" style="width: {sharePct(count)}%; background: {meta.color}"></div>
          </div>
        </button>
      {/each}
    </div>

    <!-- Configuration -->
    {#if canManageSettings && config}
      <section class="p-5 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 space-y-5">
        <h3 class="text-sm font-bold text-on-surface flex items-center gap-2">
          <Papicon icon="Settings" size={16} class="text-primary" />
          {m.ghost_config_title()}
        </h3>

        <label class="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" bind:checked={form.enabled} class="w-4 h-4 rounded accent-primary" />
          <span class="text-sm text-on-surface">{m.ghost_config_enabled()}</span>
        </label>

        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {#each [
            { key: 'inactiveDays' as const, label: m.ghost_inactive_days(), help: m.ghost_inactive_days_help(), min: 7, max: 730 },
            { key: 'spectatorWindowDays' as const, label: m.ghost_spectator_window(), help: m.ghost_spectator_window_help(), min: 1, max: 365 },
            { key: 'gracePeriodDays' as const, label: m.ghost_grace_period(), help: m.ghost_grace_period_help(), min: 0, max: 365 },
            { key: 'maxPruneBatch' as const, label: m.ghost_max_batch(), help: m.ghost_max_batch_help(), min: 1, max: 500 },
          ] as field}
            <div class="space-y-1.5">
              <label for="ghost-{field.key}" class="text-xs font-semibold text-on-surface-variant">
                {field.label}
              </label>
              <input
                id="ghost-{field.key}"
                type="number"
                min={field.min}
                max={field.max}
                bind:value={form[field.key]}
                class="w-full px-3 py-2 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-sm text-on-surface focus:border-primary/50 focus:outline-none"
              />
              <p class="text-2xs text-on-surface-variant leading-snug">{field.help}</p>
            </div>
          {/each}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="space-y-3">
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" bind:checked={form.protectStaff} class="w-4 h-4 rounded accent-primary" />
              <span class="text-sm text-on-surface">{m.ghost_protect_staff()}</span>
            </label>
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" bind:checked={form.protectBoosters} class="w-4 h-4 rounded accent-primary" />
              <span class="text-sm text-on-surface">{m.ghost_protect_boosters()}</span>
            </label>
          </div>

          <div class="space-y-1.5">
            <label for="ghost-protected-roles" class="text-xs font-semibold text-on-surface-variant">
              {m.ghost_protected_roles()}
            </label>
            <MultiSelect
              id="ghost-protected-roles"
              bind:values={form.protectedRoleIds}
              options={availableRoles.map((r: any) => ({ id: r.id, name: `@${r.name}` }))}
              accentClass="bg-success/20 text-emerald-300 border-success/40"
            />
            <p class="text-2xs text-on-surface-variant">{m.ghost_protected_roles_help()}</p>
          </div>
        </div>

        <div class="space-y-1.5">
          <label for="ghost-prune-reason" class="text-xs font-semibold text-on-surface-variant">
            {m.ghost_prune_reason()}
          </label>
          <input
            id="ghost-prune-reason"
            type="text"
            maxlength="400"
            bind:value={form.pruneReason}
            class="w-full px-3 py-2 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-sm text-on-surface focus:border-primary/50 focus:outline-none"
          />
        </div>

        <div class="flex justify-end">
          <button
            onclick={saveConfig}
            disabled={saving}
            class="px-5 py-2.5 rounded-xl text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-2"
          >
            <Papicon icon={saving ? 'Loader' : 'Check'} size={14} class={saving ? 'animate-spin' : ''} />
            {saving ? m.ghost_saving() : m.ghost_save()}
          </button>
        </div>
      </section>
    {/if}

    <!-- Tableau des membres -->
    <section class="rounded-2xl bg-surface-container-high/50 border border-outline-variant/10 overflow-hidden">
      <div class="p-4 flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant/10">
        <h3 class="text-sm font-bold text-on-surface">{m.ghost_table_title()} <span class="text-on-surface-variant/40 font-normal">({membersTotal})</span></h3>
        <div class="flex items-center gap-2 flex-wrap">
          <button
            onclick={() => selectStatus('')}
            class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {statusFilter === ''
              ? 'bg-primary text-on-primary'
              : 'bg-surface-container-highest text-on-surface-variant hover:text-on-surface'}"
          >{m.ghost_filter_all()}</button>
          {#each ORDERED_STATUSES as status}
            <button
              onclick={() => selectStatus(status)}
              class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all {statusFilter === status
                ? 'text-on-primary'
                : 'bg-surface-container-highest text-on-surface-variant hover:text-on-surface'}"
              style={statusFilter === status ? `background: ${STATUS_META[status].color}` : ''}
            >{STATUS_META[status].label()}</button>
          {/each}
          <input
            type="search"
            bind:value={search}
            oninput={onSearchInput}
            placeholder={m.ghost_search_placeholder()}
            class="px-3 py-1.5 rounded-lg bg-surface-container-highest border border-outline-variant/20 text-xs text-on-surface w-48 focus:border-primary/50 focus:outline-none"
          />
        </div>
      </div>

      {#if loadingMembers}
        <div class="p-4 space-y-2">
          {#each Array(5) as _}
            <div class="h-12 rounded-xl bg-surface-container-highest/50 animate-pulse"></div>
          {/each}
        </div>
      {:else if members.length === 0}
        <div class="p-10 text-center text-sm text-on-surface-variant">{m.ghost_no_members()}</div>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-on-surface-variant border-b border-outline-variant/10">
                <th class="text-left font-bold px-4 py-3">{m.ghost_table_member()}</th>
                <th class="text-left font-bold px-4 py-3">{m.ghost_table_status()}</th>
                <th class="text-left font-bold px-4 py-3 whitespace-nowrap">{m.ghost_table_last_message()}</th>
                <th class="text-left font-bold px-4 py-3 whitespace-nowrap">{m.ghost_table_last_silent()}</th>
                <th class="text-right font-bold px-4 py-3">{m.ghost_table_messages()}</th>
                <th class="text-right font-bold px-4 py-3">{m.ghost_table_voice()}</th>
                <th class="text-left font-bold px-4 py-3">{m.ghost_table_protections()}</th>
              </tr>
            </thead>
            <tbody>
              {#each members as member (member.userId)}
                <tr class="border-b border-outline-variant/5 hover:bg-surface-container-highest/40 transition-colors">
                  <td class="px-4 py-3">
                    <button
                      type="button"
                      onclick={() => onOpenMember?.(member.userId, member.displayName || member.username)}
                      class="flex w-full items-center gap-2.5 min-w-0 text-left group/member"
                    >
                      {#if member.avatarUrl}
                        <img src={member.avatarUrl} alt="" class="w-7 h-7 rounded-full shrink-0" loading="lazy" />
                      {:else}
                        <div class="w-7 h-7 rounded-full bg-surface-container-highest shrink-0"></div>
                      {/if}
                      <div class="min-w-0">
                        <div class="font-medium text-on-surface truncate group-hover/member:text-primary transition-colors">{member.displayName || member.username}</div>
                        <div class="text-2xs text-on-surface-variant/40 truncate">{member.userId}</div>
                      </div>
                    </button>
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="px-2 py-1 rounded-md text-2xs font-semibold whitespace-nowrap"
                      style="background: {STATUS_META[member.status].color}18; color: {STATUS_META[member.status].color}"
                    >{STATUS_META[member.status].label()}</span>
                  </td>
                  <td class="px-4 py-3 text-on-surface-variant whitespace-nowrap">{formatDate(member.lastMessageAt)}</td>
                  <td class="px-4 py-3 text-on-surface-variant whitespace-nowrap">{formatDate(member.lastSilentActivityAt)}</td>
                  <td class="px-4 py-3 text-right text-on-surface-variant">{member.messageCount.toLocaleString(dateLocale())}</td>
                  <td class="px-4 py-3 text-right text-on-surface-variant">{formatVoice(member.voiceTimeSeconds)}</td>
                  <td class="px-4 py-3">
                    <div class="flex flex-wrap gap-1">
                      {#each member.protections as protection}
                        <span class="px-1.5 py-0.5 rounded text-2xs font-medium bg-success/15 text-emerald-300 whitespace-nowrap">
                          {PROTECTION_LABELS[protection]()}
                        </span>
                      {/each}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="p-4 flex items-center justify-between border-t border-outline-variant/10">
          <span class="text-xs text-on-surface-variant">{m.ghost_page_of({ page, pages: totalPages })}</span>
          <div class="flex gap-2">
            <button
              onclick={() => changePage(-1)}
              disabled={page <= 1}
              class="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-container-highest text-on-surface-variant hover:text-on-surface disabled:opacity-30 transition-all"
            >{m.ghost_previous()}</button>
            <button
              onclick={() => changePage(1)}
              disabled={page >= totalPages}
              class="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-container-highest text-on-surface-variant hover:text-on-surface disabled:opacity-30 transition-all"
            >{m.ghost_next()}</button>
          </div>
        </div>
      {/if}
    </section>

    <!-- Historique -->
    <section class="p-5 rounded-2xl bg-surface-container-high/50 border border-outline-variant/10">
      <h3 class="text-sm font-bold text-on-surface mb-3 flex items-center gap-2">
        <Papicon icon="History" size={16} class="text-primary" />
        {m.ghost_history_title()}
      </h3>
      {#if runs.length === 0}
        <p class="text-xs text-on-surface-variant">{m.ghost_history_empty()}</p>
      {:else}
        <ul class="space-y-2">
          {#each runs as run (run.id)}
            <li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-surface-container-highest/50 text-xs">
              <div class="flex items-center gap-2 min-w-0">
                <span
                  class="px-2 py-0.5 rounded font-semibold whitespace-nowrap {run.status === 'COMPLETED'
                    ? 'bg-success/15 text-emerald-300'
                    : run.status === 'PARTIAL'
                      ? 'bg-warning/15 text-amber-300'
                      : 'bg-error/15 text-red-300'}"
                >{run.status}</span>
                <span class="text-on-surface truncate">{m.ghost_history_entry({ n: run.successCount, t: run.totalTargeted })}</span>
              </div>
              <span class="text-on-surface-variant whitespace-nowrap">{run.executedByName} · {formatDate(run.startedAt)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <!-- Modale de nettoyage en deux étapes -->
  {#if pruneOpen}
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div class="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-surface-container border border-outline-variant/20 shadow-2xl">
        <div class="p-5 border-b border-outline-variant/10 flex items-center justify-between">
          <h3 class="text-base font-bold text-on-surface flex items-center gap-2">
            <Papicon icon="Trash" size={18} class="text-error" />
            {m.ghost_prune_title()}
          </h3>
          <button onclick={() => (pruneOpen = false)} class="p-1.5 rounded-lg hover:bg-surface-container-high text-on-surface-variant">
            <Papicon icon="X" size={16} />
          </button>
        </div>

        <div class="p-5 space-y-5">
          <!-- Étape 1 : cible + prévisualisation -->
          <div class="space-y-2">
            <span class="text-xs font-semibold text-on-surface-variant">{m.ghost_prune_target()}</span>
            <div class="flex gap-2">
              {#each ['INACTIVE', 'SPECTATOR'] as const as status}
                <button
                  onclick={() => togglePruneStatus(status)}
                  class="px-3 py-2 rounded-xl text-xs font-medium border transition-all {pruneStatuses.includes(status)
                    ? 'border-transparent text-on-primary'
                    : 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant'}"
                  style={pruneStatuses.includes(status) ? `background: ${STATUS_META[status].color}` : ''}
                >{STATUS_META[status].label()}</button>
              {/each}
            </div>
          </div>

          <button
            onclick={runPreview}
            disabled={previewing}
            use:explainDisabled={(pruneStatuses.length === 0) ? m.common_reason_select_one() : ''}
            class="w-full px-4 py-2.5 rounded-xl text-xs font-semibold bg-surface-container-high text-on-surface hover:bg-surface-container-highest transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Papicon icon={previewing ? 'Loader' : 'Search'} size={14} class={previewing ? 'animate-spin' : ''} />
            {previewing ? m.ghost_prune_previewing() : m.ghost_prune_preview()}
          </button>

          {#if preview}
            <div class="space-y-3">
              <div class="px-4 py-3 rounded-xl bg-surface-container-high border border-outline-variant/10 text-xs text-on-surface">
                {m.ghost_prune_summary({ n: preview.candidates.length, p: preview.protectedCount })}
                {#if preview.truncated}
                  <p class="mt-1 text-amber-300">{m.ghost_prune_truncated()}</p>
                {/if}
              </div>

              {#if preview.candidates.length === 0}
                <p class="px-4 py-3 rounded-xl bg-success/10 border border-success/20 text-emerald-300 text-xs">
                  {m.ghost_prune_empty()}
                </p>
              {:else}
                <div class="max-h-48 overflow-y-auto rounded-xl border border-outline-variant/10 divide-y divide-outline-variant/5">
                  {#each preview.candidates as candidate (candidate.userId)}
                    <div class="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <span class="text-on-surface truncate">{candidate.displayName || candidate.username}</span>
                      <span class="text-on-surface-variant/40 whitespace-nowrap">{formatDate(candidate.lastAnyActivityAt)}</span>
                    </div>
                  {/each}
                </div>

                <!-- Étape 2 : confirmation chiffrée -->
                <div class="space-y-2">
                  <label for="ghost-confirm" class="block text-xs text-on-surface-variant/80">
                    {m.ghost_prune_confirm_label()}
                    <strong class="text-on-surface"> {preview.candidates.length}</strong>
                  </label>
                  <input
                    id="ghost-confirm"
                    type="text"
                    inputmode="numeric"
                    bind:value={confirmInput}
                    class="w-full px-3 py-2 rounded-xl bg-surface-container-highest border text-sm text-on-surface focus:outline-none {confirmInput && !confirmMatches
                      ? 'border-error/50'
                      : 'border-outline-variant/20 focus:border-primary/50'}"
                  />
                  {#if confirmInput && !confirmMatches}
                    <p class="text-2xs text-error">{m.ghost_prune_confirm_mismatch()}</p>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <div class="p-5 border-t border-outline-variant/10 flex justify-end gap-2">
          <button
            onclick={() => (pruneOpen = false)}
            class="px-4 py-2.5 rounded-xl text-xs font-semibold bg-surface-container-high text-on-surface-variant/80 hover:text-on-surface transition-all"
          >{m.ghost_prune_cancel()}</button>
          <button
            onclick={runPrune}
            disabled={pruning}
            use:explainDisabled={(!confirmMatches) ? m.common_reason_confirm() : ''}
            class="px-4 py-2.5 rounded-xl text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Papicon icon={pruning ? 'Loader' : 'Trash'} size={14} class={pruning ? 'animate-spin' : ''} />
            {pruning ? m.ghost_prune_executing() : m.ghost_prune_execute({ n: preview?.candidates.length ?? 0 })}
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}
