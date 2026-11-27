<script lang="ts">
  import { dateLocale, m } from '../lib/i18n';
  import { onDestroy, onMount, tick } from 'svelte';
  import { dashboardFetch } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { WB_CLOSE_REASONS, wbCloseReasonLabel, wbCaseEventLabel, WB_SEVERITIES, WB_STATUSES, wbSeverityLabel, wbStatusLabel } from '../lib/wellbeingLabels';
  import { WB_EMPTY_CUSTOMIZATION, wbCaseTags, wbCategoryName, wbFilterByTag, type WbCustomization } from '../lib/wellbeingCustom';
  import { wbCustom } from '../lib/stores/wellbeingCustomization.svelte';
  import CustomizationPanel from '../lib/components/wellbeing/CustomizationPanel.svelte';
  import TagPicker from '../lib/components/wellbeing/TagPicker.svelte';
  import WellbeingStats, { type WellbeingCellStats, type WellbeingProfileStats, type WellbeingPulseWeek, type WellbeingReferentLoad, type WellbeingStageCount } from '../lib/components/wellbeing/WellbeingStats.svelte';
  import CaseTasks from '../lib/components/wellbeing/CaseTasks.svelte';
  import ReporterThread from '../lib/components/wellbeing/ReporterThread.svelte';
  import DistressSignals, { type DistressSignal } from '../lib/components/wellbeing/DistressSignals.svelte';
  import ReportPanelPublisher from '../lib/components/wellbeing/ReportPanelPublisher.svelte';
  import CaseBoard from '../lib/components/wellbeing/CaseBoard.svelte';
  import WellbeingSettings from '../lib/components/wellbeing/WellbeingSettings.svelte';
  import NetworkReferent from '../lib/components/wellbeing/NetworkReferent.svelte';
  import NetworkCases from '../lib/components/wellbeing/NetworkCases.svelte';
  import ProfilesPanel from '../lib/components/wellbeing/ProfilesPanel.svelte';
  import NewCaseModal, { type NewCasePrefill } from '../lib/components/wellbeing/NewCaseModal.svelte';
  import BreakGlassModal from '../lib/components/wellbeing/BreakGlassModal.svelte';
  import AccessLog from '../lib/components/wellbeing/AccessLog.svelte';
  import ResourcesEditor, { type WellbeingResource } from '../lib/components/wellbeing/ResourcesEditor.svelte';
  import { memberCaseModal } from '../lib/stores/memberCaseModal.svelte';
  import MemberName from '../lib/components/MemberName.svelte';
  import WellbeingMemberList from '../lib/components/WellbeingMemberList.svelte';
  import { Button, Callout, EmptyState, Field, FilterPills, Menu, Modal, StatTile, Tabs, ToggleSwitch, type FilterOption, type MenuItem, type TabItem } from '../lib/components/ui';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { WB_IDLE_LOCK_MS, WB_REVIEW_SHORTCUTS, wbNeighbourCaseId, wbShortcut, wbCaseExportHtml, wbPurgeInfo, wbTaskProgress, wbCaseStats, wbCaseTimeline, wbCompactTimeline, wbFilterCases, wbIsReviewDue, wbLinkedCases, wbMergeHeader, wbReviewShortcut, wbSearchCases, wbSeverityAccent, wbSeverityTone, wbSortCases, wbStatusTone, type WbBoardStage, type WbBoardTarget, type WbCaseFilter, type WbCaseSort } from '../lib/wellbeingView';
  import { authStore } from '../lib/stores/auth.svelte';
  import { isMobile } from '../lib/stores/media.svelte';

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
    /** Accès d'urgence en cours de la personne connectée, pour l'arrêter. */
    breakGlassLogId: string | null;
    /** Propriétaire : la composition n'a pas été reconfirmée depuis 30 jours. */
    accessReviewDue: boolean;
    /** Étapes ajoutées par la cellule à la vue en colonnes. */
    boardColumns?: WbBoardStage[];
    /** Catégories, protocole de crise, plans types et étiquettes de la cellule. */
    customization?: WbCustomization | null;
    /** Désactivation de la cellule demandée par le propriétaire, effective à cette date. */
    dissolutionAt: string | null;
    dissolutionByName: string | null;
    /** Accès d'urgence soumis à la validation d'une seconde personne. */
    breakGlassApproval: boolean;
    reportEnabled: boolean;
  };

  let loading = $state(true);
  let status = $state<WellbeingStatus | null>(null);
  /** En-têtes des dossiers : la liste ne porte pas leur contenu. */
  let cases = $state<any[]>([]);
  let trashCases = $state<any[]>([]);
  let logs = $state<any[]>([]);
  let selectedCaseId = $state<string | null>(null);
  /** Dossier ouvert avec son contenu, lu à part : chaque ouverture est tracée côté bot. */
  let detail = $state<any | null>(null);

  const selectedHeader = $derived(cases.find((c) => c.id === selectedCaseId) ?? null);
  const selectedCase = $derived(detail && detail.id === selectedCaseId ? detail : null);

  type Tab = 'cases' | 'profiles' | 'stats' | 'resources' | 'custom' | 'access' | 'settings';
  type DetailTab = 'timeline' | 'tasks' | 'documents';
  let detailTab = $state<DetailTab>('timeline');
  /** Petit écran : la fiche remplace la liste après un choix. */
  let mobileDetail = $state(false);
  const taskProgress = $derived(wbTaskProgress(selectedCase?.tasks));
  const detailTabs = $derived<TabItem[]>(selectedCase ? [
    { id: 'timeline', label: m.wb_detail_timeline(), icon: 'Clock' },
    { id: 'tasks', label: m.wb_tasks_title(), icon: 'CheckSquare', badge: taskProgress.total ? `${taskProgress.done}/${taskProgress.total}` : undefined },
    { id: 'documents', label: m.wb_attachments_title(), icon: 'Paperclip', badge: (selectedCase.attachments ?? []).length || undefined },
  ] : []);
  type ListFilter = WbCaseFilter | 'trash';
  let activeTab = $state<Tab>('cases');
  /** L'onglet d'arrivée n'est choisi qu'au premier chargement : un rechargement ne déplace personne. */
  let initialTabChosen = false;
  /** Fiche à ouvrir à l'arrivée sur l'onglet Fiches, depuis un lien. */
  let profileSubjectId = $state<string | null>(null);
  let caseFilter = $state<ListFilter>('active');
  let caseSearch = $state('');
  let caseSort = $state<WbCaseSort>('recent');
  /** Étiquette choisie pour filtrer la liste et les colonnes ; `null` : toutes. */
  let tagFilter = $state<string | null>(null);
  const tags = $derived(wbCustom.value.tags);
  const viewerId = $derived(authStore.user?.id);
  const now = new Date();
  const purgeInfo = $derived(selectedCase ? wbPurgeInfo(selectedCase, now) : null);
  const stats = $derived(wbCaseStats(cases, now));
  const visibleCases = $derived(caseFilter === 'trash'
    ? wbSearchCases(trashCases, caseSearch)
    : wbSortCases(wbFilterByTag(wbSearchCases(wbFilterCases(cases, caseFilter, viewerId), caseSearch), tagFilter), caseSort));
  const linkedCases = $derived(selectedHeader ? wbLinkedCases(cases, selectedHeader) : []);
  const timeline = $derived(selectedCase ? wbCaseTimeline(selectedCase) : []);
  /** Historique réduit : notes seules, ou actions à la suite repliées ; le choix est gardé. */
  const NOTES_ONLY_KEY = 'kotbo:wellbeing:notes-only';
  let timelineNotesOnly = $state(typeof localStorage !== 'undefined' && localStorage.getItem(NOTES_ONLY_KEY) === '1');
  let expandedGroups = $state<string[]>([]);
  const compactTimeline = $derived(wbCompactTimeline(timeline, { notesOnly: timelineNotesOnly, expanded: expandedGroups }));
  function setNotesOnly(value: boolean) {
    timelineNotesOnly = value;
    try { localStorage.setItem(NOTES_ONLY_KEY, value ? '1' : '0'); } catch { /* stockage indisponible : réglage gardé pour la session */ }
  }
  const filterOptions = $derived<FilterOption<ListFilter>[]>([
    ...(status?.reportEnabled || stats.triage > 0 ? [{ value: 'triage' as const, label: m.wb_filter_triage(), count: stats.triage }] : []),
    { value: 'active', label: m.wb_filter_active(), count: stats.active },
    { value: 'mine', label: m.wb_filter_mine(), count: wbFilterCases(cases, 'mine', viewerId).length },
    { value: 'closed', label: m.wb_filter_closed(), count: stats.closed },
    { value: 'all', label: m.wb_filter_all(), count: cases.length },
    ...(status?.canWriteCases ? [{ value: 'trash' as const, label: m.wb_filter_trash() }] : []),
  ]);
  const SORT_OPTIONS: Array<{ value: WbCaseSort; label: () => string }> = [
    { value: 'recent', label: () => m.wb_sort_recent() },
    { value: 'severity', label: () => m.wb_sort_severity() },
    { value: 'review', label: () => m.wb_sort_review() },
  ];
  /** Même délai que le bot (PURGE_REQUEST_HOURS) : passé, une demande d'effacement est à refaire. */
  const PURGE_REQUEST_MS = 72 * 60 * 60 * 1000;

  function pickFilter(value: ListFilter) {
    caseFilter = value;
    if (value === 'trash') void loadTrash();
  }

  // Mode discret : le contenu du dossier n'est rendu qu'à la demande, pour le partage d'écran.
  const DISCREET_KEY = 'kotbo:wellbeing:discreet';
  let discreet = $state(typeof localStorage === 'undefined' || localStorage.getItem(DISCREET_KEY) !== 'off');
  let revealed = $state(false);
  function setDiscreet(value: boolean) {
    discreet = value;
    try { localStorage.setItem(DISCREET_KEY, value ? 'on' : 'off'); } catch { /* stockage indisponible : réglage gardé pour la session */ }
  }
  const contentHidden = $derived(discreet && !revealed);

  // Verrouillage : après une inactivité, ou quand l'onglet passe en arrière-plan en mode discret, le dossier ouvert quitte la page.
  let locked = $state(false);
  let lastActivity = Date.now();
  function lock() {
    if (!detail && !selectedCaseId) return;
    locked = true;
    detail = null;
    revealed = false;
  }
  function unlock() {
    locked = false;
    lastActivity = Date.now();
    if (selectedCaseId) void loadDetail(selectedCaseId);
  }
  const markActivity = () => { lastActivity = Date.now(); };
  const onVisibility = () => { if (document.hidden && discreet) lock(); };
  const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll'] as const;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, markActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    idleTimer = setInterval(() => { if (!locked && Date.now() - lastActivity > WB_IDLE_LOCK_MS) lock(); }, 15_000);
  });
  onDestroy(() => {
    if (typeof window === 'undefined') return;
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, markActivity);
    document.removeEventListener('visibilitychange', onVisibility);
    clearInterval(idleTimer);
  });

  /** Le bot exige une connexion récente pour lire les dossiers. */
  let reauthRequired = $state(false);
  async function needsReauth(res: Response): Promise<boolean> {
    if (res.status !== 403) return false;
    const data = await res.clone().json().catch(() => ({}));
    if (data.code !== 'WELLBEING_REAUTH') return false;
    reauthRequired = true;
    detail = null;
    return true;
  }

  /** Référent du dossier ouvert absent : jusqu'à quand, et qui reçoit ses relances. */
  let absence = $state<{ until: string | null; backupUserId: string | null } | null>(null);

  /** Vérification de l'historique du dossier ouvert : intact, vérifié depuis le chaînage, ou altéré. */
  let integrity = $state<'ok' | 'partial' | 'broken' | null>(null);

  async function loadDetail(caseId: string) {
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}`);
      if (await needsReauth(res)) return;
      if (!res.ok) throw new Error('detail');
      const data = await res.json();
      if (selectedCaseId === caseId && !locked) {
        detail = data.item;
        integrity = data.integrity ?? null;
        absence = data.assigneeAbsence ?? null;
      }
    } catch {
      toast.error(m.toast_wb_load_failed());
    }
  }

  function openCaseById(caseId: string) {
    if (caseId === selectedCaseId && detail) return;
    selectedCaseId = caseId;
    detail = null;
    integrity = null;
    absence = null;
    editingNoteId = null;
    revealed = false;
    expandedGroups = [];
    detailTab = 'timeline';
    void loadDetail(caseId);
  }

  /** Dossier renvoyé par l'API après un geste : il devient le dossier ouvert et met son en-tête à jour. */
  function applyItem(item: any) {
    if (item.id === selectedCaseId) detail = item;
    cases = cases.map((c) => (c.id === item.id ? wbMergeHeader(c, item) : c));
  }

  /**
   * Relit la liste depuis le bot après une création ou une restauration : la
   * page montre ce que le serveur montre, pas seulement ce qu'il a renvoyé.
   */
  async function refreshCaseList() {
    const res = await dashboardFetch('/wellbeing/cases');
    if ((await needsReauth(res)) || !res.ok) return;
    cases = (await res.json()).cases ?? [];
    if (selectedCaseId && !cases.some((c) => c.id === selectedCaseId)) {
      selectedCaseId = null;
      detail = null;
      toast.error(m.toast_wb_case_hidden());
    }
  }

  /** En-tête d'un dossier complet, pour l'ajouter à la liste. */
  function headerOf(item: any) {
    const { summary: _summary, notes: _notes, events: _events, attachments: _attachments, ...header } = item;
    return { ...header, subjectIsTeamMember: false };
  }

  async function loadTrash() {
    const res = await dashboardFetch('/wellbeing/cases?trash=1');
    if (res.ok) trashCases = (await res.json()).cases ?? [];
    else toast.error(m.toast_wb_load_failed());
  }

  let restoringId = $state<string | null>(null);
  async function restoreCase(caseId: string) {
    if (restoringId) return;
    restoringId = caseId;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/restore`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      trashCases = trashCases.filter((c) => c.id !== caseId);
      cases = [headerOf(data.item), ...cases];
      caseFilter = 'active';
      selectedCaseId = data.item.id;
      detail = data.item;
      revealed = false;
      toast.success(m.toast_wb_case_restored());
      void refreshCaseList();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      restoringId = null;
    }
  }

  let endingLogId = $state<string | null>(null);
  /** Arrête un accès d'urgence (le sien, ou celui d'un autre pour la cellule et le propriétaire), ou annule une demande. */
  async function endBreakGlass(logId: string) {
    if (endingLogId) return;
    if (!(await confirmDialog.ask({ title: m.wb_bg_end_q(), description: m.wb_bg_end_desc(), confirmLabel: m.wb_bg_end_confirm() }))) return;
    endingLogId = logId;
    try {
      const res = await dashboardFetch(`/wellbeing/break-glass/${logId}/end`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      toast.success(m.toast_wb_bg_ended());
      detail = null;
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_decide_failed());
    } finally {
      endingLogId = null;
    }
  }

  // Accès d'urgence : demande et seconde clé
  let breakGlassOpen = $state(false);
  let decidingLogId = $state<string | null>(null);
  const pendingLogs = $derived(logs.filter((log) => log.status === 'PENDING' && new Date(log.expiresAt) > new Date()));

  // Ressources d'aide (cellule)
  let resources = $state<WellbeingResource[]>([]);
  let sendingResources = $state(false);
  let assigneeCandidate = $state('');
  /** Membres de la cellule : seuls choix possibles pour un référent ou un collègue à prévenir. */
  let team = $state<Array<{ id: string; name: string }>>([]);
  /** La cellule sans la personne concernée, ni soi-même si `withSelf` est faux. */
  const teamFor = (subjectUserId: string | null | undefined, withSelf = true) =>
    team.filter((member) => member.id !== subjectUserId && (withSelf || member.id !== viewerId));

  // Documents Google Drive du dossier ouvert
  let newAttachmentLabel = $state('');
  let newAttachmentUrl = $state('');
  let addingAttachment = $state(false);
  let removingAttachmentId = $state<string | null>(null);
  /** Même plafond que le bot (MAX_CASE_ATTACHMENTS). */
  const MAX_CASE_ATTACHMENTS = 20;
  /** Un lien illisible (clé changée) ne devient jamais un href. */
  const isDriveLink = (url: string) => /^https:\/\/(drive|docs)\.google\.com\//.test(url);
  // Fenêtre de création d'un dossier
  let newCaseOpen = $state(false);
  let newCaseModal = $state<{ openWith: (prefill?: NewCasePrefill) => Promise<void> }>();
  let signalsPanel = $state<{ reload: () => Promise<void> }>();
  const openNewCase = (prefill?: NewCasePrefill) => newCaseModal?.openWith(prefill);
  const openCaseFromSignal = (signal: DistressSignal) =>
    openNewCase({ subjectUserId: signal.userId, subjectName: signal.userName, severity: 'HIGH', signalId: signal.id });

  // Note on selected case
  let newNote = $state('');
  /** Collègues de la cellule prévenus en privé de la note. */
  let noteNotify = $state<string[]>([]);
  let noteInput = $state<HTMLTextAreaElement>();

  // Vue des dossiers : liste et fiche, ou colonnes par statut. Retenue par navigateur.
  const VIEW_KEY = 'kotbo:wellbeing:view';
  let caseView = $state<'list' | 'board'>(typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list');
  function setCaseView(view: 'list' | 'board') {
    caseView = view;
    if (view === 'board' && caseFilter === 'trash') caseFilter = 'active';
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* stockage indisponible : réglage gardé pour la session */ }
  }
  const boardCases = $derived(wbFilterByTag(wbSearchCases(cases, caseSearch), tagFilter));
  /** Étapes de la vue en colonnes, propres à la cellule. */
  let boardStages = $state<WbBoardStage[]>([]);

  /** Enregistre les étapes ; les dossiers d'une étape supprimée reviennent à leur statut. */
  async function saveStages(columns: Array<{ id?: string; label: string }>): Promise<boolean> {
    try {
      const res = await dashboardFetch('/wellbeing/board-columns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      boardStages = data.columns ?? [];
      void refreshCaseList();
      toast.success(m.toast_wb_board_saved());
      return true;
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
      return false;
    }
  }

  /** Raccourcis : j/k dossier suivant ou précédent, n nouvelle note, d mode discret. */
  function onShortcut(event: KeyboardEvent) {
    if (activeTab !== 'cases' || locked || reauthRequired || newCaseOpen || breakGlassOpen) return;
    const target = event.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    const action = wbShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, typing });
    if (!action) return;
    if (action === 'next' || action === 'previous') {
      if (caseView === 'list' && caseFilter === 'trash') return;
      const id = wbNeighbourCaseId(caseView === 'board' ? boardCases : visibleCases, selectedCaseId, action === 'next' ? 1 : -1);
      if (id) openCaseById(id);
    } else if (action === 'note') {
      if (!status?.canWriteCases || !selectedCase) return;
      // Le champ de note reste utilisable en mode discret : rien n'est dévoilé.
      detailTab = 'timeline';
      void tick().then(() => noteInput?.focus());
    } else {
      setDiscreet(!discreet);
    }
    event.preventDefault();
  }
  let addingNote = $state(false);

  const tabItems = $derived.by<TabItem[]>(() => {
    if (!status) return [];
    const on = status.enabled;
    return [
      ...(on && status.isTeamMember ? [{ id: 'profiles', label: m.wb_tab_profiles(), icon: 'StickyNote' }] : []),
      { id: 'cases', label: m.wb_tab_cases(), icon: 'folder', badge: on && status.hasCaseAccess ? stats.active || undefined : undefined },
      ...(on && (status.isTeamMember || status.isDirector) ? [{ id: 'stats', label: m.wb_tab_stats(), icon: 'BarChart3' }] : []),
      ...(on && status.isTeamMember ? [{ id: 'resources', label: m.wb_tab_resources(), icon: 'heart', badge: resources.length || undefined }] : []),
      ...(on && status.isTeamMember ? [{ id: 'custom', label: m.wb_tab_custom(), icon: 'SlidersHorizontal' }] : []),
      ...(on && (status.isDirector || status.isTeamMember) ? [{ id: 'access', label: m.wb_tab_access(), icon: 'eye', badge: pendingLogs.length || undefined }] : []),
      ...(status.canConfigure ? [{ id: 'settings', label: m.wb_tab_settings(), icon: 'settings' }] : []),
    ];
  });

  // Un onglet retiré (droits changés, module éteint) ramène aux dossiers.
  $effect(() => {
    if (tabItems.length > 0 && !tabItems.some((tab) => tab.id === activeTab)) activeTab = 'cases';
  });


  // Bilan : relu à chaque ouverture de l'onglet, il ne coûte qu'une requête.
  let cellStats = $state<WellbeingCellStats | null>(null);
  let cellLoad = $state<WellbeingReferentLoad[]>([]);
  let cellPulse = $state<WellbeingPulseWeek[] | null>(null);
  $effect(() => {
    if (activeTab === 'stats') void loadStats();
  });
  let cellProfiles = $state<WellbeingProfileStats | null>(null);
  let cellStages = $state<WellbeingStageCount[]>([]);
  async function loadStats() {
    const res = await dashboardFetch('/wellbeing/stats');
    if (res.ok) {
      const data = await res.json();
      cellStats = data.stats;
      cellLoad = data.load ?? [];
      cellPulse = data.pulse ?? null;
      cellProfiles = data.profiles ?? null;
      cellStages = data.stages ?? [];
    } else {
      toast.error(m.toast_wb_load_failed());
    }
  }

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
      boardStages = status?.boardColumns ?? [];
      wbCustom.value = status?.customization ?? WB_EMPTY_CUSTOMIZATION;
      // La cellule arrive sur ses personnes suivies ; un lien vers un dossier ramène aux dossiers.
      if (status?.isTeamMember && !new URLSearchParams(window.location.search).has('case') && activeTab === 'cases' && !initialTabChosen) {
        activeTab = 'profiles';
      }
      initialTabChosen = true;
      // Lien direct (fiche membre) : `?profile=` ouvre la fiche de cette personne.
      const linkedProfile = new URLSearchParams(window.location.search).get('profile');
      if (linkedProfile) {
        history.replaceState(history.state, '', window.location.pathname);
        profileSubjectId = linkedProfile;
        activeTab = 'profiles';
      }

      if (status?.canWriteCases) {
        const teamRes = await dashboardFetch('/wellbeing/team').catch(() => null);
        if (teamRes?.ok) team = (await teamRes.json()).members ?? [];
      }

      if (status?.hasCaseAccess) {
        const casesRes = await dashboardFetch('/wellbeing/cases');
        if (await needsReauth(casesRes)) {
          cases = [];
        } else if (casesRes.ok) {
          reauthRequired = false;
          const data = await casesRes.json();
          cases = data.cases ?? [];
          // Lien direct (accueil, « Mes échéances ») : `?case=` ouvre ce dossier.
          const linked = new URLSearchParams(window.location.search).get('case');
          // Lu une fois : un rechargement plus tard ne ramène pas à ce dossier.
          if (linked) history.replaceState(history.state, '', window.location.pathname);
          if (linked && cases.some((c) => c.id === linked)) {
            openCaseById(linked);
          } else if (selectedCaseId && cases.some((c) => c.id === selectedCaseId)) {
            if (!detail && !locked) void loadDetail(selectedCaseId!);
          } else if (cases.length > 0 && activeTab === 'cases') {
            // Ouvrir un dossier est tracé : on ne le fait d'office que sur la liste des dossiers.
            openCaseById((wbFilterCases(cases, 'active')[0] ?? cases[0]).id);
          } else {
            selectedCaseId = null;
          }
        }
      } else {
        cases = [];
        selectedCaseId = null;
        detail = null;
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

  /** Dossier créé depuis la fenêtre : il rejoint la liste et s'ouvre, dévoilé. */
  function onCaseCreated(item: any, fromSignal: boolean) {
    cases = [headerOf(item), ...cases];
    selectedCaseId = item.id;
    detail = item;
    revealed = true;
    if (fromSignal) void signalsPanel?.reload();
    void refreshCaseList();
  }

  const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());
  const formatDay = (iso: string) => new Date(iso).toLocaleDateString(dateLocale());

  let updatingCase = $state(false);

  /** Statut ou gravité du dossier ouvert. Fermer un dossier le rend purgeable après un an. */
  type CasePatch = { status?: string; severity?: string; assigneeId?: string | null; reviewAt?: string | null; closedReason?: string; stage?: string | null; tagIds?: string[] };

  /** Modification du dossier ouvert. */
  function updateCase(patch: CasePatch) {
    if (selectedCase) return patchCase(selectedCase.id, patch);
  }

  /** Modifie un dossier, ouvert ou non (vue en colonnes). */
  async function patchCase(caseId: string, patch: CasePatch) {
    if (updatingCase) return;
    updatingCase = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      applyItem(data.item);
      toast.success(m.toast_wb_case_updated());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      updatingCase = false;
    }
  }

  // Fermeture : une fenêtre demande le motif (le bilan les compte) ; l'annuler n'enregistre rien.
  let closeDialogOpen = $state(false);
  let closeReason = $state<string>('RESOLVED');
  let closeResolver: ((reason: string | null) => void) | null = null;
  function askCloseReason(): Promise<string | null> {
    closeResolver?.(null);
    closeReason = 'RESOLVED';
    closeDialogOpen = true;
    return new Promise((resolve) => { closeResolver = resolve; });
  }
  function finishClose(reason: string | null) {
    closeDialogOpen = false;
    const resolve = closeResolver;
    closeResolver = null;
    resolve?.(reason);
  }

  /** Change le statut d'un dossier ; fermer passe par le choix du motif. */
  async function changeStatus(caseId: string, status: string) {
    if (status !== 'CLOSED') return patchCase(caseId, { status });
    const reason = await askCloseReason();
    if (reason) await patchCase(caseId, { status, closedReason: reason });
  }

  /**
   * Carte glissée dans une autre colonne : même parcours qu'avec la fiche. Une
   * étape garde le statut (un dossier clos est rouvert) ; une colonne de statut
   * sort le dossier de son étape.
   */
  function moveCase(caseId: string, target: WbBoardTarget) {
    const card = cases.find((c) => c.id === caseId);
    if ('stage' in target) return patchCase(caseId, { stage: target.stage, ...(card?.status === 'CLOSED' ? { status: 'OPEN' } : {}) });
    if (target.status === 'CLOSED') return changeStatus(caseId, 'CLOSED');
    return patchCase(caseId, { ...(card?.status !== target.status ? { status: target.status } : {}), ...(card?.stage ? { stage: null } : {}) });
  }

  /** Fermer rend le dossier purgeable après un an : on le confirme. */
  async function pickStatus(code: string) {
    if (!selectedCase || code === selectedCase.status) return;
    await changeStatus(selectedCase.id, code);
  }

  function pickSeverity(code: string) {
    if (selectedCase && code !== selectedCase.severity) void updateCase({ severity: code });
  }

  const openMember = $derived(selectedCase?.subjectUserId ? memberCaseModal.opener(selectedCase.subjectName) : undefined);
  const caseMenu = $derived<MenuItem[]>(selectedCase && status?.canWriteCases ? [
    ...(openMember && selectedCase.subjectUserId ? [{ label: m.wb_open_member(), description: m.wb_open_member_desc(), icon: 'User', onselect: () => openMember(selectedCase.subjectUserId) }] : []),
    { label: m.wb_export(), description: m.wb_export_desc(), icon: 'Printer', onselect: () => void exportCase() },
    { label: m.wb_delete_case(), description: m.wb_delete_case_warn(), icon: 'Trash', onselect: () => void deleteCase() },
  ] : []);

  let extending = $state(false);
  /** Repousse d'un an l'effacement d'un dossier fermé. */
  async function extendCase() {
    const target = selectedCase;
    if (!target || extending) return;
    extending = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}/extend`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      applyItem(data.item);
      toast.success(m.toast_wb_case_extended());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      extending = false;
    }
  }

  /** Export imprimable, filigrané au nom de qui l'exporte ; l'export est tracé par le bot. */
  async function exportCase() {
    const target = selectedCase;
    if (!target) return;
    // Ouverte avant l'appel : un navigateur bloque une fenêtre ouverte après une attente.
    const win = window.open('', '_blank');
    if (!win) {
      toast.error(m.toast_wb_export_blocked());
      return;
    }
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}/export`, { method: 'POST' });
      if (await needsReauth(res)) {
        win.close();
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      const item = data.item;
      const when = formatDate(data.exportedAt);
      win.document.write(wbCaseExportHtml({
        title: item.title,
        meta: [item.subjectName, wbCategoryName(wbCustom.value, item.category), wbStatusLabel(item.status), wbSeverityLabel(item.severity), formatDay(item.createdAt)],
        summary: item.summary,
        notes: (item.notes ?? []).map((note: any) => ({ author: note.authorName, date: formatDate(note.createdAt), content: note.content })),
        tasks: (item.tasks ?? []).map((task: any) => ({ label: task.label, done: !!task.doneAt })),
        attachments: (item.attachments ?? []).map((attachment: any) => ({ label: attachment.label, url: attachment.url })),
      }, {
        summary: m.wb_summary(),
        notes: m.wb_export_notes(),
        tasks: m.wb_tasks_title(),
        attachments: m.wb_attachments_title(),
        exported: m.wb_export_footer({ name: data.exportedBy, date: when }),
      }, `${data.exportedBy} · ${when}`));
      win.document.close();
      win.focus();
      win.print();
      applyItem(item);
    } catch (err: any) {
      win.close();
      toast.error(err?.message || m.toast_wb_update_failed());
    }
  }

  let purgingId = $state<string | null>(null);
  /** Effacement anticipé de la corbeille : `approve` valide la demande d'une autre personne. */
  async function purgeStep(caseId: string, approve: boolean) {
    if (purgingId) return;
    if (approve && !(await confirmDialog.danger(m.wb_purge_q(), m.wb_purge_warn(), m.wb_purge_confirm()))) return;
    purgingId = caseId;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${caseId}/${approve ? 'purge' : 'purge-request'}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      toast.success(approve ? m.toast_wb_case_purged() : m.toast_wb_purge_requested());
      await loadTrash();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_update_failed());
    } finally {
      purgingId = null;
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
      detail = null;
      toast.success(m.toast_wb_case_trashed());
    } catch {
      toast.error(m.toast_wb_delete_failed());
    } finally {
      deletingCase = false;
    }
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
      await loadDetail(target.id);
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
      applyItem(data.item);
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
      applyItem(data.item);
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_attachment_failed());
    } finally {
      removingAttachmentId = null;
    }
  }

  let cancellingDissolution = $state(false);
  /** Le propriétaire annule la désactivation demandée. */
  async function cancelDissolution() {
    if (cancellingDissolution) return;
    cancellingDissolution = true;
    try {
      const res = await dashboardFetch('/wellbeing/dissolution/cancel', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      toast.success(m.toast_wb_dissolution_cancelled());
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_save_failed());
    } finally {
      cancellingDissolution = false;
    }
  }

  // Correction d'une note par son auteur, dans le même délai que le bot (NOTE_EDIT_HOURS).
  const NOTE_EDIT_MS = 48 * 60 * 60 * 1000;
  let editingNoteId = $state<string | null>(null);
  let editingText = $state('');
  let savingNote = $state(false);
  let originalShown = $state<Record<string, boolean>>({});
  const canEditNote = (note: any) => !!status?.canWriteCases && note.authorId === viewerId && Date.now() - new Date(note.createdAt).getTime() < NOTE_EDIT_MS;

  async function saveNoteEdit() {
    const target = selectedCase;
    const noteId = editingNoteId;
    if (!target || !noteId || !editingText.trim() || savingNote) return;
    savingNote = true;
    try {
      const res = await dashboardFetch(`/wellbeing/cases/${target.id}/notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editingText.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? '');
      applyItem(data.item);
      editingNoteId = null;
      toast.success(m.toast_wb_note_edited());
    } catch (err: any) {
      toast.error(err?.message || m.toast_wb_note_failed());
    } finally {
      savingNote = false;
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
        body: JSON.stringify({ content: newNote.trim(), notifyUserIds: noteNotify }),
      });
      if (!res.ok) throw new Error('note');
      newNote = '';
      noteNotify = [];
      await loadDetail(selectedCase.id);
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
        <div class="flex gap-2 mt-3">
          <Button size="sm" variant="ghost" icon="X" loading={endingLogId === log.id} onclick={() => void endBreakGlass(log.id)}>{m.wb_bg_cancel_request()}</Button>
        </div>
      {:else}
        <div class="flex gap-2 mt-3">
          <Button size="sm" variant="primary" icon="Check" loading={decidingLogId === log.id} onclick={() => void decideBreakGlass(log.id, true)}>{m.wb_pending_approve()}</Button>
          <Button size="sm" variant="ghost" icon="X" disabled={decidingLogId === log.id} onclick={() => void decideBreakGlass(log.id, false)}>{m.wb_pending_reject()}</Button>
        </div>
      {/if}
    </Callout>
  {/each}
{/snippet}

{#snippet caseRow(c: any)}
  {@const selected = selectedCaseId === c.id}
  <button
    type="button"
    aria-current={selected ? 'true' : undefined}
    onclick={() => { openCaseById(c.id); mobileDetail = true; }}
    class="w-full text-left rounded-lg border-l-4 {wbSeverityAccent(c.severity)} px-3 py-2.5 transition-colors {selected ? 'bg-primary/10 ring-1 ring-primary/30' : 'bg-surface-container-high/20 hover:bg-surface-container-high/40'}"
  >
    <div class="flex items-start justify-between gap-2">
      <span class="text-sm font-semibold text-on-surface line-clamp-2">{c.title}</span>
      {@render pill(wbStatusLabel(c.status), wbStatusTone(c.status))}
    </div>
    <p class="text-xs text-on-surface-variant mt-1 truncate">{c.subjectName} · {wbCategoryName(wbCustom.value, c.category)}</p>
    {#if c.tagIds?.length}
      <div class="flex flex-wrap gap-1 mt-1">
        {#each wbCaseTags(wbCustom.value, c.tagIds) as tag (tag.id)}
          <span class="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">{tag.label}</span>
        {/each}
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
      {@render pill(wbSeverityLabel(c.severity), wbSeverityTone(c.severity))}
      {#if c.source === 'DISCORD'}
        <span class="text-2xs font-semibold flex items-center gap-1 text-primary"><Papicon icon="MessageSquare" size={11} /> {m.wb_source_report()}</span>
      {/if}
      {#if c.assigneeId && c.assigneeId === viewerId}
        <span class="text-2xs font-semibold flex items-center gap-1 text-on-surface-variant"><Papicon icon="User" size={11} /> {m.wb_assigned_to_me()}</span>
      {/if}
      {#if wbIsReviewDue(c, now)}
        <span class="text-2xs font-semibold flex items-center gap-1 text-on-warning-container"><Papicon icon="Clock" size={11} /> {m.wb_review_due_badge()}</span>
      {/if}
    </div>
  </button>
{/snippet}

{#snippet caseList()}
  <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-4 space-y-3 lg:sticky lg:top-4">
    <h3 class="text-base font-semibold flex items-center gap-2"><Papicon icon="folder" size={16} /> {m.wb_cases_title()}</h3>
    <div class="flex flex-wrap gap-2">
      <input type="search" bind:value={caseSearch} class="input text-sm flex-1 min-w-36" aria-label={m.wb_search_label()} placeholder={m.wb_search_ph()} />
      {#if tags.length > 0}
        <select value={tagFilter ?? ''} onchange={(event) => (tagFilter = event.currentTarget.value || null)} class="input text-sm w-auto" aria-label={m.wb_tag_filter()}>
          <option value="">{m.wb_tag_filter_all()}</option>
          {#each tags as tag (tag.id)}<option value={tag.id}>{tag.label}</option>{/each}
        </select>
      {/if}
      {#if caseFilter !== 'trash'}
        <select bind:value={caseSort} class="input text-sm w-auto" aria-label={m.wb_sort_label()}>
          {#each SORT_OPTIONS as option (option.value)}<option value={option.value}>{option.label()}</option>{/each}
        </select>
      {/if}
    </div>
    <FilterPills label={m.wb_filter_label()} options={filterOptions} value={caseFilter} onchange={pickFilter} />
    {#if caseFilter === 'trash'}
      <p class="text-2xs text-on-surface-variant">{m.wb_trash_desc()}</p>
      {#if visibleCases.length === 0}
        <EmptyState icon="trash" title={m.wb_trash_empty()} reason="all-clear" />
      {:else}
        <ul class="space-y-1.5 max-h-[70vh] overflow-y-auto pr-1">
          {#each visibleCases as c (c.id)}
            <li class="rounded-lg bg-surface-container-high/20 px-3 py-2.5 space-y-1.5">
              <p class="text-sm font-semibold text-on-surface line-clamp-2">{c.title}</p>
              <p class="text-xs text-on-surface-variant">{m.wb_trashed_by({ name: c.deletedByName ?? '-', date: formatDay(c.deletedAt) })}</p>
              <div class="flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" icon="RotateCcw" loading={restoringId === c.id} onclick={() => void restoreCase(c.id)}>{m.wb_restore()}</Button>
                {#if !c.purgeRequestedById || (c.purgeRequestedAt && Date.now() - new Date(c.purgeRequestedAt).getTime() >= PURGE_REQUEST_MS)}
                  <Button size="sm" variant="ghost" icon="trash" loading={purgingId === c.id} onclick={() => void purgeStep(c.id, false)}>{m.wb_purge_request()}</Button>
                {:else if c.purgeRequestedById === viewerId}
                  <span class="text-2xs text-on-surface-variant self-center">{m.wb_purge_waiting()}</span>
                {:else}
                  <Button size="sm" variant="danger" icon="trash" loading={purgingId === c.id} onclick={() => void purgeStep(c.id, true)}>{m.wb_purge_approve({ name: c.purgeRequestedByName ?? '-' })}</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if cases.length === 0}
      <EmptyState icon="folder" title={m.wb_cases_empty()} reason="accumulating" />
    {:else if visibleCases.length === 0}
      <p class="text-sm text-on-surface-variant py-6 text-center">{m.wb_cases_filtered_empty()}</p>
    {:else}
      <ul class="space-y-1.5 max-h-[70vh] overflow-y-auto pr-1">
        {#each visibleCases as c (c.id)}
          <li>{@render caseRow(c)}</li>
        {/each}
      </ul>
    {/if}
    <p class="text-2xs text-on-surface-variant">{m.wb_cases_retention()}</p>
  </section>
{/snippet}

{#snippet hiddenContent()}
  <div class="rounded-xl border border-dashed border-outline-variant/60 p-6 text-center space-y-3">
    <p class="text-sm text-on-surface-variant flex items-center justify-center gap-2"><Papicon icon="EyeOff" size={16} /> {m.wb_discreet_hidden()}</p>
    <Button size="sm" variant="secondary" icon="eye" onclick={() => (revealed = true)}>{m.wb_discreet_reveal()}</Button>
  </div>
{/snippet}

{#snippet caseDetail()}
  {#if locked}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-8 text-center space-y-3">
      <div class="h-12 w-12 mx-auto rounded-full flex items-center justify-center bg-primary/10 text-primary"><Papicon icon="lock" size={22} /></div>
      <h2 class="text-base font-semibold text-on-surface">{m.wb_locked_page_title()}</h2>
      <p class="text-sm text-on-surface-variant">{m.wb_locked_page_desc()}</p>
      <Button variant="primary" icon="Unlock" onclick={unlock}>{m.wb_unlock()}</Button>
    </section>
  {:else if !selectedCaseId}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6">
      <EmptyState icon="file-text" title={m.wb_case_select()} reason="nothing-matches" />
    </section>
  {:else if !selectedCase}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-4">
      <Skeleton height="60px" />
      <Skeleton height="200px" />
    </section>
  {:else}
    <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-6 space-y-5">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold text-on-surface">{selectedCase.title}</h2>
            {@render pill(wbStatusLabel(selectedCase.status), wbStatusTone(selectedCase.status))}
            {@render pill(wbSeverityLabel(selectedCase.severity), wbSeverityTone(selectedCase.severity))}
            {#if selectedCase.status === 'CLOSED' && selectedCase.closedReason}
              {@render pill(wbCloseReasonLabel(selectedCase.closedReason), wbStatusTone('CLOSED'))}
            {/if}
          </div>
          <p class="text-xs text-on-surface-variant flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="flex items-center gap-1"><Papicon icon="User" size={12} /> {selectedCase.subjectName}</span>
            <span class="flex items-center gap-1"><Papicon icon="Tag" size={12} /> {wbCategoryName(wbCustom.value, selectedCase.category)}</span>
            <span class="flex items-center gap-1"><Papicon icon="Calendar" size={12} /> {formatDay(selectedCase.createdAt)}</span>
            {#if selectedCase.source === 'DISCORD'}
              <span class="flex items-center gap-1"><Papicon icon="MessageSquare" size={12} /> {m.wb_source_report()}</span>
            {/if}
            {#if integrity === 'ok' || integrity === 'partial'}
              <span class="flex items-center gap-1 text-on-success-container" title={integrity === 'ok' ? m.wb_integrity_ok_hint() : m.wb_integrity_partial_hint()}>
                <Papicon icon="ShieldCheck" size={12} /> {integrity === 'ok' ? m.wb_integrity_ok() : m.wb_integrity_partial()}
              </span>
            {/if}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="flex items-center gap-2 text-xs text-on-surface-variant">
            <ToggleSwitch size="sm" checked={discreet} onToggle={setDiscreet} ariaLabel={m.wb_discreet_label()} />
            {m.wb_discreet_label()}
          </span>
          {#if status?.canWriteCases}
            {#if selectedCase.subjectUserId && resources.length > 0}
              <Button size="sm" variant="secondary" icon="heart" loading={sendingResources} onclick={() => void sendResources()}>{m.wb_send_resources()}</Button>
            {/if}
            <Menu items={caseMenu} label={m.wb_case_actions({ name: selectedCase.title })} />
          {/if}
        </div>
      </header>
      <TagPicker tagIds={selectedCase.tagIds ?? []} canWrite={!!status?.canWriteCases} busy={updatingCase} onchange={(tagIds) => void updateCase({ tagIds })} />

      {#if integrity === 'broken'}
        <Callout variant="danger" title={m.wb_integrity_broken_title()}>{m.wb_integrity_broken_desc()}</Callout>
      {/if}
      {#if selectedHeader?.subjectIsTeamMember}
        <Callout variant="info" title={m.wb_conflict_title()}>{m.wb_conflict_desc()}</Callout>
      {/if}
      {#if !status?.canWriteCases}
        <Callout variant="info">{m.wb_read_only_emergency()}</Callout>
      {/if}
      {#if purgeInfo}
        <Callout variant={purgeInfo.soon ? 'warning' : 'info'} title={m.wb_purge_date({ date: formatDay(purgeInfo.date.toISOString()) })}>
          {m.wb_purge_date_desc()}
          {#if status?.canWriteCases}
            <div class="mt-3"><Button size="sm" variant="secondary" icon="Clock" loading={extending} onclick={() => void extendCase()}>{m.wb_extend()}</Button></div>
          {/if}
        </Callout>
      {/if}

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {@render choiceGroup(m.wb_status_label(), WB_STATUSES, selectedCase.status, wbStatusLabel, wbStatusTone, (code) => void pickStatus(code))}
        {@render choiceGroup(m.wb_severity_label(), WB_SEVERITIES, selectedCase.severity, wbSeverityLabel, wbSeverityTone, pickSeverity)}
      </div>
      {#if boardStages.length > 0 && status?.canWriteCases && selectedCase.status !== 'CLOSED'}
        <div class="flex flex-wrap items-center gap-2">
          <label for="wb-case-stage" class="text-xs font-medium text-on-surface-variant">{m.wb_stage_label()}</label>
          <select id="wb-case-stage" class="input text-sm w-auto" value={selectedCase.stage ?? ''} disabled={updatingCase}
            onchange={(event) => void updateCase({ stage: event.currentTarget.value || null })}>
            <option value="">{m.wb_stage_none()}</option>
            {#each boardStages as stage (stage.id)}
              <option value={stage.id}>{stage.label}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if absence}
        <Callout variant="warning" title={absence.until ? m.wb_absent_until({ date: formatDay(absence.until) }) : m.wb_absent_open()}>
          {#if absence.backupUserId}
            <span class="flex flex-wrap items-center gap-1">{m.wb_absent_backup()} <MemberName userId={absence.backupUserId} /></span>
          {:else}
            {m.wb_absent_no_backup()}
          {/if}
        </Callout>
      {/if}

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
              <div class="space-y-1.5">
                <select {id} aria-describedby={describedBy} class="input w-full" bind:value={assigneeCandidate} disabled={updatingCase}
                  onchange={() => { const assigneeId = assigneeCandidate; assigneeCandidate = ''; if (assigneeId) void updateCase({ assigneeId }); }}>
                  <option value="">{m.wb_member_pick()}</option>
                  {#each teamFor(selectedCase?.subjectUserId) as member (member.id)}
                    <option value={member.id}>{member.name}</option>
                  {/each}
                </select>
                {#if viewerId && viewerId !== selectedCase?.subjectUserId}
                  <Button size="sm" variant="ghost" icon="User" disabled={updatingCase} onclick={() => void updateCase({ assigneeId: viewerId })}>{m.wb_assign_me()}</Button>
                {/if}
              </div>
            {:else}
              <p class="text-sm text-on-surface-variant min-h-9 flex items-center">{m.wb_assignee_none()}</p>
            {/if}
          {/snippet}
        </Field>
        <Field label={m.wb_review_at()} hint={m.wb_review_hint()}>
          {#snippet children(id, describedBy)}
            <div class="space-y-1.5">
              <div class="flex items-center gap-2">
                <input {id} aria-describedby={describedBy} type="date" class="input w-full" disabled={updatingCase || !status?.canWriteCases}
                  value={selectedCase?.reviewAt ? selectedCase.reviewAt.slice(0, 10) : ''}
                  onchange={(e) => void updateCase({ reviewAt: e.currentTarget.value || null })} />
                {#if selectedCase?.reviewAt && status?.canWriteCases}
                  <Button size="sm" variant="ghost" icon="X" disabled={updatingCase} aria-label={m.wb_review_clear()} onclick={() => void updateCase({ reviewAt: null })} />
                {/if}
              </div>
              {#if status?.canWriteCases}
                <div role="group" aria-label={m.wb_review_shortcuts()} class="flex flex-wrap gap-1.5">
                  {#each WB_REVIEW_SHORTCUTS as days (days)}
                    <Button size="sm" variant="ghost" disabled={updatingCase} onclick={() => void updateCase({ reviewAt: wbReviewShortcut(new Date(), days) })}>{m.wb_review_in_days({ days })}</Button>
                  {/each}
                </div>
              {/if}
            </div>
          {/snippet}
        </Field>
      </div>

      <NetworkReferent caseId={selectedCase.id} subjectUserId={selectedCase.subjectUserId ?? null}
        referentId={selectedCase.networkReferentId ?? null} referentGuildId={selectedCase.networkReferentGuildId ?? null}
        canWrite={!!status?.canWriteCases} onchange={applyItem} />

      {#if selectedCase.hasTrackingCode}
        <ReporterThread caseId={selectedCase.id} messages={selectedCase.reporterMessages ?? []} canWrite={!!status?.canWriteCases} hidden={contentHidden} onchange={applyItem} />
      {/if}

      {#if linkedCases.length > 0}
        <div class="space-y-1.5">
          <h3 class="text-xs font-semibold text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Link" size={13} /> {m.wb_linked_title({ count: linkedCases.length })}</h3>
          <div class="flex flex-wrap gap-1.5">
            {#each linkedCases as linked (linked.id)}
              <button type="button" onclick={() => openCaseById(linked.id)}
                class="text-xs px-2.5 py-1 rounded-lg border border-outline-variant/40 text-on-surface hover:bg-surface-container-high/40 flex items-center gap-1.5">
                {linked.title} {@render pill(wbStatusLabel(linked.status), wbStatusTone(linked.status))}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if contentHidden}
        {@render hiddenContent()}
      {:else}
        <div class="space-y-1.5">
          <h3 class="text-xs font-semibold text-on-surface-variant">{m.wb_summary()}</h3>
          <p class="text-sm whitespace-pre-wrap text-on-surface bg-surface-container-lowest rounded-lg p-3 border border-outline-variant/40">{selectedCase.summary}</p>
        </div>
      {/if}

      <div class="space-y-4 border-t border-outline-variant/30 pt-4">
        <Tabs label={m.wb_detail_tabs_label()} tabs={detailTabs} active={detailTab} onchange={(id) => (detailTab = id as DetailTab)} />
        {#if detailTab === 'timeline'}
        <div class="space-y-3">
          {#if status?.canWriteCases}
            <form onsubmit={addNote} class="space-y-2">
              <textarea bind:this={noteInput} bind:value={newNote} aria-label={m.a11y_wellbeing_note()} required rows={2} placeholder={m.wb_note_ph()} class="input w-full text-sm"></textarea>
              <div class="space-y-1">
                <label for="wb-note-notify" class="text-xs font-medium text-on-surface-variant">{m.wb_note_notify()}</label>
                <WellbeingMemberList id="wb-note-notify" bind:ids={noteNotify} max={5} candidates={teamFor(selectedCase?.subjectUserId, false)} />
              </div>
              <div class="flex justify-end">
                <Button type="submit" size="sm" variant="primary" icon="Plus" loading={addingNote} disabled={!newNote.trim()}>{m.wb_note_add()}</Button>
              </div>
            </form>
          {/if}
          {#if timeline.length > 0}
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div role="group" aria-label={m.wb_timeline_view_label()} class="inline-flex rounded-lg border border-outline-variant/40 bg-surface-container p-0.5 text-xs">
                <button type="button" aria-pressed={!timelineNotesOnly} onclick={() => setNotesOnly(false)}
                  class="rounded-md px-2.5 py-1 {!timelineNotesOnly ? 'bg-surface-container-highest font-semibold text-on-surface' : 'text-on-surface-variant'}">{m.wb_timeline_all()}</button>
                <button type="button" aria-pressed={timelineNotesOnly} onclick={() => setNotesOnly(true)}
                  class="rounded-md px-2.5 py-1 {timelineNotesOnly ? 'bg-surface-container-highest font-semibold text-on-surface' : 'text-on-surface-variant'}">{m.wb_timeline_notes_only()}</button>
              </div>
              {#if !timelineNotesOnly && expandedGroups.length > 0}
                <Button size="sm" variant="ghost" icon="ChevronUp" onclick={() => (expandedGroups = [])}>{m.wb_timeline_collapse_all()}</Button>
              {/if}
            </div>
          {/if}
          {#if compactTimeline.length === 0}
            <p class="text-xs text-on-surface-variant">{timeline.length === 0 ? m.wb_timeline_empty() : m.wb_timeline_no_note()}</p>
          {:else}
            <ol class="relative border-l border-outline-variant/50 ml-2 space-y-3">
              {#each compactTimeline as entry (entry.id)}
                <li class="ml-4">
                  <span class="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full {entry.kind === 'note' ? 'bg-primary' : 'bg-outline-variant'}" aria-hidden="true"></span>
                  {#if entry.kind === 'group'}
                    <button type="button" aria-expanded="false" class="flex flex-wrap items-center gap-x-2 text-xs text-on-surface-variant hover:text-on-surface"
                      onclick={() => (expandedGroups = [...expandedGroups, entry.id])}>
                      <Papicon icon="ChevronDown" size={12} />
                      <span class="font-medium">{m.wb_timeline_group({ count: entry.count })}</span>
                      <span>· {formatDay(entry.entries[entry.entries.length - 1]!.at)} – {formatDay(entry.at)}</span>
                    </button>
                  {:else if entry.kind === 'note'}
                    <div class="rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-3 text-sm">
                      <div class="flex flex-wrap justify-between gap-2 text-xs text-on-surface-variant mb-1">
                        <span class="font-semibold text-on-surface">{entry.note.authorName}</span>
                        <span>{formatDate(entry.at)}</span>
                      </div>
                      {#if contentHidden}
                        <p class="text-xs italic text-on-surface-variant">{m.wb_discreet_note_hidden()}</p>
                      {:else if editingNoteId === entry.note.id}
                        <div class="space-y-2">
                          <textarea bind:value={editingText} rows={3} class="input w-full text-sm" aria-label={m.wb_note_edit_label()}></textarea>
                          <div class="flex justify-end gap-2">
                            <Button size="sm" variant="ghost" onclick={() => (editingNoteId = null)}>{m.common_cancel()}</Button>
                            <Button size="sm" variant="primary" loading={savingNote} disabled={!editingText.trim()} onclick={() => void saveNoteEdit()}>{m.common_save()}</Button>
                          </div>
                        </div>
                      {:else}
                        <p class="whitespace-pre-wrap text-on-surface">{entry.note.content}</p>
                        <div class="flex flex-wrap items-center gap-2 mt-1.5 text-2xs text-on-surface-variant">
                          {#if entry.note.editedAt}
                            <span>{m.wb_note_edited({ date: formatDate(entry.note.editedAt) })}</span>
                            {#if entry.note.originalContent}
                              <button type="button" class="underline hover:text-on-surface" aria-expanded={!!originalShown[entry.note.id]}
                                onclick={() => (originalShown = { ...originalShown, [entry.note.id]: !originalShown[entry.note.id] })}>
                                {originalShown[entry.note.id] ? m.wb_note_hide_original() : m.wb_note_show_original()}
                              </button>
                            {/if}
                          {/if}
                          {#if canEditNote(entry.note)}
                            <button type="button" class="underline hover:text-on-surface" onclick={() => { editingNoteId = entry.note.id; editingText = entry.note.content; }}>{m.wb_note_edit()}</button>
                          {/if}
                        </div>
                        {#if entry.note.originalContent && originalShown[entry.note.id]}
                          <p class="mt-2 whitespace-pre-wrap text-xs text-on-surface-variant border-l-2 border-outline-variant pl-2">{entry.note.originalContent}</p>
                        {/if}
                      {/if}
                    </div>
                  {:else}
                    <p class="flex flex-wrap items-center gap-x-2 text-xs text-on-surface-variant">
                      <span class="font-medium text-on-surface">{entry.event.actorName}</span>
                      <span>{wbCaseEventLabel(entry.event, formatDay)}</span>
                      {#if entry.event.type === 'ASSIGNEE' && entry.event.toValue}<MemberName userId={entry.event.toValue} />{/if}
                      <span>· {formatDate(entry.at)}</span>
                    </p>
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
        </div>
        {:else if detailTab === 'tasks'}
          <CaseTasks caseId={selectedCase.id} tasks={selectedCase.tasks ?? []} canWrite={!!status?.canWriteCases} hidden={contentHidden} onchange={applyItem} />
        {:else}
        <div class="space-y-2">
          <p class="text-xs text-on-surface-variant">{m.wb_attachments_desc()}</p>
          {#if contentHidden && (selectedCase.attachments ?? []).length > 0}
            <p class="text-xs italic text-on-surface-variant">{m.wb_discreet_attachments_hidden({ count: selectedCase.attachments.length })}</p>
          {:else}
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
          {/if}
          {#if status?.canWriteCases && (selectedCase.attachments ?? []).length < MAX_CASE_ATTACHMENTS}
            <form onsubmit={addAttachment} class="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
              <input bind:value={newAttachmentLabel} maxlength={120} class="input text-sm" aria-label={m.wb_attachment_label()} placeholder={m.wb_attachment_label()} />
              <input bind:value={newAttachmentUrl} type="url" required maxlength={500} class="input text-sm" aria-label={m.wb_attachment_url()} placeholder={m.wb_attachment_url_ph()} />
              <Button type="submit" size="sm" variant="secondary" icon="Plus" loading={addingAttachment}>{m.common_add()}</Button>
            </form>
          {/if}
        </div>
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
      <Button variant="primary" icon="plus" onclick={() => void openNewCase()}>{m.wb_new_case()}</Button>
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
          {#if status.breakGlassLogId}
            <div class="mt-3">
              <Button size="sm" variant="secondary" icon="lock" loading={endingLogId === status.breakGlassLogId} onclick={() => void endBreakGlass(status!.breakGlassLogId!)}>{m.wb_bg_end_now()}</Button>
            </div>
          {/if}
        </Callout>
      {/if}
      {#if status.dissolutionAt}
        <Callout variant="danger" title={m.wb_dissolution_title({ date: formatDate(status.dissolutionAt) })} class="mb-4">
          {m.wb_dissolution_desc({ name: status.dissolutionByName ?? '-' })}
          {#if status.canConfigure}
            <div class="mt-3"><Button size="sm" variant="secondary" icon="RotateCcw" loading={cancellingDissolution} onclick={() => void cancelDissolution()}>{m.wb_dissolution_cancel()}</Button></div>
          {/if}
        </Callout>
      {/if}
      {#if status.accessReviewDue && activeTab !== 'settings'}
        <Callout variant="info" title={m.wb_review_due_title()} class="mb-4">
          {m.wb_review_due_desc()}
          <div class="mt-3"><Button size="sm" variant="secondary" icon="settings" onclick={() => (activeTab = 'settings')}>{m.wb_review_open()}</Button></div>
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
      {:else if reauthRequired}
        <section class="bg-surface-container-low/40 border border-outline-variant/30 rounded-xl p-8 text-center space-y-3 max-w-xl mx-auto">
          <div class="h-12 w-12 mx-auto rounded-full flex items-center justify-center bg-primary/10 text-primary"><Papicon icon="lock" size={22} /></div>
          <h2 class="text-base font-semibold text-on-surface">{m.wb_reauth_title()}</h2>
          <p class="text-sm text-on-surface-variant">{m.wb_reauth_desc()}</p>
          <Button variant="primary" icon="LogIn" onclick={() => void authStore.logout()}>{m.wb_reauth_action()}</Button>
        </section>
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
        {#if status.canWriteCases}
          <DistressSignals bind:this={signalsPanel} onopen={(signal) => void openCaseFromSignal(signal)} />
          <NetworkCases hidden={contentHidden} />
        {/if}
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatTile icon="folder" tone="bg-primary/10 text-primary" value={stats.active} label={m.wb_stat_active()} />
          <StatTile icon="AlertTriangle" tone="bg-error/10 text-on-error-container" value={stats.urgent} label={m.wb_stat_urgent()} />
          <StatTile icon="Clock" tone="bg-warning/10 text-on-warning-container" value={stats.reviewDue} label={m.wb_stat_review_due()} />
          <StatTile icon="Check" tone="bg-success/10 text-on-success-container" value={stats.closed} label={m.wb_stat_closed()} />
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div role="group" aria-label={m.wb_view_label()} class="inline-flex rounded-xl border border-outline-variant/40 bg-surface-container p-1 gap-1">
            {#each [{ id: 'list', icon: 'List', label: m.wb_view_list(), hint: m.wb_view_list_hint() }, { id: 'board', icon: 'Columns', label: m.wb_view_board(), hint: m.wb_view_board_hint() }] as view (view.id)}
              <button type="button" aria-pressed={caseView === view.id} onclick={() => setCaseView(view.id as 'list' | 'board')}
                class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-left transition-colors {caseView === view.id ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high'}">
                <Papicon icon={view.icon} size={16} />
                <span>
                  <span class="block font-semibold leading-tight">{view.label}</span>
                  <span class="block text-2xs opacity-80 leading-tight">{view.hint}</span>
                </span>
              </button>
            {/each}
          </div>
          <p class="text-2xs text-on-surface-variant flex items-center gap-1.5"><Papicon icon="Keyboard" size={12} /> {m.wb_shortcuts_hint()}</p>
        </div>
        {#if caseView === 'board'}
          <div class="space-y-6">
            <div class="flex flex-wrap items-center gap-3">
              <input type="search" bind:value={caseSearch} class="input text-sm flex-1 min-w-48 max-w-md" aria-label={m.wb_search_label()} placeholder={m.wb_search_ph()} />
              {#if tags.length > 0}
                <select value={tagFilter ?? ''} onchange={(event) => (tagFilter = event.currentTarget.value || null)} class="input text-sm w-auto" aria-label={m.wb_tag_filter()}>
                  <option value="">{m.wb_tag_filter_all()}</option>
                  {#each tags as tag (tag.id)}<option value={tag.id}>{tag.label}</option>{/each}
                </select>
              {/if}
              <p class="text-2xs text-on-surface-variant">{m.wb_board_hint()}</p>
            </div>
            <CaseBoard cases={boardCases} stages={boardStages} selectedId={selectedCaseId} canWrite={!!status.canWriteCases} onopen={openCaseById}
              onmove={(id, target) => void moveCase(id, target)} onstages={saveStages} />
            {@render caseDetail()}
          </div>
        {:else}
          {#if $isMobile}
            <!-- Sur petit écran : la liste, puis la fiche en pleine largeur avec un retour. -->
            {#if mobileDetail && selectedCaseId}
              <div class="space-y-3">
                <Button size="sm" variant="ghost" icon="ArrowLeft" onclick={() => (mobileDetail = false)}>{m.wb_mobile_back()}</Button>
                {@render caseDetail()}
              </div>
            {:else}
              {@render caseList()}
            {/if}
          {:else}
            <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6 items-start">
              {@render caseList()}
              {@render caseDetail()}
            </div>
          {/if}
        {/if}
      {/if}
    {:else if activeTab === 'profiles'}
      <ProfilesPanel {cases} hidden={contentHidden} initialSubjectId={profileSubjectId}
        checkReauth={async (res) => { const stale = await needsReauth(res); if (stale) activeTab = 'cases'; return stale; }}
        {selectedCaseId} {caseDetail}
        onselectcase={(caseId) => { if (caseId) openCaseById(caseId); else { selectedCaseId = null; detail = null; } }}
        onnewcase={(prefill) => void openNewCase(prefill)} />
    {:else if activeTab === 'stats'}
      {#if cellStats}
        <WellbeingStats stats={cellStats} load={cellLoad} pulse={cellPulse} profiles={cellProfiles} stages={cellStages} />
      {:else}
        <Skeleton height="320px" />
      {/if}
    {:else if activeTab === 'custom'}
      <CustomizationPanel />
    {:else if activeTab === 'resources'}
      <ResourcesEditor bind:resources />
      <div class="mt-6">
        <ReportPanelPublisher reportEnabled={status.reportEnabled} />
      </div>
    {:else if activeTab === 'access'}
      <div class="space-y-6">
        {#if pendingLogs.length > 0}
          <div class="space-y-3">{@render pendingRequests()}</div>
        {/if}
        <AccessLog {logs} {viewerId} canRevokeOthers={!!status.isTeamMember || !!status.canConfigure} {endingLogId} onend={(logId) => void endBreakGlass(logId)} />
      </div>
    {:else if activeTab === 'settings'}
      <WellbeingSettings
        accessReviewDue={status.accessReviewDue}
        onsaved={loadAll}
        onreviewed={() => { if (status) status = { ...status, accessReviewDue: false }; }}
      />
    {/if}
  {/if}
</ModulePage>

<svelte:window onkeydown={onShortcut} />

<Modal bind:open={closeDialogOpen} title={m.wb_close_case_q()} size="sm" onClose={() => finishClose(null)}>
  <div class="space-y-4">
    <p class="text-sm text-on-surface-variant">{m.wb_cases_retention()}</p>
    <div class="space-y-1.5">
      <p class="text-xs font-semibold text-on-surface-variant">{m.wb_close_reason_label()}</p>
      <div role="group" aria-label={m.wb_close_reason_label()} class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {#each WB_CLOSE_REASONS as code (code)}
          <button type="button" aria-pressed={closeReason === code} onclick={() => (closeReason = code)}
            class="text-sm text-left font-medium px-3 py-2 rounded-lg transition-colors {closeReason === code ? 'bg-primary/10 text-primary border border-primary/30' : 'border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high/40'}">
            {wbCloseReasonLabel(code)}
          </button>
        {/each}
      </div>
    </div>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => finishClose(null)}>{m.common_cancel()}</Button>
    <Button variant="primary" icon="Check" onclick={() => finishClose(closeReason)}>{m.wb_close_case_confirm()}</Button>
  {/snippet}
</Modal>

<BreakGlassModal bind:open={breakGlassOpen} approvalRequired={!!status?.breakGlassApproval} ondone={loadAll} />

<NewCaseModal bind:this={newCaseModal} bind:open={newCaseOpen} {viewerId} {teamFor} oncreated={onCaseCreated} />
