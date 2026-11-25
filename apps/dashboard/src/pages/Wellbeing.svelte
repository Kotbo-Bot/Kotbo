<script lang="ts">
  import { dateLocale, m } from '../lib/i18n';
  import { onMount } from 'svelte';
  import { dashboardFetch } from '../lib/api';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import MemberSearchSelect from '../lib/components/MemberSearchSelect.svelte';
  import { WB_ALERT_EVENTS, wbCaseEventLabel, WB_CATEGORIES, WB_SEVERITIES, WB_STATUSES, wbAlertEventLabel, wbCategoryLabel, wbSeverityLabel, wbStatusLabel } from '../lib/wellbeingLabels';
  import MemberName from '../lib/components/MemberName.svelte';
  import WellbeingMemberList from '../lib/components/WellbeingMemberList.svelte';
  import { channelDisplayName } from '../lib/channelUtils';
  import { Button, Callout, EmptyState, Field, FilterPills, Menu, Modal, SettingsGroup, SettingsRow, StatTile, Tabs, ToggleSwitch, type FilterOption, type MenuItem, type TabItem } from '../lib/components/ui';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { wbCaseStats, wbCaseTimeline, wbFilterCases, wbIsReviewDue, wbSeverityAccent, wbSeverityTone, wbStatusTone, type WbCaseFilter } from '../lib/wellbeingView';
  import { authStore } from '../lib/stores/auth.svelte';

  type WellbeingStatus = {
    enabled: boolean;
    requireReason: boolean;
    isTeamMember: boolean;
    isDirector: boolean;
    /** Propriétaire du serveur : seul à modifier la composition de la cellule. */
    canConfigure: boolean;
    hasCaseAccess: boolean;
    /** Sous accès d'urgence, la direction lit sans écrire. */
    canWriteCases: boolean;
    breakGlassExpiresAt: string | null;
    /** Accès d'urgence soumis à la validation d'une seconde personne. */
    breakGlassApproval: boolean;
    reportEnabled: boolean;
  };

  type Resource = { label: string; phone: string | null; url: string | null; description: string | null };

  let loading = $state(true);
  let status = $state<WellbeingStatus | null>(null);
  let cases = $state<any[]>([]);
  let logs = $state<any[]>([]);
  let selectedCaseId = $state<string | null>(null);

  const selectedCase = $derived(cases.find((c) => c.id === selectedCaseId) ?? null);

  type Tab = 'cases' | 'resources' | 'access' | 'settings';
  let activeTab = $state<Tab>('cases');
  let caseFilter = $state<WbCaseFilter>('active');
  const now = new Date();
  const stats = $derived(wbCaseStats(cases, now));
  const visibleCases = $derived(wbFilterCases(cases, caseFilter));
  const timeline = $derived(selectedCase ? wbCaseTimeline(selectedCase) : []);
  const filterOptions = $derived<FilterOption<WbCaseFilter>[]>([
    { value: 'active', label: m.wb_filter_active(), count: stats.active },
    { value: 'closed', label: m.wb_filter_closed(), count: stats.closed },
    { value: 'all', label: m.wb_filter_all(), count: cases.length },
  ]);

  const discordRoles = $derived((dashboardStore.state.discordRoles ?? []) as Array<{ id: string; name: string }>);

  const roleOptions = $derived(discordRoles.map((r) => ({ id: r.id, name: `@${r.name}` })));

  // Break-glass modal
  let breakGlassOpen = $state(false);
  let breakGlassReason = $state('');
  let breakGlassSubjectUserId = $state('');
  let decidingLogId = $state<string | null>(null);
  const pendingLogs = $derived(logs.filter((log) => log.status === 'PENDING' && new Date(log.expiresAt) > new Date()));
  const LOG_STATUS: Record<string, () => string> = {
    PENDING: () => m.wb_log_status_PENDING(),
    APPROVED: () => m.wb_log_status_APPROVED(),
    REJECTED: () => m.wb_log_status_REJECTED(),
  };
  const LOG_TONES: Record<string, string> = {
    PENDING: 'bg-warning/10 text-on-warning-container border border-warning/20',
    APPROVED: 'bg-success/10 text-on-success-container border border-success/20',
    REJECTED: 'bg-error/10 text-on-error-container border border-error/20',
  };

  // Ressources d'aide (cellule)
  let resources = $state<Resource[]>([]);
  let savingResources = $state(false);
  let sendingResources = $state(false);
  let assigneeCandidate = $state('');

  // Documents Google Drive du dossier ouvert
  let newAttachmentLabel = $state('');
  let newAttachmentUrl = $state('');
  let addingAttachment = $state(false);
  let removingAttachmentId = $state<string | null>(null);
  /** Même plafond que le bot (MAX_CASE_ATTACHMENTS). */
  const MAX_CASE_ATTACHMENTS = 20;
  /** Un lien illisible (clé changée) ne devient jamais un href. */
  const isDriveLink = (url: string) => /^https:\/\/(drive|docs)\.google\.com\//.test(url);
  let breakGlassSubmitting = $state(false);

  // New case modal
  let newCaseOpen = $state(false);
  // Membre choisi : lie le dossier à sa fiche. Le nom reste modifiable, ou libre hors serveur.
  let newSubjectUserId = $state('');
  let newSubjectName = $state('');
  let newTitle = $state('');
  let newCategory = $state('SOUTIEN');
  let newSeverity = $state('NORMAL');
  let newSummary = $state('');
  let newAssigneeId = $state('');
  let newReviewAt = $state('');
  let creatingCase = $state(false);

  // Note on selected case
  let newNote = $state('');
  let addingNote = $state(false);

  // Onglet Réglages (propriétaire) : lu à la première ouverture.
  let configLoaded = $state(false);
  let cfgEnabled = $state(false);
  let cfgRequireReason = $state(true);
  let cfgTeamRoleIds = $state<string[]>([]);
  let cfgDirectorRoleIds = $state<string[]>([]);
  let cfgTeamUserIds = $state<string[]>([]);
  let cfgDirectorUserIds = $state<string[]>([]);
  /** Membres désignés un par un, par liste. */
  const MAX_NAMED_MEMBERS = 25;
  let cfgAlertChannelId = $state('');
  let cfgAlertUserIds = $state<string[]>([]);
  let cfgAlertEvents = $state<string[]>([]);
  let cfgBreakGlassApproval = $state(false);
  let cfgReportEnabled = $state(false);
  let cfgStaleDays = $state(7);
  /** Même plafond que le bot (MAX_ALERT_USERS). */
  const MAX_ALERT_USERS = 10;

  const alertChannels = $derived(
    ((dashboardStore.state.discordChannels ?? []) as Array<{ id: string; name: string; type?: string }>)
      .filter((c) => c.type === undefined || c.type === 'text' || c.type === 'announcement'),
  );


  function toggleAlertEvent(code: string, checked: boolean) {
    cfgAlertEvents = checked ? [...new Set([...cfgAlertEvents, code])] : cfgAlertEvents.filter((e) => e !== code);
  }
  let savingConfig = $state(false);

  const tabItems = $derived.by<TabItem[]>(() => {
    if (!status) return [];
    const on = status.enabled;
    return [
      { id: 'cases', label: m.wb_tab_cases(), icon: 'folder', badge: on && status.hasCaseAccess ? stats.active || undefined : undefined },
      ...(on && status.isTeamMember ? [{ id: 'resources', label: m.wb_tab_resources(), icon: 'heart', badge: resources.length || undefined }] : []),
      ...(on && (status.isDirector || status.isTeamMember) ? [{ id: 'access', label: m.wb_tab_access(), icon: 'eye', badge: pendingLogs.length || undefined }] : []),
      ...(status.canConfigure ? [{ id: 'settings', label: m.wb_tab_settings(), icon: 'settings' }] : []),
    ];
  });

  // Un onglet retiré (droits changés, module éteint) ramène aux dossiers.
  $effect(() => {
    if (tabItems.length > 0 && !tabItems.some((tab) => tab.id === activeTab)) activeTab = 'cases';
  });

  $effect(() => {
    if (activeTab === 'settings' && !configLoaded) void loadConfig();
  });

  async function loadAll() {
    loading = true;
    try {
      const stRes = await dashboardFetch('/wellbeing/status');
      // Module hors offre ou éteint : l'encadré de ModulePage l'explique déjà.
      if (stRes.status === 403) {
        status = null;
        return;
      }
      if (!stRes.ok) throw new Error('status');
      status = await stRes.json();

      if (status?.hasCaseAccess) {
        const casesRes = await dashboardFetch('/wellbeing/cases');
        if (casesRes.ok) {
          const data = await casesRes.json();
          cases = data.cases ?? [];
          if (!selectedCaseId && cases.length > 0) selectedCaseId = (wbFilterCases(cases, 'active')[0] ?? cases[0]).id;
        }
      } else {
        cases = [];
      }

      if (status?.isTeamMember) {
        const resRes = await dashboardFetch('/wellbeing/resources');
        if (resRes.ok) resources = (await resRes.json()).resources ?? [];
      }

      if (status?.isDirector || status?.isTeamMember) {
        const logsRes = await dashboardFetch('/wellbeing/break-glass-logs');
        if (logsRes.ok) {
          logs = (await logsRes.json()).logs ?? [];
        }
      }
    } catch {
      toast.error(m.toast_wb_load_failed());
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadAll();
  });

  async function loadConfig() {
    try {
      const res = await dashboardFetch('/wellbeing/config');
      if (!res.ok) throw new Error('config');
      const { config } = await res.json();
      cfgEnabled = config.enabled === true;
      cfgRequireReason = config.requireReason !== false;
      cfgTeamRoleIds = [...(config.teamRoleIds ?? [])];
      cfgDirectorRoleIds = [...(config.directorRoleIds ?? [])];
      cfgTeamUserIds = [...(config.teamUserIds ?? [])];
      cfgDirectorUserIds = [...(config.directorUserIds ?? [])];
      cfgAlertChannelId = config.alertChannelId ?? '';
      cfgAlertUserIds = [...(config.alertUserIds ?? [])];
      cfgAlertEvents = [...(config.alertEvents ?? [])];
      cfgBreakGlassApproval = config.breakGlassApproval === true;
      cfgReportEnabled = config.reportEnabled === true;
      cfgStaleDays = typeof config.staleCriticalDays === 'number' ? config.staleCriticalDays : 7;
      configLoaded = true;
    } catch {
      toast.error(m.toast_wb_management_only());
    }
  }

  async function saveConfig(event: SubmitEvent) {
    event.preventDefault();
    savingConfig = true;
    try {
      const res = await dashboardFetch('/wellbeing/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: cfgEnabled,
          requireReason: cfgRequireReason,
          teamRoleIds: cfgTeamRoleIds,
          directorRoleIds: cfgDirectorRoleIds,
          teamUserIds: cfgTeamUserIds,
          directorUserIds: cfgDirectorUserIds,
          alertChannelId: cfgAlertChannelId || null,
          alertUserIds: cfgAlertUserIds,
          alertEvents: cfgAlertEvents,
          breakGlassApproval: cfgBreakGlassApproval,
          reportEnabled: cfgReportEnabled,
          staleCriticalDays: Math.max(0, Math.min(90, Math.round(Number(cfgStaleDays) || 0))),
        }),
      });
      if (!res.ok) throw new Error('save');
      toast.success(m.toast_wb_config_saved());
      await loadAll();
    } catch {
      toast.error(m.toast_wb_save_failed());
    } finally {
      savingConfig = false;
    }
  }

  async function activateBreakGlass(event: SubmitEvent) {
    event.preventDefault();
    if (breakGlassSubmitting) return;
    breakGlassSubmitting = true;
    try {
      const res = await dashboardFetch('/wellbeing/break-glass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: breakGlassReason.trim(), subjectUserId: breakGlassSubjectUserId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '');
      breakGlassOpen = false;
      breakGlassReason = '';
      breakGlassSubjectUserId = '';
      toast.success(data.pending ? m.toast_wb_break_glass_pending() : m.toast_wb_break_glass_on());
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_break_glass_failed());
    } finally {
      breakGlassSubmitting = false;
    }
  }

  /** Seconde clé : valider ou refuser la demande d'une autre personne. */
  async function decideBreakGlass(logId: string, approve: boolean) {
    if (decidingLogId) return;
    decidingLogId = logId;
    try {
      const res = await dashboardFetch(`/wellbeing/break-glass/${logId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      toast.success(m.toast_wb_decided());
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_decide_failed());
    } finally {
      decidingLogId = null;
    }
  }

  async function createCase(event: SubmitEvent) {
    event.preventDefault();
    if (creatingCase) return;
    creatingCase = true;
    try {
      const res = await dashboardFetch('/wellbeing/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectUserId: newSubjectUserId || undefined,
          subjectName: newSubjectName.trim(),
          title: newTitle.trim(),
          category: newCategory,
          severity: newSeverity,
          summary: newSummary.trim(),
          assigneeId: newAssigneeId || undefined,
          reviewAt: newReviewAt || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '');
      cases = [data.item, ...cases];
      selectedCaseId = data.item.id;
      newCaseOpen = false;
      newSubjectUserId = '';
      newSubjectName = '';
      newTitle = '';
      newSummary = '';
      newAssigneeId = '';
      newReviewAt = '';
      toast.success(m.toast_wb_file_created());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_create_failed());
    } finally {
      creatingCase = false;
    }
  }

  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());
  const formatDay = (iso: string) => new Date(iso).toLocaleDateString(dateLocale());

  let updatingCase = $state(false);

  /** Statut ou gravité du dossier ouvert. Fermer un dossier le rend purgeable après un an. */
  async function updateCase(patch: { status?: string; severity?: string; assigneeId?: string | null; reviewAt?: string | null }) {
    const target = selectedCase;
    if (!target || updatingCase) return;
    updatingCase = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      const { item } = data;
      cases = cases.map((c) => (c.id === item.id ? item : c));
      toast.success(m.toast_wb_case_updated());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      updatingCase = false;
    }
  }

  /** Fermer rend le dossier purgeable après un an : on le confirme. */
  async function pickStatus(code: string) {
    if (!selectedCase || code === selectedCase.status) return;
    if (code === 'CLOSED' && !(await confirmDialog.ask({ title: m.wb_close_case_q(), description: m.wb_cases_retention(), confirmLabel: m.wb_close_case_confirm() }))) return;
    void updateCase({ status: code });
  }

  function pickSeverity(code: string) {
    if (selectedCase && code !== selectedCase.severity) void updateCase({ severity: code });
  }

  const caseMenu = $derived<MenuItem[]>(selectedCase && status?.canWriteCases ? [
    { label: m.wb_delete_case(), description: m.wb_delete_case_warn(), icon: 'Trash', onselect: () => void deleteCase() },
  ] : []);

  let deletingCase = $state(false);

  async function deleteCase() {
    const target = selectedCase;
    if (!target || deletingCase) return;
    if (!(await confirmDialog.danger(m.wb_delete_case_q(), m.wb_delete_case_warn()))) return;
    deletingCase = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete');
      cases = cases.filter((c) => c.id !== target.id);
      selectedCaseId = null;
      toast.success(m.toast_wb_case_deleted());
    } catch {
      toast.error(m.toast_wb_delete_failed());
    } finally {
      deletingCase = false;
    }
  }

  /** Relit un dossier après un geste qui ajoute une entrée d'historique. */
  async function refreshCase(caseId: string) {
    const res = await dashboardFetch('/wellbeing/cases');
    if (!res.ok) return;
    const fresh = ((await res.json()).cases ?? []).find((c: any) => c.id === caseId);
    if (fresh) cases = cases.map((c) => (c.id === caseId ? fresh : c));
  }

  async function sendResources() {
    const target = selectedCase;
    if (!target || sendingResources) return;
    sendingResources = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}/send-resources`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      toast.success(m.toast_wb_resources_sent());
      await refreshCase(target.id);
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_resources_send_failed());
    } finally {
      sendingResources = false;
    }
  }

  async function addAttachment(event: SubmitEvent) {
    event.preventDefault();
    const target = selectedCase;
    if (!target || addingAttachment) return;
    addingAttachment = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newAttachmentLabel.trim(), url: newAttachmentUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      cases = cases.map((c) => (c.id === data.item.id ? data.item : c));
      newAttachmentLabel = '';
      newAttachmentUrl = '';
      toast.success(m.toast_wb_attachment_added());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_attachment_failed());
    } finally {
      addingAttachment = false;
    }
  }

  async function removeAttachment(attachmentId: string) {
    const target = selectedCase;
    if (!target || removingAttachmentId) return;
    if (!(await confirmDialog.danger(m.wb_attachment_remove_q(), m.wb_attachment_remove_warn()))) return;
    removingAttachmentId = attachmentId;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}/attachments/${attachmentId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      cases = cases.map((c) => (c.id === data.item.id ? data.item : c));
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_attachment_failed());
    } finally {
      removingAttachmentId = null;
    }
  }

  async function saveResources() {
    if (savingResources) return;
    savingResources = true;
    try {
      const res = await dashboardFetch('/wellbeing/resources', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resources }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      resources = data.resources ?? [];
      toast.success(m.toast_wb_resources_saved());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_resources_save_failed());
    } finally {
      savingResources = false;
    }
  }

  async function addNote(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedCase || !newNote.trim() || addingNote) return;
    addingNote = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${selectedCase.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newNote.trim() }),
      });
      if (!res.ok) throw new Error('note');
      const { note } = await res.json();
      cases = cases.map((c) => (c.id === selectedCase.id ? { ...c, notes: [...(c.notes ?? []), note] } : c));
      newNote = '';
      await refreshCase(selectedCase.id);
    } catch {
      toast.error(m.toast_wb_note_failed());
    } finally {
      addingNote = false;
    }
  }
