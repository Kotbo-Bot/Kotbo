<script lang="ts">
  import { Tabs } from '../lib/components/ui';
  import { m, dateLocale } from '../lib/i18n';
  import { onMount } from 'svelte';
  import { useUnsavedChanges } from '../lib/useUnsavedChanges.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { 
    fetchTutoringConfig, 
    fetchTutoringItems, 
    fetchTutorDashboard, 
    fetchApprenticeProgress,
    updateTutoringConfig,
    updateTutoringChecklist,
    addTutoringLog,
    deleteTutoringItem,
    upsertTutoringItem,
    deleteTestingPeriod,
    addMentorReport,
    endTestingPeriod,
    fetchFeatureConfigurations,
    updateFeatureConfiguration,
    createTestingPeriod,
    fetchStaffMembers,
    fetchStaffRoles,
    fetchStaffHierarchies
  } from '../lib/api';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import RolePermissionSettings from '../lib/components/RolePermissionSettings.svelte';

  let createTutoringModalOpen = $state(false);
  const createTutoringForm = $state({
    staffUserId: '',
    mentorId: '',
    plannedDurationDays: 14,
    targetGrade: ''
  });
  let allStaffMembers = $state<any[]>([]);
  let allStaffRoles = $state<any[]>([]);
  let loadingStaffInfo = $state(false);

  async function openCreateTutoringModal() {
    createTutoringModalOpen = true;
    loadingStaffInfo = true;
    try {
      const [membersData, rolesData] = await Promise.all([
        fetchStaffMembers().catch(() => ({ members: [] })),
        fetchStaffRoles().catch(() => ({ roles: [] }))
      ]);
      allStaffMembers = membersData?.members || [];
      allStaffRoles = rolesData?.roles || [];
      
      // Select default values
      const potentialApprentices = allStaffMembers.filter(m => !tutorApprentices.some(a => a.staffMember?.userId === m.userId));
      if (potentialApprentices.length > 0) {
        createTutoringForm.staffUserId = potentialApprentices[0].userId;
      } else if (allStaffMembers.length > 0) {
        createTutoringForm.staffUserId = allStaffMembers[0].userId;
      }
      
      const tutors = allStaffMembers.filter(m => m.isTutor);
      if (tutors.length > 0) {
        createTutoringForm.mentorId = tutors[0].userId;
      } else {
        createTutoringForm.mentorId = '';
      }
      
      if (allStaffRoles.length > 0) {
        createTutoringForm.targetGrade = allStaffRoles[0].name;
      } else {
        createTutoringForm.targetGrade = '';
      }
      
      if (config) {
        createTutoringForm.plannedDurationDays = config.minTestDays || 14;
      }
    } catch (err) {
      console.error('Error fetching staff info for tutoring creation:', err);
    } finally {
      loadingStaffInfo = false;
    }
  }

  async function submitCreateTutoring() {
    if (!createTutoringForm.staffUserId) {
      alert(m.tutoring_alert_select_apprentice());
      return;
    }
    try {
      const ok = await createTestingPeriod({
        staffUserId: createTutoringForm.staffUserId,
        mentorId: createTutoringForm.mentorId || undefined,
        plannedDurationDays: Number(createTutoringForm.plannedDurationDays),
        targetGrade: createTutoringForm.targetGrade || undefined
      });
      if (!ok) throw new Error(m.tutoring_err_api());
      createTutoringModalOpen = false;
      fetchData();
    } catch (err) {
      console.error('Error creating tutoring relation:', err);
      alert(errorMessage(err) || m.tutoring_err_create());
    }
  }
  
  let activeTab = $state('dashboard'); // dashboard, progress, config
  let config = $state<any>(null);
  /** Derniere configuration enregistree : la barre d'enregistrement compare a elle. */
  let savedConfig = $state<any>(null);
  const snapshotConfig = (value: any) => (value ? structuredClone($state.snapshot(value)) : null);
  const configDirty = $derived(JSON.stringify(config) !== JSON.stringify(savedConfig));

  useUnsavedChanges({
    id: 'tutoring',
    label: m.tutoring_page_title(),
    getConfig: () => config,
    getSaved: () => savedConfig,
    onSave: async () => {
      await saveConfig();
      return !configDirty;
    },
    onReset: () => { config = snapshotConfig(savedConfig); },
  });
  let tutoringItems = $state<any[]>([]);
  let tutorApprentices = $state<any[]>([]);
  let apprenticeProgress = $state<any>(null);
  let loading = $state(true);

  // Modal states
  let reportModalOpen = $state(false);
  let itemModalOpen = $state(false);
  let selectedApprentice = $state<any>(null);
  let selectedItem = $state<any>(null);
  let reportType = $state('POSITIVE');
  let reportContent = $state('');

  // Item Modal form states
  let itemForm = $state({
    id: '',
    title: '',
    description: '',
    category: 'TOOLS',
    sortOrder: 0,
    hierarchyId: '',
    grade: ''
  });

  // Le ciblage d'un element par hierarchie et grade ne se reglait que depuis
  // un onglet de la page Staff, fondu ici. Sans lui, reenregistrer un element
  // depuis cette page effacait sa cible : l'API pose `null` sur tout champ absent.
  let hierarchies = $state<any[]>([]);
  let targetingLoaded = false;

  async function loadTargetingData() {
    if (targetingLoaded) return;
    targetingLoaded = true;
    const [hierarchyData, rolesData] = await Promise.all([
      fetchStaffHierarchies().catch(() => ({ hierarchies: [] })),
      allStaffRoles.length ? Promise.resolve({ roles: allStaffRoles }) : fetchStaffRoles().catch(() => ({ roles: [] })),
    ]);
    hierarchies = hierarchyData?.hierarchies || [];
    allStaffRoles = rolesData?.roles || [];
  }

  const gradeOptions = $derived(
    itemForm.hierarchyId
      ? allStaffRoles.filter((role) => (role.hierarchyId ?? '') === itemForm.hierarchyId)
      : allStaffRoles
  );

  function itemTargetLabel(item: { hierarchyId?: string | null; grade?: string | null }) {
    if (!item.hierarchyId && !item.grade) return '';
    const hierarchy = item.hierarchyId
      ? hierarchies.find((h) => h.id === item.hierarchyId)?.name || m.sm_hierarchy_unknown()
      : m.sm_hierarchy_all();
    return `${hierarchy} · ${item.grade || m.sm_grade_all()}`;
  }

  $effect(() => {
    if (activeTab === 'config') void loadTargetingData();
  });

  let endTutoringModalOpen = $state(false);
  let endTutoringStatus = $state<'PASSED' | 'FAILED'>('PASSED');
  let endTutoringNotes = $state('');
  let endTutoringForce = $state(false);
  let endTutoringError = $state<string | null>(null);
  let canForce = $state(false);

  // Confirmation Modal state
  let confirmModal = $state({
    open: false,
    title: '',
    message: '',
    onConfirm: () => {}
  });

  const saveAction = createAsyncActionState();

  let featureConfig = $state<any>(null);
  let loadingConfig = $state(false);

  async function loadFeatureConfig() {
    loadingConfig = true;
    try {
      const configs = await fetchFeatureConfigurations();
      featureConfig = configs?.features?.find((c: any) => c.featureKey === 'tutoring') || null;
    } catch (err) {
      console.error('Error fetching tutoring config:', err);
    } finally {
      loadingConfig = false;
    }
  }

  function showConfirm(title: string, message: string, onConfirm: () => void) {
    confirmModal = { open: true, title, message, onConfirm };
  }

  let defaultTabApplied = false;

  async function fetchData() {
    loading = true;
    try {
      const [configData, itemsData, tutorData, apprenticeData] = await Promise.all([
        fetchTutoringConfig().catch(() => ({ config: null })),
        fetchTutoringItems().catch(() => ({ items: [] })),
        fetchTutorDashboard().catch(() => ({ apprentices: [] })),
        fetchApprenticeProgress().catch(() => ({ progress: null }))
      ]);

      // Ce rechargement suit aussi chaque action sur le catalogue : il ne doit
      // pas emporter des reglages modifies et pas encore enregistres.
      const freshConfig = configData?.config;
      if (!configDirty) config = freshConfig;
      savedConfig = snapshotConfig(freshConfig);
      tutoringItems = itemsData?.items || [];
      tutorApprentices = tutorData?.apprentices || [];
      apprenticeProgress = apprenticeData?.progress;

      // Onglet par defaut choisi une seule fois : les rechargements declenches
      // par une action (checklist, carnet de bord, items) ne doivent pas
      // ramener l'utilisateur sur un autre onglet.
      if (!defaultTabApplied) {
        defaultTabApplied = true;
        if (tutorApprentices.length > 0) activeTab = 'dashboard';
        else if (apprenticeProgress) activeTab = 'progress';
        else if (authStore.isAdmin) activeTab = 'config';
      }

    } catch (err) {
      console.error('Error fetching tutoring data:', err);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    // Le layout monte la page des que la session est confirmee, alors que les
    // guildes (donc authStore.isAdmin) arrivent un peu apres. Sans cette
    // attente, un rechargement complet choisit l'onglet par defaut et masque
    // les controles admin comme si l'utilisateur ne l'etait pas.
    await authStore.initialize();
    await Promise.all([
      fetchData(),
      loadFeatureConfig()
    ]);
  });

  async function saveConfig() {
    await saveAction.run(async () => {
      const ok = await updateTutoringConfig(config);
      if (!ok) throw new Error(m.tutoring_err_api());

      if (featureConfig) {
        // Sync to feature config as well
        await updateFeatureConfiguration('tutoring', {
          metadata: {
            reportIntervalDays: config.reportIntervalDays,
            reminderDaysBefore: config.reminderDaysBefore,
            minTestDays: config.minTestDays,
            showVocalActivity: config.showVocalActivity,
            showAbsences: config.showAbsences,
            remindersEnabled: config.remindersEnabled
          }
        });
      }

      savedConfig = snapshotConfig(config);
      await dashboardStore.refresh();
      return true;
    }, { successMessage: m.tutoring_config_saved() });
  }

  async function setChecklistState(periodId: string, itemId: string, targetState: string, currentState: string | undefined) {
    const newState = currentState === targetState ? 'UNCHECKED' : targetState;
    
    try {
      await updateTutoringChecklist(periodId, itemId, newState);
      fetchData();
    } catch (err) {
      console.error('Error updating checklist:', err);
    }
  }

  async function addLog(periodId: string, content: string) {
    if (!content.trim()) return;
    try {
      await addTutoringLog(periodId, content);
      fetchData();
    } catch (err) {
      console.error('Error adding log:', err);
    }
  }

  function getProgressPercentage(progress: any[]) {
    if (!tutoringItems.length) return 0;
    
    let totalScore = 0;
    progress.forEach(p => {
      if (p.state === 'KNOWN') totalScore += 1;
      else if (p.state === 'ACQUIRED') totalScore += 2;
    });
    
    const maxScore = tutoringItems.length * 2;
    return Math.round((totalScore / maxScore) * 100);
  }

  async function handleDeleteTutoring(periodId: string) {
    showConfirm(
      m.tutoring_confirm_delete_title(),
      m.tutoring_confirm_delete_msg(),
      async () => {
        try {
          await deleteTestingPeriod(periodId);
          fetchData();
        } catch (err) {
          console.error('Error deleting tutoring:', err);
        }
      }
    );
  }

  async function submitReport() {
    if (!reportContent.trim() || !selectedApprentice) return;
    try {
      await addMentorReport(selectedApprentice.id, reportType, reportContent);
      reportModalOpen = false;
      reportContent = '';
      fetchData();
    } catch (err) {
      console.error('Error submitting report:', err);
    }
  }

  async function submitEndTutoring() {
    if (!selectedApprentice) return;
    endTutoringError = null;
    try {
      await endTestingPeriod(selectedApprentice.id, endTutoringStatus, endTutoringNotes, endTutoringForce);
      endTutoringModalOpen = false;
      endTutoringNotes = '';
      endTutoringForce = false;
      fetchData();
    } catch (err) {
      if (errorStatus(err) === 403 && errorMessage(err).includes('trop courte')) {
        endTutoringError = errorMessage(err);
        canForce = true;
      } else {
        console.error('Error ending tutoring:', err);
        endTutoringError = m.tutoring_err_generic_validation();
      }
    }
  }

  function formatReportType(type: string) {
    switch (type) {
      case 'POSITIVE': return m.tutoring_report_positive();
      case 'NEUTRAL': return m.tutoring_report_neutral();
      case 'NEGATIVE': return m.tutoring_report_negative();
      default: return type;
    }
  }

  function getDaysInTest(startDate: string) {
    const start = new Date(startDate);
    const diff = Date.now() - start.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  // Visual helper for categories
  const categories = [
    { id: 'TOOLS', label: m.tutoring_cat_tools(), icon: 'tool', color: 'primary' },
    { id: 'KNOWLEDGE', label: m.tutoring_cat_knowledge(), icon: 'book', color: 'secondary' },
    { id: 'ACCESS', label: m.tutoring_cat_access(), icon: 'key', color: 'tertiary' }
  ];

  function openItemModal(item = null) {
    if (item) {
      itemForm = {
        id: item.id,
        title: item.title,
        description: item.description,
        category: item.category,
        sortOrder: item.sortOrder || 0,
        hierarchyId: item.hierarchyId || '',
        grade: item.grade || ''
      };
      selectedItem = item;
    } else {
      itemForm = {
        id: '',
        title: '',
        description: '',
        category: 'TOOLS',
        sortOrder: tutoringItems.length,
        hierarchyId: '',
        grade: ''
      };
      selectedItem = null;
    }
    void loadTargetingData();
    itemModalOpen = true;
  }

  async function saveItem() {
    if (!itemForm.title.trim()) return;
    try {
      await upsertTutoringItem({
        ...itemForm,
        hierarchyId: itemForm.hierarchyId || null,
        grade: itemForm.grade.trim() || null
      });
      itemModalOpen = false;
      fetchData();
    } catch (err) {
      console.error('Error saving tutoring item:', err);
    }
  }

  async function deleteItem(itemId: string) {
    showConfirm(
      m.tutoring_confirm_delete_item_title(),
      m.tutoring_confirm_delete_item_msg(),
      async () => {
        try {
          await deleteTutoringItem(itemId);
          fetchData();
        } catch (err) {
          console.error('Error deleting tutoring item:', err);
        }
      }
    );
  }

  import ModulePage from '../lib/components/ModulePage.svelte';

  import { errorMessage, errorStatus } from '@kotbo/shared';
</script>

<ModulePage 
  title={m.tutoring_page_title()}
  description={m.tutoring_page_desc()}
  icon="book"
  featureKey="tutoring"
>
  {#snippet actions()}
    <div class="flex items-center gap-4">
      <Tabs
        label={m.nav_tutoring()}
        tabs={[
          { id: 'dashboard', label: m.tutoring_tab_dashboard(), icon: 'grid' },
          { id: 'progress', label: m.tutoring_tab_progress(), icon: 'trending-up' },
          ...(authStore.isAdmin || tutorApprentices.length > 0 ? [{ id: 'config', label: m.tutoring_tab_config(), icon: 'settings' }] : []),
        ]}
        active={activeTab}
        onchange={(id) => (activeTab = id)}
      />

      {#if authStore.isAdmin}
        <button 
          onclick={openCreateTutoringModal}
          class="flex items-center gap-2 px-5 py-3 rounded-lg transition-all duration-300 bg-primary text-white active:scale-[0.98]"
        >
          <Papicon icon="plus" size={18} />
          <span class="text-sm font-semibold">{m.tutoring_create_btn()}</span>
        </button>
      {/if}
    </div>
  {/snippet}

  {#if loading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each Array(3) as _}
        <div class="h-64 bg-surface-container rounded-xl animate-pulse"></div>
      {/each}
    </div>
  {:else}
    <!-- Content based on tab -->
    {#if activeTab === 'dashboard'}
      <div class="grid grid-cols-1 gap-8">
        {#if tutorApprentices.length === 0}
          <div class="flex flex-col items-center justify-center py-20 bg-surface-container-low/40 rounded-xl border border-dashed border-outline-variant/50">
            <Papicon icon="user-plus" size={48} class="text-on-surface-variant/30 mb-4" />
            <p class="text-on-surface-variant font-medium">{m.tutoring_empty_tutor()}</p>
          </div>
        {:else}
          {#each tutorApprentices as apprentice}
            <div class="bg-surface-container-low/60 rounded-xl border border-outline-variant/30 overflow-hidden">
              <div class="p-8 flex flex-col md:flex-row gap-8">
                <!-- Apprentice Sidebar -->
                <div class="w-full md:w-64 flex flex-col gap-4">
                  <div class="flex flex-col items-center gap-4 p-6 bg-surface-container rounded-xl">
                    <div class="w-20 h-20 rounded-lg bg-primary/10 flex items-center justify-center border-2 border-primary/20 overflow-hidden shadow-inner">
                      {#if apprentice.staffMember.avatarUrl}
                        <img src={apprentice.staffMember.avatarUrl} alt={apprentice.staffMember.username} class="w-full h-full object-cover" />
                      {:else}
                        <Papicon icon="user" size={40} class="text-primary" />
                      {/if}
                    </div>
                    <div class="text-center">
                      <h3 class="font-semibold text-on-surface">{apprentice.staffMember.username}</h3>
                      {#if apprentice.mentor && apprentice.mentor.userId !== authStore.user?.id}
                        <p class="text-xs font-semibold text-primary">{m.tutoring_mentor_prefix({ name: apprentice.mentor.username })}</p>
                      {/if}
                      <p class="text-xs text-on-surface-variant">{m.tutoring_apprentice_since({ date: new Date(apprentice.startDate).toLocaleDateString(dateLocale()) })}</p>
                    </div>
                  </div>
                  
                  <div class="flex flex-col gap-2">
                    <div class="flex justify-between text-body-sm font-medium text-on-surface-variant px-2">
                      <span>{m.tutoring_progress_label()}</span>
                      <span>{getProgressPercentage(apprentice.checklistProgress)}%</span>
                    </div>
                    <div class="h-3 bg-surface-container-high rounded-full overflow-hidden border border-outline-variant/20 p-0.5">
                      <div 
                        class="h-full bg-primary/10 rounded-full transition-all duration-1000" 
                        style="width: {getProgressPercentage(apprentice.checklistProgress)}%"
                      ></div>
                    </div>
                  </div>

                  <div class="mt-4 p-4 bg-primary/5 rounded-lg border border-primary/10">
                    <div class="flex items-center gap-2 mb-2">
                      <Papicon icon="alert-circle" size={16} class="text-primary" />
                      <span class="text-xs font-bold text-primary">{m.tutoring_next_report()}</span>
                    </div>
                    <p class="text-sm font-medium text-on-surface-variant mb-4">
                      {apprentice.lastReportAt ? m.tutoring_next_report_scheduled() : m.tutoring_next_report_asap()}
                    </p>
                    <button 
                      onclick={() => { selectedApprentice = apprentice; reportModalOpen = true; }}
                      class="w-full py-2 bg-primary/10 text-primary rounded-xl text-xs font-bold hover:bg-primary/20 transition-all flex items-center justify-center gap-2"
                    >
                      <Papicon icon="plus" size={14} />
                      {m.tutoring_make_report_btn()}
                    </button>
                  </div>

                  <div class="mt-auto flex flex-col gap-2">
                    <div class="flex gap-2">
                      <button 
                        onclick={() => { selectedApprentice = apprentice; endTutoringStatus = 'PASSED'; endTutoringModalOpen = true; endTutoringError = null; canForce = false; }}
                        class="flex-1 py-3 bg-success/10 text-success rounded-xl text-xs font-semibold hover:bg-success/20 transition-all"
                      >
                        {m.tutoring_validate_btn()}
                      </button>
                      <button 
                         onclick={() => { selectedApprentice = apprentice; endTutoringStatus = 'FAILED'; endTutoringModalOpen = true; endTutoringError = null; canForce = false; }}
                        class="flex-1 py-3 bg-error/10 text-error rounded-xl text-xs font-semibold hover:bg-error/20 transition-all"
                      >
                        {m.tutoring_fail_btn()}
                      </button>
                    </div>
                    {#if authStore.isAdmin}
                      <button 
                        onclick={() => handleDeleteTutoring(apprentice.id)}
                        class="w-full py-2 text-on-surface-variant hover:text-error text-xs font-medium transition-all"
                      >
                        {m.tutoring_delete_btn()}
                      </button>
                    {/if}
                  </div>
                </div>

                <!-- Main Content -->
                <div class="flex-1 flex flex-col gap-6">
                  {#if (config?.showVocalActivity || config?.showAbsences) && (apprentice.vocalStats || (apprentice.absences && apprentice.absences.length > 0))}
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {#if config?.showVocalActivity && apprentice.vocalStats}
                        <div class="p-4 bg-primary/5 rounded-lg border border-primary/10 flex items-center gap-4">
                          <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <Papicon icon="mic" size={20} />
                          </div>
                          <div>
                            <div class="text-xs font-semibold text-primary">{m.tutoring_vocal_activity()}</div>
                            <div class="text-lg font-semibold text-on-surface">
                              {Math.round(apprentice.vocalStats.voiceTimeSeconds / 3600)}h {Math.round((apprentice.vocalStats.voiceTimeSeconds % 3600) / 60)}m
                            </div>
                            <div class="text-2xs text-on-surface-variant">{m.tutoring_vocal_sessions_total({ count: apprentice.vocalStats.voiceSessionCount })}</div>
                          </div>
                        </div>
                      {/if}

                      {#if config?.showAbsences && apprentice.absences && apprentice.absences.length > 0}
                        <div class="p-4 bg-warning/5 rounded-lg border border-warning/10 flex items-center gap-4">
                          <div class="w-10 h-10 rounded-xl bg-warning/10 flex items-center justify-center text-warning">
                            <Papicon icon="calendar-off" size={20} />
                          </div>
                          <div class="flex-1 overflow-hidden">
                            <div class="text-xs font-semibold text-warning">{m.tutoring_upcoming_absences()}</div>
                            <div class="flex flex-col gap-0.5">
                              {#each apprentice.absences as absence}
                                <div class="text-2xs font-bold text-on-surface truncate">
                                  {new Date(absence.startDate).toLocaleDateString()} - {new Date(absence.endDate).toLocaleDateString()}
                                </div>
                              {/each}
                            </div>
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/if}

                  <div class="flex items-center justify-between border-b border-outline-variant/30 pb-4">
                    <h2 class="text-xl font-semibold text-on-surface">{m.tutoring_checklist_title()}</h2>
                    <div class="flex gap-2">
                      {#each categories as cat}
                        <div class="flex items-center gap-1.5 px-3 py-1 rounded-full bg-{cat.color}/10 text-{cat.color} text-2xs font-bold uppercase">
                          <Papicon icon={cat.icon} size={12} />
                          {cat.label}
                        </div>
                      {/each}
                    </div>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {#each tutoringItems as item}
                      {@const progress = apprentice.checklistProgress.find(p => p.itemId === item.id)}
                      <div class="flex items-start gap-4 p-4 bg-surface-container/30 rounded-lg border border-outline-variant/20 hover:border-primary/30 transition-all group">
                        <div class="flex-1">
                          <div class="flex items-center justify-between mb-1">
                            <div class="flex items-center gap-2">
                              <span class="font-bold text-sm text-on-surface">{item.title}</span>
                              <Papicon 
                                icon={categories.find(c => c.id === item.category)?.icon || 'info'} 
                                size={12} 
                                class="text-on-surface-variant/40" 
                              />
                            </div>
                            
                            <div class="flex gap-2">
                              <button 
                                onclick={() => setChecklistState(apprentice.id, item.id, 'KNOWN', progress?.state)}
                                class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all text-2xs font-semibold uppercase tracking-wider
 {progress?.state === 'KNOWN' ? 'bg-primary/10 border-primary/30 text-primary shadow-sm shadow-primary/5' : 
                                   progress?.state === 'ACQUIRED' ? 'bg-surface-container-highest/30 border-outline-variant/20 text-on-surface-variant/30 cursor-not-allowed' :
                                   'bg-surface-container border-outline-variant/30 text-on-surface-variant hover:border-primary/50'}"
                                disabled={progress?.state === 'ACQUIRED'}
                              >
                                <Papicon icon="eye" size={12} />
                                <span>{m.tutoring_state_known()}</span>
                              </button>
                              
                              <button 
                                onclick={() => setChecklistState(apprentice.id, item.id, 'ACQUIRED', progress?.state)}
                                class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all text-2xs font-semibold uppercase tracking-wider
 {progress?.state === 'ACQUIRED' ? 'bg-success/10 border-success/30 text-success shadow-sm shadow-success/5' : 
                                   'bg-surface-container border-outline-variant/30 text-on-surface-variant hover:border-success/50'}"
                              >
                                <Papicon icon="check" size={12} />
                                <span>{m.tutoring_state_acquired()}</span>
                              </button>
                            </div>
                          </div>
                          
                          <p class="text-xs text-on-surface-variant leading-relaxed mb-2">{item.description}</p>
                          
                          {#if progress?.completedAt}
                            <div class="flex items-center gap-1 text-2xs font-medium text-primary/60">
                              <Papicon icon="clock" size={10} />
                              <span>{m.tutoring_validated_on({ date: new Date(progress.completedAt).toLocaleDateString(dateLocale()), name: apprentice.mentor?.username || m.tutoring_default_tutor() })}</span>
                            </div>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {:else if activeTab === 'progress'}
      {#if !apprenticeProgress}
        <div class="flex flex-col items-center justify-center py-20 bg-surface-container-low/40 rounded-xl border border-dashed border-outline-variant/50">
          <Papicon icon="award" size={48} class="text-on-surface-variant/30 mb-4" />
          <p class="text-on-surface-variant font-medium">{m.tutoring_empty_apprentice()}</p>
        </div>
      {:else}
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <!-- Progress Stats -->
          <div class="lg:col-span-2 flex flex-col gap-8">
            <div class="bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30 relative overflow-hidden">
               <div class="absolute top-0 right-0 p-8">
                <div class="w-32 h-32 rounded-full border-10 border-surface-container-high relative flex items-center justify-center">
                  <svg class="w-full h-full -rotate-90">
                    <circle 
                      cx="64" cy="64" r="54" fill="none" 
                      stroke="currentColor" stroke-width="10" 
                      class="text-primary transition-all duration-1000" 
                      stroke-dasharray="339.29" 
                      stroke-dashoffset={339.29 * (1 - getProgressPercentage(apprenticeProgress.checklistProgress) / 100)}
                    />
                  </svg>
                  <div class="absolute inset-0 flex flex-col items-center justify-center">
                    <span class="text-2xl font-semibold text-on-surface">{getProgressPercentage(apprenticeProgress.checklistProgress)}%</span>
                  </div>
                </div>
              </div>

              <h2 class="text-2xl font-semibold text-on-surface mb-2">{m.tutoring_my_progress_title()}</h2>
              <p class="text-on-surface-variant mb-8 max-w-md">{m.tutoring_my_progress_desc({ name: apprenticeProgress.mentor?.username || m.tutoring_assigned_tutor() })}</p>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                {#each categories as cat}
                  {@const items = tutoringItems.filter(i => i.category === cat.id)}
                  {@const score = apprenticeProgress.checklistProgress.filter(p => items.find(i => i.id === p.itemId)).reduce((acc, p) => acc + (p.state === 'ACQUIRED' ? 2 : p.state === 'KNOWN' ? 1 : 0), 0)}
                  {@const catProgress = Math.round((score / (items.length * 2)) * 100)}
                  <div class="p-6 bg-surface-container/50 rounded-xl border border-outline-variant/20">
                    <div class="flex items-center gap-3 mb-4">
                      <div class="w-10 h-10 rounded-xl bg-{cat.color}/10 flex items-center justify-center">
                        <Papicon icon={cat.icon} size={20} class="text-{cat.color}" />
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase text-on-surface-variant">{cat.label}</div>
                        <div class="text-lg font-semibold text-on-surface">{catProgress}%</div>
                      </div>
                    </div>
                    <div class="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                      <div 
                        class="h-full bg-{cat.color} transition-all duration-700" 
                        style="width: {catProgress}%"
                      ></div>
                    </div>
                  </div>
                {/each}
              </div>
            </div>

            <!-- Logbook -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              {#if config?.showVocalActivity && apprenticeProgress.vocalStats}
                <div class="bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30 flex items-center gap-6">
                  <div class="w-16 h-16 rounded-lg bg-primary/10 flex items-center justify-center text-primary shadow-sm">
                    <Papicon icon="mic" size={32} />
                  </div>
                  <div>
                    <h3 class="text-xs font-semibold text-primary mb-1">{m.tutoring_my_vocal_activity()}</h3>
                    <div class="text-lg font-semibold text-on-surface leading-none mb-1">
                      {Math.round(apprenticeProgress.vocalStats.voiceTimeSeconds / 3600)}h {Math.round((apprenticeProgress.vocalStats.voiceTimeSeconds % 3600) / 60)}m
                    </div>
                    <p class="text-xs font-medium text-on-surface-variant">{m.tutoring_vocal_sessions_recorded({ count: apprenticeProgress.vocalStats.voiceSessionCount })}</p>
                  </div>
                </div>
              {/if}

              {#if config?.showAbsences && apprenticeProgress.absences && apprenticeProgress.absences.length > 0}
                <div class="bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30 flex items-center gap-6">
                  <div class="w-16 h-16 rounded-lg bg-warning/10 flex items-center justify-center text-warning shadow-lg shadow-warning/5">
                    <Papicon icon="calendar-off" size={32} />
                  </div>
                  <div class="flex-1 overflow-hidden">
                    <h3 class="text-xs font-semibold text-warning mb-1">{m.tutoring_my_absences()}</h3>
                    <div class="flex flex-col gap-1">
                      {#each apprenticeProgress.absences.slice(0, 2) as absence}
                        <div class="flex items-center justify-between">
                          <span class="text-sm font-bold text-on-surface">{new Date(absence.startDate).toLocaleDateString()}</span>
                          <span class="text-2xs font-medium text-on-surface-variant">→ {new Date(absence.endDate).toLocaleDateString()}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            <div class="bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30">
              <h2 class="text-2xl font-semibold text-on-surface mb-6">{m.tutoring_logbook_title()}</h2>
              
              <div class="flex flex-col gap-6">
                <div class="flex gap-4">
                  <input 
                    type="text" 
                    placeholder={m.tutoring_logbook_ph()}
                    class="flex-1 bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:outline-none focus:border-primary transition-all text-on-surface"
                    onkeydown={(e) => { if(e.key === 'Enter') { addLog(apprenticeProgress.id, e.currentTarget.value); e.currentTarget.value = ''; } }}
                  />
                  <button 
                    class="bg-primary text-white px-8 rounded-lg font-semibold active:scale-[0.98] transition-all"
                    onclick={() => { 
                      const input = document.querySelector('input') as HTMLInputElement;
                      addLog(apprenticeProgress.id, input.value);
                      input.value = '';
                    }}
                  >
                    {m.tutoring_logbook_add()}
                  </button>
                </div>

                <div class="flex flex-col gap-4">
                  {#each apprenticeProgress.logs as log}
                    <div class="p-6 bg-surface-container/30 rounded-xl border border-outline-variant/20 flex gap-4 animate-in slide-in-from-left-2 duration-300">
                      <div class="w-1.5 bg-primary/20 rounded-full"></div>
                      <div class="flex-1">
                        <div class="text-xs font-semibold text-primary mb-1">{new Date(log.date).toLocaleDateString()}</div>
                        <p class="text-on-surface font-medium">{log.content}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          </div>

          <!-- Mentor Sidebar -->
          <div class="flex flex-col gap-6">
            <div class="bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30 text-center">
              <div class="w-24 h-24 mx-auto bg-primary/10 rounded-xl flex items-center justify-center shadow-sm shadow-primary/20 mb-6">
                <Papicon icon="user-check" size={40} class="text-white" />
              </div>
              <h3 class="text-xl font-semibold text-on-surface mb-1">{m.tutoring_my_tutor_title()}</h3>
              <p class="text-on-surface-variant font-medium mb-6">{apprenticeProgress.mentor?.username || m.tutoring_tutor_pending()}</p>
              
              <div class="flex flex-col gap-3">
                <button class="w-full py-4 rounded-lg border-2 border-primary/20 text-primary font-semibold hover:bg-primary/5 transition-all">
                  {m.tutoring_contact_discord()}
                </button>
              </div>
            </div>

            <div class="bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30">
              <h3 class="font-semibold text-on-surface mb-4">{m.tutoring_last_feedback()}</h3>
              {#if apprenticeProgress.reports.length > 0}
                {@const lastReport = apprenticeProgress.reports[0]}
                <div class="flex items-center gap-2 mb-3">
                  <div class="px-2 py-0.5 rounded-md text-2xs font-semibold uppercase {lastReport.type === 'POSITIVE' ? 'bg-success/10 text-success' : lastReport.type === 'NEGATIVE' ? 'bg-error/10 text-error' : 'bg-warning/10 text-warning'}">
                    {formatReportType(lastReport.type)}
                  </div>
                  <span class="text-2xs font-bold text-on-surface-variant">{new Date(lastReport.createdAt).toLocaleDateString()}</span>
                </div>
                <p class="text-sm text-on-surface-variant italic leading-relaxed">"{lastReport.content}"</p>
              {:else}
                <p class="text-sm text-on-surface-variant italic">{m.tutoring_no_report_yet()}</p>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    {:else if activeTab === 'config'}
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <!-- Parameters -->
        <div class="lg:col-span-1 bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30 flex flex-col gap-6">
          <h2 class="text-2xl font-semibold text-on-surface mb-4">{m.tutoring_settings_title()}</h2>
          
          {#if !config}
            <div class="p-6 bg-surface-container rounded-xl border border-dashed border-outline-variant/50 flex flex-col items-center justify-center text-center">
              <Papicon icon="alert-circle" size={32} class="text-on-surface-variant/30 mb-2" />
              <p class="text-xs text-on-surface-variant font-medium">{m.tutoring_config_load_error()}</p>
            </div>
          {:else}
            <div class="flex flex-col gap-2">
              <label for="reportIntervalDays" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_field_report_interval()}</label>
              <input 
                id="reportIntervalDays"
                type="number" 
                bind:value={config.reportIntervalDays}
                class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all"
              />
            </div>

          <div class="flex flex-col gap-2">
            <label for="reminderDaysBefore" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_field_reminder_days()}</label>
            <input 
              id="reminderDaysBefore"
              type="number" 
              bind:value={config.reminderDaysBefore}
              class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all"
            />
          </div>

          <div class="flex flex-col gap-2">
            <label for="minTestDays" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_field_min_test_days()}</label>
            <input 
              id="minTestDays"
              type="number" 
              bind:value={config.minTestDays}
              class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all"
            />
          </div>

            <div class="flex items-center justify-between p-4 bg-surface-container/50 rounded-lg border border-outline-variant/20">
              <div class="flex flex-col">
                <span class="font-bold text-on-surface text-sm">{m.tutoring_toggle_vocal_label()}</span>
                <span class="text-2xs text-on-surface-variant">{m.tutoring_toggle_vocal_desc()}</span>
              </div>
              <button 
                onclick={() => config.showVocalActivity = !config.showVocalActivity}
                class="w-10 h-5 rounded-full transition-all relative {config.showVocalActivity ? 'bg-primary' : 'bg-outline-variant'}"
                aria-label={m.tutoring_toggle_vocal_aria()}
              >
                <div class="absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-all {config.showVocalActivity ? 'translate-x-5' : ''}"></div>
              </button>
            </div>

            <div class="flex items-center justify-between p-4 bg-surface-container/50 rounded-lg border border-outline-variant/20">
              <div class="flex flex-col">
                <span class="font-bold text-on-surface text-sm">{m.tutoring_toggle_absences_label()}</span>
                <span class="text-2xs text-on-surface-variant">{m.tutoring_toggle_absences_desc()}</span>
              </div>
              <button 
                onclick={() => config.showAbsences = !config.showAbsences}
                class="w-10 h-5 rounded-full transition-all relative {config.showAbsences ? 'bg-primary' : 'bg-outline-variant'}"
                aria-label={m.tutoring_toggle_absences_aria()}
              >
                <div class="absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-all {config.showAbsences ? 'translate-x-5' : ''}"></div>
              </button>
            </div>

            <div class="flex items-center justify-between p-4 bg-surface-container/50 rounded-lg border border-outline-variant/20 mt-2">
              <div class="flex flex-col">
                <span class="font-bold text-on-surface text-sm">{m.tutoring_toggle_dm_label()}</span>
                <span class="text-2xs text-on-surface-variant">{m.tutoring_toggle_dm_desc()}</span>
              </div>
              <button 
                onclick={() => config.remindersEnabled = !config.remindersEnabled}
                class="w-10 h-5 rounded-full transition-all relative {config.remindersEnabled ? 'bg-primary' : 'bg-outline-variant'}"
                aria-label={m.tutoring_toggle_dm_aria()}
              >
                <div class="absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-all {config.remindersEnabled ? 'translate-x-5' : ''}"></div>
              </button>
            </div>

          {/if}

          {#if featureConfig}
            <div class="pt-6 border-t border-outline-variant/10">
              <RolePermissionSettings 
                featureKey="tutoring" 
                roleAccess={featureConfig.roleAccessByRole} 
              />
            </div>
          {/if}
        </div>

        <!-- Checklist Items Management -->
        <div class="lg:col-span-2 bg-surface-container-low/60 p-8 rounded-xl border border-outline-variant/30">
          <div class="flex items-center justify-between mb-8">
            <h2 class="text-2xl font-semibold text-on-surface">{m.tutoring_training_checklist_title()}</h2>
            <button 
              onclick={() => openItemModal()}
              class="bg-primary/10 text-primary px-6 py-2.5 rounded-xl font-bold hover:bg-primary/20 transition-all flex items-center gap-2"
            >
              <Papicon icon="plus" size={18} />
              {m.tutoring_new_item_btn()}
            </button>
          </div>

          <div class="flex flex-col gap-4">
            {#each tutoringItems as item}
              <div class="p-6 bg-surface-container/30 rounded-xl border border-outline-variant/20 flex items-center justify-between group">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-all">
                    <Papicon icon={categories.find(c => c.id === item.category)?.icon || 'help-circle'} size={24} />
                  </div>
                  <div>
                    <div class="flex items-center gap-2">
                      <span class="font-semibold text-on-surface">{item.title}</span>
                      <span class="text-2xs font-semibold uppercase px-2 py-0.5 bg-primary/5 text-primary rounded-md">{categories.find(c => c.id === item.category)?.label || item.category}</span>
                      {#if itemTargetLabel(item)}
                        <span class="badge badge-neutral">{itemTargetLabel(item)}</span>
                      {/if}
                    </div>
                    <p class="text-sm text-on-surface-variant line-clamp-1">{item.description}</p>
                  </div>
                </div>
                <div class="flex gap-2">
                  <button 
                    onclick={() => openItemModal(item)}
                    class="w-10 h-10 rounded-xl bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-primary transition-all"
                    aria-label={m.tutoring_edit_item_aria()}
                  >
                    <Papicon icon="edit-2" size={18} />
                  </button>
                  <button 
                    onclick={() => deleteItem(item.id)}
                    class="w-10 h-10 rounded-xl bg-surface-container-high flex items-center justify-center text-on-surface-variant hover:text-error transition-all"
                    aria-label={m.tutoring_delete_item_aria()}
                  >
                    <Papicon icon="trash-2" size={18} />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  {/if}

{#if reportModalOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-container-lowest/80 animate-in fade-in duration-300">
    <div class="w-full max-w-lg bg-surface-container-low rounded-[31px] border border-outline-variant/30 shadow-sm overflow-hidden animate-in zoom-in-95 duration-300">
      <div class="p-8">
        <h2 class="text-2xl font-semibold text-on-surface mb-2">{m.tutoring_report_modal_title()}</h2>
        <p class="text-on-surface-variant mb-6 font-medium">{m.tutoring_report_modal_desc({ name: selectedApprentice?.staffMember?.username ?? "" })}</p>
        
        <div class="flex flex-col gap-6">
          <div class="flex gap-2 p-1 bg-surface-container rounded-lg border border-outline-variant/20">
            {#each ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as type}
              <button 
                onclick={() => reportType = type}
                class="flex-1 py-2.5 rounded-xl text-xs font-semibold transition-all {reportType === type ? 'bg-primary text-white ' : 'text-on-surface-variant hover:bg-surface-hover'}"
              >
                {formatReportType(type)}
              </button>
            {/each}
          </div>

          <textarea 
            placeholder={m.tutoring_report_content_ph()}
            bind:value={reportContent}
            rows="6"
            class="w-full bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface resize-none"
          ></textarea>

          <div class="flex gap-4">
            <button 
              onclick={() => reportModalOpen = false}
              class="flex-1 py-4 rounded-lg border-2 border-outline-variant/30 text-on-surface-variant font-semibold hover:bg-surface-hover transition-all"
            >
              {m.common_cancel()}
            </button>
            <button 
              onclick={submitReport}
              class="flex-1 py-4 bg-primary text-white rounded-lg font-semibold shadow-sm shadow-primary/20 active:scale-[0.98] transition-all"
            >
              {m.tutoring_publish_btn()}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if endTutoringModalOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-container-lowest/80 animate-in fade-in duration-300">
    <div class="w-full max-w-lg bg-surface-container-low rounded-[31px] border border-outline-variant/30 shadow-sm overflow-hidden animate-in zoom-in-95 duration-300">
      <div class="p-8">
        <h2 class="text-2xl font-semibold text-on-surface mb-2">
          {endTutoringStatus === 'PASSED' ? m.tutoring_end_modal_title_pass() : m.tutoring_end_modal_title_fail()}
        </h2>
        <p class="text-on-surface-variant mb-6 font-medium text-sm">
          {endTutoringStatus === 'PASSED'
            ? m.tutoring_end_modal_desc_pass({ name: selectedApprentice?.staffMember?.username ?? '' })
            : m.tutoring_end_modal_desc_fail({ name: selectedApprentice?.staffMember?.username ?? '' })}
        </p>
        
        <div class="flex flex-col gap-6">
          <div class="p-4 bg-surface-container/50 rounded-lg border border-outline-variant/20 flex items-center justify-between">
            <div class="flex flex-col">
              <span class="text-xs font-semibold text-on-surface-variant">{m.tutoring_current_duration()}</span>
              <span class="font-bold text-on-surface">{m.tutoring_days_unit({ count: getDaysInTest(selectedApprentice?.startDate) })}</span>
            </div>
            <div class="flex flex-col items-end">
              <span class="text-xs font-semibold text-on-surface-variant">{m.tutoring_required_duration()}</span>
              <span class="font-bold text-on-surface">{m.tutoring_days_unit({ count: config?.minTestDays ?? 14 })}</span>
            </div>
          </div>

          {#if endTutoringError}
            <div class="p-4 bg-error/10 border border-error/20 rounded-lg flex gap-3 animate-in shake duration-500">
              <Papicon icon="alert-triangle" size={20} class="text-error mt-0.5" />
              <div class="flex-1">
                <p class="text-sm font-bold text-error leading-tight">{endTutoringError}</p>
                {#if canForce && authStore.isAdmin}
                  <button 
                    onclick={() => { endTutoringForce = true; endTutoringError = null; }}
                    class="mt-2 text-xs font-semibold uppercase text-error underline underline-offset-4 hover:text-error/80 transition-all"
                  >
                    {m.tutoring_force_link()}
                  </button>
                {/if}
              </div>
            </div>
          {/if}

          <div class="flex flex-col gap-2">
            <label for="notes" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_final_notes_label()}</label>
            <textarea 
              id="notes"
              placeholder={m.tutoring_final_notes_ph()}
              bind:value={endTutoringNotes}
              rows="4"
              class="w-full bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface resize-none"
            ></textarea>
          </div>

          {#if endTutoringForce}
            <div class="p-4 bg-warning/10 border border-warning/20 rounded-lg flex items-center justify-between">
              <div class="flex flex-col">
                <span class="font-bold text-warning">{m.tutoring_forced_validation()}</span>
                <span class="text-2xs text-on-surface-variant">{m.tutoring_forced_validation_desc()}</span>
              </div>
              <Papicon icon="shield-alert" size={24} class="text-warning" />
            </div>
          {/if}

          <div class="flex gap-4">
            <button 
              onclick={() => endTutoringModalOpen = false}
              class="flex-1 py-4 rounded-lg border-2 border-outline-variant/30 text-on-surface-variant font-semibold hover:bg-surface-hover transition-all"
            >
              {m.common_cancel()}
            </button>
            <button 
              onclick={submitEndTutoring}
              class="flex-1 py-4 {endTutoringStatus === 'PASSED' ? 'bg-success text-white' : 'bg-error text-on-error'} rounded-lg font-semibold shadow-sm transition-all active:scale-[0.98]"
            >
              {m.common_confirm()}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if itemModalOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-container-lowest/80 animate-in fade-in duration-300">
    <div class="w-full max-w-lg bg-surface-container-low rounded-[31px] border border-outline-variant/30 shadow-sm overflow-hidden animate-in zoom-in-95 duration-300">
      <div class="p-8">
        <h2 class="text-2xl font-semibold text-on-surface mb-2">{selectedItem ? m.tutoring_item_modal_title_edit() : m.tutoring_item_modal_title_new()}</h2>
        <p class="text-on-surface-variant mb-6 font-medium text-sm">{m.tutoring_item_modal_desc()}</p>
        
        <div class="flex flex-col gap-6">
          <div class="flex flex-col gap-2">
            <label for="item-title" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_item_title_label()}</label>
            <input 
              id="item-title"
              type="text" 
              placeholder={m.tutoring_item_title_ph()}
              bind:value={itemForm.title}
              class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface"
            />
          </div>

          <div class="flex flex-col gap-2">
            <label for="item-category" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_item_category_label()}</label>
            <select 
              id="item-category"
              bind:value={itemForm.category}
              class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface"
            >
              {#each categories as cat}
                <option value={cat.id}>{cat.label}</option>
              {/each}
            </select>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="flex flex-col gap-2">
              <label for="item-hierarchy" class="field-label">{m.sm_field_target_hierarchy()}</label>
              <select
                id="item-hierarchy"
                bind:value={itemForm.hierarchyId}
                onchange={() => (itemForm.grade = '')}
                class="input"
              >
                <option value="">{m.sm_hierarchy_all()}</option>
                {#each hierarchies as hierarchy (hierarchy.id)}
                  <option value={hierarchy.id}>{hierarchy.name}</option>
                {/each}
              </select>
            </div>
            <div class="flex flex-col gap-2">
              <label for="item-grade" class="field-label">{m.sm_field_target_grade()}</label>
              <select id="item-grade" bind:value={itemForm.grade} class="input">
                <option value="">{m.sm_grade_all()}</option>
                {#each gradeOptions as role (role.id ?? role.name)}
                  <option value={role.name}>{role.name}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <label for="item-desc" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_item_desc_label()}</label>
            <textarea 
              id="item-desc"
              placeholder={m.tutoring_item_desc_ph()}
              bind:value={itemForm.description}
              rows="4"
              class="w-full bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface resize-none"
            ></textarea>
          </div>

          <div class="flex gap-4">
            <button 
              onclick={() => itemModalOpen = false}
              class="flex-1 py-4 rounded-lg border-2 border-outline-variant/30 text-on-surface-variant font-semibold hover:bg-surface-hover transition-all"
            >
              {m.common_cancel()}
            </button>
            <button 
              onclick={saveItem}
              class="flex-1 py-4 bg-primary text-white rounded-lg font-semibold shadow-sm shadow-primary/20 active:scale-[0.98] transition-all"
            >
              {m.common_save()}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if createTutoringModalOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-container-lowest/80 animate-in fade-in duration-300">
    <div class="w-full max-w-lg bg-surface-container-low rounded-[31px] border border-outline-variant/30 shadow-sm overflow-hidden animate-in zoom-in-95 duration-300">
      <div class="p-8">
        <h2 class="text-2xl font-semibold text-on-surface mb-2">{m.tutoring_create_modal_title()}</h2>
        <p class="text-on-surface-variant mb-6 font-medium text-sm">{m.tutoring_create_modal_desc()}</p>
        
        {#if loadingStaffInfo}
          <div class="flex flex-col items-center justify-center py-10">
            <div class="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            <p class="text-sm text-on-surface-variant mt-4 font-medium">{m.tutoring_loading_staff()}</p>
          </div>
        {:else}
          <div class="flex flex-col gap-6">
            <div class="flex flex-col gap-2">
              <label for="apprentice" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_field_apprentice()}</label>
              <select 
                id="apprentice"
                bind:value={createTutoringForm.staffUserId}
                class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface"
              >
                <option value="">{m.tutoring_choose_apprentice()}</option>
                {#each allStaffMembers as member}
                  <option value={member.userId}>
                    {member.displayName || member.username} ({member.grade})
                  </option>
                {/each}
              </select>
            </div>

            <div class="flex flex-col gap-2">
              <label for="mentor" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_field_mentor()}</label>
              <select 
                id="mentor"
                bind:value={createTutoringForm.mentorId}
                class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface"
              >
                <option value="">{m.tutoring_no_mentor()}</option>
                {#each allStaffMembers.filter(m => m.isTutor) as member}
                  <option value={member.userId}>
                    {member.displayName || member.username}
                  </option>
                {/each}
              </select>
            </div>

            <div class="flex flex-col gap-2">
              <label for="target-grade" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_field_target_grade()}</label>
              <select 
                id="target-grade"
                bind:value={createTutoringForm.targetGrade}
                class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface"
              >
                <option value="">{m.tutoring_none_option()}</option>
                {#each allStaffRoles as role}
                  <option value={role.name}>{role.name}</option>
                {/each}
              </select>
            </div>

            <div class="flex flex-col gap-2">
              <label for="duration" class="text-xs font-semibold text-on-surface-variant pl-2">{m.tutoring_field_duration()}</label>
              <input 
                id="duration"
                type="number" 
                bind:value={createTutoringForm.plannedDurationDays}
                min="1"
                class="bg-surface-container px-6 py-4 rounded-lg border border-outline-variant/30 focus:border-primary outline-none transition-all text-on-surface"
              />
            </div>

            <div class="flex gap-4">
              <button 
                onclick={() => createTutoringModalOpen = false}
                class="flex-1 py-4 rounded-lg border-2 border-outline-variant/30 text-on-surface-variant font-semibold hover:bg-surface-hover transition-all"
              >
                {m.common_cancel()}
              </button>
              <button 
                onclick={submitCreateTutoring}
                class="flex-1 py-4 bg-primary text-white rounded-lg font-semibold shadow-sm shadow-primary/20 active:scale-[0.98] transition-all"
              >
                {m.tutoring_create_submit()}
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if confirmModal.open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-container-lowest/80 animate-in fade-in duration-300">
    <div class="w-full max-w-md bg-surface-container-low rounded-[31px] border border-outline-variant/30 shadow-sm overflow-hidden animate-in zoom-in-95 duration-300">
      <div class="p-8">
        <div class="w-16 h-16 bg-error/10 rounded-lg flex items-center justify-center text-error mb-6 mx-auto">
          <Papicon icon="alert-triangle" size={32} />
        </div>
        
        <h2 class="text-2xl font-semibold text-on-surface text-center mb-2">{confirmModal.title}</h2>
        <p class="text-on-surface-variant text-center mb-8 font-medium">{confirmModal.message}</p>
        
        <div class="flex gap-4">
          <button 
            onclick={() => confirmModal.open = false}
            class="flex-1 py-4 rounded-lg border-2 border-outline-variant/30 text-on-surface-variant font-semibold hover:bg-surface-hover transition-all"
          >
            {m.common_cancel()}
          </button>
          <button 
            onclick={() => { confirmModal.onConfirm(); confirmModal.open = false; }}
            class="flex-1 py-4 bg-error text-on-error rounded-lg font-semibold shadow-sm shadow-error/20 active:scale-[0.98] transition-all"
          >
            {m.common_confirm()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}


<style>
  /* Custom colors if not in tailwind config */
  :global(.bg-primary) { background-color: rgb(var(--color-primary, 67 97 238)); }
  :global(.text-primary) { color: rgb(var(--color-primary, 67 97 238)); }
  :global(.border-primary) { border-color: rgb(var(--color-primary, 67 97 238)); }
  :global(.bg-secondary) { background-color: rgb(var(--color-secondary, 76 201 240)); }
  :global(.text-secondary) { color: rgb(var(--color-secondary, 76 201 240)); }
  :global(.bg-tertiary) { background-color: rgb(var(--color-tertiary, 114 9 183)); }
  :global(.text-tertiary) { color: rgb(var(--color-tertiary, 114 9 183)); }
</style>

</ModulePage>
