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
  import { Button, Callout, EmptyState, Field, Modal, SectionCard } from '../lib/components/ui';
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

  // Config modal (Direction)
  let configOpen = $state(false);
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
          if (!selectedCaseId && cases.length > 0) selectedCaseId = cases[0].id;
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

  async function openConfig() {
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
      configOpen = true;
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
      configOpen = false;
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

{#snippet pendingRequests()}
  {#if pendingLogs.length > 0}
    <SectionCard title={m.wb_pending_title()} icon="lock">
      <div class="divide-y divide-outline-variant">
        {#each pendingLogs as log (log.id)}
          <div class="px-4 py-3 text-xs space-y-2">
            <p class="text-on-surface"><span class="font-semibold">{m.wb_pending_by({ name: log.actorName })}</span> — {log.reason}</p>
            {#if log.subjectUserId}
              <p class="text-on-surface-variant flex items-center gap-1">{m.wb_pending_scope()} <MemberName userId={log.subjectUserId} /></p>
            {/if}
            {#if log.actorId === authStore.user?.id}
              <p class="text-on-surface-variant">{m.wb_pending_own()}</p>
            {:else}
              <div class="flex gap-2">
                <Button size="sm" variant="primary" loading={decidingLogId === log.id} onclick={() => void decideBreakGlass(log.id, true)}>{m.wb_pending_approve()}</Button>
                <Button size="sm" variant="ghost" disabled={decidingLogId === log.id} onclick={() => void decideBreakGlass(log.id, false)}>{m.wb_pending_reject()}</Button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </SectionCard>
  {/if}
{/snippet}

<ModulePage
  title={m.wb_title()}
  description={m.wb_desc()}
  icon="shield"
  featureKey="wellbeing"
>
  {#snippet actions()}
    <div class="flex flex-wrap items-center gap-2">
      {#if status?.canWriteCases}
        <Button variant="primary" icon="plus" onclick={() => (newCaseOpen = true)}>{m.wb_new_case()}</Button>
      {/if}
      {#if status?.canConfigure}
        <Button variant="ghost" icon="settings" onclick={() => void openConfig()}>{m.wb_config()}</Button>
      {/if}
    </div>
  {/snippet}

  {#if loading}
    <p class="text-sm text-on-surface-variant">{m.common_loading()}</p>
  {:else if !status?.enabled}
    <EmptyState
      icon="shield"
      title={m.wb_disabled_title()}
      description={m.wb_disabled_desc()}
      actionLabel={status?.canConfigure ? m.wb_configure() : undefined}
      onAction={status?.canConfigure ? () => void openConfig() : undefined}
    />
  {:else if !status.hasCaseAccess}
    <div class="space-y-4">
      <Callout variant="warning" title={m.wb_locked_title()}>
        {m.wb_locked_desc()}
        {#if status.isDirector}
          {m.wb_locked_director()}
        {/if}
      </Callout>
      {#if status.isDirector}
        <Button variant="primary" icon="lock" onclick={() => (breakGlassOpen = true)}>
          {m.wb_break_glass_open()}
        </Button>
      {/if}
      {@render pendingRequests()}
    </div>
  {:else}
    {#if status.breakGlassExpiresAt && !status.isTeamMember}
      <Callout variant="warning" title={m.wb_break_glass_active_title()}>
        {m.wb_break_glass_active_desc({ time: new Date(status.breakGlassExpiresAt).toLocaleTimeString(dateLocale()) })}
      </Callout>
    {/if}

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <SectionCard title={m.wb_cases_title()} description={m.wb_cases_retention()} icon="folder">
        <div class="divide-y divide-outline-variant">
          {#if cases.length === 0}
            <p class="p-4 text-sm text-on-surface-variant">{m.wb_cases_empty()}</p>
          {:else}
            {#each cases as c (c.id)}
              <button
                type="button"
                onclick={() => (selectedCaseId = c.id)}
                class="w-full text-left p-4 hover:bg-surface-container-low transition-colors {selectedCaseId === c.id ? 'bg-primary/5' : ''}"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-semibold text-on-surface truncate">{c.title}</span>
                  <span class="text-2xs px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant">{wbStatusLabel(c.status)}</span>
                </div>
                <p class="text-xs text-on-surface-variant mt-1">{c.subjectName} · {wbCategoryLabel(c.category)} · {wbSeverityLabel(c.severity)}</p>
              </button>
            {/each}
          {/if}
        </div>
      </SectionCard>

      <div class="lg:col-span-2 space-y-6">
        {#if selectedCase}
          <SectionCard title={selectedCase.title} description={m.wb_case_subject({ name: selectedCase.subjectName, category: wbCategoryLabel(selectedCase.category) })} icon="file-text">
            <div class="p-4 space-y-4">
              <div class="grid grid-cols-2 gap-3">
                <Field label={m.wb_status_label()}>
                  {#snippet children(id)}
                    <select {id} value={selectedCase?.status} disabled={updatingCase || !status?.canWriteCases} class="input w-full"
                      onchange={(e) => void updateCase({ status: e.currentTarget.value })}>
                      {#each WB_STATUSES as code (code)}<option value={code}>{wbStatusLabel(code)}</option>{/each}
                    </select>
                  {/snippet}
                </Field>
                <Field label={m.wb_severity_label()}>
                  {#snippet children(id)}
                    <select {id} value={selectedCase?.severity} disabled={updatingCase || !status?.canWriteCases} class="input w-full"
                      onchange={(e) => void updateCase({ severity: e.currentTarget.value })}>
                      {#each WB_SEVERITIES as code (code)}<option value={code}>{wbSeverityLabel(code)}</option>{/each}
                    </select>
                  {/snippet}
                </Field>
                <Field label={m.wb_assignee()} hint={m.wb_assignee_hint()}>
                  {#snippet children(id, describedBy)}
                    {#if selectedCase?.assigneeId}
                      <div class="flex items-center justify-between gap-2 text-sm">
                        <MemberName userId={selectedCase.assigneeId} />
                        {#if status?.canWriteCases}
                          <Button size="sm" variant="ghost" disabled={updatingCase} onclick={() => void updateCase({ assigneeId: null })}>{m.wb_assignee_clear()}</Button>
                        {/if}
                      </div>
                    {:else if status?.canWriteCases}
                      <MemberSearchSelect {id} {describedBy} bind:value={assigneeCandidate} placeholder={m.wb_member_ph()}
                        onselect={(member) => { assigneeCandidate = ''; void updateCase({ assigneeId: member.id }); }} />
                    {:else}
                      <p class="text-sm text-on-surface-variant">{m.wb_assignee_none()}</p>
                    {/if}
                  {/snippet}
                </Field>
                <Field label={m.wb_review_at()} hint={m.wb_review_hint()}>
                  {#snippet children(id, describedBy)}
                    <input {id} aria-describedby={describedBy} type="date" class="input w-full" disabled={updatingCase || !status?.canWriteCases}
                      value={selectedCase?.reviewAt ? selectedCase.reviewAt.slice(0, 10) : ''}
                      onchange={(e) => void updateCase({ reviewAt: e.currentTarget.value || null })} />
                  {/snippet}
                </Field>
              </div>
              <p class="text-sm whitespace-pre-wrap text-on-surface bg-surface-container-low rounded-lg p-3 border border-outline-variant">
                {selectedCase.summary}
              </p>

              <div class="space-y-2">
                <h3 class="text-xs font-semibold text-on-surface-variant">{m.wb_notes_title()}</h3>
                {#each selectedCase.notes ?? [] as note (note.id)}
                  <div class="rounded-lg border border-outline-variant p-3 text-xs bg-surface-container-lowest">
                    <div class="flex justify-between text-on-surface-variant mb-1">
                      <span class="font-semibold text-on-surface">{note.authorName}</span>
                      <span>{formatDate(note.createdAt)}</span>
                    </div>
                    <p class="whitespace-pre-wrap text-on-surface">{note.content}</p>
                  </div>
                {/each}
              </div>

              <div class="space-y-2">
                <h3 class="text-xs font-semibold text-on-surface-variant">{m.wb_attachments_title()}</h3>
                <p class="text-xs text-on-surface-variant">{m.wb_attachments_desc()}</p>
                {#each selectedCase.attachments ?? [] as attachment (attachment.id)}
                  <div class="flex items-center justify-between gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm">
                    {#if isDriveLink(attachment.url)}
                      <a href={attachment.url} target="_blank" rel="noopener noreferrer" class="text-primary underline truncate">{attachment.label}</a>
                    {:else}
                      <span class="truncate text-on-surface-variant">{attachment.label}</span>
                    {/if}
                    <span class="flex items-center gap-2 shrink-0 text-xs text-on-surface-variant">
                      {attachment.addedByName}
                      {#if status?.canWriteCases}
                        <Button size="sm" variant="ghost" icon="trash" loading={removingAttachmentId === attachment.id}
                          aria-label={m.wb_attachment_remove({ name: attachment.label })}
                          onclick={() => void removeAttachment(attachment.id)}>{m.common_delete()}</Button>
                      {/if}
                    </span>
                  </div>
                {/each}
                {#if status?.canWriteCases && (selectedCase.attachments ?? []).length < MAX_CASE_ATTACHMENTS}
                  <form onsubmit={addAttachment} class="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
                    <input bind:value={newAttachmentLabel} maxlength={120} class="input text-sm" aria-label={m.wb_attachment_label()} placeholder={m.wb_attachment_label()} />
                    <input bind:value={newAttachmentUrl} type="url" required maxlength={500} class="input text-sm" aria-label={m.wb_attachment_url()} placeholder={m.wb_attachment_url_ph()} />
                    <Button type="submit" size="sm" variant="secondary" loading={addingAttachment}>{m.common_add()}</Button>
                  </form>
                {/if}
              </div>

              {#if status?.canWriteCases}
                <form onsubmit={addNote} class="flex gap-2">
                  <input bind:value={newNote} aria-label={m.a11y_wellbeing_note()} required placeholder={m.wb_note_ph()} class="input flex-1 text-sm" />
                  <Button type="submit" size="sm" variant="primary" loading={addingNote}>{m.common_add()}</Button>
                </form>
              {:else}
                <p class="text-xs text-on-surface-variant">{m.wb_read_only_emergency()}</p>
              {/if}

              {#if (selectedCase.events ?? []).length > 0}
                <div class="space-y-1">
                  <h3 class="text-xs font-semibold text-on-surface-variant">{m.wb_history_title()}</h3>
                  <ol class="space-y-1 text-xs">
                    {#each selectedCase.events as event (event.id)}
                      <li class="flex flex-wrap items-center gap-x-2 text-on-surface-variant">
                        <span>{formatDate(event.createdAt)}</span>
                        <span class="font-medium text-on-surface">{event.actorName}</span>
                        <span>{wbCaseEventLabel(event, formatDay)}</span>
                        {#if event.type === 'ASSIGNEE' && event.toValue}<MemberName userId={event.toValue} />{/if}
                      </li>
                    {/each}
                  </ol>
                </div>
              {/if}

              {#if status?.canWriteCases}
                <div class="flex flex-wrap justify-end gap-2">
                  {#if selectedCase.subjectUserId && resources.length > 0}
                    <Button size="sm" variant="secondary" icon="heart" loading={sendingResources} onclick={() => void sendResources()}>{m.wb_send_resources()}</Button>
                  {/if}
                  <Button size="sm" variant="ghost" icon="trash" loading={deletingCase} onclick={() => void deleteCase()}>{m.wb_delete_case()}</Button>
                </div>
              {/if}
            </div>
          </SectionCard>
        {/if}

        {#if logs.length > 0}
          <SectionCard title={m.wb_logs_title()} icon="eye">
            <div class="divide-y divide-outline-variant">
              {#each logs as log (log.id)}
                <div class="px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span class="font-semibold text-on-surface">{log.actorName}</span>
                    <span class="text-on-surface-variant"> — {log.reason}</span>
                  </div>
                  <span class="text-on-surface-variant">{LOG_STATUS[log.status]?.() ?? log.status} · {formatDate(log.createdAt)}</span>
                </div>
              {/each}
            </div>
          </SectionCard>
        {/if}

        {@render pendingRequests()}

        {#if status.isTeamMember}
          <SectionCard title={m.wb_resources_title()} description={m.wb_resources_desc()} icon="heart">
            <div class="p-4 space-y-3">
              {#if resources.length === 0}
                <p class="text-sm text-on-surface-variant">{m.wb_resources_empty()}</p>
              {/if}
              {#each resources as resource, index (index)}
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg border border-outline-variant p-3">
                  <input bind:value={resource.label} maxlength={80} class="input text-sm" aria-label={m.wb_resources_label()} placeholder={m.wb_resources_label()} />
                  <input bind:value={resource.phone} maxlength={30} class="input text-sm" aria-label={m.wb_resources_phone()} placeholder={m.wb_resources_phone()} />
                  <input bind:value={resource.url} maxlength={300} type="url" class="input text-sm" aria-label={m.wb_resources_url()} placeholder={m.wb_resources_url()} />
                  <input bind:value={resource.description} maxlength={200} class="input text-sm" aria-label={m.wb_resources_description()} placeholder={m.wb_resources_description()} />
                  <div class="sm:col-span-2 flex justify-end">
                    <Button size="sm" variant="ghost" icon="trash" aria-label={m.wb_resources_remove({ name: resource.label })}
                      onclick={() => (resources = resources.filter((_, i) => i !== index))}>{m.common_delete()}</Button>
                  </div>
                </div>
              {/each}
              <div class="flex flex-wrap justify-between gap-2">
                <Button size="sm" variant="ghost" icon="plus" disabled={resources.length >= 10}
                  onclick={() => (resources = [...resources, { label: '', phone: null, url: null, description: null }])}>{m.wb_resources_add()}</Button>
                <Button size="sm" variant="primary" loading={savingResources} onclick={() => void saveResources()}>{m.wb_resources_save()}</Button>
              </div>
            </div>
          </SectionCard>
        {/if}
      </div>
    </div>
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
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label={m.wb_subject()} hint={m.wb_subject_hint()} required>
        {#snippet children(id, describedBy)}
          <input {id} aria-describedby={describedBy} bind:value={newSubjectName} required class="input w-full" placeholder={m.wb_subject_ph()} />
        {/snippet}
      </Field>
      <Field label={m.wb_category()}>
        {#snippet children(id)}
          <select {id} bind:value={newCategory} class="input w-full">
            {#each WB_CATEGORIES as code (code)}<option value={code}>{wbCategoryLabel(code)}</option>{/each}
          </select>
        {/snippet}
      </Field>
    </div>
    <Field label={m.wb_severity_label()}>
      {#snippet children(id)}
        <select {id} bind:value={newSeverity} class="input w-full">
          {#each WB_SEVERITIES as code (code)}<option value={code}>{wbSeverityLabel(code)}</option>{/each}
        </select>
      {/snippet}
    </Field>
    <Field label={m.wb_case_title()} required>
      {#snippet children(id)}
        <input {id} bind:value={newTitle} required class="input w-full" placeholder={m.wb_case_title_ph()} />
      {/snippet}
    </Field>
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

<Modal bind:open={configOpen} title={m.wb_cfg_title()} size="md">
  <form id="wb-cfg-form" onsubmit={saveConfig} class="space-y-4">
    <label class="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" bind:checked={cfgEnabled} />
      {m.wb_cfg_enabled()}
    </label>
    <label class="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" bind:checked={cfgRequireReason} />
      {m.wb_cfg_require_reason()}
    </label>
    <label class="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" bind:checked={cfgBreakGlassApproval} />
      {m.wb_cfg_break_glass_approval()}
    </label>
    <label class="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" bind:checked={cfgReportEnabled} />
      {m.wb_cfg_report_enabled()}
    </label>
    {#if cfgReportEnabled && (!cfgAlertEvents.includes('REPORT') || (!cfgAlertChannelId && cfgAlertUserIds.length === 0))}
      <p class="text-xs text-warning">{m.wb_cfg_report_unnoticed()}</p>
    {/if}
    <Field label={m.wb_cfg_stale_days()} hint={m.wb_cfg_stale_hint()}>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} type="number" min="0" max="90" step="1" bind:value={cfgStaleDays} class="input w-32" />
      {/snippet}
    </Field>
    <Callout variant="info">{m.wb_cfg_named_advice()}</Callout>
    <Field label={m.wb_cfg_team_members()} hint={m.wb_cfg_named_hint()}>
      {#snippet children(id, describedBy)}
        <WellbeingMemberList {id} {describedBy} bind:ids={cfgTeamUserIds} max={MAX_NAMED_MEMBERS} />
      {/snippet}
    </Field>
    <Field label={m.wb_cfg_team_roles()} hint={m.wb_cfg_roles_hint()}>
      {#snippet children(id, describedBy)}
        <MultiSelect {id} {describedBy} bind:values={cfgTeamRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
      {/snippet}
    </Field>
    <Field label={m.wb_cfg_director_members()} hint={m.wb_cfg_named_hint()}>
      {#snippet children(id, describedBy)}
        <WellbeingMemberList {id} {describedBy} bind:ids={cfgDirectorUserIds} max={MAX_NAMED_MEMBERS} />
      {/snippet}
    </Field>
    <Field label={m.wb_cfg_director_roles()} hint={m.wb_cfg_roles_hint()}>
      {#snippet children(id, describedBy)}
        <MultiSelect {id} {describedBy} bind:values={cfgDirectorRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
      {/snippet}
    </Field>

    <fieldset class="space-y-3 border-t border-outline-variant pt-4">
      <legend class="text-sm font-semibold text-on-surface">{m.wb_alerts_title()}</legend>
      <p class="text-xs text-on-surface-variant">{m.wb_alerts_desc()}</p>
      <Field label={m.wb_alerts_channel()}>
        {#snippet children(id)}
          <select {id} bind:value={cfgAlertChannelId} class="input w-full">
            <option value="">{m.wb_alerts_channel_none()}</option>
            {#each alertChannels as channel (channel.id)}
              <option value={channel.id}>{channelDisplayName(channel)}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field label={m.wb_alerts_users({ max: MAX_ALERT_USERS })}>
        {#snippet children(id)}
          <WellbeingMemberList {id} bind:ids={cfgAlertUserIds} max={MAX_ALERT_USERS} />
        {/snippet}
      </Field>
      <div class="space-y-1">
        <p class="text-xs font-medium text-on-surface-variant">{m.wb_alerts_events()}</p>
        {#each WB_ALERT_EVENTS as code (code)}
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cfgAlertEvents.includes(code)}
              onchange={(e) => toggleAlertEvent(code, e.currentTarget.checked)} />
            {wbAlertEventLabel(code)}
          </label>
        {/each}
      </div>
    </fieldset>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (configOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="wb-cfg-form" loading={savingConfig}>{m.common_save()}</Button>
  {/snippet}
</Modal>