</script>

{#snippet pill(text: string, tone: string)}
  <span class="text-2xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap {tone}">{text}</span>
{/snippet}

<!-- Choix exclusif en boutons : un clic, un changement visible, au lieu d'un menu déroulant qui enregistre en silence. -->
{#snippet choiceGroup(label: string, codes: readonly string[], value: string, text: (code: string) => string, tone: (code: string) => string, onpick: (code: string) => void)}
  <div class="space-y-1.5">
    <p class="text-xs font-semibold text-on-surface-variant">{label}</p>
    <div role="group" aria-label={label} class="flex flex-wrap gap-1.5">
      {#each codes as code (code)}
        {@const selected = code === value}
        <button
          type="button"
          aria-pressed={selected}
          disabled={updatingCase || !status?.canWriteCases}
          onclick={() => onpick(code)}
          class="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed {selected ? tone(code) : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40 disabled:opacity-60'}"
        >
          {#if selected}<Papicon icon="Check" size={12} class="inline -mt-0.5 mr-1" />{/if}{text(code)}
        </button>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet pendingRequests()}
  {#each pendingLogs as log (log.id)}
    <Callout variant="warning" title={m.wb_pending_by({ name: log.actorName })}>
      <p>{log.reason}</p>
      {#if log.subjectUserId}
        <p class="flex items-center gap-1 mt-1">{m.wb_pending_scope()} <MemberName userId={log.subjectUserId} /></p>
      {/if}
      {#if log.actorId === authStore.user?.id}
        <p class="mt-2 text-xs">{m.wb_pending_own()}</p>
      {:else}
        <div class="flex gap-2 mt-3">
          <Button size="sm" variant="primary" icon="Check" loading={decidingLogId === log.id} onclick={() => void decideBreakGlass(log.id, true)}>{m.wb_pending_approve()}</Button>
          <Button size="sm" variant="ghost" icon="X" disabled={decidingLogId === log.id} onclick={() => void decideBreakGlass(log.id, false)}>{m.wb_pending_reject()}</Button>
        </div>
      {/if}
    </Callout>
  {/each}
{/snippet}

{#snippet caseList()}
  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-4 space-y-3 lg:sticky lg:top-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="folder" size={16} /> {m.wb_cases_title()}</h3>
    </div>
    <FilterPills label={m.wb_filter_label()} options={filterOptions} value={caseFilter} onchange={(value) => (caseFilter = value)} />
    {#if cases.length === 0}
      <EmptyState icon="folder" title={m.wb_cases_empty()} reason="accumulating" />
    {:else if visibleCases.length === 0}
      <p class="text-sm text-on-surface-variant py-6 text-center">{m.wb_cases_filtered_empty()}</p>
    {:else}
      <ul class="space-y-1.5 max-h-[70vh] overflow-y-auto pr-1">
        {#each visibleCases as c (c.id)}
          {@const selected = selectedCaseId === c.id}
          <li>
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onclick={() => (selectedCaseId = c.id)}
              class="w-full text-left rounded-lg border-l-4 {wbSeverityAccent(c.severity)} px-3 py-2.5 transition-colors {selected ? 'bg-primary/10 ring-1 ring-primary/30' : 'bg-surface-container-high/20 hover:bg-surface-container-high/40'}"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="text-sm font-semibold text-on-surface line-clamp-2">{c.title}</span>
                {@render pill(wbStatusLabel(c.status), wbStatusTone(c.status))}
              </div>
              <p class="text-xs text-on-surface-variant mt-1 truncate">{c.subjectName} · {wbCategoryLabel(c.category)}</p>
              <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
                {@render pill(wbSeverityLabel(c.severity), wbSeverityTone(c.severity))}
                {#if wbIsReviewDue(c, now)}
                  <span class="text-2xs font-semibold flex items-center gap-1 text-on-warning-container"><Papicon icon="Clock" size={11} /> {m.wb_review_due_badge()}</span>
                {/if}
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="text-2xs text-on-surface-variant">{m.wb_cases_retention()}</p>
  </section>
{/snippet}

{#snippet caseDetail()}
  {#if !selectedCase}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6">
      <EmptyState icon="file-text" title={m.wb_case_select()} reason="nothing-matches" />
    </section>
  {:else}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-5">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold text-on-surface">{selectedCase.title}</h2>
            {@render pill(wbStatusLabel(selectedCase.status), wbStatusTone(selectedCase.status))}
            {@render pill(wbSeverityLabel(selectedCase.severity), wbSeverityTone(selectedCase.severity))}
          </div>
          <p class="text-xs text-on-surface-variant flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="flex items-center gap-1"><Papicon icon="User" size={12} /> {selectedCase.subjectName}</span>
            <span class="flex items-center gap-1"><Papicon icon="Tag" size={12} /> {wbCategoryLabel(selectedCase.category)}</span>
            <span class="flex items-center gap-1"><Papicon icon="Calendar" size={12} /> {formatDay(selectedCase.createdAt)}</span>
          </p>
        </div>
        {#if status?.canWriteCases}
          <div class="flex flex-wrap items-center gap-2">
            {#if selectedCase.subjectUserId && resources.length > 0}
              <Button size="sm" variant="secondary" icon="heart" loading={sendingResources} onclick={() => void sendResources()}>{m.wb_send_resources()}</Button>
            {/if}
            <Menu items={caseMenu} label={m.wb_case_actions({ name: selectedCase.title })} />
          </div>
        {/if}
      </header>

      {#if !status?.canWriteCases}
        <Callout variant="info">{m.wb_read_only_emergency()}</Callout>
      {/if}

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {@render choiceGroup(m.wb_status_label(), WB_STATUSES, selectedCase.status, wbStatusLabel, wbStatusTone, (code) => void pickStatus(code))}
        {@render choiceGroup(m.wb_severity_label(), WB_SEVERITIES, selectedCase.severity, wbSeverityLabel, wbSeverityTone, pickSeverity)}
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-xl bg-surface-container-high/20 p-4">
        <Field label={m.wb_assignee()} hint={m.wb_assignee_hint()}>
          {#snippet children(id, describedBy)}
            {#if selectedCase?.assigneeId}
              <div class="flex items-center justify-between gap-2 text-sm min-h-9">
                <MemberName userId={selectedCase.assigneeId} />
                {#if status?.canWriteCases}
                  <Button size="sm" variant="ghost" icon="X" disabled={updatingCase} aria-label={m.wb_assignee_clear()} onclick={() => void updateCase({ assigneeId: null })} />
                {/if}
              </div>
            {:else if status?.canWriteCases}
              <MemberSearchSelect {id} {describedBy} bind:value={assigneeCandidate} placeholder={m.wb_member_ph()}
                onselect={(member) => { assigneeCandidate = ''; void updateCase({ assigneeId: member.id }); }} />
            {:else}
              <p class="text-sm text-on-surface-variant min-h-9 flex items-center">{m.wb_assignee_none()}</p>
            {/if}
          {/snippet}
        </Field>
        <Field label={m.wb_review_at()} hint={m.wb_review_hint()}>
          {#snippet children(id, describedBy)}
            <div class="flex items-center gap-2">
              <input {id} aria-describedby={describedBy} type="date" class="input w-full" disabled={updatingCase || !status?.canWriteCases}
                value={selectedCase?.reviewAt ? selectedCase.reviewAt.slice(0, 10) : ''}
                onchange={(e) => void updateCase({ reviewAt: e.currentTarget.value || null })} />
              {#if selectedCase?.reviewAt && status?.canWriteCases}
                <Button size="sm" variant="ghost" icon="X" disabled={updatingCase} aria-label={m.wb_review_clear()} onclick={() => void updateCase({ reviewAt: null })} />
              {/if}
            </div>
          {/snippet}
        </Field>
      </div>

      <div class="space-y-1.5">
        <h3 class="text-xs font-semibold text-on-surface-variant">{m.wb_summary()}</h3>
        <p class="text-sm whitespace-pre-wrap text-on-surface bg-surface-container-lowest rounded-lg p-3 border border-outline-variant/40">{selectedCase.summary}</p>
      </div>

      <div class="space-y-3">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Clock" size={15} /> {m.wb_timeline_title()}</h3>
        {#if status?.canWriteCases}
          <form onsubmit={addNote} class="space-y-2">
            <textarea bind:value={newNote} aria-label={m.a11y_wellbeing_note()} required rows={2} placeholder={m.wb_note_ph()} class="input w-full text-sm"></textarea>
            <div class="flex justify-end">
              <Button type="submit" size="sm" variant="primary" icon="Plus" loading={addingNote} disabled={!newNote.trim()}>{m.wb_note_add()}</Button>
            </div>
          </form>
        {/if}
        {#if timeline.length === 0}
          <p class="text-xs text-on-surface-variant">{m.wb_timeline_empty()}</p>
        {:else}
          <ol class="relative border-l border-outline-variant/50 ml-2 space-y-3">
            {#each timeline as entry (entry.id)}
              <li class="ml-4">
                <span class="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full {entry.kind === 'note' ? 'bg-primary' : 'bg-outline-variant'}" aria-hidden="true"></span>
                {#if entry.kind === 'note'}
                  <div class="rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-3 text-sm">
                    <div class="flex flex-wrap justify-between gap-2 text-xs text-on-surface-variant mb-1">
                      <span class="font-semibold text-on-surface">{entry.note.authorName}</span>
                      <span>{formatDate(entry.at)}</span>
                    </div>
                    <p class="whitespace-pre-wrap text-on-surface">{entry.note.content}</p>
                  </div>
                {:else}
                  <p class="flex flex-wrap items-center gap-x-2 text-xs text-on-surface-variant">
                    <span class="font-medium text-on-surface">{entry.event.actorName}</span>
                    <span>{wbCaseEventLabel(entry.event, formatDay)}</span>
                    {#if entry.event.type === 'ASSIGNEE' && entry.event.toValue}<MemberName userId={entry.event.toValue} />{/if}
                    <span class="opacity-70">· {formatDate(entry.at)}</span>
                  </p>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <div class="space-y-2 border-t border-outline-variant/30 pt-4">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Papicon icon="Paperclip" size={15} /> {m.wb_attachments_title()}</h3>
        <p class="text-xs text-on-surface-variant">{m.wb_attachments_desc()}</p>
        {#each selectedCase.attachments ?? [] as attachment (attachment.id)}
          <div class="flex items-center justify-between gap-2 rounded-lg bg-surface-container-high/20 px-3 py-2 text-sm">
            <span class="flex items-center gap-2 min-w-0">
              <Papicon icon="file-text" size={14} />
              {#if isDriveLink(attachment.url)}
                <a href={attachment.url} target="_blank" rel="noopener noreferrer" class="text-primary hover:underline truncate">{attachment.label}</a>
              {:else}
                <span class="truncate text-on-surface-variant">{attachment.label}</span>
              {/if}
            </span>
            <span class="flex items-center gap-1 shrink-0 text-xs text-on-surface-variant">
              {attachment.addedByName}
              {#if status?.canWriteCases}
                <Button size="sm" variant="ghost" icon="trash" loading={removingAttachmentId === attachment.id}
                  aria-label={m.wb_attachment_remove({ name: attachment.label })}
                  onclick={() => void removeAttachment(attachment.id)} />
              {/if}
            </span>
          </div>
        {/each}
        {#if status?.canWriteCases && (selectedCase.attachments ?? []).length < MAX_CASE_ATTACHMENTS}
          <form onsubmit={addAttachment} class="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
            <input bind:value={newAttachmentLabel} maxlength={120} class="input text-sm" aria-label={m.wb_attachment_label()} placeholder={m.wb_attachment_label()} />
            <input bind:value={newAttachmentUrl} type="url" required maxlength={500} class="input text-sm" aria-label={m.wb_attachment_url()} placeholder={m.wb_attachment_url_ph()} />
            <Button type="submit" size="sm" variant="secondary" icon="Plus" loading={addingAttachment}>{m.common_add()}</Button>
          </form>
        {/if}
      </div>
    </section>
  {/if}
{/snippet}

<ModulePage
  title={m.wb_title()}
  description={m.wb_desc()}
  icon="shield"
  featureKey="wellbeing"
>
  {#snippet actions()}
    {#if status?.enabled && status.canWriteCases}
      <Button variant="primary" icon="plus" onclick={() => (newCaseOpen = true)}>{m.wb_new_case()}</Button>
    {/if}
  {/snippet}

  {#if loading}
    <div class="space-y-4">
      <Skeleton height="80px" />
      <Skeleton height="320px" />
    </div>
  {:else if status}
    {#if status.enabled}
      {#if status.breakGlassExpiresAt && !status.isTeamMember}
        <Callout variant="warning" title={m.wb_break_glass_active_title()} class="mb-4">
          {m.wb_break_glass_active_desc({ time: new Date(status.breakGlassExpiresAt).toLocaleTimeString(dateLocale()) })}
        </Callout>
      {/if}
      {#if pendingLogs.length > 0 && activeTab !== 'access'}
        <div class="space-y-3 mb-4">{@render pendingRequests()}</div>
      {/if}
    {/if}

    {#if tabItems.length > 1}
      <Tabs label={m.wb_tabs_label()} tabs={tabItems} active={activeTab} onchange={(id) => (activeTab = id as Tab)} class="mb-6" />
    {/if}

    {#if activeTab === 'cases'}
      {#if !status.enabled}
        <EmptyState
          icon="shield"
          title={m.wb_disabled_title()}
          description={m.wb_disabled_desc()}
          actionLabel={status.canConfigure ? m.wb_configure() : undefined}
          onAction={status.canConfigure ? () => (activeTab = 'settings') : undefined}
        />
      {:else if !status.hasCaseAccess}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4 max-w-2xl">
          <div class="flex items-start gap-3">
            <div class="h-10 w-10 rounded-lg flex items-center justify-center shrink-0 bg-primary/10 text-primary"><Papicon icon="lock" size={20} /></div>
            <div class="space-y-1">
              <h2 class="text-base font-semibold text-on-surface">{m.wb_locked_title()}</h2>
              <p class="text-sm text-on-surface-variant">{m.wb_locked_desc()}</p>
              {#if status.isDirector}<p class="text-sm text-on-surface-variant">{m.wb_locked_director()}</p>{/if}
            </div>
          </div>
          {#if status.isDirector}
            <Button variant="primary" icon="lock" onclick={() => (breakGlassOpen = true)}>{m.wb_break_glass_open()}</Button>
          {/if}
        </section>
      {:else}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatTile icon="folder" tone="bg-primary/10 text-primary" value={stats.active} label={m.wb_stat_active()} />
          <StatTile icon="AlertTriangle" tone="bg-error/10 text-on-error-container" value={stats.urgent} label={m.wb_stat_urgent()} />
          <StatTile icon="Clock" tone="bg-warning/10 text-on-warning-container" value={stats.reviewDue} label={m.wb_stat_review_due()} />
          <StatTile icon="Check" tone="bg-success/10 text-on-success-container" value={stats.closed} label={m.wb_stat_closed()} />
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6 items-start">
          {@render caseList()}
          {@render caseDetail()}
        </div>
      {/if}
    {:else if activeTab === 'resources'}
      <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
        <div>
          <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="heart" size={16} /> {m.wb_resources_title()}</h3>
          <p class="text-xs text-on-surface-variant mt-1">{m.wb_resources_desc()}</p>
        </div>
        {#if resources.length === 0}
          <EmptyState icon="heart" title={m.wb_resources_empty()} actionLabel={m.wb_resources_add()}
            onAction={() => (resources = [...resources, { label: '', phone: null, url: null, description: null }])} />
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            {#each resources as resource, index (index)}
              <div class="rounded-xl bg-surface-container-high/20 border border-outline-variant/30 p-4 space-y-2">
                <div class="flex items-center gap-2">
                  <input bind:value={resource.label} maxlength={80} class="input text-sm font-semibold flex-1" aria-label={m.wb_resources_label()} placeholder={m.wb_resources_label()} />
                  <Button size="sm" variant="ghost" icon="trash" aria-label={m.wb_resources_remove({ name: resource.label })}
                    onclick={() => (resources = resources.filter((_, i) => i !== index))} />
                </div>
                <input bind:value={resource.phone} maxlength={30} class="input text-sm w-full" aria-label={m.wb_resources_phone()} placeholder={m.wb_resources_phone()} />
                <input bind:value={resource.url} maxlength={300} type="url" class="input text-sm w-full" aria-label={m.wb_resources_url()} placeholder={m.wb_resources_url()} />
                <input bind:value={resource.description} maxlength={200} class="input text-sm w-full" aria-label={m.wb_resources_description()} placeholder={m.wb_resources_description()} />
              </div>
            {/each}
          </div>
        {/if}
        <div class="flex flex-wrap justify-between gap-2 border-t border-outline-variant/30 pt-4">
          <Button variant="ghost" icon="plus" disabled={resources.length >= 10}
            onclick={() => (resources = [...resources, { label: '', phone: null, url: null, description: null }])}>{m.wb_resources_add()}</Button>
          <Button variant="primary" loading={savingResources} onclick={() => void saveResources()}>{m.wb_resources_save()}</Button>
        </div>
      </section>
    {:else if activeTab === 'access'}
      <div class="space-y-6">
        {#if pendingLogs.length > 0}
          <div class="space-y-3">{@render pendingRequests()}</div>
        {/if}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="eye" size={16} /> {m.wb_logs_title()}</h3>
          {#if logs.length === 0}
            <EmptyState icon="eye" title={m.wb_access_empty()} reason="accumulating" />
          {:else}
            <ul class="space-y-1.5">
              {#each logs as log (log.id)}
                <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-container-high/20 px-3 py-2.5 text-sm">
                  <div class="min-w-0">
                    <span class="font-semibold text-on-surface">{log.actorName}</span>
                    {#if log.reason}<span class="text-on-surface-variant"> · {log.reason}</span>{/if}
                    {#if log.subjectUserId}
                      <span class="text-xs text-on-surface-variant flex items-center gap-1 mt-0.5">{m.wb_pending_scope()} <MemberName userId={log.subjectUserId} /></span>
                    {/if}
                  </div>
                  <span class="flex items-center gap-2 text-xs text-on-surface-variant shrink-0">
                    {@render pill(LOG_STATUS[log.status]?.() ?? log.status, LOG_TONES[log.status] ?? wbStatusTone(''))}
                    {formatDate(log.createdAt)}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    {:else if activeTab === 'settings'}
      {#if !configLoaded}
        <Skeleton height="320px" />
      {:else}
        <form onsubmit={saveConfig} class="space-y-6">
          <SettingsGroup title={m.wb_set_general()}>
            <SettingsRow label={m.wb_cfg_enabled()} description={m.wb_desc()}>
              <ToggleSwitch checked={cfgEnabled} onToggle={(v) => (cfgEnabled = v)} ariaLabel={m.wb_cfg_enabled()} />
            </SettingsRow>
            <SettingsRow label={m.wb_cfg_report_enabled()}>
              <ToggleSwitch checked={cfgReportEnabled} onToggle={(v) => (cfgReportEnabled = v)} ariaLabel={m.wb_cfg_report_enabled()} />
            </SettingsRow>
            {#if cfgReportEnabled && (!cfgAlertEvents.includes('REPORT') || (!cfgAlertChannelId && cfgAlertUserIds.length === 0))}
              <div class="px-4 pb-3"><Callout variant="warning">{m.wb_cfg_report_unnoticed()}</Callout></div>
            {/if}
            <SettingsRow label={m.wb_cfg_stale_days()} description={m.wb_cfg_stale_hint()} labelFor="wb-stale-days">
              <input id="wb-stale-days" type="number" min="0" max="90" step="1" bind:value={cfgStaleDays} class="input w-24" />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title={m.wb_set_team()} description={m.wb_cfg_named_advice()}>
            <SettingsRow label={m.wb_cfg_team_members()} description={m.wb_cfg_named_hint()} labelFor="wb-team-users" stacked>
              <WellbeingMemberList id="wb-team-users" bind:ids={cfgTeamUserIds} max={MAX_NAMED_MEMBERS} />
            </SettingsRow>
            <SettingsRow label={m.wb_cfg_team_roles()} description={m.wb_cfg_roles_hint()} labelFor="wb-team-roles" stacked>
              <MultiSelect id="wb-team-roles" bind:values={cfgTeamRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
            </SettingsRow>
            <SettingsRow label={m.wb_cfg_director_members()} description={m.wb_cfg_named_hint()} labelFor="wb-director-users" stacked>
              <WellbeingMemberList id="wb-director-users" bind:ids={cfgDirectorUserIds} max={MAX_NAMED_MEMBERS} />
            </SettingsRow>
            <SettingsRow label={m.wb_cfg_director_roles()} description={m.wb_cfg_roles_hint()} labelFor="wb-director-roles" stacked>
              <MultiSelect id="wb-director-roles" bind:values={cfgDirectorRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title={m.wb_set_access()} description={m.wb_bg_modal_desc()}>
            <SettingsRow label={m.wb_cfg_require_reason()}>
              <ToggleSwitch checked={cfgRequireReason} onToggle={(v) => (cfgRequireReason = v)} ariaLabel={m.wb_cfg_require_reason()} />
            </SettingsRow>
            <SettingsRow label={m.wb_cfg_break_glass_approval()} description={m.wb_bg_approval_hint()}>
              <ToggleSwitch checked={cfgBreakGlassApproval} onToggle={(v) => (cfgBreakGlassApproval = v)} ariaLabel={m.wb_cfg_break_glass_approval()} />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title={m.wb_alerts_title()} description={m.wb_alerts_desc()}>
            <SettingsRow label={m.wb_alerts_channel()} labelFor="wb-alert-channel" stacked>
              <select id="wb-alert-channel" bind:value={cfgAlertChannelId} class="input w-full">
                <option value="">{m.wb_alerts_channel_none()}</option>
                {#each alertChannels as channel (channel.id)}
                  <option value={channel.id}>{channelDisplayName(channel)}</option>
                {/each}
              </select>
            </SettingsRow>
            <SettingsRow label={m.wb_alerts_users({ max: MAX_ALERT_USERS })} labelFor="wb-alert-users" stacked>
              <WellbeingMemberList id="wb-alert-users" bind:ids={cfgAlertUserIds} max={MAX_ALERT_USERS} />
            </SettingsRow>
            {#each WB_ALERT_EVENTS as code (code)}
              <SettingsRow label={wbAlertEventLabel(code)}>
                <ToggleSwitch size="sm" checked={cfgAlertEvents.includes(code)} onToggle={(v) => toggleAlertEvent(code, v)} ariaLabel={wbAlertEventLabel(code)} />
              </SettingsRow>
            {/each}
          </SettingsGroup>

          <div class="flex justify-end">
            <Button variant="primary" type="submit" icon="Check" loading={savingConfig}>{m.common_save()}</Button>
          </div>
        </form>
      {/if}
    {/if}
  {/if}
</ModulePage>

<Modal bind:open={breakGlassOpen} title={m.wb_bg_modal_title()} size="sm">
  <form id="bg-form" onsubmit={activateBreakGlass} class="space-y-4">
    <Callout variant="warning">
      {m.wb_bg_modal_desc()}
    </Callout>
    <Field label={m.wb_bg_reason()} required>
      {#snippet children(id)}
        <textarea {id} bind:value={breakGlassReason} required minlength={8} rows={3} class="input w-full" placeholder={m.wb_bg_reason_ph()}></textarea>
      {/snippet}
    </Field>
    <Field label={m.wb_bg_scope()} hint={m.wb_bg_scope_hint()}>
      {#snippet children(id, describedBy)}
        <MemberSearchSelect {id} {describedBy} bind:value={breakGlassSubjectUserId} placeholder={m.wb_member_ph()} />
      {/snippet}
    </Field>
    {#if status?.breakGlassApproval}
      <p class="text-xs text-on-surface-variant">{m.wb_bg_approval_hint()}</p>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (breakGlassOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="bg-form" loading={breakGlassSubmitting}>{m.wb_bg_confirm()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={newCaseOpen} title={m.wb_new_modal_title()} size="md">
  <form id="wb-case-form" onsubmit={createCase} class="space-y-4">
    <Field label={m.wb_member()} hint={m.wb_member_hint()}>
      {#snippet children(id, describedBy)}
        <MemberSearchSelect {id} {describedBy} bind:value={newSubjectUserId} placeholder={m.wb_member_ph()}
          onselect={(member) => (newSubjectName = member.displayName || member.username)} />
      {/snippet}
    </Field>
    <Field label={m.wb_subject()} hint={m.wb_subject_hint()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} bind:value={newSubjectName} required class="input w-full" placeholder={m.wb_subject_ph()} />
      {/snippet}
    </Field>
    <Field label={m.wb_case_title()} required>
      {#snippet children(id)}
        <input {id} bind:value={newTitle} required class="input w-full" placeholder={m.wb_case_title_ph()} />
      {/snippet}
    </Field>
    <div class="space-y-1.5">
      <p class="text-xs font-semibold text-on-surface-variant">{m.wb_category()}</p>
      <div role="group" aria-label={m.wb_category()} class="flex flex-wrap gap-1.5">
        {#each WB_CATEGORIES as code (code)}
          <button type="button" aria-pressed={newCategory === code} onclick={() => (newCategory = code)}
            class="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors {newCategory === code ? 'bg-primary/10 text-primary border border-primary/30' : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
            {wbCategoryLabel(code)}
          </button>
        {/each}
      </div>
    </div>
    <div class="space-y-1.5">
      <p class="text-xs font-semibold text-on-surface-variant">{m.wb_severity_label()}</p>
      <div role="group" aria-label={m.wb_severity_label()} class="flex flex-wrap gap-1.5">
        {#each WB_SEVERITIES as code (code)}
          <button type="button" aria-pressed={newSeverity === code} onclick={() => (newSeverity = code)}
            class="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors {newSeverity === code ? wbSeverityTone(code) : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
            {wbSeverityLabel(code)}
          </button>
        {/each}
      </div>
    </div>
    <Field label={m.wb_summary()} required>
      {#snippet children(id)}
        <textarea {id} bind:value={newSummary} required rows={4} class="input w-full" placeholder={m.wb_summary_ph()}></textarea>
      {/snippet}
    </Field>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label={m.wb_assignee()} hint={m.wb_assignee_hint()}>
        {#snippet children(id, describedBy)}
          <MemberSearchSelect {id} {describedBy} bind:value={newAssigneeId} placeholder={m.wb_member_ph()} />
        {/snippet}
      </Field>
      <Field label={m.wb_review_at()} hint={m.wb_review_hint()}>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} type="date" bind:value={newReviewAt} class="input w-full" />
        {/snippet}
      </Field>
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (newCaseOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="wb-case-form" loading={creatingCase}>{m.wb_create()}</Button>
  {/snippet}
</Modal>
