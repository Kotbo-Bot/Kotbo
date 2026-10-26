<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { resolveTabFromUrl } from '../lib/tabRouting';
  import { authStore } from '../lib/stores/auth.svelte';
  import { canViewFeature } from '../lib/permissions.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import {
    fetchStaffMembers,
    fetchStaffCalendarData,
    fetchAbsenceSuperiors,
    createCall,
    deleteCall,
    fetchTasks,
    createTask,
    updateTask,
    deleteTask,
    createAbsence,
    updateAbsenceStatus,
    createMeeting,
    deleteMeeting,
    updateMeeting,
    deleteAbsence,
    searchDiscordMembers,
    fetchCallPermissionConfig,
    updateCallPermissionConfig,
    fetchMemberCase,
    createReminder,
    deleteReminder,
    type AbsenceSuperior,
  } from '../lib/api';
  import { parseDiscordEmojisAndMarkdown } from '../lib/emojiParser';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import { formatWallClockInTimezone, parseDateTimeInTimezone } from '@kotbo/contracts';
  import TimezoneHint from '../lib/components/TimezoneHint.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Calendar, { EVENT_TYPE_COLOR, CALENDAR_VIEWS, type CalendarEvent, type CalendarView } from '../lib/components/Calendar.svelte';
  import AnchoredPopover from '../lib/components/planning/AnchoredPopover.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import DiscordMarkdownEditor from '../lib/components/DiscordMarkdownEditor.svelte';
  import DoingListPin from '../lib/components/doingLists/DoingListPin.svelte';
  import { Button, Callout, Field, FilterPills, Menu, Modal, ToggleSwitch, type FilterOption, type MenuItem } from '../lib/components/ui';
  import { localInitialAvatar } from '../lib/discordMedia';
  import { errorMessage } from '@kotbo/shared';

  type PlanningType = 'meeting' | 'absence' | 'call' | 'task';
  type CalendarData = { absences: any[]; voiceSessions: any[]; meetings: any[]; calls: any[]; tasks: any[] };
  const emptyCalendarData = (): CalendarData => ({ absences: [], voiceSessions: [], meetings: [], calls: [], tasks: [] });
  const normalize = (data: any): CalendarData => ({
    absences: data?.absences || [],
    voiceSessions: data?.voiceSessions || [],
    meetings: data?.meetings || [],
    calls: data?.calls || [],
    tasks: data?.tasks || [],
  });

  const TYPES: PlanningType[] = ['meeting', 'call', 'absence', 'task'];
  const TYPE_META: Record<PlanningType, { label: () => string; calendar: () => string; icon: string }> = {
    meeting: { label: m.planning_type_meeting, calendar: m.planning_cal_meetings, icon: 'calendar' },
    call: { label: m.planning_type_call, calendar: m.planning_cal_calls, icon: 'phone' },
    absence: { label: m.planning_type_absence, calendar: m.planning_cal_absences, icon: 'sun' },
    task: { label: m.planning_type_task, calendar: m.planning_cal_tasks, icon: 'check-square' },
  };
  const VIEW_META: Record<CalendarView, { label: () => string; short?: () => string; icon: string }> = {
    day: { label: m.cal_view_day, icon: 'calendar' },
    workweek: { label: m.cal_view_workweek, short: m.cal_view_workweek_short, icon: 'briefcase' },
    week: { label: m.cal_view_week, icon: 'calendar-days' },
    month: { label: m.cal_view_month, icon: 'layout-grid' },
    agenda: { label: m.cal_view_agenda, icon: 'list' },
  };
  const PRIORITY_LABEL: Record<string, () => string> = {
    LOW: m.planning_priority_low,
    MEDIUM: m.planning_priority_medium,
    HIGH: m.planning_priority_high,
  };
  const TASK_STATUS_LABEL: Record<string, () => string> = {
    PENDING: m.planning_task_status_pending,
    IN_PROGRESS: m.planning_task_status_in_progress,
    COMPLETED: m.planning_task_status_completed,
  };
  const ABSENCE_STATUS: Record<string, { label: () => string; badge: string }> = {
    PENDING: { label: m.planning_absence_pending, badge: 'badge-warning' },
    ACKNOWLEDGED: { label: m.planning_absence_acknowledged, badge: 'badge-info' },
    APPROVED: { label: m.planning_absence_approved, badge: 'badge-success' },
    REJECTED: { label: m.planning_absence_rejected, badge: 'badge-danger' },
  };
  const MEETING_BADGE: Record<string, string> = {
    SCHEDULED: 'badge-info',
    IN_PROGRESS: 'badge-warning',
    COMPLETED: 'badge-success',
    CANCELLED: 'badge-danger',
    PRESENT: 'badge-success',
    EXCUSED: 'badge-warning',
    ABSENT_CHECKED: 'badge-warning',
    ABSENT: 'badge-danger',
  };

  // ── Donnees ─────────────────────────────────────────────
  let loading = $state(true);
  let allStaff = $state<any[]>([]);
  let superiors = $state<AbsenceSuperior[]>([]);
  let calendarData = $state<CalendarData>(emptyCalendarData());
  // Journee en cours pour toute l'equipe, quel que soit le filtre ou la periode affichee.
  let todayData = $state<CalendarData>(emptyCalendarData());
  let userTasks = $state<any[]>([]);

  // ── Affichage ───────────────────────────────────────────
  let calendarView = $state<CalendarView>('week');
  let calendarCurrentDate = $state(new Date());
  let rangeStart = $state(new Date());
  let rangeEnd = $state(new Date());
  let rangeKnown = false;
  let miniCalDate = $state(new Date());
  let selectedStaffIds = $state<string[]>([]);
  let visibleTypes = $state<string[]>([...TYPES]);
  let peopleQuery = $state('');
  let leftPaneOpen = $state(true);
  let myDayOpen = $state(true);
  let myDayTab = $state<'agenda' | 'tasks'>('agenda');
  let showDoneTasks = $state(false);
  let quickTaskTitle = $state('');
  let quickTaskSaving = $state(false);

  // ── Bulles ──────────────────────────────────────────────
  let peek = $state<{ event: CalendarEvent; anchor: DOMRect } | null>(null);
  let quickAnchor = $state<DOMRect | null>(null);

  // ── Creation ────────────────────────────────────────────
  const planningTabs = ['meeting', 'absence', 'call', 'task'] as const;
  // L'onglet de l'URL (/planning/absence...) choisit le type propose a la creation.
  let createType = $state<PlanningType>('meeting');
  $effect(() => {
    const _path = $router.path;
    createType = resolveTabFromUrl('/planning', planningTabs, 'meeting') as PlanningType;
  });

  let creationModalOpen = $state(false);
  let selectedStartDate = $state(new Date());
  let selectedEndDate = $state(new Date(Date.now() + 3600000));
  // Fuseau choisi pour la reunion en cours de creation ; remis a `null` a chaque ouverture.
  let formTimezone = $state<string | null>(null);
  let formTitle = $state('');
  let formDescription = $state('');
  let formPriority = $state<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  let formAssigneeId = $state('');
  let formSuperiorId = $state<string | null>('');
  let formAbsenceType = $state('Autre');
  let formChannelMode = $state('CREATE_NEW');
  let formChannelType = $state('VOICE');
  let formDiscordChannelId = $state('');
  let formIsTempChannel = $state(true);
  let formInviteeUserIds = $state<string[]>([]);
  let formError = $state('');
  let saving = $state(false);

  let memberSearchQuery = $state('');
  let memberSearchResults = $state<any[]>([]);
  let memberSearchLoading = $state(false);
  let memberSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  let formInviteeMemberIds = $state<string[]>([]);
  let selectedMembers = $state<Map<string, any>>(new Map());

  // ── Fiche complete ──────────────────────────────────────
  let detailModalOpen = $state(false);
  let currentItemDetail = $state<CalendarEvent | null>(null);
  let newReminderTime = $state('');
  let newReminderMessage = $state('');
  let newReminderChannel = $state('DM');

  // ── Qui peut creer des appels ───────────────────────────
  let callPermConfig = $state<any>(null);
  let callPermCanCreate = $state(true);
  let permissionModalOpen = $state(false);
  let permMode = $state<'EVERYONE' | 'RESTRICTED'>('EVERYONE');
  let permRoleIds = $state<string[]>([]);
  let permUserIds = $state<string[]>([]);
  let permSelectedUsersMap = $state<Map<string, any>>(new Map());
  let permMemberSearchQuery = $state('');
  let permMemberSearchResults = $state<any[]>([]);
  let permMemberSearchLoading = $state(false);
  let permMemberSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  let permError = $state('');
  let permSaving = $state(false);

  // ── Droits ──────────────────────────────────────────────
  const isAdmin = $derived(authStore.guilds.find(g => g.id === authStore.selectedGuildId)?.accessLevel === 'admin');
  const canManageSettings = $derived(isAdmin || !!dashboardStore.state.access?.canManageSettings);
  const meetingsFeatureAccess = $derived((dashboardStore.state.featureAccess as any)?.meetings || {});
  const canManageMeetings = $derived(canManageSettings || !!meetingsFeatureAccess.canConfigure);
  const canModerateMeetings = $derived(canManageMeetings || !!meetingsFeatureAccess.canModerate);
  const absencesFeatureAccess = $derived((dashboardStore.state.featureAccess as any)?.absences || {});
  const canModerateAbsences = $derived(canManageSettings || !!absencesFeatureAccess.canModerate || !!absencesFeatureAccess.canConfigure);
  /**
   * Le dossier membre est la fiche de la section Membres : un role a qui le
   * centre de gestion l'a fermee ne doit pas la rouvrir depuis cette page.
   */
  const canOpenMemberCase = $derived(canViewFeature('members'));

  // ── Dossier membre ──────────────────────────────────────
  let userCaseModalOpen = $state(false);
  let selectedUserIdForCase = $state<string | null>(null);
  let selectedUserNameForCase = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  // ── Reunions : suppression et edition ───────────────────
  let meetingDeleteModalOpen = $state(false);
  let meetingToDeleteId = $state<string | null>(null);
  let deleteDiscordEvent = $state(true);
  let deleteDiscordMessage = $state(false);
  let deleteDiscordNotification = $state(true);
  let deletingMeeting = $state(false);

  let meetingEditModalOpen = $state(false);
  let editMeetingId = $state<string | null>(null);
  let editMeetingTitle = $state('');
  let editMeetingDesc = $state('');
  let editMeetingDate = $state('');
  let editMeetingEndDate = $state('');
  let editMeetingError = $state('');
  let editMeetingTimezone = $state<string | null>(null);
  let savingMeetingEdit = $state(false);

  // ── Derives ─────────────────────────────────────────────
  const myId = $derived((authStore.user as any)?.id);
  const myStaffRecord = $derived(allStaff.find(s => s.userId === myId));
  const activeStaff = $derived(allStaff.filter(s => !s.blacklistEntries || s.blacklistEntries.length === 0));
  const filteredStaff = $derived.by(() => {
    const q = peopleQuery.trim().toLowerCase();
    return q ? activeStaff.filter(s => `${s.displayName ?? ''} ${s.username ?? ''}`.toLowerCase().includes(q)) : activeStaff;
  });

  const superiorLabel = (s: AbsenceSuperior) =>
    `${s.displayName} · ${s.reason === 'tutor' ? m.planning_superior_tutor() : s.reason === 'owner' ? m.planning_superior_owner() : s.grade ?? ''}`;
  const superiorOptions = $derived(superiors.map(s => ({ id: s.userId, name: superiorLabel(s) })));

  /** Forme commune d'un element du planning, pour le calendrier comme pour les listes. */
  function toEvent(type: PlanningType, raw: any): CalendarEvent {
    if (type === 'absence') {
      const start = new Date(raw.startDate);
      const end = raw.endDate ? new Date(raw.endDate) : (raw.isIndefinite ? new Date(start.getTime() + 86400000 * 30) : start);
      const durationHours = (end.getTime() - start.getTime()) / 3600000;
      return {
        id: raw.id, title: raw.reason, start, end, type, raw,
        isAllDay: raw.isIndefinite || durationHours >= 12,
        staffName: raw.staffMember?.displayName || raw.staffMember?.username,
        avatarUrl: raw.staffMember?.avatarUrl,
      };
    }
    const startRaw = type === 'task' ? raw.dueDate : raw.scheduledAt;
    const start = startRaw ? new Date(startRaw) : new Date();
    const fallback = type === 'meeting' ? 3600000 : 1800000;
    const end = type !== 'task' && raw.endedAt ? new Date(raw.endedAt) : new Date(start.getTime() + fallback);
    return { id: raw.id, title: raw.title, start, end, type, isAllDay: false, details: raw.description, raw };
  }

  const calendarEvents = $derived.by(() => {
    const events: CalendarEvent[] = [];
    if (visibleTypes.includes('meeting')) calendarData.meetings.forEach(x => events.push(toEvent('meeting', x)));
    if (visibleTypes.includes('absence')) calendarData.absences.forEach(x => events.push(toEvent('absence', x)));
    if (visibleTypes.includes('call')) calendarData.calls.forEach(x => events.push(toEvent('call', x)));
    if (visibleTypes.includes('task')) calendarData.tasks.filter(t => t.dueDate).forEach(x => events.push(toEvent('task', x)));
    return events;
  });

  const typeCounts = $derived<Record<PlanningType, number>>({
    meeting: calendarData.meetings.length,
    call: calendarData.calls.length,
    absence: calendarData.absences.length,
    task: calendarData.tasks.filter(t => t.dueDate).length,
  });

  const todayAgenda = $derived(
    [...todayData.meetings.map(x => toEvent('meeting', x)), ...todayData.calls.map(x => toEvent('call', x))]
      .sort((a, b) => a.start.getTime() - b.start.getTime()),
  );
  const absentToday = $derived(todayData.absences.filter(a => a.status !== 'REJECTED'));
  const pendingTasks = $derived(userTasks.filter(t => t.status !== 'COMPLETED'));
  const doneTasks = $derived(userTasks.filter(t => t.status === 'COMPLETED'));

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const isSameDay = (a: Date, b: Date) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const isToday = (d: Date) => isSameDay(d, new Date());
  const inRange = (d: Date) => d.getTime() >= rangeStart.getTime() && d.getTime() <= rangeEnd.getTime();
  const isOverdue = (task: any) => task.dueDate && task.status !== 'COMPLETED' && new Date(task.dueDate).getTime() < Date.now();
  const formatTime = (date: Date) => date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  const memberName = (x: any) => x?.displayName || x?.username || m.planning_member_fallback();
  const eventKey = (e: CalendarEvent | null | undefined) => (e ? `${e.type}:${e.id}` : null);

  function formatSpan(start: Date, end: Date | undefined, type: string) {
    const day = capitalize(start.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' }));
    if (type === 'task' || !end) return `${day} · ${formatTime(start)}`;
    if (isSameDay(start, end)) return `${day} · ${formatTime(start)} – ${formatTime(end)}`;
    return `${day} ${formatTime(start)} – ${end.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long' })} ${formatTime(end)}`;
  }

  const miniCalDays = $derived.by(() => {
    const year = miniCalDate.getFullYear();
    const month = miniCalDate.getMonth();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => {
      const date = new Date(year, month, 1 - offset + i);
      return { date, isCurrentMonth: date.getMonth() === month };
    });
  });

  // Le mini calendrier suit la periode affichee.
  $effect(() => {
    const d = calendarCurrentDate;
    miniCalDate = new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // ── Fuseaux ─────────────────────────────────────────────
  // Seule une reunion porte son propre fuseau. Le retenir au-dela ferait lire
  // une absence, un appel ou une tache dans le fuseau d'une reunion creee juste
  // avant, alors que le libelle sous le champ annonce celui du serveur.
  const activeTimezone = $derived(
    meetingEditModalOpen
      ? (editMeetingTimezone ?? timezoneStore.timezone)
      : (creationModalOpen || quickAnchor) && createType === 'meeting'
        ? (formTimezone ?? timezoneStore.timezone)
        : timezoneStore.timezone,
  );
  const formatLocal = (date: Date) => formatWallClockInTimezone(date, activeTimezone);
  const parseLocal = (input: string): Date => parseDateTimeInTimezone(input, activeTimezone) ?? new Date();
  /** Un rappel ne porte pas de fuseau propre : il se lit toujours dans celui du serveur. */
  const parseServerLocal = (input: string): Date => parseDateTimeInTimezone(input, timezoneStore.timezone) ?? new Date();

  function reinterpretWallClock(date: Date, from: string, to: string): Date {
    return parseDateTimeInTimezone(formatWallClockInTimezone(date, from), to) ?? date;
  }

  /**
   * Changer le fuseau reinterprete l'heure affichee, il ne la reecrit pas :
   * 15:00 tape puis « Montreal » choisi doit donner 15:00 a Montreal.
   */
  function applyFormTimezone(zone: string | null): void {
    const previous = formTimezone ?? timezoneStore.timezone;
    const next = zone ?? timezoneStore.timezone;
    formTimezone = zone;
    if (previous === next) return;
    selectedStartDate = reinterpretWallClock(selectedStartDate, previous, next);
    selectedEndDate = reinterpretWallClock(selectedEndDate, previous, next);
  }

  // ── Chargement ──────────────────────────────────────────
  async function loadData() {
    loading = true;
    try {
      const [membersData, callPermData, superiorsData] = await Promise.all([
        fetchStaffMembers(),
        fetchCallPermissionConfig().catch(() => null),
        fetchAbsenceSuperiors().catch(() => null),
      ]);
      allStaff = membersData?.members || [];
      superiors = superiorsData?.superiors || [];

      if (callPermData) {
        callPermConfig = callPermData.config;
        callPermCanCreate = callPermData.canCreate;
        const usersMap = new Map();
        for (const uid of callPermData.config?.allowedUserIds || []) {
          const staff = allStaff.find((s: any) => s.userId === uid);
          if (staff) usersMap.set(uid, { id: uid, username: staff.username, displayName: staff.displayName, avatarUrl: staff.avatarUrl });
        }
        permSelectedUsersMap = usersMap;
      }

      if (myStaffRecord) selectedStaffIds = [myStaffRecord.id];
      else if (allStaff.length > 0) selectedStaffIds = [allStaff[0].id];

      await refreshAll();
    } catch (e) {
      console.error('Failed to load initial data:', e);
    } finally {
      loading = false;
    }
  }

  async function refreshCalendar() {
    // La periode n'est connue qu'une fois le calendrier affiche, qui la signale lui-meme.
    if (!rangeKnown) return;
    try {
      calendarData = normalize(await fetchStaffCalendarData(rangeStart, rangeEnd, selectedStaffIds));
    } catch (e) {
      console.error('Failed to load calendar data:', e);
    }
  }

  async function refreshToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    try {
      todayData = normalize(await fetchStaffCalendarData(start, end));
    } catch (e) {
      console.error('Failed to load today data:', e);
    }
  }

  async function refreshTasks() {
    try {
      if (myStaffRecord) userTasks = (await fetchTasks(myStaffRecord.id)).tasks || [];
    } catch (e) {
      console.error('Failed to load tasks:', e);
    }
  }

  async function refreshAll() {
    await Promise.all([refreshCalendar(), refreshTasks(), refreshToday()]);
    syncDetail();
  }

  /** Relit l'element ouvert apres un rechargement, pour que la fiche et l'apercu suivent. */
  function syncDetail() {
    const find = (type: string, id: string) =>
      ((calendarData as any)[type + 's'] as any[] | undefined)?.find(x => x.id === id)
      || ((todayData as any)[type + 's'] as any[] | undefined)?.find(x => x.id === id)
      || userTasks.find(x => x.id === id);
    if (currentItemDetail) {
      const updated = find(currentItemDetail.type, currentItemDetail.id);
      if (updated) currentItemDetail = toEvent(currentItemDetail.type as PlanningType, updated);
    }
    if (peek) {
      const updated = find(peek.event.type, peek.event.id);
      if (updated) peek = { ...peek, event: toEvent(peek.event.type as PlanningType, updated) };
    }
  }

  function handleRangeChange(start: Date, end: Date) {
    rangeKnown = true;
    rangeStart = start;
    rangeEnd = end;
    void refreshCalendar();
  }

  // ── Bulles et fiches ────────────────────────────────────
  function handleEventClick(event: CalendarEvent, anchor: DOMRect) {
    quickAnchor = null;
    peek = { event, anchor };
  }

  function openDetail(event: CalendarEvent) {
    peek = null;
    currentItemDetail = event;
    newReminderMessage = '';
    newReminderTime = '';
    detailModalOpen = true;
  }

  async function openMemberCase(userId: string, name: string) {
    if (!authStore.selectedGuildId || !canOpenMemberCase) return;
    selectedUserIdForCase = userId;
    selectedUserNameForCase = name;
    userCaseModalOpen = true;
    loadingCase = true;
    caseError = '';
    caseData = null;
    try {
      caseData = await fetchMemberCase(userId, authStore.selectedGuildId);
    } catch (err) {
      caseError = err instanceof Error ? err.message : m.planning_case_err();
    } finally {
      loadingCase = false;
    }
  }

  // ── Creation ────────────────────────────────────────────
  /**
   * Prochaine demi-heure, au moins une heure plus tard : partir de l'instant
   * d'ouverture laissait passer l'heure le temps de saisir un titre, et
   * Discord refuse un evenement planifie dans le passe.
   */
  function defaultStart(): Date {
    const d = new Date(Date.now() + 3600000);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    return d;
  }

  function resetForm(start: Date, end: Date | undefined, type: PlanningType) {
    createType = type === 'call' && !callPermCanCreate ? 'meeting' : type;
    selectedStartDate = start;
    selectedEndDate = end || new Date(start.getTime() + 3600000);
    formTitle = '';
    formDescription = '';
    formTimezone = null;
    formPriority = 'MEDIUM';
    formAssigneeId = myStaffRecord?.id || '';
    // Le tuteur d'abord : c'est lui qui suit le staff au quotidien.
    formSuperiorId = superiors.find(s => s.reason === 'tutor')?.userId ?? '';
    formAbsenceType = 'Autre';
    formChannelMode = 'CREATE_NEW';
    formChannelType = 'VOICE';
    formDiscordChannelId = '';
    formIsTempChannel = true;
    formInviteeUserIds = [];
    formInviteeMemberIds = [];
    selectedMembers = new Map();
    memberSearchQuery = '';
    memberSearchResults = [];
    formError = '';
  }

  /** Creneau choisi dans la grille : bulle de creation rapide, comme Outlook. */
  function handleSlotSelect(start: Date, end: Date, anchor: DOMRect) {
    peek = null;
    resetForm(start, end, createType);
    quickAnchor = anchor;
  }

  function openFullCreate(type: PlanningType = createType, start = defaultStart()) {
    peek = null;
    quickAnchor = null;
    resetForm(start, undefined, type);
    creationModalOpen = true;
  }

  /** « Plus d'options » : la saisie de la bulle passe dans la fenetre complete. */
  function expandQuickCreate() {
    quickAnchor = null;
    creationModalOpen = true;
  }

  function setDuration(minutes: number) {
    selectedEndDate = new Date(selectedStartDate.getTime() + minutes * 60000);
  }

  const durationMinutes = $derived(Math.round((selectedEndDate.getTime() - selectedStartDate.getTime()) / 60000));

  function onStartChange(value: string) {
    const duration = selectedEndDate.getTime() - selectedStartDate.getTime();
    selectedStartDate = parseLocal(value);
    // Deplacer le debut garde la duree, comme dans un agenda.
    if (duration > 0) selectedEndDate = new Date(selectedStartDate.getTime() + duration);
  }

  async function handleCreateItem(event?: SubmitEvent) {
    event?.preventDefault();
    if (!formTitle.trim() && createType !== 'absence') {
      formError = m.planning_err_title_required();
      return;
    }
    saving = true;
    formError = '';

    try {
      if (createType === 'meeting') {
        // Un creneau du calendrier peut etre deja passe : le dire ici vaut mieux
        // que le refus brut de Discord.
        if (selectedStartDate.getTime() <= Date.now()) {
          formError = m.planning_err_meeting_in_past();
          return;
        }
        if (selectedEndDate.getTime() <= selectedStartDate.getTime()) {
          formError = m.meetings_err_end_before_start();
          return;
        }
        const ok = await createMeeting(formTitle.trim(), formDescription, selectedStartDate.toISOString(), selectedEndDate.toISOString(), formTimezone);
        if (!ok) throw new Error(m.planning_err_create_meeting());
      } else if (createType === 'absence') {
        if (!myStaffRecord) { formError = m.planning_err_not_staff(); return; }
        if (!formDescription.trim()) { formError = m.planning_err_absence_reason(); return; }
        if (!formSuperiorId) { formError = m.planning_err_superior_required(); return; }
        if (selectedEndDate < selectedStartDate) { formError = m.planning_err_end_before_start(); return; }
        await createAbsence({
          staffUserId: myStaffRecord.userId,
          startDate: selectedStartDate.toISOString(),
          endDate: selectedEndDate.toISOString(),
          reason: formDescription.trim(),
          type: formAbsenceType,
          superiorUserId: formSuperiorId,
          confirmIndefinite: false,
        });
      } else if (createType === 'call') {
        if (!callPermCanCreate) { formError = m.planning_err_no_call_permission(); return; }
        await createCall({
          title: formTitle.trim(),
          description: formDescription,
          scheduledAt: selectedStartDate.toISOString(),
          channelMode: formChannelMode,
          channelType: formChannelMode === 'CREATE_NEW' ? formChannelType : null,
          discordChannelId: formChannelMode === 'EXISTING' ? formDiscordChannelId : null,
          isTempChannel: formIsTempChannel,
          inviteeUserIds: [...formInviteeUserIds, ...formInviteeMemberIds],
        });
      } else {
        await createTask({
          title: formTitle.trim(),
          description: formDescription,
          priority: formPriority,
          dueDate: selectedStartDate.toISOString(),
          assigneeId: formAssigneeId,
        });
      }

      creationModalOpen = false;
      quickAnchor = null;
      await refreshAll();
    } catch (err) {
      console.error(err);
      formError = errorMessage(err) || m.planning_err_create_generic();
    } finally {
      saving = false;
    }
  }

  const typeOptions = $derived<FilterOption<PlanningType>[]>(
    TYPES.filter(t => t !== 'call' || callPermCanCreate).map(t => ({ value: t, label: TYPE_META[t].label() })),
  );

  const newEventMenu = $derived<MenuItem[]>(
    TYPES.filter(t => t !== 'call' || callPermCanCreate).map(t => ({
      label: TYPE_META[t].label(),
      icon: TYPE_META[t].icon,
      onselect: () => openFullCreate(t),
    })),
  );

  const moreMenu = $derived<MenuItem[]>(
    isAdmin ? [{ label: m.planning_call_perms_btn(), description: m.planning_call_perms_tooltip(), icon: 'shield', onselect: openPermissionModal }] : [],
  );

  // ── Recherche de membres (invites, permissions) ─────────
  async function searchMembers(query: string) {
    if (!query.trim()) {
      memberSearchResults = [];
      return;
    }
    memberSearchLoading = true;
    try {
      const data = await searchDiscordMembers(query, 15);
      memberSearchResults = (data?.members || []).filter(
        (mem: any) => !activeStaff.some(s => s.userId === mem.id) && mem.id !== myId,
      );
    } catch (e) {
      console.error('Member search error:', e);
      memberSearchResults = [];
    } finally {
      memberSearchLoading = false;
    }
  }

  function handleMemberSearchInput(value: string) {
    memberSearchQuery = value;
    if (memberSearchTimeout) clearTimeout(memberSearchTimeout);
    memberSearchTimeout = setTimeout(() => searchMembers(value), 300);
  }

  function toggleMemberInvitee(member: any) {
    const next = new Map(selectedMembers);
    if (formInviteeMemberIds.includes(member.id)) {
      formInviteeMemberIds = formInviteeMemberIds.filter(id => id !== member.id);
      next.delete(member.id);
    } else {
      formInviteeMemberIds = [...formInviteeMemberIds, member.id];
      next.set(member.id, member);
    }
    selectedMembers = next;
  }

  function togglePermRole(roleId: string) {
    permRoleIds = permRoleIds.includes(roleId) ? permRoleIds.filter(id => id !== roleId) : [...permRoleIds, roleId];
  }

  function togglePermUser(member: any) {
    const next = new Map(permSelectedUsersMap);
    if (permUserIds.includes(member.id)) {
      permUserIds = permUserIds.filter(id => id !== member.id);
      next.delete(member.id);
    } else {
      permUserIds = [...permUserIds, member.id];
      next.set(member.id, member);
    }
    permSelectedUsersMap = next;
  }

  async function searchPermMembers(query: string) {
    if (!query.trim()) {
      permMemberSearchResults = [];
      return;
    }
    permMemberSearchLoading = true;
    try {
      const data = await searchDiscordMembers(query, 15);
      permMemberSearchResults = (data?.members || []).filter((mem: any) => !permUserIds.includes(mem.id));
    } catch (e) {
      console.error('Permission member search error:', e);
      permMemberSearchResults = [];
    } finally {
      permMemberSearchLoading = false;
    }
  }

  function handlePermMemberSearchInput(value: string) {
    permMemberSearchQuery = value;
    if (permMemberSearchTimeout) clearTimeout(permMemberSearchTimeout);
    permMemberSearchTimeout = setTimeout(() => searchPermMembers(value), 300);
  }

  function openPermissionModal() {
    permMode = callPermConfig?.mode || 'EVERYONE';
    permRoleIds = [...(callPermConfig?.allowedRoleIds || [])];
    permUserIds = [...(callPermConfig?.allowedUserIds || [])];
    permMemberSearchQuery = '';
    permMemberSearchResults = [];
    permError = '';
    permissionModalOpen = true;
  }

  async function savePermissionConfig() {
    permSaving = true;
    permError = '';
    try {
      await updateCallPermissionConfig({ mode: permMode, allowedRoleIds: permRoleIds, allowedUserIds: permUserIds });
      const data = await fetchCallPermissionConfig().catch(() => null);
      if (data) {
        callPermConfig = data.config;
        callPermCanCreate = data.canCreate;
      }
      permissionModalOpen = false;
    } catch (e) {
      permError = errorMessage(e) || m.planning_err_perm_update();
    } finally {
      permSaving = false;
    }
  }

  // ── Actions sur un element ──────────────────────────────
  async function updateMeetingStatus(id: string, status: string) {
    if (!canModerateMeetings) return;
    try {
      await updateMeeting(id, { status });
      await refreshAll();
    } catch (e) {
      console.error('Failed to update status:', e);
    }
  }

  function getAttendanceStats(meeting: any) {
    const presences = meeting.presences || [];
    return {
      present: presences.filter((p: any) => p.status === 'PRESENT').length,
      excused: presences.filter((p: any) => p.status === 'EXCUSED' || p.status === 'ABSENT_CHECKED').length,
      absent: presences.filter((p: any) => p.status === 'ABSENT').length,
    };
  }

  function formatStatus(status: string) {
    switch (status) {
      case 'SCHEDULED': return m.meetings_status_scheduled();
      case 'IN_PROGRESS': return m.meetings_status_in_progress();
      case 'COMPLETED': return m.meetings_status_completed();
      case 'CANCELLED': return m.meetings_status_cancelled();
      case 'PRESENT': return m.meetings_presence_present();
      case 'EXCUSED': return m.meetings_presence_excused();
      case 'ABSENT_CHECKED': return m.planning_presence_excused_checked();
      case 'ABSENT': return m.meetings_presence_absent();
      default: return status;
    }
  }

  function openEditMeeting(meeting: any) {
    if (!canManageMeetings) return;
    peek = null;
    editMeetingId = meeting.id;
    editMeetingTitle = meeting.title;
    editMeetingDesc = meeting.description || '';
    // Le fuseau est nomme ici : `formatLocal` ne bascule sur celui de
    // l'edition qu'une fois la modale ouverte, apres ces lignes.
    editMeetingTimezone = meeting.timezone ?? null;
    const editZone = editMeetingTimezone ?? timezoneStore.timezone;
    editMeetingDate = formatWallClockInTimezone(new Date(meeting.scheduledAt), editZone);
    editMeetingEndDate = formatWallClockInTimezone(
      meeting.endedAt ? new Date(meeting.endedAt) : new Date(new Date(meeting.scheduledAt).getTime() + 3600000),
      editZone,
    );
    editMeetingError = '';
    meetingEditModalOpen = true;
  }

  async function saveMeetingEdit() {
    if (!editMeetingTitle || !editMeetingDate) {
      editMeetingError = m.meetings_err_required();
      return;
    }
    const start = parseLocal(editMeetingDate);
    const end = parseLocal(editMeetingEndDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      editMeetingError = m.planning_err_dates_invalid();
      return;
    }
    if (end <= start) {
      editMeetingError = m.meetings_err_end_before_start();
      return;
    }
    savingMeetingEdit = true;
    editMeetingError = '';
    try {
      if (editMeetingId) {
        await updateMeeting(editMeetingId, {
          title: editMeetingTitle,
          description: editMeetingDesc,
          scheduledAt: start.toISOString(),
          endedAt: end.toISOString(),
          timezone: editMeetingTimezone,
        } as any);
        meetingEditModalOpen = false;
        await refreshAll();
      }
    } catch (e) {
      console.error('Failed to save meeting:', e);
      editMeetingError = m.meetings_err_save();
    } finally {
      savingMeetingEdit = false;
    }
  }

  async function confirmDeleteMeeting() {
    if (!meetingToDeleteId) return;
    deletingMeeting = true;
    try {
      await deleteMeeting(meetingToDeleteId, {
        deleteEvent: deleteDiscordEvent,
        deleteMessage: deleteDiscordMessage,
        deleteNotifications: deleteDiscordNotification,
      });
      meetingDeleteModalOpen = false;
      detailModalOpen = false;
      await refreshAll();
    } catch (e) {
      console.error('Failed to delete meeting:', e);
    } finally {
      deletingMeeting = false;
    }
  }

  async function deleteItem(event: CalendarEvent) {
    peek = null;
    if (event.type === 'meeting') {
      meetingToDeleteId = event.id;
      deleteDiscordEvent = true;
      deleteDiscordMessage = false;
      deleteDiscordNotification = true;
      meetingDeleteModalOpen = true;
      return;
    }
    if (!(await confirmDialog.danger(m.planning_confirm_delete_item()))) return;
    try {
      if (event.type === 'absence') await deleteAbsence(event.id);
      else if (event.type === 'call') await deleteCall(event.id);
      else if (event.type === 'task') await deleteTask(event.id);
      detailModalOpen = false;
      await refreshAll();
    } catch (e) {
      console.error(e);
    }
  }

  async function toggleTaskCompletion(task: any) {
    const nextStatus = task.status === 'COMPLETED' ? 'PENDING' : 'COMPLETED';
    try {
      await updateTask(task.id, { status: nextStatus });
      await refreshAll();
    } catch (e) {
      console.error(e);
    }
  }

  async function addQuickTask(event: SubmitEvent) {
    event.preventDefault();
    const title = quickTaskTitle.trim();
    if (!title || !myStaffRecord) return;
    quickTaskSaving = true;
    try {
      await createTask({ title, priority: 'MEDIUM', dueDate: null, assigneeId: myStaffRecord.id });
      quickTaskTitle = '';
      await refreshAll();
    } catch (e) {
      toast.error(errorMessage(e) || m.planning_err_create_generic());
    } finally {
      quickTaskSaving = false;
    }
  }

  async function decideAbsence(id: string, status: 'APPROVED' | 'REJECTED') {
    if (await updateAbsenceStatus(id, status, undefined)) {
      toast.success(m.planning_absence_decided());
      await refreshAll();
    }
  }

  async function handleAddReminder(event: SubmitEvent) {
    event.preventDefault();
    if (!currentItemDetail) return;
    if (!newReminderTime || !newReminderMessage.trim()) {
      toast.error(m.planning_reminder_required());
      return;
    }
    try {
      const raw = currentItemDetail.raw;
      const payload: any = {
        message: newReminderMessage,
        targetTime: parseServerLocal(newReminderTime).toISOString(),
        channelId: newReminderChannel === 'CURRENT' ? raw.discordChannelId || null : null,
      };
      if (currentItemDetail.type === 'task') payload.taskId = raw.id;
      else if (currentItemDetail.type === 'call') payload.callId = raw.id;
      else if (currentItemDetail.type === 'meeting') payload.meetingId = raw.id;
      await createReminder(payload);
      toast.success(m.planning_reminder_created());
      newReminderMessage = '';
      newReminderTime = '';
      await refreshAll();
    } catch (e) {
      console.error('Failed to create reminder:', e);
      toast.error(errorMessage(e) || m.planning_reminder_err_create());
    }
  }

  async function handleDeleteReminder(reminderId: string) {
    try {
      await deleteReminder(reminderId);
      toast.success(m.planning_reminder_deleted());
      await refreshAll();
    } catch (e) {
      console.error('Failed to delete reminder:', e);
      toast.error(errorMessage(e) || m.planning_reminder_err_delete());
    }
  }

  // ── Filtres ─────────────────────────────────────────────
  function toggleType(type: string) {
    visibleTypes = visibleTypes.includes(type) ? visibleTypes.filter(t => t !== type) : [...visibleTypes, type];
  }

  function setStaff(ids: string[]) {
    selectedStaffIds = ids;
    void refreshCalendar();
  }

  function toggleStaff(staffId: string) {
    setStaff(selectedStaffIds.includes(staffId) ? selectedStaffIds.filter(id => id !== staffId) : [...selectedStaffIds, staffId]);
  }

  onMount(() => {
    const handleDashboardRefresh = () => loadData();
    window.addEventListener('kotbo-dashboard-refresh-request', handleDashboardRefresh);
    // Volets lateraux replies sur petit ecran : le calendrier prend la place.
    if (window.matchMedia('(max-width: 1023px)').matches) leftPaneOpen = false;
    if (window.matchMedia('(max-width: 1279px)').matches) myDayOpen = false;
    // Fuseau du serveur avant loadData : les formulaires seedent sinon leurs
    // dates en heure navigateur, puis basculent au chargement du store.
    void timezoneStore.ensureLoaded();
    void loadData();
    return () => window.removeEventListener('kotbo-dashboard-refresh-request', handleDashboardRefresh);
  });
</script>

{#snippet avatar(src: string | null | undefined, name: string, size = 'w-6 h-6')}
  <img src={src || localInitialAvatar(name)} alt="" class="{size} rounded-full shrink-0 object-cover" />
{/snippet}

{#snippet bar(type: string)}
  <span class="pl-bar" style="--evt: {EVENT_TYPE_COLOR[type]}" aria-hidden="true"></span>
{/snippet}

{#snippet taskRow(task: any)}
  <li class="pl-task">
    <input
      type="checkbox"
      class="pl-check mt-0.5"
      style="--evt: {EVENT_TYPE_COLOR.task}"
      checked={task.status === 'COMPLETED'}
      onchange={() => toggleTaskCompletion(task)}
      aria-label={task.status === 'COMPLETED' ? m.planning_task_mark_todo() : m.planning_task_mark_done()}
    />
    <button type="button" class="flex-1 min-w-0 text-left" onclick={() => openDetail(toEvent('task', task))}>
      <span class="block text-body-sm text-on-surface wrap-break-word {task.status === 'COMPLETED' ? 'line-through text-on-surface-variant' : ''}">{task.title}</span>
      {#if task.priority === 'HIGH' || task.dueDate}
        <span class="flex flex-wrap items-center gap-2 mt-0.5 text-2xs">
          {#if task.priority === 'HIGH'}
            <span class="text-error font-medium">{m.planning_task_important()}</span>
          {/if}
          {#if task.dueDate}
            <span class={isOverdue(task) ? 'text-error font-medium' : 'text-on-surface-variant'}>
              {new Date(task.dueDate).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}{isOverdue(task) ? ` · ${m.planning_task_overdue()}` : ''}
            </span>
          {/if}
        </span>
      {/if}
    </button>
  </li>
{/snippet}

{#snippet dateFields(compact: boolean)}
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <Papicon icon="clock" size={16} class="text-on-surface-variant shrink-0" />
      <input type="datetime-local" class="input w-auto {compact ? 'text-body-sm' : ''}" aria-label={m.meetings_field_start_label()} value={formatLocal(selectedStartDate)} onchange={(e) => onStartChange((e.target as HTMLInputElement).value)} />
      {#if createType !== 'task'}
        <span class="text-on-surface-variant">–</span>
        <input type="datetime-local" class="input w-auto {compact ? 'text-body-sm' : ''}" aria-label={m.meetings_field_end_label()} value={formatLocal(selectedEndDate)} onchange={(e) => (selectedEndDate = parseLocal((e.target as HTMLInputElement).value))} />
      {/if}
    </div>
    {#if createType === 'meeting' || createType === 'call'}
      <div class="flex flex-wrap items-center gap-1.5 pl-6" role="group" aria-label={m.planning_duration()}>
        {#each [30, 60, 120] as minutes (minutes)}
          <button type="button" class="pl-chip {durationMinutes === minutes ? 'pl-chip--active' : ''}" aria-pressed={durationMinutes === minutes} onclick={() => setDuration(minutes)}>
            {minutes === 30 ? m.planning_duration_30() : minutes === 60 ? m.planning_duration_60() : m.planning_duration_120()}
          </button>
        {/each}
      </div>
    {/if}
    {#if timezoneStore.loaded && createType === 'meeting' && !compact}
      <div class="pl-6">
        <TimezoneHint bind:value={() => formTimezone, (zone) => applyFormTimezone(zone)} />
      </div>
    {:else if timezoneStore.loaded && timezoneStore.differsFromBrowser}
      <p class="pl-6 text-2xs text-on-surface-variant">{m.planning_datetime_hint_diff_short({ server: timezoneStore.timezone })}</p>
    {/if}
  </div>
{/snippet}

{#snippet memberSearch(query: string, busy: boolean, results: any[], onInput: (v: string) => void, onPick: (member: any) => void, picked: string[])}
  <div class="relative">
    <Papicon icon="search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
    <input type="search" class="input pl-9 text-body-sm" value={query} oninput={(e) => onInput((e.target as HTMLInputElement).value)} placeholder={m.planning_search_member_ph()} aria-label={m.planning_search_member_ph()} />
  </div>
  {#if results.length > 0}
    <ul class="mt-2 max-h-36 overflow-y-auto rounded-lg border border-outline-variant">
      {#each results as member (member.id)}
        <li>
          <button type="button" class="pl-row px-3" aria-pressed={picked.includes(member.id)} onclick={() => onPick(member)}>
            {@render avatar(member.avatarUrl, memberName(member), 'w-5 h-5')}
            <span class="flex-1 min-w-0 text-left">
              <span class="block truncate text-body-sm text-on-surface">{memberName(member)}</span>
              {#if member.username !== member.displayName}
                <span class="text-2xs text-on-surface-variant">@{member.username}</span>
              {/if}
            </span>
            {#if picked.includes(member.id)}
              <Papicon icon="check" size={14} class="text-primary" />
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else if query.trim() && !busy}
    <p class="mt-2 text-2xs text-on-surface-variant text-center py-2">{m.planning_no_member_found()}</p>
  {/if}
{/snippet}

<ModulePage title={m.planning_page_title()} icon="calendar" featureKey="absences" bare>
  {#if loading && allStaff.length === 0}
    <div class="pl-shell"><Skeleton height="h-full" radius="0" /></div>
  {:else}
    <div class="pl-shell">
      <!-- ===== Ruban ===== -->
      <div class="pl-ribbon" role="toolbar" aria-label={m.planning_ribbon_aria()}>
        <Button variant="ghost" icon="menu" aria-label={m.planning_toggle_left()} aria-pressed={leftPaneOpen} onclick={() => (leftPaneOpen = !leftPaneOpen)} />
        <div class="pl-split">
          <Button variant="primary" icon="plus" onclick={() => openFullCreate()}>{m.planning_new_event()}</Button>
          <Menu items={newEventMenu} label={m.planning_new_type_menu()} icon="chevron-down" />
        </div>

        <span class="pl-sep" aria-hidden="true"></span>

        <div class="hidden md:flex items-center gap-0.5" role="group" aria-label={m.planning_view_aria()} title={m.planning_shortcuts_hint()}>
          {#each CALENDAR_VIEWS as v (v)}
            <button type="button" class="pl-view {calendarView === v ? 'pl-view--active' : ''}" aria-pressed={calendarView === v} onclick={() => (calendarView = v)}>
              <Papicon icon={VIEW_META[v].icon} size={15} />
              <span class="hidden xl:inline">{VIEW_META[v].label()}</span>
              <span class="xl:hidden">{(VIEW_META[v].short ?? VIEW_META[v].label)()}</span>
            </button>
          {/each}
        </div>
        <select class="input w-auto md:hidden text-body-sm" bind:value={calendarView} aria-label={m.planning_view_aria()}>
          {#each CALENDAR_VIEWS as v (v)}
            <option value={v}>{VIEW_META[v].label()}</option>
          {/each}
        </select>

        <div class="ml-auto flex items-center gap-1">
          <Button variant="ghost" icon="refresh" aria-label={m.planning_refresh()} title={m.planning_refresh()} onclick={refreshAll} />
          <button type="button" class="pl-view {myDayOpen ? 'pl-view--active' : ''}" aria-pressed={myDayOpen} onclick={() => (myDayOpen = !myDayOpen)}>
            <Papicon icon="clipboard-list" size={15} />
            <span class="hidden sm:inline">{m.planning_my_day()}</span>
            {#if pendingTasks.length > 0}
              <span class="pl-count">{pendingTasks.length}</span>
            {/if}
          </button>
          {#if moreMenu.length > 0}
            <Menu items={moreMenu} label={m.planning_more_actions()} />
          {/if}
        </div>
      </div>

      <div class="pl-body">
        <!-- ===== Volet gauche ===== -->
        {#if leftPaneOpen}
          <aside class="pl-left">
            <section class="px-3 pt-3 pb-2">
              <div class="flex items-center justify-between mb-1">
                <span class="text-body-sm font-semibold text-on-surface pl-1">
                  {capitalize(miniCalDate.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }))}
                </span>
                <span class="flex">
                  <button type="button" class="pl-icon-btn" aria-label={m.cal_prev()} onclick={() => (miniCalDate = new Date(miniCalDate.getFullYear(), miniCalDate.getMonth() - 1, 1))}>
                    <Papicon icon="chevron-up" size={14} />
                  </button>
                  <button type="button" class="pl-icon-btn" aria-label={m.cal_next()} onclick={() => (miniCalDate = new Date(miniCalDate.getFullYear(), miniCalDate.getMonth() + 1, 1))}>
                    <Papicon icon="chevron-down" size={14} />
                  </button>
                </span>
              </div>
              <div class="grid grid-cols-7 text-center">
                {#each [m.planning_weekday_mon(), m.planning_weekday_tue(), m.planning_weekday_wed(), m.planning_weekday_thu(), m.planning_weekday_fri(), m.planning_weekday_sat(), m.planning_weekday_sun()] as day, i (i)}
                  <span class="text-2xs text-on-surface-variant py-1">{day}</span>
                {/each}
                {#each miniCalDays as { date, isCurrentMonth } (date.getTime())}
                  <button
                    type="button"
                    onclick={() => (calendarCurrentDate = new Date(date))}
                    aria-label={date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long' })}
                    class="pl-mini-day {isCurrentMonth ? '' : 'pl-mini-day--out'} {inRange(date) && calendarView !== 'month' && calendarView !== 'agenda' ? 'pl-mini-day--range' : ''} {isToday(date) ? 'pl-mini-day--today' : ''}"
                  >
                    {date.getDate()}
                  </button>
                {/each}
              </div>
            </section>

            <section class="pl-left-section">
              <h3 class="pl-left-title">{m.planning_my_calendars()}</h3>
              <ul>
                {#each TYPES as type (type)}
                  <li>
                    <label class="pl-filter" style="--evt: {EVENT_TYPE_COLOR[type]}">
                      <input type="checkbox" class="pl-check" checked={visibleTypes.includes(type)} onchange={() => toggleType(type)} />
                      <span class="flex-1 text-body-sm text-on-surface">{TYPE_META[type].calendar()}</span>
                      <span class="text-2xs text-on-surface-variant tabular-nums">{typeCounts[type]}</span>
                    </label>
                  </li>
                {/each}
              </ul>
            </section>

            <section class="pl-left-section flex-1 min-h-0 flex flex-col">
              <div class="flex items-center justify-between gap-2">
                <h3 class="pl-left-title">{m.planning_people()}</h3>
                <span class="flex gap-0.5">
                  {#if myStaffRecord}
                    <button type="button" class="pl-link" onclick={() => setStaff([myStaffRecord.id])}>{m.planning_only_me()}</button>
                  {/if}
                  <button type="button" class="pl-link" onclick={() => setStaff(selectedStaffIds.length === activeStaff.length ? [] : activeStaff.map(s => s.id))}>
                    {selectedStaffIds.length === activeStaff.length ? m.planning_select_none() : m.planning_select_all()}
                  </button>
                </span>
              </div>
              {#if activeStaff.length > 8}
                <input type="search" class="input my-1 text-body-sm" bind:value={peopleQuery} placeholder={m.planning_people_search_ph()} aria-label={m.planning_people_search_ph()} />
              {/if}
              <ul class="flex-1 min-h-0 overflow-y-auto">
                {#each filteredStaff as staff (staff.id)}
                  <li>
                    <label class="pl-filter">
                      <input type="checkbox" class="pl-check" checked={selectedStaffIds.includes(staff.id)} onchange={() => toggleStaff(staff.id)} />
                      {@render avatar(staff.avatarUrl, staff.username)}
                      <span class="flex-1 min-w-0 truncate text-body-sm text-on-surface">{memberName(staff)}</span>
                    </label>
                  </li>
                {/each}
              </ul>
            </section>
          </aside>
        {/if}

        <!-- ===== Calendrier ===== -->
        <div class="pl-main">
          <Calendar
            bind:view={calendarView}
            bind:currentDate={calendarCurrentDate}
            events={calendarEvents}
            selectedKey={eventKey(peek?.event)}
            onRangeChange={handleRangeChange}
            onEventClick={handleEventClick}
            onSlotSelect={handleSlotSelect}
          />
        </div>

        <!-- ===== Ma journee ===== -->
        {#if myDayOpen}
          <aside class="pl-right">
            <header class="flex items-center justify-between px-4 pt-3">
              <div>
                <h2 class="text-base font-semibold text-on-surface">{m.planning_my_day()}</h2>
                <p class="text-2xs text-on-surface-variant">
                  {capitalize(new Date().toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' }))}
                </p>
              </div>
              <Button variant="ghost" size="sm" icon="x" aria-label={m.planning_close_aria()} onclick={() => (myDayOpen = false)} />
            </header>
            <div class="px-4 pt-2 pb-2 border-b border-outline-variant">
              <FilterPills
                label={m.planning_my_day()}
                options={[
                  { value: 'agenda', label: m.planning_tab_agenda(), count: todayAgenda.length },
                  { value: 'tasks', label: m.planning_tab_tasks(), count: pendingTasks.length },
                ]}
                value={myDayTab}
                onchange={(v) => (myDayTab = v as typeof myDayTab)}
              />
            </div>

            <div class="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-5">
              {#if myDayTab === 'agenda'}
                {#if todayAgenda.length === 0}
                  <p class="px-1 text-body-sm text-on-surface-variant">{m.planning_today_empty()}</p>
                {:else}
                  <ul class="space-y-1">
                    {#each todayAgenda as event (eventKey(event))}
                      <li>
                        <button type="button" class="pl-agenda-item {event.end && event.end.getTime() < Date.now() ? 'opacity-60' : ''}" onclick={() => openDetail(event)}>
                          <span class="w-11 shrink-0 text-2xs text-on-surface-variant tabular-nums leading-snug">
                            {formatTime(event.start)}<br />{event.end ? formatTime(event.end) : ''}
                          </span>
                          {@render bar(event.type)}
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-body-sm font-medium text-on-surface">{event.title}</span>
                            <span class="block text-2xs text-on-surface-variant">{TYPE_META[event.type as PlanningType].label()}</span>
                          </span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}

                {#if absentToday.length > 0}
                  <section>
                    <h3 class="pl-left-title mb-1">{m.planning_absent_today()} · {absentToday.length}</h3>
                    <ul class="space-y-0.5">
                      {#each absentToday as absence (absence.id)}
                        <li>
                          <button type="button" class="pl-row" onclick={() => openDetail(toEvent('absence', absence))}>
                            {@render avatar(absence.staffMember?.avatarUrl, absence.staffMember?.username ?? '', 'w-6 h-6')}
                            <span class="flex-1 min-w-0 truncate text-body-sm text-on-surface">{memberName(absence.staffMember)}</span>
                            <span class="text-2xs text-on-surface-variant truncate max-w-24">{absence.type || ''}</span>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  </section>
                {/if}
              {:else}
                {#if myStaffRecord}
                  <form onsubmit={addQuickTask}>
                    <div class="relative">
                      <Papicon icon="plus" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-primary pointer-events-none" />
                      <input class="input pl-9 text-body-sm" bind:value={quickTaskTitle} maxlength="200" disabled={quickTaskSaving} placeholder={m.planning_quick_task_ph()} aria-label={m.planning_add_task()} />
                    </div>
                  </form>
                {/if}
                {#if pendingTasks.length === 0}
                  <p class="px-1 text-body-sm text-on-surface-variant">{m.planning_no_task()} · {m.planning_day_free()}</p>
                {:else}
                  <ul class="space-y-0.5">
                    {#each pendingTasks as task (task.id)}
                      {@render taskRow(task)}
                    {/each}
                  </ul>
                {/if}
                {#if doneTasks.length > 0}
                  <div>
                    <button type="button" class="inline-flex items-center gap-1 px-1 text-2xs font-medium text-on-surface-variant hover:text-on-surface" aria-expanded={showDoneTasks} onclick={() => (showDoneTasks = !showDoneTasks)}>
                      <Papicon icon={showDoneTasks ? 'chevron-down' : 'chevron-right'} size={12} />
                      {m.planning_tasks_done({ count: doneTasks.length })}
                    </button>
                    {#if showDoneTasks}
                      <ul class="space-y-0.5 mt-1">
                        {#each doneTasks as task (task.id)}
                          {@render taskRow(task)}
                        {/each}
                      </ul>
                    {/if}
                  </div>
                {/if}
              {/if}
            </div>
          </aside>
        {/if}
      </div>
    </div>
  {/if}
</ModulePage>

<!-- ===== Bulle de creation rapide ===== -->
<AnchoredPopover anchor={quickAnchor} onClose={() => (quickAnchor = null)} label={m.planning_new_event()} width={400}>
  <form class="p-4 space-y-3" onsubmit={handleCreateItem}>
    <FilterPills label={m.planning_type_aria()} options={typeOptions} value={createType} onchange={(v) => { createType = v; formError = ''; }} />
    {#if createType === 'absence'}
      <input class="input text-base font-semibold" bind:value={formDescription} placeholder={m.planning_quick_reason_ph()} aria-label={m.planning_quick_reason_ph()} />
      {#if superiors.length === 0}
        <Callout variant="warning">{m.planning_superior_none()}</Callout>
      {:else}
        <select class="input text-body-sm" bind:value={formSuperiorId} aria-label={m.planning_superior_ph()}>
          <option value="">{m.planning_superior_ph()}</option>
          {#each superiors as s (s.userId)}
            <option value={s.userId}>{superiorLabel(s)}</option>
          {/each}
        </select>
      {/if}
    {:else}
      <input class="input text-base font-semibold" bind:value={formTitle} placeholder={m.planning_title_ph()} aria-label={m.planning_title_ph()} />
    {/if}
    {@render dateFields(true)}
    {#if formError}
      <Callout variant="danger">{formError}</Callout>
    {/if}
    <div class="flex items-center justify-between gap-2 pt-1">
      <Button variant="ghost" size="sm" onclick={expandQuickCreate}>{m.planning_quick_more()}</Button>
      <Button variant="primary" size="sm" type="submit" loading={saving}>{m.common_save()}</Button>
    </div>
  </form>
</AnchoredPopover>

<!-- ===== Apercu d'un element ===== -->
<AnchoredPopover anchor={peek?.anchor ?? null} onClose={() => (peek = null)} label={peek?.event.title ?? ''} width={360}>
  {#if peek}
    {@const event = peek.event}
    {@const raw = event.raw}
    {@const type = event.type as PlanningType}
    <div class="pl-peek" style="--evt: {EVENT_TYPE_COLOR[type]}">
      <div class="flex items-center justify-end gap-0.5 px-2 pt-2">
        {#if type === 'meeting' && canManageMeetings}
          <Button variant="ghost" size="sm" icon="edit-2" aria-label={m.planning_detail_edit()} title={m.planning_detail_edit()} onclick={() => openEditMeeting(raw)} />
        {/if}
        <Button variant="ghost" size="sm" icon="trash-2" aria-label={m.planning_detail_delete()} title={m.planning_detail_delete()} onclick={() => deleteItem(event)} />
        <Button variant="ghost" size="sm" icon="x" aria-label={m.planning_close_aria()} onclick={() => (peek = null)} />
      </div>
      <div class="px-4 pb-4 space-y-3">
        <div class="flex gap-3">
          <span class="pl-peek__square" aria-hidden="true"></span>
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-on-surface wrap-break-word">{event.title}</h3>
            <p class="text-body-sm text-on-surface-variant">{formatSpan(event.start, event.end, type)}</p>
          </div>
        </div>

        {#if type === 'meeting'}
          {@const stats = getAttendanceStats(raw)}
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge {MEETING_BADGE[raw.status] ?? 'badge-neutral'}">{formatStatus(raw.status)}</span>
            {#if raw.presences?.length > 0}
              <span class="text-2xs text-on-surface-variant">{m.planning_presences_summary(stats)}</span>
            {/if}
          </div>
          {#if canModerateMeetings && raw.status === 'SCHEDULED'}
            <Button size="sm" icon="play" onclick={() => updateMeetingStatus(raw.id, 'IN_PROGRESS')}>{m.meetings_start_btn()}</Button>
          {:else if canModerateMeetings && raw.status === 'IN_PROGRESS'}
            <Button size="sm" icon="check" onclick={() => updateMeetingStatus(raw.id, 'COMPLETED')}>{m.meetings_finish_btn()}</Button>
          {/if}
        {:else if type === 'call'}
          <p class="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <Papicon icon="headphones" size={14} />
            {raw.channelMode === 'CREATE_NEW' ? m.planning_channel_temp() : m.planning_channel_existing()}
            {#if raw.invitees?.length}· {m.planning_invitees_count({ count: raw.invitees.length })}{/if}
          </p>
        {:else if type === 'task'}
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge {raw.priority === 'HIGH' ? 'badge-danger' : raw.priority === 'MEDIUM' ? 'badge-warning' : 'badge-neutral'}">{PRIORITY_LABEL[raw.priority]?.() ?? raw.priority}</span>
            <span class="badge {raw.status === 'COMPLETED' ? 'badge-success' : 'badge-info'}">{TASK_STATUS_LABEL[raw.status]?.() ?? raw.status}</span>
            {#if raw.assignee}
              <span class="inline-flex items-center gap-1.5 text-body-sm">{@render avatar(raw.assignee.avatarUrl, memberName(raw.assignee), 'w-5 h-5')} {memberName(raw.assignee)}</span>
            {/if}
          </div>
          <Button size="sm" icon={raw.status === 'COMPLETED' ? 'rotate-ccw' : 'check'} onclick={() => toggleTaskCompletion(raw)}>
            {raw.status === 'COMPLETED' ? m.planning_task_mark_todo() : m.planning_task_mark_done()}
          </Button>
        {:else if type === 'absence'}
          {@const status = ABSENCE_STATUS[raw.status]}
          <div class="flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center gap-1.5 text-body-sm font-medium text-on-surface">
              {@render avatar(event.avatarUrl, event.staffName ?? '', 'w-6 h-6')}
              {event.staffName || m.planning_unknown_member()}
            </span>
            <span class="badge badge-neutral">{raw.type || m.planning_absence_type_default()}</span>
            <span class="badge {status?.badge ?? 'badge-neutral'}">{status?.label() ?? raw.status}</span>
          </div>
          {#if canModerateAbsences && (raw.status === 'PENDING' || raw.status === 'ACKNOWLEDGED')}
            <div class="flex gap-2">
              <Button size="sm" variant="primary" icon="check" onclick={() => decideAbsence(raw.id, 'APPROVED')}>{m.planning_absence_approve()}</Button>
              <Button size="sm" variant="danger" icon="x" onclick={() => decideAbsence(raw.id, 'REJECTED')}>{m.planning_absence_reject()}</Button>
            </div>
          {/if}
        {/if}

        {#if raw.description && type !== 'absence'}
          <p class="text-body-sm text-on-surface-variant line-clamp-3 whitespace-pre-wrap">{raw.description}</p>
        {/if}

        <Button variant="ghost" size="sm" iconRight="arrow-right" onclick={() => openDetail(event)}>{m.planning_peek_open()}</Button>
      </div>
    </div>
  {/if}
</AnchoredPopover>

<!-- ===== Creation complete ===== -->
<Modal bind:open={creationModalOpen} title={m.planning_new_event()} size="lg">
  <form id="pl-create" class="space-y-4" onsubmit={handleCreateItem}>
    <FilterPills label={m.planning_type_aria()} options={typeOptions} value={createType} onchange={(v) => { createType = v; formError = ''; }} />

    {#if createType !== 'absence'}
      <input class="input text-base font-semibold" bind:value={formTitle} placeholder={m.planning_title_ph()} aria-label={m.planning_title_ph()} />
    {/if}

    {@render dateFields(false)}

    <textarea
      class="input resize-none"
      rows="3"
      bind:value={formDescription}
      aria-label={createType === 'absence' ? m.planning_absence_reason_ph() : m.planning_description_ph()}
      placeholder={createType === 'absence' ? m.planning_absence_reason_ph() : m.planning_description_ph()}
    ></textarea>

    {#if createType === 'absence'}
      <div class="grid gap-3 sm:grid-cols-2">
        <select class="input" bind:value={formAbsenceType} aria-label={m.planning_absence_type_default()}>
          <option value="Vacances">{m.planning_absence_type_holidays()}</option>
          <option value="Maladie">{m.planning_absence_type_sick()}</option>
          <option value="Examens">{m.planning_absence_type_exams()}</option>
          <option value="Autre">{m.planning_absence_type_other()}</option>
        </select>
        <SearchableSelect bind:value={formSuperiorId} options={superiorOptions} placeholder={m.planning_superior_ph()} showId={false} className="w-full" />
      </div>
      {#if superiors.length === 0}
        <Callout variant="warning">{m.planning_superior_none()}</Callout>
      {/if}
    {/if}

    {#if createType === 'call'}
      <fieldset class="rounded-lg border border-outline-variant p-4 space-y-3">
        <legend class="px-1 text-body-sm font-medium text-on-surface">{m.planning_discord_config()}</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          <select class="input" bind:value={formChannelMode} aria-label={m.planning_discord_config()}>
            <option value="CREATE_NEW">{m.planning_channel_temp()}</option>
            <option value="EXISTING">{m.planning_channel_existing()}</option>
          </select>
          {#if formChannelMode === 'CREATE_NEW'}
            <select class="input" bind:value={formChannelType} aria-label={m.planning_channel_voice()}>
              <option value="VOICE">{m.planning_channel_voice()}</option>
              <option value="STAGE">{m.planning_channel_stage()}</option>
            </select>
          {:else}
            <SearchableSelect
              bind:value={formDiscordChannelId}
              options={[
                ...dashboardStore.state.discordVoiceChannels.map(c => ({ id: c.id, name: `🔊 ${c.name}` })),
                ...dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) })),
              ]}
              placeholder={m.planning_select_ph()}
              className="w-full"
            />
          {/if}
        </div>
        {#if formChannelMode === 'CREATE_NEW'}
          <label class="flex items-center justify-between gap-3 text-body-sm text-on-surface">
            {m.planning_auto_delete_empty()}
            <ToggleSwitch checked={formIsTempChannel} onToggle={(v: boolean) => (formIsTempChannel = v)} />
          </label>
        {/if}
        <div>
          <p class="text-body-sm font-medium text-on-surface mb-2">{m.planning_guests_staff()}</p>
          <div class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
            {#each activeStaff.filter(s => s.id !== myStaffRecord?.id) as staff (staff.id)}
              {@const on = formInviteeUserIds.includes(staff.id)}
              <button type="button" class="pl-chip {on ? 'pl-chip--active' : ''}" aria-pressed={on} onclick={() => (formInviteeUserIds = on ? formInviteeUserIds.filter(id => id !== staff.id) : [...formInviteeUserIds, staff.id])}>
                {@render avatar(staff.avatarUrl, staff.username, 'w-4 h-4')}
                {memberName(staff)}
              </button>
            {/each}
          </div>
        </div>
        <div>
          <p class="text-body-sm font-medium text-on-surface mb-2">{m.planning_guests_members()}</p>
          {#if formInviteeMemberIds.length > 0}
            <div class="flex flex-wrap gap-1.5 mb-2">
              {#each formInviteeMemberIds as memberId (memberId)}
                {@const member = selectedMembers.get(memberId)}
                {#if member}
                  <button type="button" class="pl-chip pl-chip--active" onclick={() => toggleMemberInvitee(member)} aria-label="{memberName(member)} ×">
                    {@render avatar(member.avatarUrl, memberName(member), 'w-4 h-4')}
                    {memberName(member)}
                    <Papicon icon="x" size={10} />
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
          {@render memberSearch(memberSearchQuery, memberSearchLoading, memberSearchResults, handleMemberSearchInput, toggleMemberInvitee, formInviteeMemberIds)}
        </div>
      </fieldset>
    {/if}

    {#if createType === 'task'}
      <div class="grid gap-3 sm:grid-cols-2">
        <select class="input" bind:value={formPriority} aria-label={m.planning_priority_medium()}>
          <option value="LOW">{m.planning_priority_low()}</option>
          <option value="MEDIUM">{m.planning_priority_medium()}</option>
          <option value="HIGH">{m.planning_priority_high()}</option>
        </select>
        <SearchableSelect bind:value={formAssigneeId} options={activeStaff.map(s => ({ id: s.id, name: memberName(s) }))} placeholder={m.planning_assign_ph()} showId={false} className="w-full" />
      </div>
    {/if}

    {#if formError}
      <Callout variant="danger">{formError}</Callout>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (creationModalOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="pl-create" loading={saving}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<!-- ===== Fiche complete ===== -->
<Modal open={detailModalOpen && !!currentItemDetail} onClose={() => (detailModalOpen = false)} title={currentItemDetail?.title ?? ''} size="md">
  {#if currentItemDetail}
    {@const detail = currentItemDetail}
    {@const raw = detail.raw}
    {@const type = detail.type as PlanningType}
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-on-surface-variant">
        <span class="inline-flex items-center gap-1.5 font-medium text-on-surface">{@render bar(type)} {TYPE_META[type]?.label() ?? type}</span>
        <span>{formatSpan(detail.start, detail.end, type)}</span>
      </div>

      {#if raw.description || raw.reason}
        {#if type === 'meeting'}
          <div class="p-4 bg-[#2f3136] rounded-lg text-body-sm">
            <div class="text-[#dcddde] leading-relaxed whitespace-pre-wrap wrap-break-word discord-preview">
              {@html parseDiscordEmojisAndMarkdown(raw.description || '')}
            </div>
          </div>
        {:else}
          <p class="p-3 bg-surface-container rounded-lg text-body-sm text-on-surface whitespace-pre-wrap wrap-break-word">{raw.description || raw.reason}</p>
        {/if}
      {/if}

      {#if type === 'meeting'}
        {@const stats = getAttendanceStats(raw)}
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="badge {MEETING_BADGE[raw.status] ?? 'badge-neutral'}">{formatStatus(raw.status)}</span>
          {#if canModerateMeetings && raw.status === 'SCHEDULED'}
            <Button size="sm" icon="play" onclick={() => updateMeetingStatus(raw.id, 'IN_PROGRESS')}>{m.meetings_start_btn()}</Button>
          {:else if canModerateMeetings && raw.status === 'IN_PROGRESS'}
            <Button size="sm" icon="check" onclick={() => updateMeetingStatus(raw.id, 'COMPLETED')}>{m.meetings_finish_btn()}</Button>
          {/if}
        </div>
        <dl class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-lg bg-surface-container p-2"><dt class="text-2xs text-on-surface-variant">{m.meetings_stat_present()}</dt><dd class="text-base font-semibold text-success">{stats.present}</dd></div>
          <div class="rounded-lg bg-surface-container p-2"><dt class="text-2xs text-on-surface-variant">{m.meetings_stat_excused()}</dt><dd class="text-base font-semibold text-warning">{stats.excused}</dd></div>
          <div class="rounded-lg bg-surface-container p-2"><dt class="text-2xs text-on-surface-variant">{m.meetings_stat_absent()}</dt><dd class="text-base font-semibold text-error">{stats.absent}</dd></div>
        </dl>
        {#if raw.presences?.length > 0}
          <div>
            <h4 class="pl-left-title mb-1">{m.meetings_presence_list_title()}</h4>
            <ul class="max-h-56 overflow-y-auto divide-y divide-outline-variant">
              {#each raw.presences as presence (presence.id ?? presence.staffUserId)}
                <li class="flex items-center gap-2.5 py-2">
                  <button type="button" class="flex items-center gap-2.5 min-w-0 flex-1 text-left hover:text-primary disabled:hover:text-on-surface" disabled={!canOpenMemberCase} onclick={() => openMemberCase(presence.staffUserId, memberName(presence.staffMember))}>
                    {@render avatar(presence.staffMember?.avatarUrl, memberName(presence.staffMember), 'w-7 h-7')}
                    <span class="min-w-0">
                      <span class="block truncate text-body-sm font-medium">{memberName(presence.staffMember)}</span>
                      {#if presence.note}
                        <span class="block truncate text-2xs text-on-surface-variant" title={presence.note}>{presence.note}</span>
                      {/if}
                    </span>
                  </button>
                  <span class="badge {MEETING_BADGE[presence.status] ?? 'badge-neutral'}">{formatStatus(presence.status)}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}

      {#if type === 'call'}
        <p class="flex items-center gap-2 text-body-sm text-on-surface-variant">
          <Papicon icon="headphones" size={14} />
          {raw.channelMode === 'CREATE_NEW' ? m.planning_channel_temp() : m.planning_channel_existing()}
        </p>
        {#if raw.invitees?.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each raw.invitees as invitee, i (invitee.id ?? i)}
              <span class="pl-chip">{@render avatar(invitee.staffMember?.avatarUrl, memberName(invitee.staffMember), 'w-4 h-4')} {memberName(invitee.staffMember)}</span>
            {/each}
          </div>
        {/if}
      {/if}

      {#if type === 'task'}
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge {raw.priority === 'HIGH' ? 'badge-danger' : raw.priority === 'MEDIUM' ? 'badge-warning' : 'badge-neutral'}">{PRIORITY_LABEL[raw.priority]?.() ?? raw.priority}</span>
          <span class="badge {raw.status === 'COMPLETED' ? 'badge-success' : 'badge-info'}">{TASK_STATUS_LABEL[raw.status]?.() ?? raw.status}</span>
          {#if raw.assignee}
            <span class="inline-flex items-center gap-1.5 text-body-sm text-on-surface">{@render avatar(raw.assignee.avatarUrl, memberName(raw.assignee), 'w-5 h-5')} {memberName(raw.assignee)}</span>
          {/if}
          <DoingListPin module="tasks" sourceId={raw.id} />
        </div>
        <Button size="sm" icon={raw.status === 'COMPLETED' ? 'rotate-ccw' : 'check'} onclick={() => toggleTaskCompletion(raw)}>
          {raw.status === 'COMPLETED' ? m.planning_task_mark_todo() : m.planning_task_mark_done()}
        </Button>
      {/if}

      {#if type === 'absence'}
        {@const status = ABSENCE_STATUS[raw.status]}
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex items-center gap-2 text-body-sm font-medium text-on-surface">
            {@render avatar(detail.avatarUrl, detail.staffName || '', 'w-7 h-7')}
            {detail.staffName || m.planning_unknown_member()}
          </span>
          <span class="badge badge-neutral">{raw.type || m.planning_absence_type_default()}</span>
          <span class="badge {status?.badge ?? 'badge-neutral'}">{status?.label() ?? raw.status}</span>
        </div>
        {#if canModerateAbsences && (raw.status === 'PENDING' || raw.status === 'ACKNOWLEDGED')}
          <div class="flex gap-2">
            <Button size="sm" variant="primary" icon="check" onclick={() => decideAbsence(raw.id, 'APPROVED')}>{m.planning_absence_approve()}</Button>
            <Button size="sm" variant="danger" icon="x" onclick={() => decideAbsence(raw.id, 'REJECTED')}>{m.planning_absence_reject()}</Button>
          </div>
        {/if}
      {/if}

      {#if type !== 'absence'}
        <section class="border-t border-outline-variant pt-4 space-y-3">
          <h4 class="flex items-center gap-1.5 text-body-sm font-semibold text-on-surface">
            <Papicon icon="bell" size={14} />
            {m.planning_reminders_title({ count: raw.reminders?.length || 0 })}
          </h4>
          {#if raw.reminders?.length > 0}
            <ul class="space-y-1.5 max-h-36 overflow-y-auto">
              {#each raw.reminders as reminder (reminder.id)}
                <li class="flex items-center gap-2 rounded-lg bg-surface-container px-3 py-2">
                  <div class="flex-1 min-w-0">
                    <p class="truncate text-body-sm text-on-surface">{reminder.message}</p>
                    <p class="text-2xs text-on-surface-variant">
                      {m.planning_reminder_at({ date: new Date(reminder.targetTime).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}
                      <span class={reminder.fired ? 'text-success' : 'text-warning'}>{reminder.fired ? m.planning_reminder_sent() : m.planning_reminder_scheduled()}</span>
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" icon="trash-2" aria-label={m.planning_reminder_delete_tooltip()} onclick={() => handleDeleteReminder(reminder.id)} />
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-2xs text-on-surface-variant">{m.planning_no_reminder()}</p>
          {/if}
          <form class="rounded-lg border border-outline-variant p-3 space-y-2" onsubmit={handleAddReminder}>
            <p class="text-body-sm font-medium text-on-surface">{m.planning_schedule_reminder()}</p>
            <div class="grid gap-2 sm:grid-cols-2">
              <Field label={m.planning_reminder_datetime()} hint={timezoneStore.loaded && timezoneStore.differsFromBrowser ? m.planning_datetime_hint_diff_short({ server: timezoneStore.timezone }) : ''}>
                {#snippet children(id, describedBy)}
                  <input {id} aria-describedby={describedBy} type="datetime-local" class="input text-body-sm" bind:value={newReminderTime} />
                {/snippet}
              </Field>
              <Field label={m.planning_reminder_channel()}>
                {#snippet children(id)}
                  <select {id} class="input text-body-sm" bind:value={newReminderChannel}>
                    <option value="DM">{m.planning_reminder_channel_dm()}</option>
                    <option value="CURRENT">{m.planning_reminder_channel_current()}</option>
                  </select>
                {/snippet}
              </Field>
            </div>
            <div class="flex gap-2">
              <input class="input flex-1 text-body-sm" bind:value={newReminderMessage} placeholder={m.planning_reminder_note_ph()} aria-label={m.planning_reminder_note_ph()} />
              <Button type="submit" size="sm" icon="plus" disabled={!newReminderTime || !newReminderMessage.trim()} disabledReason={m.planning_reminder_required()}>{m.planning_reminder_add()}</Button>
            </div>
          </form>
        </section>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" icon="trash-2" class="mr-auto text-error" onclick={() => currentItemDetail && deleteItem(currentItemDetail)}>{m.planning_detail_delete()}</Button>
    {#if currentItemDetail?.type === 'meeting' && canManageMeetings}
      <Button icon="edit-2" onclick={() => { detailModalOpen = false; openEditMeeting(currentItemDetail?.raw); }}>{m.planning_detail_edit()}</Button>
    {/if}
    <Button variant="ghost" onclick={() => (detailModalOpen = false)}>{m.planning_detail_close()}</Button>
  {/snippet}
</Modal>

<!-- ===== Qui peut creer des appels ===== -->
<Modal bind:open={permissionModalOpen} title={m.planning_call_perms_tooltip()}>
  <div class="space-y-4">
    <FilterPills
      label={m.planning_call_perms_tooltip()}
      options={[{ value: 'EVERYONE', label: m.planning_perm_everyone() }, { value: 'RESTRICTED', label: m.planning_perm_restricted() }]}
      value={permMode}
      onchange={(v) => (permMode = v as typeof permMode)}
    />
    {#if permMode === 'RESTRICTED'}
      <div>
        <p class="text-body-sm font-medium text-on-surface mb-2">{m.planning_perm_roles()}</p>
        {#if (dashboardStore.state.discordRoles || []).length === 0}
          <p class="text-2xs text-on-surface-variant">{m.planning_perm_no_roles()}</p>
        {:else}
          <div class="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {#each dashboardStore.state.discordRoles as role (role.id)}
              <button type="button" class="pl-chip {permRoleIds.includes(role.id) ? 'pl-chip--active' : ''}" aria-pressed={permRoleIds.includes(role.id)} onclick={() => togglePermRole(role.id)}>@{role.name}</button>
            {/each}
          </div>
        {/if}
      </div>
      <div>
        <p class="text-body-sm font-medium text-on-surface mb-2">{m.planning_perm_members()}</p>
        {#if permUserIds.length > 0}
          <div class="flex flex-wrap gap-1.5 mb-2">
            {#each permUserIds as uid (uid)}
              {@const u = permSelectedUsersMap.get(uid)}
              <button type="button" class="pl-chip pl-chip--active" onclick={() => togglePermUser({ id: uid, ...(u || {}) })} aria-label="{u ? memberName(u) : uid} ×">
                {#if u}{@render avatar(u.avatarUrl, memberName(u), 'w-4 h-4')}{/if}
                {u ? memberName(u) : uid}
                <Papicon icon="x" size={10} />
              </button>
            {/each}
          </div>
        {/if}
        {@render memberSearch(permMemberSearchQuery, permMemberSearchLoading, permMemberSearchResults, handlePermMemberSearchInput, togglePermUser, permUserIds)}
      </div>
    {:else}
      <p class="text-body-sm text-on-surface-variant">{m.planning_perm_everyone_hint()}</p>
    {/if}
    {#if permError}
      <Callout variant="danger">{permError}</Callout>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (permissionModalOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" loading={permSaving} onclick={savePermissionConfig}>{m.common_save()}</Button>
  {/snippet}
</Modal>

<MemberCaseModal
  open={userCaseModalOpen}
  userId={selectedUserIdForCase}
  userName={selectedUserNameForCase}
  {caseData}
  loading={loadingCase}
  error={caseError}
  onClose={() => { userCaseModalOpen = false; }}
  onSelectUser={(newUserId) => {
    const foundNode = caseData?.interactionGraph?.nodes?.find((n: any) => n.id === newUserId);
    openMemberCase(newUserId, foundNode?.label || m.planning_member_fallback());
  }}
/>

<!-- ===== Suppression d'une reunion ===== -->
<Modal bind:open={meetingDeleteModalOpen} title={m.meetings_delete_modal_title()} subtitle={m.meetings_delete_modal_subtitle()}>
  <div class="space-y-3">
    <p class="text-body-sm text-on-surface-variant">{m.meetings_delete_question()}</p>
    {#each [
      { label: m.meetings_delete_event_label(), desc: m.meetings_delete_event_desc(), get: () => deleteDiscordEvent, set: (v: boolean) => (deleteDiscordEvent = v) },
      { label: m.meetings_delete_message_label(), desc: m.meetings_delete_message_desc(), get: () => deleteDiscordMessage, set: (v: boolean) => (deleteDiscordMessage = v) },
      { label: m.meetings_delete_notif_label(), desc: m.meetings_delete_notif_desc(), get: () => deleteDiscordNotification, set: (v: boolean) => (deleteDiscordNotification = v) },
    ] as option, i (i)}
      <label class="flex items-start gap-3 p-3 rounded-lg border border-outline-variant cursor-pointer hover:bg-surface-container">
        <input type="checkbox" class="mt-0.5" checked={option.get()} onchange={(e) => option.set((e.target as HTMLInputElement).checked)} />
        <span>
          <span class="block text-body-sm font-medium text-on-surface">{option.label}</span>
          <span class="block text-2xs text-on-surface-variant">{option.desc}</span>
        </span>
      </label>
    {/each}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (meetingDeleteModalOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="danger" loading={deletingMeeting} onclick={confirmDeleteMeeting}>{m.planning_detail_delete()}</Button>
  {/snippet}
</Modal>

<!-- ===== Edition d'une reunion ===== -->
<Modal bind:open={meetingEditModalOpen} title={m.planning_edit_meeting_title()} subtitle={m.meetings_modal_subtitle()} size="xl">
  <form id="pl-edit-meeting" class="space-y-4" onsubmit={(e) => { e.preventDefault(); void saveMeetingEdit(); }}>
    <Field label={m.meetings_field_title_label()} required>
      {#snippet children(id, describedBy)}
        <input {id} aria-describedby={describedBy} class="input text-base font-semibold" bind:value={editMeetingTitle} placeholder={m.meetings_field_title_ph()} />
      {/snippet}
    </Field>
    <div class="grid gap-4 sm:grid-cols-2">
      <Field label={m.meetings_field_start_label()} required>
        {#snippet children(id)}
          <input {id} type="datetime-local" class="input" bind:value={editMeetingDate} />
        {/snippet}
      </Field>
      <Field label={m.meetings_field_end_label()}>
        {#snippet children(id)}
          <input {id} type="datetime-local" class="input" bind:value={editMeetingEndDate} />
        {/snippet}
      </Field>
    </div>
    {#if timezoneStore.loaded}
      <TimezoneHint bind:value={editMeetingTimezone} />
    {/if}
    <DiscordMarkdownEditor
      id="edit-meeting-desc"
      bind:value={editMeetingDesc}
      label={m.meetings_field_agenda_label()}
      placeholder={m.meetings_field_agenda_ph()}
      rows={10}
      agendaMode={true}
      disabled={savingMeetingEdit}
    />
    {#if editMeetingError}
      <Callout variant="danger">{editMeetingError}</Callout>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (meetingEditModalOpen = false)}>{m.common_cancel()}</Button>
    <Button variant="primary" type="submit" form="pl-edit-meeting" loading={savingMeetingEdit} disabled={!editMeetingTitle || !editMeetingDate} disabledReason={m.common_reason_fill_field()}>
      {m.common_save()}
    </Button>
  {/snippet}
</Modal>

<style>
  /* Coque facon Outlook : un seul cadre, des volets separes par des filets. */
  .pl-shell {
    display: flex;
    flex-direction: column;
    /* Toute la hauteur sous la barre du haut (h-14). */
    height: calc(100dvh - 3.5rem);
    min-height: 30rem;
    overflow: hidden;
    background: var(--color-surface-container-lowest);
  }
  @media (max-width: 767px) {
    .pl-shell {
      height: calc(100dvh - var(--mobile-topbar-height) - var(--mobile-tabbar-clearance));
    }
  }
  .pl-ribbon {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-low);
  }
  .pl-sep {
    width: 1px;
    height: 1.5rem;
    background: var(--color-outline-variant);
  }
  /* Bouton scinde : l'action par defaut, puis la fleche des autres types. */
  .pl-split {
    display: flex;
    align-items: stretch;
  }
  .pl-split > :global(.btn:first-child) {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .pl-split > :global(.btn + .btn) {
    height: auto;
    align-self: stretch;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid color-mix(in srgb, var(--color-on-primary) 30%, transparent);
    background: var(--color-primary);
    color: var(--color-on-primary);
  }
  .pl-view {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-on-surface);
    white-space: nowrap;
  }
  .pl-view:hover {
    background: var(--color-surface-container-high);
  }
  .pl-view--active {
    background: color-mix(in srgb, var(--color-primary) 16%, transparent);
    color: var(--color-primary);
  }
  .pl-count {
    min-width: 1.125rem;
    padding: 0 0.3125rem;
    border-radius: 999px;
    background: var(--color-primary);
    color: var(--color-on-primary);
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1.125rem;
    text-align: center;
  }
  .pl-body {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .pl-left {
    width: 15.5rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--color-outline-variant);
    overflow-y: auto;
  }
  .pl-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .pl-right {
    width: 20rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--color-outline-variant);
    background: var(--color-surface-container-low);
  }
  /* Sur petit ecran, les volets passent par-dessus le calendrier. */
  @media (max-width: 1023px) {
    .pl-left,
    .pl-right {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 20;
      background: var(--color-surface-container-lowest);
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.3);
    }
    .pl-left {
      left: 0;
    }
    .pl-right {
      right: 0;
      width: min(20rem, 90vw);
    }
  }
  .pl-left-section {
    padding: 0.75rem;
    border-top: 1px solid var(--color-outline-variant);
  }
  .pl-left-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-on-surface);
    padding: 0 0.25rem 0.25rem;
  }
  .pl-link {
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    color: var(--color-primary);
  }
  .pl-link:hover {
    background: var(--color-surface-container);
  }
  .pl-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    color: var(--color-on-surface-variant);
  }
  .pl-icon-btn:hover {
    background: var(--color-surface-container);
  }
  .pl-mini-day {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    color: var(--color-on-surface);
    border-radius: 0.25rem;
  }
  .pl-mini-day:hover {
    background: var(--color-surface-container-high);
  }
  .pl-mini-day--out {
    color: var(--color-on-surface-variant);
  }
  .pl-mini-day--range {
    background: color-mix(in srgb, var(--color-primary) 14%, transparent);
    border-radius: 0;
  }
  .pl-mini-day--today {
    background: var(--color-primary);
    color: var(--color-on-primary);
    font-weight: 600;
    border-radius: 999px;
  }
  .pl-mini-day--today:hover {
    background: var(--color-primary);
  }
  .pl-filter {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.3125rem 0.375rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .pl-filter:hover,
  .pl-row:hover,
  .pl-agenda-item:hover,
  .pl-task:hover {
    background: var(--color-surface-container);
  }
  .pl-check {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    accent-color: var(--evt, var(--color-primary));
  }
  .pl-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    text-align: left;
  }
  .pl-agenda-item {
    display: flex;
    align-items: stretch;
    gap: 0.625rem;
    width: 100%;
    padding: 0.375rem;
    border-radius: 0.375rem;
    text-align: left;
  }
  .pl-task {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.375rem;
    border-radius: 0.375rem;
  }
  .pl-bar {
    width: 3px;
    flex-shrink: 0;
    align-self: stretch;
    min-height: 1rem;
    border-radius: 2px;
    background: var(--evt);
  }
  .pl-peek {
    border-top: 4px solid var(--evt);
    border-radius: 0.75rem;
  }
  .pl-peek__square {
    width: 0.875rem;
    height: 0.875rem;
    margin-top: 0.375rem;
    flex-shrink: 0;
    border-radius: 0.1875rem;
    background: var(--evt);
  }
  .pl-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    border: 1px solid var(--color-outline-variant);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-on-surface-variant);
  }
  button.pl-chip:hover {
    background: var(--color-surface-container);
  }
  .pl-chip--active {
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    color: var(--color-primary);
  }
</style>
