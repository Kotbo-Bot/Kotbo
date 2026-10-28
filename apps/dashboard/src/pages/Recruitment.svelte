<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { m, dateLocale } from '../lib/i18n';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { fetchFeatureConfigurations, updateRecruitmentConfig, fetchStaffHierarchies, dashboardFetch } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import { Button, Callout, EmptyState, Field, FilterPills, Menu, Modal, Tabs, type FilterOption } from '../lib/components/ui';
  import { formatRelative } from '../lib/components/staff/format';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { errorMessage } from '@kotbo/shared';

  type Status = 'PENDING' | 'ORAL' | 'APPROVED' | 'REJECTED' | 'AUTO_REJECTED';
  type Filter = 'ALL' | Status;
  const STATUSES: Status[] = ['PENDING', 'ORAL', 'APPROVED', 'REJECTED', 'AUTO_REJECTED'];

  const STATUS_LABEL: Record<Status, () => string> = {
    PENDING: m.recruit_status_pending,
    ORAL: m.recruit_status_oral,
    APPROVED: m.recruit_status_approved,
    REJECTED: m.recruit_status_rejected,
    AUTO_REJECTED: m.recruit_status_auto_rejected,
  };

  const STATUS_BADGE: Record<Status, string> = {
    PENDING: 'badge-warning',
    ORAL: 'badge-info',
    APPROVED: 'badge-success',
    REJECTED: 'badge-danger',
    AUTO_REJECTED: 'badge-neutral',
  };

  const statusLabel = (status: string) => STATUS_LABEL[status as Status]?.() ?? status;

  // ── Droits ──────────────────────────────────────────────
  const rights = $derived((dashboardStore.state.featureAccess as any)?.recruitment);
  const isAdmin = $derived(!!dashboardStore.state.access?.canManageSettings);
  const canView = $derived(isAdmin || !!rights?.canView);
  const canModerate = $derived(isAdmin || !!rights?.canModerate);
  const canManageSettings = $derived(isAdmin || !!rights?.canConfigure);

  // ── Données ─────────────────────────────────────────────
  let candidatures = $state<any[]>([]);
  let tutors = $state<any[]>([]);
  let hierarchies = $state<any[]>([]);
  // id de champ (ex: f_1782999782943_x469d) → intitulé de la question
  let fieldLabels = $state<Record<string, string>>({});
  // id de formulaire → nom du poste
  let formNames = $state<Record<string, string>>({});
  let guildState = $state<any>(null);
  let featureConfig = $state<any>(null);
  let loading = $state(true);
  let error = $state('');

  // ── Liste ───────────────────────────────────────────────
  let filter = $state<Filter>('PENDING');
  let search = $state('');
  let formFilter = $state('');
  let sortOldest = $state(false);
  let selectedId = $state<string | null>(null);
  let wide = $state(true);

  const formOf = (c: any): string => c.customFormId || c.formId || '';
  const nameOf = (c: any): string => c.username || m.recruit_anonymous();

  function formatValue(value: unknown) {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  function answersOf(c: any): Array<[string, unknown]> {
    return Object.entries(c?.data ?? {}).filter(([, v]) => v !== null && v !== '' && (typeof v !== 'object' || Array.isArray(v)));
  }

  const counts = $derived(
    Object.fromEntries(STATUSES.map((s) => [s, candidatures.filter((c) => c.status === s).length])) as Record<Status, number>,
  );

  const filterOptions = $derived<FilterOption<Filter>[]>([
    { value: 'ALL', label: m.recruit_filter_all(), count: candidatures.length },
    ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s](), count: counts[s] })),
  ]);

  const formOptions = $derived(
    [...new Set(candidatures.map(formOf).filter(Boolean))].map((id) => ({ id, name: formNames[id] ?? id })),
  );

  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const list = candidatures.filter((c) => {
      if (filter !== 'ALL' && c.status !== filter) return false;
      if (formFilter && formOf(c) !== formFilter) return false;
      if (!q) return true;
      const haystack = [c.username, c.discordId, c.email, c.notes, ...answersOf(c).map(([, v]) => formatValue(v))];
      return haystack.join(' ').toLowerCase().includes(q);
    });
    // L'API rend les plus recentes d'abord.
    return sortOldest ? [...list].reverse() : list;
  });

  const selected = $derived(candidatures.find((c) => c.id === selectedId) ?? null);

  // Grand ecran : la premiere de la liste s'ouvre d'office, on lit sans cliquer.
  // Petit ecran : la liste reste affichee tant qu'on n'a rien choisi.
  $effect(() => {
    if (selectedId && visible.some((c) => c.id === selectedId)) return;
    selectedId = wide ? (visible[0]?.id ?? null) : null;
  });

  function select(id: string) {
    selectedId = id;
    document.getElementById(`cand-${id}`)?.scrollIntoView({ block: 'nearest' });
  }

  function move(step: number) {
    if (visible.length === 0) return;
    const index = visible.findIndex((c) => c.id === selectedId);
    select(visible[Math.min(visible.length - 1, Math.max(0, index + step))].id);
  }

  function onListKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    }
  }

  // ── Modales ─────────────────────────────────────────────
  let validateTarget = $state<any>(null);
  let validationDiscordId = $state('');
  let rejectTarget = $state<any>(null);
  let rejectReason = $state('');
  let oralPassTarget = $state<any>(null);
  let tutorSelected = $state<string | null>('');
  let oralPassNotes = $state('');
  let selectedHierarchyId = $state('');
  let selectedHierarchyGrade = $state('');
  let oralFailTarget = $state<any>(null);
  let oralFailReason = $state('');
  let configOpen = $state(false);
  let cfgCategoryId = $state<string | null>('');
  let cfgLogChannelId = $state<string | null>('');

  const hierarchyRoles = $derived(
    [...(hierarchies.find((h) => h.id === selectedHierarchyId)?.roles ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
  );

  function pickHierarchy(id: string) {
    selectedHierarchyId = id;
    selectedHierarchyGrade = hierarchyRoles[0]?.name ?? '';
  }

  // J / K passent d'une candidature a l'autre, hors saisie et hors modale.
  function onWindowKeydown(event: KeyboardEvent) {
    if (activeTab !== 'candidatures' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (validateTarget || rejectTarget || oralPassTarget || oralFailTarget || configOpen) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
    if (event.key === 'j') move(1);
    else if (event.key === 'k') move(-1);
  }

  // ── Chargement ──────────────────────────────────────────
  async function loadCandidatures() {
    const res = await dashboardFetch('/recruitment/candidatures');
    if (!res.ok) throw new Error(m.recruit_err_load_applications());
    candidatures = (await res.json()).candidatures || [];
  }

  async function fetchInitialData() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const [resState, resTutors, resForms, resCustomForms] = await Promise.all([
        dashboardFetch('/state').catch(() => null),
        dashboardFetch('/recruitment/tutors').catch(() => null),
        dashboardFetch('/recruitment/forms').catch(() => null),
        dashboardFetch('/custom-forms?includeStructure=true').catch(() => null),
        loadCandidatures(),
      ]);

      if (resState?.ok) guildState = await resState.json();
      if (resTutors?.ok) tutors = (await resTutors.json()).tutors || [];

      const labels: Record<string, string> = {};
      const names: Record<string, string> = {};
      for (const res of [resForms, resCustomForms]) {
        if (!res?.ok) continue;
        try {
          const data = await res.json();
          for (const f of data.forms || []) {
            if (f?.id && f?.name) names[f.id] = f.name;
            for (const field of f.structure?.fields || []) {
              if (field?.id && field?.label) labels[field.id] = field.label;
            }
          }
        } catch { /* formulaire illisible : on garde les ids bruts */ }
      }
      fieldLabels = labels;
      formNames = names;

      hierarchies = (await fetchStaffHierarchies().catch(() => null))?.hierarchies || [];
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  async function loadFeatureConfig() {
    try {
      const configs = await fetchFeatureConfigurations();
      featureConfig = configs?.features?.find((c: any) => c.featureKey === 'recruitment') || null;
    } catch (err) {
      console.error('Error fetching recruitment config:', err);
    }
  }

  // `canView` depend de featureAccess, rempli apres le montage : on attend
  // qu'il passe a vrai, puis on ne charge qu'une fois.
  let initialLoadStarted = $state(false);
  $effect(() => {
    if (!canView || initialLoadStarted) return;
    initialLoadStarted = true;
    void Promise.all([fetchInitialData(), loadFeatureConfig()]);
  });

  onMount(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => (wide = mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  // ── Actions sur une candidature ─────────────────────────
  async function patch(id: string, action: string, data: Record<string, unknown> = {}) {
    const res = await dashboardFetch(`/recruitment/candidatures/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...data }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || m.recruit_err_action_failed());
    }
  }

  let acting = $state(false);

  /** Applique la decision puis ouvre la candidature suivante de la liste. */
  async function decide(id: string, steps: Array<[string, Record<string, unknown>]>): Promise<boolean> {
    const index = visible.findIndex((c) => c.id === id);
    const nextId = visible[index + 1]?.id ?? visible[index - 1]?.id ?? null;
    acting = true;
    try {
      for (const [action, data] of steps) await patch(id, action, data);
      await loadCandidatures();
      toast.success(m.recruit_action_done());
      if (!visible.some((c) => c.id === id)) selectedId = nextId;
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      acting = false;
    }
  }

  async function submitValidate() {
    if (await decide(validateTarget.id, [['approve', { discordUserId: validationDiscordId.trim() }]])) validateTarget = null;
  }

  async function submitReject() {
    if (await decide(rejectTarget.id, [['reject', { reason: rejectReason }]])) rejectTarget = null;
  }

  async function submitOralPass() {
    const steps: Array<[string, Record<string, unknown>]> = [
      ['oral_pass', { reason: oralPassNotes, hierarchyId: selectedHierarchyId || undefined, hierarchyGrade: selectedHierarchyGrade || undefined }],
    ];
    if (tutorSelected) steps.push(['assign_tutor', { tutorUserId: tutorSelected }]);
    if (await decide(oralPassTarget.id, steps)) oralPassTarget = null;
  }

  async function submitOralFail() {
    if (await decide(oralFailTarget.id, [['oral_fail', { reason: oralFailReason }]])) oralFailTarget = null;
  }

  function openValidate(c: any) {
    validateTarget = c;
    validationDiscordId = c.discordId || '';
  }

  function openReject(c: any) {
    rejectTarget = c;
    rejectReason = '';
  }

  function openOralPass(c: any) {
    oralPassTarget = c;
    tutorSelected = '';
    oralPassNotes = '';
    selectedHierarchyId = '';
    selectedHierarchyGrade = '';
  }

  function openOralFail(c: any) {
    oralFailTarget = c;
    oralFailReason = '';
  }

  async function deleteCandidature(c: any) {
    if (!(await confirmDialog.danger(m.recruit_confirm_delete_title(), m.recruit_confirm_delete_desc()))) return;
    const index = visible.findIndex((x) => x.id === c.id);
    const nextId = visible[index + 1]?.id ?? visible[index - 1]?.id ?? null;
    try {
      const res = await dashboardFetch(`/recruitment/candidatures/${c.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(m.recruit_err_delete());
      candidatures = candidatures.filter((x) => x.id !== c.id);
      selectedId = nextId;
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function copyDiscordId(id: string) {
    void navigator.clipboard.writeText(id);
    toast.success(m.recruit_id_copied());
  }

  // ── Notes internes : enregistrees a la sortie du champ ──
  let notesDraft = $state('');
  let notesState = $state<'idle' | 'saving' | 'saved'>('idle');

  $effect(() => {
    const id = selectedId;
    untrack(() => {
      notesDraft = candidatures.find((c) => c.id === id)?.notes ?? '';
      notesState = 'idle';
    });
  });

  async function saveNotes() {
    const c = selected;
    if (!c || (c.notes ?? '') === notesDraft) return;
    notesState = 'saving';
    try {
      await patch(c.id, 'status_update', { status: c.status, notes: notesDraft });
      c.notes = notesDraft;
      notesState = 'saved';
    } catch (err) {
      notesState = 'idle';
      toast.error(errorMessage(err));
    }
  }

  // ── Reglages ────────────────────────────────────────────
  const saveAction = createAsyncActionState();

  function openConfig() {
    cfgCategoryId = guildState?.recruitmentCategoryId ?? '';
    cfgLogChannelId = guildState?.recruitmentLogChannelId ?? '';
    configOpen = true;
  }

  async function saveConfig() {
    await saveAction.run(async () => {
      const payload = { recruitmentCategoryId: cfgCategoryId || null, recruitmentLogChannelId: cfgLogChannelId || null };
      const ok = await updateRecruitmentConfig(payload);
      if (!ok) throw new Error(m.recruit_err_api());
      guildState = { ...guildState, ...payload };
      configOpen = false;
      return true;
    }, { successMessage: m.recruit_config_saved() });
  }

  // ── Google Forms ────────────────────────────────────────
  let activeTab = $state<'candidatures' | 'google-forms'>('candidatures');
  let forms = $state<any[]>([]);
  let formsLoading = $state(false);
  let formsError = $state('');
  let showCreateModal = $state(false);
  let showScriptModal = $state(false);
  let selectedForm = $state<any>(null);
  let generatedScript = $state('');
  let newlyGeneratedKey = $state('');
  let showKeyModal = $state(false);
  let keyCopied = $state(false);
  let newFormName = $state('');
  let newFormDescription = $state('');

  const createFormAction = createAsyncActionState();
  const deleteFormAction = createAsyncActionState();
  const regenerateKeyAction = createAsyncActionState();

  function copyKeyToClipboard() {
    void navigator.clipboard.writeText(newlyGeneratedKey);
    keyCopied = true;
    setTimeout(() => { keyCopied = false; }, 2000);
  }

  async function fetchForms() {
    if (!authStore.selectedGuildId) return;
    formsLoading = true;
    formsError = '';
    try {
      const res = await dashboardFetch('/recruitment/forms');
      if (!res.ok) throw new Error(m.recruit_err_load_forms());
      const data = await res.json();
      forms = (data.forms || []).filter((f: any) => f.structure?.type === 'google');
    } catch (err) {
      formsError = errorMessage(err);
    } finally {
      formsLoading = false;
    }
  }

  async function createForm(event?: SubmitEvent) {
    event?.preventDefault();
    if (!newFormName.trim()) return;

    await createFormAction.run(async () => {
      const structure = {
        title: newFormName,
        description: newFormDescription,
        type: 'google',
        fields: [
          { id: 'discord_id', type: 'short_text', label: m.recruit_form_default_discord_id_label(), description: m.recruit_form_default_discord_id_desc(), required: true },
          { id: 'discord_username', type: 'short_text', label: m.recruit_form_default_username_label(), description: m.recruit_form_default_username_desc(), required: true },
          { id: 'email', type: 'email', label: m.recruit_form_default_email_label(), description: m.recruit_form_default_email_desc(), required: true },
          { id: 'age', type: 'number', label: m.recruit_form_default_age_label(), description: m.recruit_form_default_age_desc(), required: true },
        ],
      };

      const res = await dashboardFetch('/recruitment/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFormName, description: newFormDescription || undefined, template: 'google', structure }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || m.recruit_err_create_form());
      }
      const data = await res.json();
      newlyGeneratedKey = data.apiKey?.key || data.apiKey || '';
      showKeyModal = !!newlyGeneratedKey;
      showCreateModal = false;
      newFormName = '';
      newFormDescription = '';
      await fetchForms();
      return true;
    }, { successMessage: m.recruit_form_created() });
  }

  async function deleteForm(formId: string) {
    if (!(await confirmDialog.danger(m.recruit_confirm_delete_form_title(), m.recruit_confirm_delete_form_desc()))) return;
    await deleteFormAction.run(async () => {
      const res = await dashboardFetch(`/recruitment/forms/${formId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(m.recruit_err_delete_form());
      await fetchForms();
      return true;
    }, { successMessage: m.recruit_form_deleted() });
  }

  async function regenerateAPIKey(formId: string) {
    if (!(await confirmDialog.ask({ title: m.recruit_confirm_regen_title(), description: m.recruit_confirm_regen_desc(), confirmLabel: m.recruit_confirm_regen_btn(), variant: 'warning' }))) return;
    await regenerateKeyAction.run(async () => {
      const res = await dashboardFetch(`/recruitment/forms/${formId}/regenerate-key`, { method: 'POST' });
      if (!res.ok) throw new Error(m.recruit_err_regen());
      newlyGeneratedKey = (await res.json()).apiKey;
      showKeyModal = true;
      await fetchForms();
      return true;
    }, { successMessage: m.recruit_key_regenerated() });
  }

  async function showGoogleAppsScript(form: any) {
    selectedForm = form;
    try {
      const res = await dashboardFetch(`/recruitment/forms/${form.id}/script`);
      if (!res.ok) throw new Error(m.recruit_err_script());
      generatedScript = (await res.json()).script;
      showScriptModal = true;
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function copyFormLink(formId: string) {
    void navigator.clipboard.writeText(`${window.location.origin}/form/${formId}`);
    toast.success(m.recruit_link_copied());
  }

  $effect(() => {
    if (activeTab === 'google-forms') untrack(fetchForms);
  });
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet statusBadge(status: string)}
  <span class="badge {STATUS_BADGE[status as Status] ?? 'badge-neutral'}">{statusLabel(status)}</span>
{/snippet}

<ModulePage title={m.recruit_page_title()} description={m.recruit_page_desc()} icon="person-add" featureKey="recruitment">
  {#snippet actions()}
    <div class="flex flex-wrap items-center gap-2">
      <Tabs
        label={m.nav_recruitment()}
        tabs={[
          { id: 'candidatures', label: m.recruit_tab_applications(), icon: 'people' },
          { id: 'google-forms', label: m.recruit_tab_google_forms(), icon: 'description' },
        ]}
        active={activeTab}
        onchange={(id) => (activeTab = id as typeof activeTab)}
      />
      <RefreshButton
        onClick={activeTab === 'candidatures' ? fetchInitialData : fetchForms}
        loading={activeTab === 'candidatures' ? loading : formsLoading}
        label={m.recruit_refresh()}
      />
      {#if activeTab === 'google-forms' && canManageSettings}
        <Button variant="primary" icon="add" onclick={() => (showCreateModal = true)}>{m.recruit_new_google_form()}</Button>
      {/if}
      {#if canManageSettings}
        <Button icon="settings" aria-label={m.recruit_module_settings_tooltip()} title={m.recruit_module_settings_tooltip()} onclick={openConfig} />
      {/if}
    </div>
  {/snippet}

  {#if activeTab === 'candidatures'}
    {#if loading && candidatures.length === 0}
      <div class="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Skeleton height="420px" radius="1rem" />
        <Skeleton height="420px" radius="1rem" />
      </div>
    {:else if error}
      <Callout variant="danger" title={error}>
        {#snippet actions()}
          <Button size="sm" icon="refresh" onclick={fetchInitialData}>{m.recruit_refresh()}</Button>
        {/snippet}
      </Callout>
    {:else if candidatures.length === 0}
      <div class="section-card">
        {#if canManageSettings}
          <EmptyState icon="person_add_disabled" title={m.recruit_empty_title()} description={m.recruit_empty_desc()} actionLabel={m.recruit_empty_action()} actionHref="/forms" />
        {:else}
          <EmptyState icon="person_add_disabled" title={m.recruit_empty_title()} description={m.recruit_empty_desc()} reason="accumulating" />
        {/if}
      </div>
    {:else}
      <div class="space-y-4">
        <div class="flex flex-col gap-3">
          <FilterPills label={m.recruit_tab_applications()} options={filterOptions} value={filter} onchange={(v) => (filter = v)} />
          <div class="flex flex-wrap items-center gap-2">
            <div class="relative flex-1 min-w-56">
              <Papicon icon="search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
              <input type="search" class="input pl-9" bind:value={search} placeholder={m.recruit_search_ph()} aria-label={m.recruit_search_ph()} />
            </div>
            {#if formOptions.length > 1}
              <select class="input w-auto" bind:value={formFilter} aria-label={m.recruit_filter_form_aria()}>
                <option value="">{m.recruit_filter_form_all()}</option>
                {#each formOptions as option (option.id)}
                  <option value={option.id}>{option.name}</option>
                {/each}
              </select>
            {/if}
            <select class="input w-auto" bind:value={sortOldest} aria-label={m.recruit_sort_aria()}>
              <option value={false}>{m.recruit_sort_newest()}</option>
              <option value={true}>{m.recruit_sort_oldest()}</option>
            </select>
          </div>
        </div>

        {#if visible.length === 0}
          <div class="section-card">
            <EmptyState
              icon={filter === 'PENDING' && !search && !formFilter ? 'inbox' : 'filter_list_off'}
              title={search.trim() ? m.recruit_empty_search({ q: search.trim() }) : filter === 'PENDING' ? m.recruit_empty_pending() : m.recruit_empty_filtered({ status: filter === 'ALL' ? m.recruit_filter_all() : statusLabel(filter) })}
              description={m.recruit_empty_filtered_hint()}
              actionLabel={m.recruit_show_all()}
              actionIcon="filter_list_off"
              onAction={() => { filter = 'ALL'; search = ''; formFilter = ''; }}
            />
          </div>
        {:else}
          <div class="grid gap-4 lg:grid-cols-[minmax(18rem,22rem)_1fr] items-start">
            {#if wide || !selected}
              <div class="section-card overflow-hidden">
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <ul class="rc-list" aria-label={m.recruit_tab_applications()} onkeydown={onListKeydown}>
                  {#each visible as c (c.id)}
                    <li>
                      <button
                        id="cand-{c.id}"
                        type="button"
                        class="rc-row {c.id === selectedId ? 'rc-row--active' : ''}"
                        aria-current={c.id === selectedId ? 'true' : undefined}
                        onclick={() => select(c.id)}
                      >
                        <span class="rc-avatar" aria-hidden="true">{nameOf(c).charAt(0).toUpperCase()}</span>
                        <span class="min-w-0 flex-1 text-left">
                          <span class="flex items-center gap-1.5">
                            <span class="text-body-sm font-medium text-on-surface truncate">{nameOf(c)}</span>
                            {#if c.notes}
                              <Papicon icon="message-square" size={12} class="text-on-surface-variant shrink-0" />
                            {/if}
                          </span>
                          <span class="block text-2xs text-on-surface-variant truncate">
                            {formNames[formOf(c)] ? `${formNames[formOf(c)]} · ` : ''}{formatRelative(c.createdAt)}
                          </span>
                        </span>
                        {#if filter === 'ALL'}
                          {@render statusBadge(c.status)}
                        {/if}
                      </button>
                    </li>
                  {/each}
                </ul>
                <p class="hidden lg:block px-4 py-2 border-t border-outline-variant text-2xs text-on-surface-variant">{m.recruit_keyboard_hint()}</p>
              </div>
            {/if}

            {#if selected}
              {@const answers = answersOf(selected)}
              <section class="section-card p-5 space-y-5 min-w-0 lg:sticky lg:top-4" aria-label={nameOf(selected)}>
                <header class="flex items-start gap-3">
                  {#if !wide}
                    <Button variant="ghost" size="sm" icon="chevron-left" aria-label={m.recruit_back_to_list()} onclick={() => (selectedId = null)} />
                  {/if}
                  <span class="rc-avatar rc-avatar--lg" aria-hidden="true">{nameOf(selected).charAt(0).toUpperCase()}</span>
                  <div class="min-w-0 flex-1">
                    <h2 class="text-base font-semibold text-on-surface truncate">{nameOf(selected)}</h2>
                    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-on-surface-variant">
                      {@render statusBadge(selected.status)}
                      {#if formNames[formOf(selected)]}
                        <span>{formNames[formOf(selected)]}</span>
                      {/if}
                      <span title={new Date(selected.createdAt).toLocaleString(dateLocale())}>{formatRelative(selected.createdAt)}</span>
                      {#if selected.discordId}
                        <button type="button" class="inline-flex items-center gap-1 font-mono hover:text-primary" title={m.recruit_copy_id()} onclick={() => copyDiscordId(selected.discordId)}>
                          {selected.discordId}
                          <Papicon icon="content_copy" size={11} />
                        </button>
                      {/if}
                    </div>
                  </div>
                  {#if canModerate}
                    <Menu
                      label={m.recruit_candidate_options({ name: nameOf(selected) })}
                      items={[{ label: m.recruit_delete_tooltip(), icon: 'delete', onselect: () => deleteCandidature(selected) }]}
                    />
                  {/if}
                </header>

                {#if canModerate && ['PENDING', 'AUTO_REJECTED', 'ORAL'].includes(selected.status)}
                  <div class="flex flex-wrap gap-2">
                    {#if selected.status === 'PENDING'}
                      <Button variant="primary" icon="check_circle" disabled={acting} onclick={() => openValidate(selected)}>{m.recruit_action_to_oral()}</Button>
                      <Button variant="danger" icon="cancel" disabled={acting} onclick={() => openReject(selected)}>{m.recruit_action_reject()}</Button>
                    {:else if selected.status === 'AUTO_REJECTED'}
                      <Button variant="primary" icon="verified" disabled={acting} onclick={() => openValidate(selected)}>{m.recruit_action_accept_anyway()}</Button>
                    {:else}
                      <Button variant="primary" icon="how_to_reg" disabled={acting} onclick={() => openOralPass(selected)}>{m.recruit_action_oral_pass()}</Button>
                      <Button variant="danger" icon="thumb_down" disabled={acting} onclick={() => openOralFail(selected)}>{m.recruit_action_oral_fail()}</Button>
                    {/if}
                  </div>
                {/if}

                {#if selected.autoRejected && selected.autoRejectReason}
                  <Callout variant="danger" icon="robot_2" title={m.recruit_auto_reject_reason()}>{selected.autoRejectReason}</Callout>
                {/if}
                {#if selected.status === 'REJECTED' && selected.rejectionReason}
                  <Callout variant="info" title={m.recruit_rejection_reason()}>{selected.rejectionReason}</Callout>
                {/if}
                {#if selected.oralNotes}
                  <Callout variant="info" icon="forum" title={m.recruit_interview_notes_label()}>{selected.oralNotes}</Callout>
                {/if}
                {#if selected.status === 'ORAL' && selected.ticketChannelId}
                  <p class="flex items-center gap-2 text-body-sm text-on-surface-variant"><Papicon icon="forum" size={14} /> {m.recruit_ticket_created()}</p>
                {/if}
                {#if selected.reapplyAfter && new Date(selected.reapplyAfter) > new Date()}
                  <p class="flex items-center gap-2 text-body-sm text-on-surface-variant">
                    <Papicon icon="schedule" size={14} />
                    {m.recruit_reapply_after({ date: new Date(selected.reapplyAfter).toLocaleDateString(dateLocale()) })}
                  </p>
                {/if}

                <div>
                  <h3 class="text-body-sm font-semibold text-on-surface mb-1">{m.recruit_answers_title()}</h3>
                  {#if answers.length === 0}
                    <p class="text-body-sm text-on-surface-variant">{m.recruit_no_answers()}</p>
                  {:else}
                    <dl class="divide-y divide-outline-variant">
                      {#each answers as [key, value] (key)}
                        <div class="py-3">
                          <dt class="text-2xs font-medium text-on-surface-variant">{fieldLabels[key] || key}</dt>
                          <dd class="mt-1 text-body-sm text-on-surface whitespace-pre-wrap wrap-break-word">{formatValue(value)}</dd>
                        </div>
                      {/each}
                    </dl>
                  {/if}
                </div>

                <Field
                  label={m.recruit_notes_label()}
                  hint={notesState === 'saving' ? m.recruit_saving() : notesState === 'saved' ? m.recruit_notes_saved() : m.recruit_notes_hint()}
                >
                  {#snippet children(id, describedBy)}
                    <textarea
                      {id}
                      aria-describedby={describedBy}
                      class="input h-28 resize-y"
                      bind:value={notesDraft}
                      oninput={() => (notesState = 'idle')}
                      onblur={saveNotes}
                      readonly={!canModerate}
                      placeholder={m.recruit_notes_ph()}
                    ></textarea>
                  {/snippet}
                </Field>
              </section>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    {#if formsLoading && forms.length === 0}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each Array(3) as _, i (i)}
          <Skeleton height="200px" radius="1rem" />
        {/each}
      </div>
    {:else if formsError}
      <Callout variant="danger" title={formsError}>
        {#snippet actions()}
          <Button size="sm" icon="refresh" onclick={fetchForms}>{m.recruit_refresh()}</Button>
        {/snippet}
      </Callout>
    {:else if forms.length === 0}
      <div class="section-card">
        {#if canManageSettings}
          <EmptyState icon="description" title={m.recruit_forms_empty_title()} description={m.recruit_forms_empty_desc()} actionLabel={m.recruit_new_google_form()} onAction={() => (showCreateModal = true)} />
        {:else}
          <EmptyState icon="description" title={m.recruit_forms_empty_title()} description={m.recruit_forms_empty_desc()} reason="read-only" />
        {/if}
      </div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each forms as form (form.id)}
          <article class="section-card p-5 flex flex-col gap-4">
            <header class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-base font-semibold text-on-surface truncate">{form.name}</h3>
                {#if form.description}
                  <p class="text-body-sm text-on-surface-variant mt-1 line-clamp-2">{form.description}</p>
                {/if}
              </div>
              <span class="badge {form.isActive ? 'badge-success' : 'badge-neutral'}">{form.isActive ? m.recruit_form_active() : m.recruit_form_inactive()}</span>
            </header>

            <dl class="space-y-2 text-body-sm text-on-surface-variant">
              {#if form.apiKey}
                <div class="flex items-center gap-2">
                  <dt>{m.recruit_form_api_key()}</dt>
                  <dd class="font-mono text-2xs bg-surface-container px-2 py-0.5 rounded">{form.apiKey.displayKey}</dd>
                </div>
              {:else}
                <div class="flex items-center gap-2 min-w-0">
                  <dt class="sr-only">{m.recruit_copy_link_tooltip()}</dt>
                  <dd class="truncate font-mono text-2xs">{window.location.origin}/form/{form.id}</dd>
                  <Button variant="ghost" size="sm" icon="content_copy" aria-label={m.recruit_copy_link_tooltip()} onclick={() => copyFormLink(form.id)} />
                </div>
              {/if}
              <div class="flex items-center gap-2">
                <Papicon icon="send" size={14} />
                <dd>{m.recruit_applications_received({ count: form._count?.candidatures || 0 })}</dd>
              </div>
            </dl>

            {#if canManageSettings}
              <footer class="mt-auto flex items-center gap-2">
                {#if form.apiKey}
                  <Button size="sm" icon="code" class="flex-1" title={m.recruit_script_tooltip()} onclick={() => showGoogleAppsScript(form)}>{m.recruit_script_btn()}</Button>
                  <Button size="sm" variant="ghost" icon="refresh" aria-label={m.recruit_regen_tooltip()} title={m.recruit_regen_tooltip()} onclick={() => regenerateAPIKey(form.id)} />
                {/if}
                <Button size="sm" variant="ghost" icon="delete" aria-label={m.recruit_delete_form_tooltip()} title={m.recruit_delete_form_tooltip()} onclick={() => deleteForm(form.id)} />
              </footer>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  {/if}
</ModulePage>

<!-- Passage a l'oral / acceptation malgre le refus automatique -->
<Modal open={!!validateTarget} onClose={() => (validateTarget = null)} title={m.recruit_validate_modal_title()} subtitle={m.recruit_validate_modal_desc()}>
  <form id="rc-validate" onsubmit={(e) => { e.preventDefault(); void submitValidate(); }}>
    <Field label={m.recruit_validate_field_id()} hint={m.recruit_validate_field_hint()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input font-mono" bind:value={validationDiscordId} placeholder={m.recruit_field_category_ph()} />
      {/snippet}
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (validateTarget = null)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="rc-validate" loading={acting} disabled={!validationDiscordId.trim()} disabledReason={m.common_reason_fill_field()}>
      {m.recruit_validate_submit()}
    </Button>
  {/snippet}
</Modal>

<Modal open={!!rejectTarget} onClose={() => (rejectTarget = null)} title={m.recruit_reject_modal_title()} subtitle={m.recruit_reject_modal_desc()}>
  <Field label={m.recruit_reason_label()}>
    {#snippet children(id, describedBy)}
      <textarea {id} aria-describedby={describedBy} class="input h-28 resize-none" bind:value={rejectReason} placeholder={m.recruit_reject_reason_ph()}></textarea>
    {/snippet}
  </Field>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (rejectTarget = null)}>{m.common_cancel()}</Button>
    <Button variant="danger" loading={acting} onclick={submitReject}>{m.recruit_reject_submit()}</Button>
  {/snippet}
</Modal>

<Modal open={!!oralPassTarget} onClose={() => (oralPassTarget = null)} title={m.recruit_oral_pass_title()} subtitle={m.recruit_oral_pass_desc()}>
  <div class="space-y-4">
    <Field label={m.recruit_assign_tutor_label()} error={tutors.length === 0 ? m.recruit_no_tutor_found() : ''}>
      {#snippet children(id)}
        <SearchableSelect
          {id}
          bind:value={tutorSelected}
          options={tutors.map((t) => ({ id: t.userId, name: `${t.displayName || t.username} (${t.grade})` }))}
          placeholder={m.recruit_select_tutor()}
          showId={false}
          className="w-full"
        />
      {/snippet}
    </Field>
    <Field label={m.recruit_hierarchy_label()}>
      {#snippet children(id)}
        <select {id} class="input" value={selectedHierarchyId} onchange={(e) => pickHierarchy((e.target as HTMLSelectElement).value)}>
          <option value="">{m.recruit_hierarchy_none()}</option>
          {#each hierarchies as h (h.id)}
            <option value={h.id}>{h.name}</option>
          {/each}
        </select>
      {/snippet}
    </Field>
    {#if selectedHierarchyId}
      <Field label={m.recruit_hierarchy_grade_label()}>
        {#snippet children(id)}
          <select {id} class="input" bind:value={selectedHierarchyGrade}>
            <option value="">{m.recruit_hierarchy_grade_none()}</option>
            {#each hierarchyRoles as r (r.name)}
              <option value={r.name}>{r.name}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
    {/if}
    <Field label={m.recruit_interview_notes_label()}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input h-24 resize-none" bind:value={oralPassNotes} placeholder={m.recruit_interview_notes_ph()}></textarea>
      {/snippet}
    </Field>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (oralPassTarget = null)}>{m.common_cancel()}</Button>
    <Button variant="primary" loading={acting} onclick={submitOralPass}>{m.recruit_oral_pass_submit()}</Button>
  {/snippet}
</Modal>

<Modal open={!!oralFailTarget} onClose={() => (oralFailTarget = null)} title={m.recruit_oral_fail_title()} subtitle={m.recruit_oral_fail_desc()}>
  <Field label={m.recruit_reason_label()}>
    {#snippet children(id, describedBy)}
      <textarea {id} aria-describedby={describedBy} class="input h-28 resize-none" bind:value={oralFailReason} placeholder={m.recruit_oral_fail_reason_ph()}></textarea>
    {/snippet}
  </Field>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (oralFailTarget = null)}>{m.common_cancel()}</Button>
    <Button variant="danger" loading={acting} onclick={submitOralFail}>{m.recruit_oral_fail_submit()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={configOpen} title={m.recruit_config_modal_title()} subtitle={m.recruit_config_modal_desc()} size="lg">
  <div class="space-y-5">
    <Field label={m.recruit_field_log_channel()}>
      {#snippet children(id)}
        <SearchableSelect
          {id}
          bind:value={cfgLogChannelId}
          options={(dashboardStore.state.discordChannels as any[]).map((c) => ({ id: c.id, name: `#${c.name}` }))}
          placeholder={m.recruit_select_channel()}
          className="w-full"
        />
      {/snippet}
    </Field>
    <Field label={m.recruit_field_category()} hint={m.recruit_field_category_hint()}>
      {#snippet children(id)}
        <SearchableSelect
          {id}
          bind:value={cfgCategoryId}
          options={(dashboardStore.state.discordCategories as any[]).map((c) => ({ id: c.id, name: c.name }))}
          placeholder={m.recruit_select_category()}
          className="w-full"
        />
      {/snippet}
    </Field>
    {#if featureConfig}
      <div class="pt-5 border-t border-outline-variant">
        <RolePermissionSettings featureKey="recruitment" roleAccess={featureConfig.roleAccessByRole} />
      </div>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (configOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" loading={saveAction.state.loading} onclick={saveConfig}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<Modal bind:open={showCreateModal} title={m.recruit_create_form_title()} subtitle={m.recruit_create_form_desc()}>
  <form id="rc-create-form" class="space-y-4" onsubmit={createForm}>
    <Field label={m.recruit_form_name_label()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input" bind:value={newFormName} placeholder={m.recruit_form_name_ph()} />
      {/snippet}
    </Field>
    <Field label={m.recruit_form_desc_label()}>
      {#snippet children(id, describedBy)}
        <textarea {id} aria-describedby={describedBy} class="input h-24 resize-none" bind:value={newFormDescription} placeholder={m.recruit_form_desc_ph()}></textarea>
      {/snippet}
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (showCreateModal = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="rc-create-form" loading={createFormAction.state.loading} disabled={!newFormName.trim()} disabledReason={m.common_reason_fill_field()}>
      {m.recruit_create_form_submit()}
    </Button>
  {/snippet}
</Modal>

<Modal bind:open={showScriptModal} title={m.recruit_script_modal_title()} subtitle={m.recruit_script_modal_form({ name: selectedForm?.name ?? '' })} size="xl">
  <div class="space-y-4">
    <Callout variant="info" title={m.recruit_script_install_title()}>
      <ol class="list-decimal list-inside space-y-1">
        <li>{m.recruit_script_step1()}</li>
        <li>{m.recruit_script_step2()}</li>
        <li>{m.recruit_script_step3()}</li>
        <li>{m.recruit_script_step4()}</li>
        <li>{m.recruit_script_step5()}</li>
        <li>{m.recruit_script_step6()}</li>
      </ol>
    </Callout>
    <pre class="bg-surface-container rounded-lg p-4 text-2xs font-mono overflow-x-auto whitespace-pre-wrap text-on-surface max-h-[40vh] overflow-y-auto">{generatedScript}</pre>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (showScriptModal = false)}>{m.recruit_close_btn()}</Button>
    <Button variant="primary" icon="content_copy" onclick={() => { void navigator.clipboard.writeText(generatedScript); toast.success(m.recruit_script_copied()); }}>
      {m.recruit_copy_btn()}
    </Button>
  {/snippet}
</Modal>

<Modal bind:open={showKeyModal} title={m.recruit_key_modal_title()} subtitle={m.recruit_key_modal_subtitle()} closeOnBackdropClick={false}>
  <div class="space-y-4">
    <Callout variant="warning" title={m.recruit_key_warning_title()}>{m.recruit_key_warning_desc()}</Callout>
    <div class="flex items-center gap-2">
      <code class="flex-1 min-w-0 bg-surface-container rounded-lg px-3 py-2.5 text-body-sm font-mono break-all select-all text-on-surface">{newlyGeneratedKey}</code>
      <Button icon={keyCopied ? 'check' : 'content_copy'} onclick={copyKeyToClipboard}>{keyCopied ? m.recruit_copied_btn() : m.recruit_copy_btn()}</Button>
    </div>
  </div>
  {#snippet footer()}
    <Button variant="primary" onclick={() => (showKeyModal = false)}>{m.recruit_key_ack_btn()}</Button>
  {/snippet}
</Modal>

<style>
  .rc-list {
    max-height: 70vh;
    overflow-y: auto;
  }
  .rc-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    border-left: 2px solid transparent;
    transition: background-color 0.15s ease;
  }
  .rc-row:hover {
    background: var(--color-surface-container);
  }
  .rc-row--active {
    background: var(--color-surface-container);
    border-left-color: var(--color-primary);
  }
  .rc-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
    background: var(--color-surface-container-high);
    color: var(--color-primary);
    font-weight: 600;
    font-size: 0.8125rem;
  }
  .rc-avatar--lg {
    width: 2.75rem;
    height: 2.75rem;
    font-size: 1.125rem;
  }
</style>
