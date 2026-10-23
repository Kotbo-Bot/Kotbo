<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  import { Tabs } from '../lib/components/ui';
  import { m, dateLocale } from '../lib/i18n';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { fetchFeatureConfigurations, updateRecruitmentConfig, fetchStaffHierarchies, dashboardFetch } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';

  let candidatures = $state<any[]>([]);
  let tutors = $state<any[]>([]);
  // Mapping id de champ (ex: f_1782999782943_x469d) → intitulé de la question,
  // construit depuis les structures des formulaires (builder + custom forms)
  let fieldLabels = $state<Record<string, string>>({});
  let guildState = $state<any>(null); // from global state if needed, or fetched config
  
  let loading = $state(true);
  
  let hierarchies = $state<any[]>([]);
  let selectedHierarchyId = $state('');
  let selectedHierarchyGrade = $state('');

  $effect(() => {
    if (selectedHierarchyId) {
      const h = hierarchies.find(x => x.id === selectedHierarchyId);
      if (h && h.roles && h.roles.length > 0) {
        const sorted = [...h.roles].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        selectedHierarchyGrade = sorted[0]?.name || '';
      } else {
        selectedHierarchyGrade = '';
      }
    } else {
      selectedHierarchyGrade = '';
    }
  });
  let error = $state('');

  let filter = $state('PENDING'); // ALL, PENDING, ORAL, APPROVED, REJECTED, AUTO_REJECTED
  
  let configVisible = $state(false);
  
  const saveAction = createAsyncActionState();

  let recruitmentCategoryId = $state('');
  let recruitmentLogChannelId = $state('');
  let recruitmentAutoRejectEnabled = $state<boolean>(true);

  $effect(() => {
    if (!guildState) return;
    if (recruitmentCategoryId === '') {
      recruitmentCategoryId = guildState.recruitmentCategoryId ?? '';
    }
    if (recruitmentLogChannelId === '') {
      recruitmentLogChannelId = guildState.recruitmentLogChannelId ?? '';
    }
  });

  let featureConfig = $state<any>(null);
  let loadingConfig = $state(false);

  async function loadFeatureConfig() {
    loadingConfig = true;
    try {
      const configs = await fetchFeatureConfigurations();
      featureConfig = configs?.features?.find((c: any) => c.featureKey === 'recruitment') || null;
      if (featureConfig) {
        recruitmentCategoryId = featureConfig.secondaryChannelId || ''; // categoryId is stored in secondaryChannelId for recruitment usually
        recruitmentLogChannelId = featureConfig.channelId || '';
        recruitmentAutoRejectEnabled = featureConfig.enabled;
      }
    } catch (err) {
      console.error('Error fetching recruitment config:', err);
    } finally {
      loadingConfig = false;
    }
  }

  const canView = $derived(
    !!(dashboardStore.state.featureAccess as any)?.recruitment?.canView
      || !!dashboardStore.state.access?.canManageSettings
  );
  const canModerate = $derived(
    !!(dashboardStore.state.featureAccess as any)?.recruitment?.canModerate
      || !!dashboardStore.state.access?.canManageSettings
  );
  const canManageSettings = $derived(
    !!(dashboardStore.state.featureAccess as any)?.recruitment?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );
  
  // Modals state
  let validateModalTarget = $state<any>(null);
  let validationDiscordId = $state('');
  
  let rejectModalTarget = $state<any>(null);
  let rejectReason = $state('');
  
  let oralPassModalTarget = $state<any>(null);
  let tutorSelected = $state('');
  let oralPassNotes = $state('');
  
  let oralFailModalTarget = $state<any>(null);
  let oralFailReason = $state('');

  const filteredCandidatures = $derived(
     filter === 'ALL' ? candidatures : candidatures.filter(c => c.status === filter)
  );

  const stats = $derived({
    total: candidatures.length,
    pending: candidatures.filter(c => c.status === 'PENDING').length,
    oral: candidatures.filter(c => c.status === 'ORAL').length,
    approved: candidatures.filter(c => c.status === 'APPROVED').length,
    autoRejected: candidatures.filter(c => c.status === 'AUTO_REJECTED').length,
  });

  async function fetchInitialData() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      // Fetch state for config
      const resState = await dashboardFetch(`/state`);
      if (resState.ok) {
        guildState = await resState.json();
        recruitmentCategoryId = guildState.recruitmentCategoryId || '';
        recruitmentLogChannelId = guildState.recruitmentLogChannelId || '';
        recruitmentAutoRejectEnabled = guildState.recruitmentAutoRejectEnabled !== false;
      }
      
      const [resCand, resTutors, resForms, resCustomForms] = await Promise.all([
        dashboardFetch(`/recruitment/candidatures`),
        dashboardFetch(`/recruitment/tutors`),
        dashboardFetch(`/recruitment/forms`).catch(() => null),
        dashboardFetch(`/custom-forms?includeStructure=true`).catch(() => null)
      ]);

      if (!resCand.ok) throw new Error(m.recruit_err_load_applications());
      const dataCand = await resCand.json();
      candidatures = dataCand.candidatures || [];

      if (resTutors.ok) {
        const dataTutors = await resTutors.json();
        tutors = dataTutors.tutors || [];
      }

      const labels: Record<string, string> = {};
      for (const res of [resForms, resCustomForms]) {
        if (!res?.ok) continue;
        try {
          const data = await res.json();
          for (const f of data.forms || []) {
            for (const field of f.structure?.fields || []) {
              if (field?.id && field?.label) labels[field.id] = field.label;
            }
          }
        } catch { /* formulaire illisible : on garde les ids bruts */ }
      }
      fieldLabels = labels;
      
      try {
        const dataH = await fetchStaffHierarchies();
        hierarchies = dataH?.hierarchies || [];
      } catch (err) {
        console.error('Error fetching hierarchies in recruitment page:', err);
      }
      
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  // `canView` depend de dashboardStore.state.featureAccess, rempli par un
  // fetch asynchrone : au montage il vaut encore `false` la plupart du temps,
  // donc un simple `onMount` qui le teste une fois ratait le chargement et
  // laissait la page tourner en boucle sur son squelette. On attend ici que
  // `canView` devienne vrai, puis on ne charge qu'une seule fois.
  let initialLoadStarted = $state(false);
  $effect(() => {
    if (!canView || initialLoadStarted) return;
    initialLoadStarted = true;
    void Promise.all([
      fetchInitialData(),
      loadFeatureConfig()
    ]);
  });

  async function updateConfig(payload: any) {
    await saveAction.run(async () => {
      const ok = await updateRecruitmentConfig(payload);
      if (!ok) throw new Error(m.recruit_err_api());

      await dashboardStore.refresh();
      configVisible = false;
      return true;
    }, { successMessage: m.recruit_config_saved() });
  }

  async function doAction(candidatureId: string, action: string, data: any = {}) {
    loading = true;
    try {
      const res = await dashboardFetch(`/recruitment/candidatures/${candidatureId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action, ...data })
      });
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.error || m.recruit_err_action_failed());
      }
      await fetchInitialData();
    } catch (err) {
      toast.error(errorMessage(err));
      loading = false;
    }
  }

  async function deleteCandidature(candidatureId: string) {
    if (!(await confirmDialog.danger(m.recruit_confirm_delete_title(), m.recruit_confirm_delete_desc()))) return;
    loading = true;
    try {
      const res = await dashboardFetch(`/recruitment/candidatures/${candidatureId}`, {
        method: 'DELETE'
        });
      if (!res.ok) {
        throw new Error(m.recruit_err_delete());
      }
      await fetchInitialData();
    } catch (err) {
      toast.error(errorMessage(err));
      loading = false;
    }
  }

  function getStatusLabel(status: string) {
    switch (status) {
      case 'PENDING': return m.recruit_status_pending();
      case 'ORAL': return m.recruit_status_oral();
      case 'APPROVED': return m.recruit_status_approved();
      case 'REJECTED': return m.recruit_status_rejected();
      case 'AUTO_REJECTED': return m.recruit_status_auto_rejected();
      default: return status;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'PENDING': return 'bg-warning/10 text-warning border-warning/20';
      case 'ORAL': return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
      case 'APPROVED': return 'bg-success/10 text-success border-success/20';
      case 'REJECTED': return 'bg-error/10 text-error border-error/20';
      case 'AUTO_REJECTED': return 'bg-rose-900/20 text-error border-rose-900/30';
      default: return 'bg-outline-variant/10 text-on-surface-variant border-outline-variant/20';
    }
  }

  function formatValue(val: any) {
    if (Array.isArray(val)) return val.join(', ');
    return String(val);
  }
  
  function openValidateModal(c: any) {
    validateModalTarget = c;
    validationDiscordId = c.discordId || '';
  }
  
  function openRejectModal(c: any) {
    rejectModalTarget = c;
    rejectReason = '';
  }
  
  function openOralPassModal(c: any) {
    oralPassModalTarget = c;
    tutorSelected = '';
    oralPassNotes = '';
    selectedHierarchyId = '';
    selectedHierarchyGrade = '';
  }
  
  function openOralFailModal(c: any) {
    oralFailModalTarget = c;
    oralFailReason = '';
  }

  let activeTab = $state<'candidatures' | 'google-forms'>('candidatures');
  
  // Google Forms state
  let forms = $state<any[]>([]);
  let formsLoading = $state(false);
  let formsError = $state('');
  
  let showCreateModal = $state(false);
  let showScriptModal = $state(false);
  let selectedForm = $state<any>(null);
  let generatedScript = $state('');

  // API Key success modal state
  let newlyGeneratedKey = $state('');
  let showKeyModal = $state(false);
  let keyCopied = $state(false);

  // New form state
  let newFormName = $state('');
  let newFormDescription = $state('');

  const createFormAction = createAsyncActionState();
  const deleteFormAction = createAsyncActionState();
  const regenerateKeyAction = createAsyncActionState();

  function copyKeyToClipboard() {
    navigator.clipboard.writeText(newlyGeneratedKey);
    keyCopied = true;
    setTimeout(() => { keyCopied = false; }, 2000);
  }

  async function fetchForms() {
    if (!authStore.selectedGuildId) return;
    formsLoading = true;
    try {
      const res = await dashboardFetch(`/recruitment/forms`);
      if (!res.ok) throw new Error(m.recruit_err_load_forms());
      const data = await res.json();
      // Filter only Google Forms
      forms = (data.forms || []).filter((f: any) => f.structure?.type === 'google');
    } catch (err) {
      formsError = errorMessage(err);
    } finally {
      formsLoading = false;
    }
  }

  async function createForm() {
    if (!newFormName.trim()) return;

    await createFormAction.run(async () => {
      const structure = {
        title: newFormName,
        description: newFormDescription,
        type: 'google',
        fields: [
          {
            id: 'discord_id',
            type: 'short_text',
            label: m.recruit_form_default_discord_id_label(),
            description: m.recruit_form_default_discord_id_desc(),
            required: true,
          },
          {
            id: 'discord_username',
            type: 'short_text',
            label: m.recruit_form_default_username_label(),
            description: m.recruit_form_default_username_desc(),
            required: true,
          },
          {
            id: 'email',
            type: 'email',
            label: m.recruit_form_default_email_label(),
            description: m.recruit_form_default_email_desc(),
            required: true,
          },
          {
            id: 'age',
            type: 'number',
            label: m.recruit_form_default_age_label(),
            description: m.recruit_form_default_age_desc(),
            required: true,
          },
        ],
      };

      const res = await dashboardFetch(`/recruitment/forms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: newFormName,
          description: newFormDescription || undefined,
          template: 'google',
          structure
        })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || m.recruit_err_create_form());
      }
      const data = await res.json();
      newlyGeneratedKey = data.apiKey?.key || data.apiKey || ''; // fallback if API returns key directly
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
      const res = await dashboardFetch(`/recruitment/forms/${formId}`, {
        method: 'DELETE'
        });
      if (!res.ok) throw new Error(m.recruit_err_delete_form());
      await fetchForms();
      return true;
    }, { successMessage: m.recruit_form_deleted() });
  }

  async function regenerateAPIKey(formId: string) {
    if (!(await confirmDialog.ask({ title: m.recruit_confirm_regen_title(), description: m.recruit_confirm_regen_desc(), confirmLabel: m.recruit_confirm_regen_btn(), variant: 'warning' }))) return;

    await regenerateKeyAction.run(async () => {
      const res = await dashboardFetch(`/recruitment/forms/${formId}/regenerate-key`, {
        method: 'POST'
        });
      if (!res.ok) throw new Error(m.recruit_err_regen());
      const data = await res.json();
      newlyGeneratedKey = data.apiKey;
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
      const data = await res.json();
      generatedScript = data.script;
      showScriptModal = true;
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  $effect(() => {
    if (activeTab === 'google-forms') {
      fetchForms();
    }
  });

  import ModulePage from '../lib/components/ModulePage.svelte';

  import { errorMessage } from '@kotbo/shared';
</script>

<ModulePage 
  title={m.recruit_page_title()}
  description={m.recruit_page_desc()}

  icon="person-add"
  featureKey="recruitment"
>
  {#snippet actions()}
    <div class="flex flex-wrap items-center gap-3">
      <Tabs
        label={m.nav_recruitment()}
        tabs={[
          { id: 'candidatures', label: m.recruit_tab_applications(), icon: 'people' },
          { id: 'google-forms', label: m.recruit_tab_google_forms(), icon: 'description' },
        ]}
        active={activeTab}
        onchange={(id) => (activeTab = id as typeof activeTab)}
      />

      <RefreshButton onClick={activeTab === 'candidatures' ? fetchInitialData : fetchForms} loading={activeTab === 'candidatures' ? loading : formsLoading} label={m.recruit_refresh()} />

      {#if activeTab === 'google-forms' && canManageSettings}
        <button 
          onclick={() => showCreateModal = true}
          class="px-4 py-2.5 rounded-xl bg-primary text-white font-medium text-body-sm active:scale-[0.98] transition-all flex items-center gap-2"
        >
          <Papicon icon="add" size={16} />
          {m.recruit_new_google_form()}
        </button>
      {/if}

      {#if canManageSettings}
        <button 
          onclick={() => configVisible = true}
          class="p-2.5 rounded-xl bg-surface-container-high hover:bg-primary/10 hover:text-primary transition-all text-on-surface-variant"
          title={m.recruit_module_settings_tooltip()}
        >
          <Papicon icon="settings" size={18} />
        </button>
      {/if}
    </div>
  {/snippet}

  <div class="space-y-10">
    {#if activeTab === 'candidatures'}
      <div class="flex flex-wrap gap-4 mb-8">
      <div class="px-6 py-4 rounded-xl bg-surface-container-low/50 border border-outline-variant/10 flex items-center gap-4 hover:shadow-sm hover:shadow-primary/5 transition-all">
        <div class="w-10 h-10 rounded-lg bg-warning/10 text-warning flex items-center justify-center">
            <Papicon icon="pending_actions" size={18} />
        </div>
        <div class="text-xs">
            <p class="text-2xl font-semibold text-on-surface leading-none">{stats.pending}</p>
            <p class="text-xs text-on-surface-variant font-semibold mt-1">{m.recruit_stat_pending()}</p>
        </div>
      </div>
      <div class="px-6 py-4 rounded-xl bg-surface-container-low/50 border border-outline-variant/10 flex items-center gap-4 hover:shadow-sm hover:shadow-primary/5 transition-all">
        <div class="w-10 h-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center">
            <Papicon icon="forum" size={18} />
        </div>
        <div class="text-xs">
            <p class="text-2xl font-semibold text-on-surface leading-none">{stats.oral}</p>
            <p class="text-xs text-on-surface-variant font-semibold mt-1">{m.recruit_stat_oral()}</p>
        </div>
      </div>
      <div class="px-6 py-4 rounded-xl bg-error/10 border border-error/20 flex items-center gap-4 hover:shadow-sm hover:shadow-rose-500/20 transition-all">
        <div class="w-10 h-10 rounded-lg bg-background text-error flex items-center justify-center shadow-sm">
            <Papicon icon="block" size={18} />
        </div>
        <div class="text-xs text-error">
            <p class="text-2xl font-semibold leading-none">{stats.autoRejected}</p>
            <p class="text-xs font-semibold mt-1 opacity-70">{m.recruit_stat_auto_rejected()}</p>
        </div>
      </div>
    </div>

  <!-- Filters -->
  <div class="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
      {#each ['ALL', 'PENDING', 'ORAL', 'APPROVED', 'REJECTED', 'AUTO_REJECTED'] as f}
        <button 
           onclick={() => filter = f}
           class="px-6 py-2.5 rounded-full text-body-sm font-medium transition-all {filter === f ? 'bg-primary text-white scale-105' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'}">
           {f === 'ALL' ? m.recruit_filter_all() : getStatusLabel(f)}
        </button>
      {/each}
  </div>

  <!-- Content -->
  {#if loading && candidatures.length === 0}
    <div class="grid grid-cols-1 gap-6">
      {#each Array(3) as _}
        <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-8 animate-pulse flex flex-col xl:flex-row gap-8">
            <div class="flex-1 space-y-6">
                <div class="flex gap-4">
                    <div class="w-14 h-14 rounded-lg bg-surface-container"></div>
                    <div class="space-y-2 py-2 flex-1"><div class="h-5 bg-surface-container rounded-md w-1/3"></div><div class="h-4 bg-surface-container rounded-md w-1/4"></div></div>
                </div>
                <div class="grid grid-cols-2 gap-4"><div class="h-16 bg-surface-container rounded-xl"></div><div class="h-16 bg-surface-container rounded-xl"></div></div>
            </div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="rounded-xl border border-error/20 bg-error/10 px-8 py-10 text-center flex flex-col items-center">
      <Papicon icon="error" size={48} class="text-error mb-4" />
      <p class="text-xl font-bold text-error">{error}</p>
    </div>
  {:else if candidatures.length === 0}
    <div class="flex flex-col items-center justify-center py-32 text-on-surface-variant/30 border-2 border-dashed border-outline-variant/10 rounded-[4rem] bg-surface-container-low/20">
      <div class="w-24 h-24 rounded-xl bg-surface-container flex items-center justify-center mb-6 shadow-inner">
        <Papicon icon="person_add_disabled" size={48} />
      </div>
      <h3 class="text-2xl font-semibold tracking-tight text-on-surface/50">{m.recruit_empty_title()}</h3>
      <p class="mt-3 text-sm max-w-sm text-center opacity-60 leading-relaxed px-10">
        {m.recruit_empty_desc()}
      </p>
    </div>
  {:else}
    {#if filteredCandidatures.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-on-surface-variant/30 border-2 border-dashed border-outline-variant/10 rounded-[4rem] bg-surface-container-low/20">
        <div class="w-20 h-20 rounded-xl bg-surface-container flex items-center justify-center mb-6 shadow-inner opacity-50">
          <Papicon icon={filter === 'PENDING' ? 'inbox' : 'filter_list_off'} size={32} />
        </div>
        <h3 class="text-xl font-semibold tracking-tight text-on-surface/40">
          {filter === 'PENDING' ? m.recruit_empty_pending() : m.recruit_empty_filtered({ status: getStatusLabel(filter) })}
        </h3>
        <p class="mt-2 text-xs opacity-50">{m.recruit_empty_filtered_hint()}</p>
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-6">
        {#each filteredCandidatures as candidature (candidature.id)}
          <div class="relative group bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-8 hover:bg-surface-container-low transition-all duration-500 {candidature.status === 'AUTO_REJECTED' ? 'opacity-80 grayscale-30' : ''}">
            <div class="absolute -inset-1 bg-linear-to-r from-primary/10 to-secondary/10 rounded-[3.1rem] blur-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>

              <div class="relative flex flex-col xl:flex-row gap-8">
                  <!-- Main Info -->
                  <div class="flex-1 space-y-6">
                      <div class="flex items-center justify-between">
                          <div class="flex items-center gap-4">
                              <div class="w-14 h-14 rounded-lg bg-surface-container flex items-center justify-center text-primary font-semibold text-xl shadow-lg">
                                  {candidature.username?.charAt(0).toUpperCase() || '?'}
                              </div>
                              <div>
                                  <h3 class="text-xl font-semibold text-on-surface font-headline tracking-tight">{candidature.username || m.recruit_anonymous()}</h3>
                                  <div class="flex flex-wrap items-center gap-3 mt-1">
                                      <span class="text-xs font-bold text-on-surface-variant/75">{new Date(candidature.createdAt).toLocaleDateString(dateLocale())}</span>
                                      <span class="px-3 py-1 rounded-full text-xs font-semibold border {getStatusColor(candidature.status)}">
                                          {getStatusLabel(candidature.status)}
                                      </span>
                                      {#if candidature.discordId}
                                         <span class="text-2xs font-mono text-on-surface-variant">ID: {candidature.discordId}</span>
                                      {/if}
                                  </div>
                              </div>
                          </div>
                              {#if canModerate}
                                <button 
                                    onclick={() => deleteCandidature(candidature.id)}
                                    class="w-10 h-10 rounded-full bg-error/10 text-error hover:bg-rose-500 hover:text-white flex items-center justify-center transition-all opacity-0 group-hover:opacity-100"
                                    title={m.recruit_delete_tooltip()}
                                >
                                    <Papicon icon="delete" size={14} />
                                </button>
                              {/if}
                      </div>
                      
                      {#if candidature.autoRejected && candidature.autoRejectReason}
                          <div class="bg-error/10 border border-error/20 rounded-lg p-4 flex gap-4 text-error">
                             <Papicon icon="robot_2" size={20} class="shrink-0" />
                             <p class="text-sm font-medium">{candidature.autoRejectReason}</p>
                          </div>
                      {/if}

                      <!-- Details from Form -->
                      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {#each Object.entries(candidature.data) as [key, value]}
                             {#if typeof value !== 'object' || Array.isArray(value)}
                              <div class="space-y-1">
                                  <p class="text-xs font-semibold text-on-surface-variant leading-tight">{fieldLabels[key] || key}</p>
                                  <div class="text-sm font-medium text-on-surface/80 bg-surface-container/30 rounded-xl px-4 py-2 border border-outline-variant/5">
                                     <div class="max-h-32 overflow-y-auto scrollbar-hide whitespace-pre-wrap">{formatValue(value)}</div>
                                  </div>
                              </div>
                             {/if}
                          {/each}
                      </div>
                  </div>

                  <!-- Actions Side -->
                  <div class="xl:w-80 space-y-6 xl:border-l border-outline-variant/20 xl:pl-8">
                      <div>
                          <p class="text-xs font-medium text-primary mb-3">{m.recruit_notes_label()}</p>
                          <textarea 
                             bind:value={candidature.notes}
                             onblur={() => doAction(candidature.id, 'status_update', { status: candidature.status, notes: candidature.notes })}
                             placeholder={m.recruit_notes_ph()}
                             class="w-full h-32 bg-surface-container/50 border border-outline-variant/20 rounded-lg p-4 text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-hidden focus:border-primary/50 transition-all resize-none"></textarea>
                      </div>
                      
                      {#if candidature.status === 'ORAL' && candidature.ticketChannelId}
                         <div class="flex items-center gap-2 p-3 rounded-xl bg-surface-container-low text-xs font-medium text-on-surface-variant">
                            <Papicon icon="forum" size={16} /> {m.recruit_ticket_created()}
                         </div>
                      {/if}

                      {#if canModerate}
                        <div class="grid grid-cols-2 gap-3">
                             {#if candidature.status === 'PENDING'}
                                <button 
                                   onclick={() => openValidateModal(candidature)}
                                   class="col-span-2 py-3 rounded-lg bg-blue-600 text-white text-body-sm font-medium shadow-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2">
                                    <Papicon icon="check_circle" size={14} /> {m.recruit_action_to_oral()}
                                </button>
                                <button 
                                   onclick={() => openRejectModal(candidature)}
                                   class="col-span-2 py-3 rounded-lg bg-surface-container hover:bg-error/10 hover:text-error text-on-surface-variant text-body-sm font-medium transition-all">
                                    {m.recruit_action_reject()}
                                </button>
                             {/if}
                             {#if candidature.status === 'AUTO_REJECTED'}
                               <button 
                                 onclick={() => openValidateModal(candidature)}
                                 class="col-span-2 py-3 rounded-lg bg-emerald-600 text-white text-body-sm font-medium shadow-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2">
                                  <Papicon icon="verified" size={14} /> {m.recruit_action_accept_anyway()}
                               </button>
                             {/if}
                             {#if candidature.status === 'ORAL'}
                                <button 
                                   onclick={() => openOralPassModal(candidature)}
                                   class="py-3 rounded-lg bg-emerald-600 text-white text-body-sm font-medium shadow-sm active:scale-[0.98] transition-all flex items-center justify-center">
                                    {m.recruit_action_oral_pass()}
                                </button>
                                <button 
                                   onclick={() => openOralFailModal(candidature)}
                                   class="py-3 rounded-lg bg-rose-600 text-white text-body-sm font-medium shadow-sm active:scale-[0.98] transition-all flex items-center justify-center">
                                    {m.recruit_action_oral_fail()}
                                </button>
                             {/if}
                        </div>
                      {/if}
                      
                      {#if candidature.reapplyAfter && new Date(candidature.reapplyAfter) > new Date()}
                         <div class="text-xs font-semibold text-on-surface-variant text-center mt-2">
                           {m.recruit_reapply_after({ date: new Date(candidature.reapplyAfter).toLocaleDateString(dateLocale()) })}
                         </div>
                      {/if}
                  </div>
              </div>
           </div>
        {/each}
      </div>
    {/if}
  {/if}
{/if}

    {#if activeTab === 'google-forms'}
      {#if formsLoading && forms.length === 0}
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {#each Array(3) as _}
            <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-6 animate-pulse">
              <div class="h-6 bg-surface-container rounded-lg w-3/4 mb-4"></div>
              <div class="h-4 bg-surface-container rounded-lg w-1/2 mb-2"></div>
              <div class="h-20 bg-surface-container rounded-xl mt-4"></div>
            </div>
          {/each}
        </div>
      {:else if formsError}
        <div class="rounded-xl border border-error/20 bg-error/10 px-8 py-10 text-center flex flex-col items-center">
          <Papicon icon="error" size={48} class="text-error mb-4" />
          <p class="text-xl font-bold text-error">{formsError}</p>
        </div>
      {:else if forms.length === 0}
        <div class="flex flex-col items-center justify-center py-32 text-on-surface-variant/30 border-2 border-dashed border-outline-variant/10 rounded-[4rem] bg-surface-container-low/20 animate-in fade-in duration-300">
          <div class="w-24 h-24 rounded-xl bg-surface-container flex items-center justify-center mb-6 shadow-inner">
            <Papicon icon="description" size={48} />
          </div>
          <h3 class="text-2xl font-semibold tracking-tight text-on-surface/50">{m.recruit_forms_empty_title()}</h3>
          <p class="mt-3 text-sm max-w-sm text-center opacity-60 leading-relaxed px-10">
            {m.recruit_forms_empty_desc()}
          </p>
        </div>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-in fade-in duration-300">
          {#each forms as form (form.id)}
            <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-6 hover:bg-surface-container-low transition-all duration-300 group relative">
              <div class="absolute -inset-1 bg-linear-to-r from-primary/5 to-secondary/5 rounded-[1.3rem] blur-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
              
              <div class="relative space-y-4">
                <div class="flex items-start justify-between">
                  <div class="flex-1 min-w-0">
                    <h3 class="text-lg font-semibold text-on-surface truncate">{form.name}</h3>
                    {#if form.description}
                      <p class="text-xs text-on-surface-variant mt-1 line-clamp-2 leading-relaxed">{form.description}</p>
                    {/if}
                  </div>
                  <span class="px-2.5 py-1 rounded-full text-2xs font-semibold uppercase tracking-wider border {form.isActive ? 'bg-success/10 text-success border-success/20' : 'bg-error/10 text-error border-error/20'}">
                    {form.isActive ? m.recruit_form_active() : m.recruit_form_inactive()}
                  </span>
                </div>

                <div class="space-y-2.5 py-3 border-y border-outline-variant/10 text-xs text-on-surface-variant/75">
                  {#if form.apiKey}
                    <div class="flex items-center gap-2">
                      <Papicon icon="api" size={14} class="text-primary" />
                      <span class="font-medium">{m.recruit_form_api_key()}</span>
                      <span class="font-mono bg-surface-container px-2 py-0.5 rounded border border-outline-variant/10">{form.apiKey.displayKey}</span>
                    </div>
                  {:else}
                    <div class="flex items-center justify-between gap-2 min-w-0">
                      <div class="flex items-center gap-2 min-w-0">
                        <Papicon icon="link" size={14} class="text-primary" />
                        <span class="truncate font-mono">{window.location.origin}/form/{form.id}</span>
                      </div>
                      <button
                        onclick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/form/${form.id}`);
                          toast.success(m.recruit_link_copied());
                        }}
                        class="p-1 rounded-md hover:bg-surface-container-high transition-colors shrink-0 text-on-surface-variant/65"
                        title={m.recruit_copy_link_tooltip()}
                      >
                        <Papicon icon="content_copy" size={12} />
                      </button>
                    </div>
                  {/if}
                  <div class="flex items-center gap-2">
                    <Papicon icon="send" size={14} class="text-primary" />
                    <span>{m.recruit_applications_received({ count: form._count?.candidatures || 0 })}</span>
                  </div>
                </div>

                <div class="flex items-center gap-2 pt-1 font-inter">
                  {#if form.apiKey}
                    <button
                      onclick={() => showGoogleAppsScript(form)}
                      class="flex-1 py-2 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary text-body-sm font-medium transition-all flex items-center justify-center gap-1.5"
                      title={m.recruit_script_tooltip()}
                    >
                      <Papicon icon="code" size={14} />
                      {m.recruit_script_btn()}
                    </button>
                    <button
                      onclick={() => regenerateAPIKey(form.id)}
                      class="px-3 py-2 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface-variant text-xs font-semibold uppercase transition-all"
                      title={m.recruit_regen_tooltip()}
                    >
                      <Papicon icon="refresh" size={14} />
                    </button>
                  {/if}
                  <button
                    onclick={() => deleteForm(form.id)}
                    class="px-3 py-2 rounded-xl bg-error/10 hover:bg-rose-500 hover:text-white text-error text-xs font-semibold uppercase transition-all"
                    title={m.recruit_delete_form_tooltip()}
                  >
                    <Papicon icon="delete" size={14} />
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

<!-- ============================================== -->
<!-- MODALS -->
<!-- ============================================== -->

<!-- Config Modal -->
{#if configVisible}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-xl shadow-sm overflow-hidden animate-in zoom-in-95 duration-300 font-inter">
        <div class="p-8 border-b border-outline-variant/20 flex items-center justify-between bg-primary/5">
          <div>
            <h3 class="text-2xl font-semibold text-on-surface">{m.recruit_config_modal_title()}</h3>
            <p class="text-on-surface-variant text-sm">{m.recruit_config_modal_desc()}</p>
          </div>
          <button onclick={() => configVisible = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
            <Papicon icon="x" size={24} />
          </button>
        </div>
        
        <div class="p-8 space-y-8 max-h-[70vh] overflow-y-auto">
             <div class="space-y-4">
                <label class="block">
                  <span class="text-body-sm font-medium text-on-surface-variant ml-1 mb-2 block">{m.recruit_field_log_channel()}</span>
                  <FormSelect
                     bind:value={recruitmentLogChannelId}
                     className="w-full"
                  >
                    <option value="">{m.recruit_select_channel()}</option>
                    {#each (dashboardStore.state.discordChannels as any[]) as c}
                      <option value={c.id}>#{c.name}</option>
                    {/each}
                  </FormSelect>
                </label>

               <label class="block">
                 <span class="text-body-sm font-medium text-on-surface-variant ml-1 mb-2 block">{m.recruit_field_category_id()}</span>
                 <FormInput 
                   type="text" 
                   bind:value={recruitmentCategoryId} 
                   placeholder={m.recruit_field_category_ph()}
                   className="w-full"
                 />
               </label>

               </div>

               {#if featureConfig}
               <div class="pt-6 border-t border-outline-variant/10">
                 <RolePermissionSettings 
                   featureKey="recruitment" 
                   roleAccess={featureConfig.roleAccessByRole} 
                 />
               </div>
               {/if}
             </div>
        
        <div class="p-8 bg-surface-container-low border-t border-outline-variant/20 flex gap-4">
            <button onclick={() => configVisible = false} class="flex-1 py-4 rounded-xl font-bold bg-surface hover:bg-surface-hover transition-colors">{m.common_cancel()}</button>
            <button 
              onclick={updateConfig} 
              disabled={saveAction.state.loading}
              class="flex-1 py-4 rounded-xl font-semibold bg-primary text-on-primary active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {saveAction.state.loading ? m.recruit_saving() : m.common_save()}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- Validate Modal -->
{#if validateModalTarget}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
        <div class="flex items-center gap-4 mb-2 text-blue-500">
           <Papicon icon="check_circle" size={36} />
           <h3 class="text-2xl font-semibold">{m.recruit_validate_modal_title()}</h3>
        </div>
        <p class="text-sm text-on-surface-variant/80 mb-6">{m.recruit_validate_modal_desc()}</p>
        
        <div>
          <label for="validate-discord-id" class="field-label">{m.recruit_validate_field_id()}</label>
          <input id="validate-discord-id" type="text" bind:value={validationDiscordId} class="w-full bg-surface-container rounded-lg px-5 py-4 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm font-medium font-mono" placeholder={m.recruit_field_category_ph()}>
            <p class="text-2xs text-on-surface-variant mt-2">{m.recruit_validate_field_hint()}</p>
        </div>
        
        <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
            <button onclick={() => validateModalTarget = null} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
            <button 
               onclick={() => doAction(validateModalTarget.id, 'approve', { discordUserId: validationDiscordId }).then(() => validateModalTarget = null)} 
               use:explainDisabled={(!validationDiscordId) ? m.common_reason_fill_field() : ''}
               class="flex-1 py-4 rounded-xl font-bold bg-blue-600 text-white disabled:opacity-50 active:scale-[0.98] transition-transform shadow-sm">
               {m.recruit_validate_submit()}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- Reject Modal -->
{#if rejectModalTarget}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
        <div class="flex items-center gap-4 mb-2 text-error">
           <Papicon icon="cancel" size={36} />
           <h3 class="text-2xl font-semibold">{m.recruit_reject_modal_title()}</h3>
        </div>
        <p class="text-sm text-on-surface-variant/80 mb-6">{m.recruit_reject_modal_desc()}</p>
        
        <div>
          <label for="reject-reason" class="field-label">{m.recruit_reason_label()}</label>
          <textarea id="reject-reason" bind:value={rejectReason} class="w-full h-32 bg-surface-container rounded-lg p-4 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm" placeholder={m.recruit_reject_reason_ph()}></textarea>
        </div>
        
        <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
            <button onclick={() => rejectModalTarget = null} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
            <button 
               onclick={() => doAction(rejectModalTarget.id, 'reject', { reason: rejectReason }).then(() => rejectModalTarget = null)} 
               class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm">
               {m.recruit_reject_submit()}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- Oral Pass Modal -->
{#if oralPassModalTarget}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
        <div class="flex items-center gap-4 mb-2 text-success">
           <Papicon icon="how_to_reg" size={36} />
           <h3 class="text-2xl font-semibold">{m.recruit_oral_pass_title()}</h3>
        </div>
        <p class="text-sm text-on-surface-variant/80 mb-6">{m.recruit_oral_pass_desc()}</p>
        
        <div class="space-y-4 font-inter">
             <div>
               <label for="oral-pass-tutor" class="field-label">{m.recruit_assign_tutor_label()}</label>
               <select id="oral-pass-tutor" bind:value={tutorSelected} class="w-full bg-surface-container rounded-lg px-5 py-4 focus:outline-hidden text-sm font-medium border-r-8 border-transparent appearance-none">
                    <option value="" disabled>{m.recruit_select_tutor()}</option>
                    {#each tutors as tutor}
                       <option value={tutor.userId}>{tutor.displayName || tutor.username} ({tutor.grade})</option>
                    {/each}
                </select>
                {#if tutors.length === 0}
                   <p class="text-error text-xs mt-1">{m.recruit_no_tutor_found()}</p>
                {/if}
             </div>

             <div>
               <label for="oral-pass-hierarchy" class="field-label">{m.recruit_hierarchy_label()}</label>
               <select id="oral-pass-hierarchy" bind:value={selectedHierarchyId} class="w-full bg-surface-container rounded-lg px-5 py-4 focus:outline-hidden text-sm font-medium border-r-8 border-transparent appearance-none">
                    <option value="">{m.recruit_hierarchy_none()}</option>
                    {#each hierarchies as h}
                       <option value={h.id}>{h.name}</option>
                    {/each}
                </select>
             </div>

             {#if selectedHierarchyId}
               {@const hRoles = selectedHierarchyId ? hierarchies.find(h => h.id === selectedHierarchyId)?.roles || [] : []}
               <div>
                 <label for="oral-pass-hierarchy-grade" class="field-label">{m.recruit_hierarchy_grade_label()}</label>
                 <select id="oral-pass-hierarchy-grade" bind:value={selectedHierarchyGrade} class="w-full bg-surface-container rounded-lg px-5 py-4 focus:outline-hidden text-sm font-medium border-r-8 border-transparent appearance-none">
                      <option value="">{m.recruit_hierarchy_grade_none()}</option>
                      {#each hRoles as r}
                         <option value={r.name}>{r.name}</option>
                      {/each}
                  </select>
               </div>
             {/if}

             <div>
               <label for="oral-pass-notes" class="field-label">{m.recruit_interview_notes_label()}</label>
               <textarea id="oral-pass-notes" bind:value={oralPassNotes} class="w-full h-24 bg-surface-container rounded-lg p-4 focus:outline-hidden text-sm" placeholder={m.recruit_interview_notes_ph()}></textarea>
             </div>
        </div>
        
        <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
            <button onclick={() => oralPassModalTarget = null} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors font-inter">{m.common_cancel()}</button>
            <button 
               onclick={async () => {
                  await doAction(oralPassModalTarget.id, 'oral_pass', { 
                     reason: oralPassNotes,
                     hierarchyId: selectedHierarchyId || undefined,
                     hierarchyGrade: selectedHierarchyGrade || undefined
                  });
                  if (tutorSelected) await doAction(oralPassModalTarget.id, 'assign_tutor', { tutorUserId: tutorSelected });
                  oralPassModalTarget = null;
               }} 
               class="flex-1 py-4 rounded-xl font-bold bg-emerald-600 text-white active:scale-[0.98] transition-transform shadow-sm font-inter">
               {m.recruit_oral_pass_submit()}
            </button>
        </div>
    </div>
</div>
{/if}

<!-- Oral Fail Modal -->
{#if oralFailModalTarget}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
        <div class="flex items-center gap-4 mb-2 text-error">
           <Papicon icon="thumb_down" size={36} />
           <h3 class="text-2xl font-semibold">{m.recruit_oral_fail_title()}</h3>
        </div>
        <p class="text-sm text-on-surface-variant/80 mb-6">{m.recruit_oral_fail_desc()}</p>
        
        <div>
          <label for="oral-fail-reason" class="field-label">{m.recruit_reason_label()}</label>
          <textarea id="oral-fail-reason" bind:value={oralFailReason} class="w-full h-32 bg-surface-container rounded-lg p-4 focus:outline-hidden text-sm" placeholder={m.recruit_oral_fail_reason_ph()}></textarea>
        </div>
        
        <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
            <button onclick={() => oralFailModalTarget = null} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
            <button 
               onclick={() => doAction(oralFailModalTarget.id, 'oral_fail', { reason: oralFailReason }).then(() => oralFailModalTarget = null)} 
               class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm">
               {m.recruit_oral_fail_submit()}
            </button>
        </div>
    </div>
</div>
{/if}
<!-- Create Google Form Modal -->
{#if showCreateModal}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm overflow-hidden animate-in zoom-in-95 duration-300 font-inter">
      <div class="p-8 border-b border-outline-variant/20 flex items-center justify-between bg-primary/5">
        <div>
          <h3 class="text-2xl font-semibold text-on-surface">{m.recruit_create_form_title()}</h3>
          <p class="text-on-surface-variant text-sm">{m.recruit_create_form_desc()}</p>
        </div>
        <button onclick={() => showCreateModal = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="x" size={24} />
        </button>
      </div>

      <div class="p-8 space-y-6">
        <label class="block">
          <span class="text-body-sm font-medium text-primary mb-2 block">{m.recruit_form_name_label()}</span>
          <FormInput 
            type="text" 
            bind:value={newFormName} 
            placeholder={m.recruit_form_name_ph()}
            className="w-full"
          />
        </label>

        <label class="block">
          <span class="text-body-sm font-medium text-primary mb-2 block">{m.recruit_form_desc_label()}</span>
          <textarea 
            bind:value={newFormDescription} 
            placeholder={m.recruit_form_desc_ph()}
            class="w-full bg-surface-container rounded-lg px-5 py-4 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm h-24 resize-none"
          ></textarea>
        </label>
      </div>

      <div class="p-8 bg-surface-container-low border-t border-outline-variant/20 flex gap-4">
        <button onclick={() => showCreateModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface hover:bg-surface-hover transition-colors">{m.common_cancel()}</button>
        <button 
          onclick={createForm} 
          disabled={createFormAction.state.loading}
          use:explainDisabled={(!newFormName.trim()) ? m.common_reason_fill_field() : ''}
          class="flex-1 py-4 rounded-xl font-semibold bg-primary text-on-primary active:scale-[0.98] transition-all disabled:opacity-50"
        >
          {createFormAction.state.loading ? m.recruit_creating() : m.recruit_create_form_submit()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Google Apps Script Modal -->
{#if showScriptModal}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-4xl shadow-sm overflow-hidden animate-in zoom-in-95 duration-300 max-h-[90vh] overflow-y-auto font-inter">
      <div class="p-8 border-b border-outline-variant/20 flex items-center justify-between bg-primary/5 sticky top-0 bg-surface z-10">
        <div>
          <h3 class="text-2xl font-semibold text-on-surface">{m.recruit_script_modal_title()}</h3>
          <p class="text-on-surface-variant text-sm">{m.recruit_script_modal_form({ name: selectedForm?.name ?? "" })}</p>
        </div>
        <button onclick={() => showScriptModal = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="x" size={24} />
        </button>
      </div>
      
      <div class="p-8 space-y-6">
        <div class="bg-warning/10 border border-warning/20 rounded-lg p-4 flex gap-4 text-warning">
          <Papicon icon="info" size={20} class="shrink-0" />
          <div class="text-sm">
            <p class="font-bold mb-1">{m.recruit_script_install_title()}</p>
            <ol class="list-decimal list-inside space-y-1 text-warning/80">
              <li>{m.recruit_script_step1()}</li>
              <li>{m.recruit_script_step2()}</li>
              <li>{m.recruit_script_step3()}</li>
              <li>{m.recruit_script_step4()}</li>
              <li>{m.recruit_script_step5()}</li>
              <li>{m.recruit_script_step6()}</li>
            </ol>
          </div>
        </div>

        <div class="relative">
          <pre class="bg-surface-container rounded-lg p-6 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-on-surface max-h-[40vh] overflow-y-auto">{generatedScript}</pre>
          <button 
            onclick={() => {
              navigator.clipboard.writeText(generatedScript);
              toast.success(m.recruit_script_copied());
            }}
            class="absolute top-4 right-4 px-4 py-2 rounded-xl bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-md active:scale-95"
          >
            {m.recruit_copy_btn()}
          </button>
        </div>
      </div>
      
      <div class="p-8 bg-surface-container-low border-t border-outline-variant/20">
        <button onclick={() => showScriptModal = false} class="w-full py-4 rounded-xl font-bold bg-surface hover:bg-surface-hover transition-colors">{m.recruit_close_btn()}</button>
      </div>
    </div>
  </div>
{/if}

<!-- API Key Success Modal -->
{#if showKeyModal}
  <div class="fixed inset-0 z-9999 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-xl shadow-sm overflow-hidden animate-in zoom-in-95 duration-300 font-inter">
      <div class="p-8 border-b border-outline-variant/20 flex items-center justify-between bg-success/5">
        <div>
          <h3 class="text-2xl font-semibold text-success flex items-center gap-2">
            <Papicon icon="check_circle" size={24} />
            {m.recruit_key_modal_title()}
          </h3>
          <p class="text-on-surface-variant text-sm">{m.recruit_key_modal_subtitle()}</p>
        </div>
        <button onclick={() => showKeyModal = false} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="x" size={24} />
        </button>
      </div>
      
      <div class="p-8 space-y-6">
        <div class="bg-warning/10 border border-warning/20 rounded-lg p-4 flex gap-4 text-warning">
          <Papicon icon="warning" size={20} class="shrink-0" />
          <div class="text-sm leading-relaxed font-medium">
            <p class="font-bold mb-1">{m.recruit_key_warning_title()}</p>
            <p>{m.recruit_key_warning_desc()}</p>
          </div>
        </div>

        <div class="relative">
          <div class="bg-surface-container rounded-lg p-6 text-sm font-mono break-all pr-24 border border-outline-variant/20 select-all text-on-surface">
            {newlyGeneratedKey}
          </div>
          <button 
            onclick={copyKeyToClipboard}
            class="absolute top-1/2 -translate-y-1/2 right-4 px-4 py-2.5 rounded-xl {keyCopied ? 'bg-emerald-500 text-white' : 'bg-primary text-white'} text-body-sm font-medium hover:bg-primary/90 transition-all shadow-md active:scale-95"
          >
            {keyCopied ? m.recruit_copied_btn() : m.recruit_copy_btn()}
          </button>
        </div>
      </div>
      
      <div class="p-8 bg-surface-container-low border-t border-outline-variant/20">
        <button onclick={() => showKeyModal = false} class="w-full py-4 rounded-xl font-bold bg-primary text-on-primary hover:bg-primary/90 transition-colors">{m.recruit_key_ack_btn()}</button>
      </div>
    </div>
  </div>
{/if}

<style>
    .scrollbar-hide::-webkit-scrollbar { display: none; }
</style>

</ModulePage>
