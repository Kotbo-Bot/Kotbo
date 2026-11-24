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
  import { WB_CATEGORIES, WB_SEVERITIES, WB_STATUSES, wbCategoryLabel, wbSeverityLabel, wbStatusLabel } from '../lib/wellbeingLabels';
  import { Button, Callout, EmptyState, Field, Modal, SectionCard } from '../lib/components/ui';

  type WellbeingStatus = {
    enabled: boolean;
    requireReason: boolean;
    isTeamMember: boolean;
    isDirector: boolean;
    /** Propriétaire du serveur : seul à modifier la composition de la cellule. */
    canConfigure: boolean;
    hasCaseAccess: boolean;
    breakGlassExpiresAt: string | null;
  };

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
  let savingConfig = $state(false);

  async function loadAll() {
    loading = true;
    try {
      const stRes = await dashboardFetch('/wellbeing/status');
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
        body: JSON.stringify({ reason: breakGlassReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '');
      breakGlassOpen = false;
      breakGlassReason = '';
      toast.success(m.toast_wb_break_glass_on());
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_break_glass_failed());
    } finally {
      breakGlassSubmitting = false;
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
      toast.success(m.toast_wb_file_created());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_create_failed());
    } finally {
      creatingCase = false;
    }
  }

  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());

  let updatingCase = $state(false);

  /** Statut ou gravité du dossier ouvert. Fermer un dossier le rend purgeable après un an. */
  async function updateCase(patch: { status?: string; severity?: string }) {
    const target = selectedCase;
    if (!target || updatingCase) return;
    updatingCase = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error('update');
      const { item } = await res.json();
      cases = cases.map((c) => (c.id === item.id ? item : c));
      toast.success(m.toast_wb_case_updated());
    } catch {
      toast.error(m.toast_wb_update_failed());
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
    } catch {
      toast.error(m.toast_wb_note_failed());
    } finally {
      addingNote = false;
    }
  }
</script>

<ModulePage
  title={m.wb_title()}
  description={m.wb_desc()}
  icon="shield"
  featureKey="staff_directory"
>
  {#snippet actions()}
    <div class="flex flex-wrap items-center gap-2">
      {#if status?.hasCaseAccess}
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
                    <select {id} value={selectedCase?.status} disabled={updatingCase} class="input w-full"
                      onchange={(e) => void updateCase({ status: e.currentTarget.value })}>
                      {#each WB_STATUSES as code (code)}<option value={code}>{wbStatusLabel(code)}</option>{/each}
                    </select>
                  {/snippet}
                </Field>
                <Field label={m.wb_severity_label()}>
                  {#snippet children(id)}
                    <select {id} value={selectedCase?.severity} disabled={updatingCase} class="input w-full"
                      onchange={(e) => void updateCase({ severity: e.currentTarget.value })}>
                      {#each WB_SEVERITIES as code (code)}<option value={code}>{wbSeverityLabel(code)}</option>{/each}
                    </select>
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

              <form onsubmit={addNote} class="flex gap-2">
                <input bind:value={newNote} aria-label={m.a11y_wellbeing_note()} required placeholder={m.wb_note_ph()} class="input flex-1 text-sm" />
                <Button type="submit" size="sm" variant="primary" loading={addingNote}>{m.common_add()}</Button>
              </form>

              {#if status?.isTeamMember}
                <div class="flex justify-end">
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
                  <span class="text-on-surface-variant">{formatDate(log.createdAt)}</span>
                </div>
              {/each}
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
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (breakGlassOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="bg-form" loading={breakGlassSubmitting}>{m.wb_bg_confirm()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={newCaseOpen} title={m.wb_new_modal_title()} size="md">
  <form id="wb-case-form" onsubmit={createCase} class="space-y-4">
    <Field label={m.wb_member()} hint={m.wb_member_hint()}>
      {#snippet children(id)}
        <MemberSearchSelect {id} bind:value={newSubjectUserId} placeholder={m.wb_member_ph()}
          onselect={(member) => (newSubjectName = member.displayName || member.username)} />
      {/snippet}
    </Field>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field label={m.wb_subject()} hint={m.wb_subject_hint()} required>
        {#snippet children(id)}
          <input {id} bind:value={newSubjectName} required class="input w-full" placeholder={m.wb_subject_ph()} />
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
    <Field label={m.wb_cfg_team_roles()}>
      {#snippet children(id)}
        <MultiSelect {id} bind:values={cfgTeamRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
      {/snippet}
    </Field>
    <Field label={m.wb_cfg_director_roles()}>
      {#snippet children(id)}
        <MultiSelect {id} bind:values={cfgDirectorRoleIds} options={roleOptions} placeholder={m.wb_role_search_ph()} />
      {/snippet}
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (configOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="wb-cfg-form" loading={savingConfig}>{m.common_save()}</Button>
  {/snippet}
</Modal>
