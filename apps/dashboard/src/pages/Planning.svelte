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
    fetchPlanningExtras,
    fetchPlanningIcalLink,
    fetchStaffRoles,
    rsvpMeeting,
    updateCall,
    dashboardFetch,
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
    type PlanningExtra,
  } from '../lib/api';
  import { parseDiscordEmojisAndMarkdown } from '../lib/emojiParser';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import { formatWallClockInTimezone, parseDateTimeInTimezone } from '@kotbo/contracts';
  import TimezoneHint from '../lib/components/TimezoneHint.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Calendar, { EVENT_TYPE_COLOR, CALENDAR_VIEWS, PHONE_VIEWS, type CalendarEvent, type CalendarView } from '../lib/components/Calendar.svelte';
  import { isPhone } from '../lib/stores/media.svelte';
  import { MAX_REPEAT, repeatDates } from '../lib/planningRepeat';
  import { API_BASE_URL } from '../lib/api/client';
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

  type ServerKind = PlanningExtra['kind'];
  /** Calques calcules par la page : presence en vocal et alertes de couverture. */
  type DerivedKind = 'voice' | 'coverage';
  type PlanningType = 'meeting' | 'absence' | 'call' | 'task' | ServerKind | DerivedKind;
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
  /** Calques du groupe « Staff » : les types creables, puis ce que la page deduit. */
  const STAFF_LAYERS: PlanningType[] = [...TYPES, 'coverage', 'voice'];
  // Ce que le serveur a deja de date ; lecture seule, gere dans sa propre page.
  const SERVER_TYPES: ServerKind[] = ['server_event', 'giveaway', 'schedule', 'testing_end', 'sanction_end'];
  const TYPE_META: Record<PlanningType, { label: () => string; calendar: () => string; icon: string }> = {
    meeting: { label: m.planning_type_meeting, calendar: m.planning_cal_meetings, icon: 'calendar' },
    call: { label: m.planning_type_call, calendar: m.planning_cal_calls, icon: 'phone' },
    absence: { label: m.planning_type_absence, calendar: m.planning_cal_absences, icon: 'sun' },
    task: { label: m.planning_type_task, calendar: m.planning_cal_tasks, icon: 'check-square' },
    coverage: { label: m.planning_type_coverage, calendar: m.planning_cal_coverage, icon: 'alert-triangle' },
    voice: { label: m.planning_type_voice, calendar: m.planning_cal_voice, icon: 'mic' },
    server_event: { label: m.planning_type_server_event, calendar: m.planning_cal_server_events, icon: 'megaphone' },
    giveaway: { label: m.planning_type_giveaway, calendar: m.planning_cal_giveaways, icon: 'gift' },
    schedule: { label: m.planning_type_schedule, calendar: m.planning_cal_schedules, icon: 'send' },
    testing_end: { label: m.planning_type_testing_end, calendar: m.planning_cal_testing_end, icon: 'graduation-cap' },
    sanction_end: { label: m.planning_type_sanction_end, calendar: m.planning_cal_sanction_end, icon: 'ban' },
  };
  const SERVER_LINK_LABEL: Record<ServerKind, () => string> = {
    server_event: m.planning_extra_open_events,
    giveaway: m.planning_extra_open_giveaways,
    schedule: m.planning_extra_open_schedules,
    testing_end: m.planning_extra_open_tutoring,
    sanction_end: m.planning_extra_open_sanctions,
  };
  /** Couleurs du mode « par personne » : une par membre, dans l'ordre de la liste. */
  const PERSON_PALETTE = ['#4f46e5', '#0891b2', '#16a34a', '#ca8a04', '#db2777', '#7c3aed', '#ea580c', '#0d9488', '#be123c', '#2563eb'];
  const EVENT_STATUS_LABEL: Record<string, { label: () => string; badge: string }> = {
    SCHEDULED: { label: m.planning_event_status_scheduled, badge: 'badge-info' },
    ACTIVE: { label: m.planning_event_status_active, badge: 'badge-warning' },
    COMPLETED: { label: m.planning_event_status_completed, badge: 'badge-success' },
  };
  const SCHEDULE_TYPE_LABEL: Record<string, () => string> = {
    SEND_MESSAGE: m.planning_schedule_type_send_message,
    CHANNEL_RESET: m.planning_schedule_type_channel_reset,
    SERVER_BACKUP: m.planning_schedule_type_server_backup,
    DATA_EXPORT: m.planning_schedule_type_data_export,
  };
  const isServerKind = (type: string): type is ServerKind => (SERVER_TYPES as string[]).includes(type);
  const VIEW_META: Record<CalendarView, { label: () => string; icon: string }> = {
    day: { label: m.cal_view_day, icon: 'calendar' },
    twodays: { label: m.cal_view_twodays, icon: 'grid' },
    week: { label: m.cal_view_week, icon: 'calendar-days' },
    month: { label: m.cal_view_month, icon: 'layout-grid' },
    agenda: { label: m.cal_view_list, icon: 'list' },
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
    CANCELED: 'badge-danger',
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
  let extras = $state<PlanningExtra[]>([]);
  let todayExtras = $state<PlanningExtra[]>([]);
  // Absences de toute l'equipe sur la periode, pour l'alerte de couverture.
  let teamAbsences = $state<Array<{ staffName: string; start: string; end: string | null }>>([]);
  let allRoles = $state<any[]>([]);
  let userTasks = $state<any[]>([]);
  let loadError = $state(false);

  // ── Affichage ───────────────────────────────────────────
  let calendarView = $state<CalendarView>('week');
  let calendarCurrentDate = $state(new Date());
  let rangeStart = $state(new Date());
  let rangeEnd = $state(new Date());
  let rangeKnown = false;
  let miniCalDate = $state(new Date());
  let selectedStaffIds = $state<string[]>([]);
  // La presence vocale est nombreuse : elle se coche quand on la cherche.
  let visibleTypes = $state<string[]>([...TYPES, 'coverage', ...SERVER_TYPES]);
  let peopleQuery = $state('');
  let searchQuery = $state('');
  // Preferences d'affichage du lecteur, gardees dans son navigateur.
  let colorMode = $state<'type' | 'person'>(readPref('kotbo.planning.colorMode', 'type'));
  let showWeekend = $state<'auto' | 'always'>(readPref('kotbo.planning.weekend', 'auto'));
  let icalOpen = $state(false);
  let icalUrl = $state('');

  function readPref<T extends string>(key: string, fallback: T): T {
    try {
      return (localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writePref(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* navigation privee : la preference vaut pour la visite */
    }
  }
  let leftPaneOpen = $state(true);
  let myDayOpen = $state(true);
  let myDayTab = $state<'agenda' | 'tasks'>('agenda');
  let showDoneTasks = $state(false);
  let quickTaskTitle = $state('');

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
  // Repetition d'une reunion ou d'un appel : chaque occurrence est creee a part.
  let formRepeat = $state<'none' | 'weekly' | 'biweekly' | 'monthly'>('none');
  let formRepeatCount = $state(4);
  let formLocation = $state('');
  let formError = $state('');

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

  /** Personnes rangees par grade, du plus haut au plus bas, comme la liste du staff. */
  const staffGroups = $derived.by(() => {
    const rank = (grade: string) => allRoles.find(r => r.name === grade)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const groups = new Map<string, any[]>();
    for (const s of filteredStaff) {
      const grade = s.grade || m.planning_no_grade();
      groups.set(grade, [...(groups.get(grade) ?? []), s]);
    }
    return [...groups.entries()]
      .map(([grade, members]) => ({ grade, members }))
      .sort((a, b) => rank(a.grade) - rank(b.grade) || a.grade.localeCompare(b.grade));
  });

  const personColor = (staffId: string | null | undefined) => {
    const index = activeStaff.findIndex(s => s.id === staffId);
    return index === -1 ? undefined : PERSON_PALETTE[index % PERSON_PALETTE.length];
  };

  /** Membre a qui appartient l'element, pour la couleur par personne. */
  function ownerOf(event: CalendarEvent): string | null {
    const raw = event.raw ?? {};
    if (event.type === 'absence' || event.type === 'voice') return raw.staffUserId ?? null;
    if (event.type === 'task') return raw.assigneeId ?? null;
    if (event.type === 'call') return raw.creatorId ?? null;
    return null;
  }

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

  /** Un element du serveur : une fin de giveaway ou une publication tient sur une demi-heure. */
  function extraToEvent(x: PlanningExtra): CalendarEvent {
    const start = new Date(x.start);
    const end = x.end ? new Date(x.end) : new Date(start.getTime() + (x.kind === 'server_event' ? 3600000 : 1800000));
    return { id: x.id, title: x.title, start, end, type: x.kind, isAllDay: false, details: x.description ?? undefined, raw: x };
  }

  /** Une session vocale du staff : qui etait en vocal, et quand. */
  function voiceToEvent(raw: any): CalendarEvent {
    const start = new Date(raw.joinedAt);
    const end = raw.leftAt ? new Date(raw.leftAt) : new Date();
    const name = memberName(raw.staffMember);
    return { id: raw.id, title: name, start, end, type: 'voice', isAllDay: false, staffName: raw.channelName ?? undefined, raw };
  }

  /** A partir de combien d'absents le meme jour on previent : un quart de l'equipe, deux au minimum. */
  const coverageThreshold = $derived(Math.max(2, Math.ceil(activeStaff.length * 0.25)));

  /** Jours ou trop de staff sont absents, d'apres les absences de toute l'equipe. */
  const coverageEvents = $derived.by((): CalendarEvent[] => {
    const result: CalendarEvent[] = [];
    const day = new Date(rangeStart);
    day.setHours(0, 0, 0, 0);
    for (; day.getTime() <= rangeEnd.getTime(); day.setDate(day.getDate() + 1)) {
      const from = day.getTime();
      const to = from + 86400000;
      const names = [...new Set(teamAbsences
        .filter(a => new Date(a.start).getTime() < to && (a.end === null || new Date(a.end).getTime() >= from))
        .map(a => a.staffName))];
      if (names.length < coverageThreshold) continue;
      result.push({
        id: `coverage-${from}`,
        title: m.planning_coverage_title({ count: names.length }),
        start: new Date(from),
        end: new Date(to - 1),
        type: 'coverage',
        isAllDay: true,
        raw: { names },
      });
    }
    return result;
  });

  const calendarEvents = $derived.by(() => {
    const events: CalendarEvent[] = [];
    if (visibleTypes.includes('meeting')) calendarData.meetings.forEach(x => events.push(toEvent('meeting', x)));
    if (visibleTypes.includes('absence')) calendarData.absences.forEach(x => events.push(toEvent('absence', x)));
    if (visibleTypes.includes('call')) calendarData.calls.forEach(x => events.push(toEvent('call', x)));
    if (visibleTypes.includes('task')) calendarData.tasks.filter(t => t.dueDate).forEach(x => events.push(toEvent('task', x)));
    if (visibleTypes.includes('voice')) calendarData.voiceSessions.forEach(x => events.push(voiceToEvent(x)));
    if (visibleTypes.includes('coverage')) events.push(...coverageEvents);
    extras.filter(x => visibleTypes.includes(x.kind)).forEach(x => events.push(extraToEvent(x)));

    const q = searchQuery.trim().toLowerCase();
    const shown = q ? events.filter(e => `${e.title ?? ''} ${e.staffName ?? ''}`.toLowerCase().includes(q)) : events;
    if (colorMode === 'type') return shown;
    return shown.map(e => ({ ...e, color: personColor(ownerOf(e)) }));
  });

  const typeCounts = $derived<Record<string, number>>({
    meeting: calendarData.meetings.length,
    call: calendarData.calls.length,
    absence: calendarData.absences.length,
    task: calendarData.tasks.filter(t => t.dueDate).length,
    voice: calendarData.voiceSessions.length,
    coverage: coverageEvents.length,
    ...Object.fromEntries(SERVER_TYPES.map(k => [k, extras.filter(x => x.kind === k).length])),
  });

  // Calques que le role peut voir : les memes droits que la page de chaque section.
  const SERVER_FEATURE: Record<ServerKind, string> = {
    server_event: 'events',
    giveaway: 'giveaways',
    schedule: 'settings',
    testing_end: 'tutoring',
    sanction_end: 'sanctions',
  };
  const canSeeServerKind = (kind: ServerKind) => (kind === 'schedule' ? canManageSettings : canViewFeature(SERVER_FEATURE[kind]));
  const canCreateServerEvent = $derived(canManageSettings && canViewFeature('events'));

  const todayAgenda = $derived(
    [
      ...todayData.meetings.map(x => toEvent('meeting', x)),
      ...todayData.calls.map(x => toEvent('call', x)),
      ...todayExtras.map(extraToEvent),
    ].sort((a, b) => a.start.getTime() - b.start.getTime()),
  );
  /** Ce qui vient ensuite aujourd'hui, comme la carte « Prochain cours » de Tafac. */
  const nextUp = $derived(todayAgenda.find(e => (e.end ?? e.start).getTime() > Date.now()) ?? null);
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
  const channelName = (id: string) =>
    [...dashboardStore.state.discordChannels, ...dashboardStore.state.discordVoiceChannels].find(c => c.id === id)?.name ?? id;
  const eventKey = (e: CalendarEvent | null | undefined) => (e ? `${e.type}:${e.id}` : null);

  function formatSpan(start: Date, end: Date | undefined, type: string) {
    const day = capitalize(start.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' }));
    // Echeance, tirage, publication ou fin de periode : un instant, pas une plage.
    if (INSTANT_TYPES.includes(type) || !end) return `${day} · ${formatTime(start)}`;
    if (type === 'coverage') return day;
    if (isSameDay(start, end)) return `${day} · ${formatTime(start)} – ${formatTime(end)}`;
    return `${day} ${formatTime(start)} – ${end.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long' })} ${formatTime(end)}`;
  }

  const INSTANT_TYPES = ['task', 'giveaway', 'schedule', 'testing_end', 'sanction_end'];

  /** « 45 min », « 1 h 30 » : la duree se lit sans calcul, comme dans Tafac. */
  function formatDuration(start: Date, end: Date | undefined): string {
    if (!end) return '';
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (minutes <= 0 || minutes >= 24 * 60) return '';
    const h = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return h === 0 ? `${rest} min` : rest === 0 ? `${h} h` : `${h} h ${String(rest).padStart(2, '0')}`;
  }

  /** « dans 25 min », « dans 2 h » : pour la carte « A suivre ». */
  function formatCountdown(start: Date): string {
    const minutes = Math.max(0, Math.round((start.getTime() - Date.now()) / 60000));
    if (minutes === 0) return m.planning_next_now();
    return m.planning_next_in({ delay: minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h` });
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
      const [membersData, callPermData, superiorsData, rolesData] = await Promise.all([
        fetchStaffMembers(),
        fetchCallPermissionConfig().catch(() => null),
        fetchAbsenceSuperiors().catch(() => null),
        fetchStaffRoles().catch(() => null),
      ]);
      allStaff = membersData?.members || [];
      superiors = superiorsData?.superiors || [];
      allRoles = rolesData?.roles || [];

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
      const [data, extra] = await Promise.all([
        fetchStaffCalendarData(rangeStart, rangeEnd, selectedStaffIds),
        fetchPlanningExtras(rangeStart, rangeEnd).catch(() => null),
      ]);
      calendarData = normalize(data);
      extras = extra?.items ?? [];
      teamAbsences = extra?.teamAbsences ?? [];
      loadError = false;
    } catch (e) {
      console.error('Failed to load calendar data:', e);
      loadError = true;
    }
  }

  async function refreshToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    try {
      const [data, extra] = await Promise.all([
        fetchStaffCalendarData(start, end),
        fetchPlanningExtras(start, end).catch(() => null),
      ]);
      todayData = normalize(data);
      // Les taches planifiees restent dans le calendrier : la journee montre ce qui implique des gens.
      todayExtras = (extra?.items ?? []).filter(x => x.kind !== 'schedule');
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

  // ── Mises a jour immediates ─────────────────────────────
  /**
   * L'ecran change tout de suite, sans attendre le serveur. S'il refuse, les
   * listes reviennent a l'etat d'avant. `run` echoue en levant, ou en rendant
   * `false` (dashboardMutation, qui a deja affiche l'erreur).
   */
  async function optimistic(
    apply: () => void,
    run: () => Promise<unknown>,
    onError: (err: unknown) => void = err => toast.error(errorMessage(err) || m.common_error()),
  ): Promise<boolean> {
    const before = { calendarData, todayData, userTasks };
    apply();
    syncDetail();
    let ok = true;
    try {
      ok = (await run()) !== false;
    } catch (err) {
      ok = false;
      onError(err);
    }
    if (!ok) {
      calendarData = before.calendarData;
      todayData = before.todayData;
      userTasks = before.userTasks;
      syncDetail();
    }
    await refreshAll();
    return ok;
  }

  /** Modifie un element partout ou il s'affiche ; sans `change`, le retire. */
  function patchLocal(type: PlanningType, id: string, change?: (raw: any) => any) {
    const key = `${type}s` as keyof CalendarData;
    const edit = (list: any[]) => (change ? list.map(x => (x.id === id ? change(x) : x)) : list.filter(x => x.id !== id));
    calendarData = { ...calendarData, [key]: edit(calendarData[key]) };
    todayData = { ...todayData, [key]: edit(todayData[key]) };
    if (type === 'task') userTasks = edit(userTasks);
  }

  /** Brouillon affiche le temps que le serveur cree l'element ; le rechargement le remplace. */
  function addLocal(type: PlanningType, raw: any) {
    const key = `${type}s` as keyof CalendarData;
    calendarData = { ...calendarData, [key]: [...calendarData[key], raw] };
    const when = raw.scheduledAt ?? raw.startDate ?? raw.dueDate;
    if (when && isToday(new Date(when))) todayData = { ...todayData, [key]: [...todayData[key], raw] };
    if (type === 'task' && raw.assigneeId === myStaffRecord?.id) userTasks = [raw, ...userTasks];
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
    rsvpExcuseOpen = false;
    rsvpNote = '';
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
    createType = creatableTypes.includes(type) ? type : 'meeting';
    formLocation = '';
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
    formRepeat = 'none';
    formRepeatCount = 4;
    formError = '';
  }

  // ── Disponibilites du creneau ───────────────────────────
  // Avant de poser une reunion ou un appel : qui est absent, et ce qui tombe deja a cette heure.
  let slotBusy = $state<{ absents: string[]; conflicts: string[] }>({ absents: [], conflicts: [] });
  let slotRequest = 0;

  $effect(() => {
    const active = (creationModalOpen || !!quickAnchor) && (createType === 'meeting' || createType === 'call');
    const start = selectedStartDate;
    const end = selectedEndDate;
    if (!active || end <= start) {
      slotBusy = { absents: [], conflicts: [] };
      return;
    }
    const request = ++slotRequest;
    const timer = setTimeout(async () => {
      // Six heures avant : une reunion commencee plus tot peut encore couvrir le creneau.
      const data = await fetchStaffCalendarData(new Date(start.getTime() - 6 * 3600000), end).catch(() => null);
      if (request !== slotRequest || !data) return;
      const day = normalize(data);
      const overlaps = (e: CalendarEvent) => e.start < end && (e.end ?? e.start) > start;
      slotBusy = {
        absents: [...new Set(day.absences.filter(a => a.status !== 'REJECTED').map(a => memberName(a.staffMember)))],
        conflicts: [...day.meetings.map(x => toEvent('meeting', x)), ...day.calls.map(x => toEvent('call', x))]
          .filter(overlaps)
          .map(e => `${e.title} (${formatTime(e.start)})`),
      };
    }, 300);
    return () => clearTimeout(timer);
  });

  // ── Reponse a une reunion ───────────────────────────────
  let rsvpExcuseOpen = $state(false);
  let rsvpNote = $state('');
  let rsvpSaving = $state(false);
  const myPresence = (meeting: any): string | null =>
    meeting?.presences?.find((p: any) => p.staffUserId === myStaffRecord?.id)?.status ?? null;

  async function answerMeeting(meetingId: string, status: 'PRESENT' | 'EXCUSED' | 'ABSENT') {
    // S'excuser demande une raison, comme le bouton du message Discord.
    if (status === 'EXCUSED' && !rsvpNote.trim()) {
      rsvpExcuseOpen = true;
      return;
    }
    rsvpSaving = true;
    if (await rsvpMeeting(meetingId, status, status === 'EXCUSED' ? rsvpNote.trim() : undefined)) {
      toast.success(m.planning_rsvp_saved());
      rsvpExcuseOpen = false;
      rsvpNote = '';
      await refreshAll();
    }
    rsvpSaving = false;
  }

  // ── Glisser-deposer ─────────────────────────────────────
  const isMine = (staffId: string | undefined) => !!staffId && staffId === myStaffRecord?.id;
  const canMoveEvent = (e: CalendarEvent) =>
    (e.type === 'meeting' && canManageMeetings && e.raw?.status === 'SCHEDULED')
    || (e.type === 'call' && (canManageSettings || isMine(e.raw?.creatorId)))
    || (e.type === 'task' && (canManageSettings || isMine(e.raw?.assigneeId) || isMine(e.raw?.creatorId)));
  const canResizeEvent = (e: CalendarEvent) => (e.type === 'meeting' || e.type === 'call') && canMoveEvent(e);

  async function handleEventMove(event: CalendarEvent, start: Date, end: Date) {
    peek = null;
    if (event.type === 'meeting' && start.getTime() <= Date.now()) {
      toast.error(m.planning_err_meeting_in_past());
      return;
    }
    const span = { scheduledAt: start.toISOString(), endedAt: end.toISOString() };
    const type = event.type as PlanningType;
    await optimistic(
      () => patchLocal(type, event.id, raw => ({ ...raw, ...(type === 'task' ? { dueDate: span.scheduledAt } : span) })),
      async () => {
        if (type === 'meeting') return updateMeeting(event.id, span);
        if (type === 'call') return updateCall(event.id, span);
        if (type === 'task') return updateTask(event.id, { dueDate: span.scheduledAt });
      },
      err => toast.error(errorMessage(err) || m.planning_err_move()),
    );
  }

  // ── Abonnement iCal ─────────────────────────────────────
  async function openIcal() {
    const link = await fetchPlanningIcalLink().catch(() => null);
    if (!link?.path) return;
    icalUrl = `${API_BASE_URL || window.location.origin}${link.path}`;
    icalOpen = true;
  }

  function copyIcal() {
    void navigator.clipboard.writeText(icalUrl);
    toast.success(m.planning_ical_copied());
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

  /** Ce qui se verifie sans le serveur : l'erreur reste dans le formulaire, encore ouvert. */
  function createFormError(): string {
    if (!formTitle.trim() && createType !== 'absence') return m.planning_err_title_required();
    if (createType === 'meeting') {
      // Un creneau du calendrier peut etre deja passe : le dire ici vaut mieux
      // que le refus brut de Discord.
      if (selectedStartDate.getTime() <= Date.now()) return m.planning_err_meeting_in_past();
      if (selectedEndDate.getTime() <= selectedStartDate.getTime()) return m.meetings_err_end_before_start();
    } else if (createType === 'absence') {
      if (!myStaffRecord) return m.planning_err_not_staff();
      if (!formDescription.trim()) return m.planning_err_absence_reason();
      if (!formSuperiorId) return m.planning_err_superior_required();
      if (selectedEndDate < selectedStartDate) return m.planning_err_end_before_start();
    } else if (createType === 'call') {
      if (!callPermCanCreate) return m.planning_err_no_call_permission();
    } else if (createType === 'server_event') {
      // Discord refuse un evenement planifie dans le passe.
      if (selectedStartDate.getTime() <= Date.now()) return m.planning_err_event_in_past();
      if (selectedEndDate.getTime() <= selectedStartDate.getTime()) return m.meetings_err_end_before_start();
    }
    return '';
  }

  async function handleCreateItem(event?: SubmitEvent) {
    event?.preventDefault();
    formError = createFormError();
    if (formError) return;

    // Tout est lu maintenant : la fenetre se ferme sans attendre le serveur et peut resservir entre-temps.
    const type = createType;
    const title = formTitle.trim();
    const description = formDescription;
    const start = selectedStartDate;
    const end = selectedEndDate;
    const occurrences = repeatDates(start, end, formRepeat, formRepeatCount);
    let drafts: any[] = [];
    let run: () => Promise<unknown>;

    if (type === 'meeting') {
      const timezone = formTimezone;
      drafts = occurrences.map(([s, e]) => ({ title, description, scheduledAt: s.toISOString(), endedAt: e.toISOString(), status: 'SCHEDULED', presences: [] }));
      run = async () => {
        for (const [index, [s, e]] of occurrences.entries()) {
          const ok = await createMeeting(title, description, s.toISOString(), e.toISOString(), timezone);
          // Une occurrence refusee arrete la serie : on dit combien sont deja posees.
          if (!ok) throw new Error(index === 0 ? m.planning_err_create_meeting() : m.planning_err_repeat_partial({ done: index }));
        }
        if (occurrences.length > 1) toast.success(m.planning_repeat_created({ count: occurrences.length }));
      };
    } else if (type === 'absence') {
      const me = myStaffRecord!;
      const payload = {
        staffUserId: me.userId,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        reason: description.trim(),
        type: formAbsenceType,
        superiorUserId: formSuperiorId,
        confirmIndefinite: false,
      };
      drafts = [{ ...payload, staffUserId: me.id, staffMember: me, status: 'PENDING' }];
      run = () => createAbsence(payload);
    } else if (type === 'call') {
      const base = {
        title,
        description,
        channelMode: formChannelMode,
        channelType: formChannelMode === 'CREATE_NEW' ? formChannelType : null,
        discordChannelId: formChannelMode === 'EXISTING' ? formDiscordChannelId : null,
        isTempChannel: formIsTempChannel,
        inviteeUserIds: [...formInviteeUserIds, ...formInviteeMemberIds],
      };
      drafts = occurrences.map(([s]) => ({ title, description, scheduledAt: s.toISOString(), creatorId: myStaffRecord?.id, status: 'SCHEDULED' }));
      run = async () => {
        for (const [index, [s]] of occurrences.entries()) {
          try {
            await createCall({ ...base, scheduledAt: s.toISOString() });
          } catch (err) {
            if (index === 0) throw err;
            throw new Error(m.planning_err_repeat_partial({ done: index }));
          }
        }
        if (occurrences.length > 1) toast.success(m.planning_repeat_created({ count: occurrences.length }));
      };
    } else if (type === 'server_event') {
      // Un evenement Kotbo personnalise, avec son evenement Discord natif : il se retrouve dans la page Evenements.
      const body = JSON.stringify({
        type: 'CUSTOM',
        title,
        description: description || undefined,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        location: formLocation.trim() || undefined,
        createDiscordEvent: true,
      });
      run = async () => {
        const res = await dashboardFetch('/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || m.planning_err_create_generic());
        toast.success(m.planning_server_event_created());
      };
    } else {
      const payload = { title, description, priority: formPriority, dueDate: start.toISOString(), assigneeId: formAssigneeId };
      drafts = [{ ...payload, status: 'PENDING' }];
      run = () => createTask(payload);
    }

    creationModalOpen = false;
    quickAnchor = null;
    const stamp = Date.now();
    let failure = '';
    const ok = await optimistic(
      () => drafts.forEach((d, i) => addLocal(type as PlanningType, { ...d, id: `draft-${stamp}-${i}` })),
      run,
      err => { failure = errorMessage(err) || m.planning_err_create_generic(); },
    );
    // Refuse : la saisie revient telle quelle, avec la raison.
    if (!ok) {
      formError = failure;
      creationModalOpen = true;
    }
  }

  const creatableTypes = $derived<PlanningType[]>([
    ...TYPES.filter(t => t !== 'call' || callPermCanCreate),
    ...(canCreateServerEvent ? (['server_event'] as const) : []),
  ]);

  const typeOptions = $derived<FilterOption<PlanningType>[]>(
    creatableTypes.map(t => ({ value: t, label: TYPE_META[t].label() })),
  );

  const newEventMenu = $derived<MenuItem[]>(
    creatableTypes.map(t => ({
      label: TYPE_META[t].label(),
      icon: TYPE_META[t].icon,
      onselect: () => openFullCreate(t),
    })),
  );

  const moreMenu = $derived<MenuItem[]>([
    ...(myStaffRecord ? [{ label: m.planning_ical_menu(), description: m.planning_ical_menu_desc(), icon: 'link', onselect: () => void openIcal() }] : []),
    {
      label: colorMode === 'type' ? m.planning_color_by_person() : m.planning_color_by_type(),
      icon: 'palette',
      onselect: () => {
        colorMode = colorMode === 'type' ? 'person' : 'type';
        writePref('kotbo.planning.colorMode', colorMode);
      },
    },
    {
      label: showWeekend === 'auto' ? m.planning_weekend_always() : m.planning_weekend_auto(),
      icon: 'calendar-days',
      onselect: () => {
        showWeekend = showWeekend === 'auto' ? 'always' : 'auto';
        writePref('kotbo.planning.weekend', showWeekend);
      },
    },
    ...(isAdmin ? [{ label: m.planning_call_perms_btn(), description: m.planning_call_perms_tooltip(), icon: 'shield', onselect: openPermissionModal }] : []),
  ]);

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
    await optimistic(() => patchLocal('meeting', id, raw => ({ ...raw, status })), () => updateMeeting(id, { status }));
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
      case 'CANCELED': return m.meetings_status_cancelled();
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
    const id = meetingToDeleteId;
    const options = { deleteEvent: deleteDiscordEvent, deleteMessage: deleteDiscordMessage, deleteNotifications: deleteDiscordNotification };
    meetingDeleteModalOpen = false;
    detailModalOpen = false;
    await optimistic(() => patchLocal('meeting', id), () => deleteMeeting(id, options));
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
    const type = event.type as PlanningType;
    detailModalOpen = false;
    await optimistic(
      () => patchLocal(type, event.id),
      async () => {
        if (type === 'absence') return deleteAbsence(event.id);
        if (type === 'call') return deleteCall(event.id);
        if (type === 'task') return deleteTask(event.id);
      },
    );
  }

  async function toggleTaskCompletion(task: any) {
    const nextStatus = task.status === 'COMPLETED' ? 'PENDING' : 'COMPLETED';
    await optimistic(
      () => patchLocal('task', task.id, raw => ({ ...raw, status: nextStatus })),
      () => updateTask(task.id, { status: nextStatus }),
    );
  }

  async function addQuickTask(event: SubmitEvent) {
    event.preventDefault();
    const title = quickTaskTitle.trim();
    if (!title || !myStaffRecord) return;
    const payload = { title, priority: 'MEDIUM' as const, dueDate: null, assigneeId: myStaffRecord.id };
    quickTaskTitle = '';
    const ok = await optimistic(
      () => addLocal('task', { ...payload, id: `draft-${Date.now()}`, status: 'PENDING' }),
      () => createTask(payload),
      err => toast.error(errorMessage(err) || m.planning_err_create_generic()),
    );
    // Refuse : le titre revient dans le champ, sauf si on en a deja tape un autre.
    if (!ok && !quickTaskTitle) quickTaskTitle = title;
  }

  async function decideAbsence(id: string, status: 'APPROVED' | 'REJECTED') {
    const ok = await optimistic(() => patchLocal('absence', id, raw => ({ ...raw, status })), () => updateAbsenceStatus(id, status, undefined));
    if (ok) toast.success(m.planning_absence_decided());
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
    {#if createType === 'meeting' || createType === 'call' || createType === 'server_event'}
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

{#snippet availability()}
  {#if (createType === 'meeting' || createType === 'call') && (slotBusy.absents.length > 0 || slotBusy.conflicts.length > 0)}
    <div class="pl-avail" role="status">
      {#if slotBusy.absents.length > 0}
        <p><Papicon icon="sun" size={13} /> {m.planning_avail_absents({ names: slotBusy.absents.join(', ') })}</p>
      {/if}
      {#if slotBusy.conflicts.length > 0}
        <p><Papicon icon="calendar" size={13} /> {m.planning_avail_conflicts({ items: slotBusy.conflicts.join(', ') })}</p>
      {/if}
    </div>
  {/if}
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

        <!-- Peu de vues, comme Tafac : quatre sur ordinateur, trois sur telephone. -->
        <div class="flex items-center gap-0.5" role="group" aria-label={m.planning_view_aria()} title={m.planning_shortcuts_hint()}>
          {#each $isPhone ? PHONE_VIEWS : CALENDAR_VIEWS as v (v)}
            <button type="button" class="pl-view {calendarView === v ? 'pl-view--active' : ''}" aria-pressed={calendarView === v} onclick={() => (calendarView = v)}>
              <Papicon icon={VIEW_META[v].icon} size={15} />
              <span class="hidden sm:inline">{VIEW_META[v].label()}</span>
              <span class="sr-only sm:hidden">{VIEW_META[v].label()}</span>
            </button>
          {/each}
        </div>

        <div class="ml-auto flex items-center gap-1">
          <div class="pl-search">
            <Papicon icon="search" size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
            <input
              type="search"
              class="input pl-8 py-1.5 text-body-sm"
              bind:value={searchQuery}
              placeholder={m.planning_search_ph()}
              aria-label={m.planning_search_ph()}
              onkeydown={(e) => e.key === 'Escape' && (searchQuery = '')}
            />
          </div>
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

            <details class="pl-left-section" open>
              <summary class="pl-left-title">{m.planning_my_calendars()}</summary>
              <ul>
                {#each STAFF_LAYERS as type (type)}
                  <li>
                    <label class="pl-filter" style="--evt: {EVENT_TYPE_COLOR[type]}" title={type === 'coverage' ? m.planning_coverage_hint({ count: coverageThreshold }) : undefined}>
                      <input type="checkbox" class="pl-check" checked={visibleTypes.includes(type)} onchange={() => toggleType(type)} />
                      <span class="flex-1 text-body-sm text-on-surface">{TYPE_META[type].calendar()}</span>
                      <span class="text-2xs text-on-surface-variant tabular-nums">{typeCounts[type]}</span>
                    </label>
                  </li>
                {/each}
              </ul>
            </details>

            {#if SERVER_TYPES.some(canSeeServerKind)}
              <details class="pl-left-section" open>
                <summary class="pl-left-title">{m.planning_server_section()}</summary>
                <ul>
                  {#each SERVER_TYPES.filter(canSeeServerKind) as type (type)}
                    <li>
                      <label class="pl-filter" style="--evt: {EVENT_TYPE_COLOR[type]}">
                        <input type="checkbox" class="pl-check" checked={visibleTypes.includes(type)} onchange={() => toggleType(type)} />
                        <span class="flex-1 text-body-sm text-on-surface">{TYPE_META[type].calendar()}</span>
                        <span class="text-2xs text-on-surface-variant tabular-nums">{typeCounts[type]}</span>
                      </label>
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}

            <!-- Hauteur naturelle : c'est le volet entier qui defile, sinon la liste etait ecrasee a zero. -->
            <details class="pl-left-section" open>
              <!-- Titre seul sur sa ligne, raccourcis dessous : rien ne passe a la ligne dans un volet etroit. -->
              <summary class="pl-left-title">{m.planning_people()}</summary>
              <div class="flex flex-wrap gap-x-1 mb-1">
                {#if myStaffRecord}
                  <button type="button" class="pl-link" onclick={() => setStaff([myStaffRecord.id])}>{m.planning_only_me()}</button>
                {/if}
                <button type="button" class="pl-link" onclick={() => setStaff(selectedStaffIds.length === activeStaff.length ? [] : activeStaff.map(s => s.id))}>
                  {selectedStaffIds.length === activeStaff.length ? m.planning_select_none() : m.planning_select_all()}
                </button>
              </div>
              {#if activeStaff.length > 8}
                <input type="search" class="input my-1 text-body-sm" bind:value={peopleQuery} placeholder={m.planning_people_search_ph()} aria-label={m.planning_people_search_ph()} />
              {/if}
              <div>
                {#each staffGroups as group (group.grade)}
                  {@const ids = group.members.map(s => s.id)}
                  {@const allIn = ids.every(id => selectedStaffIds.includes(id))}
                  <div class="mt-1">
                    <!-- Un grade entier se coche d'un clic. -->
                    <label class="pl-filter pl-filter--group">
                      <input
                        type="checkbox"
                        class="pl-check"
                        checked={allIn}
                        indeterminate={!allIn && ids.some(id => selectedStaffIds.includes(id))}
                        onchange={() => setStaff(allIn ? selectedStaffIds.filter(id => !ids.includes(id)) : [...new Set([...selectedStaffIds, ...ids])])}
                      />
                      <span class="flex-1 min-w-0 truncate text-2xs font-semibold text-on-surface-variant">{group.grade}</span>
                      <span class="text-2xs text-on-surface-variant tabular-nums">{group.members.length}</span>
                    </label>
                    <ul>
                      {#each group.members as staff (staff.id)}
                        <li>
                          <label class="pl-filter pl-4">
                            <input type="checkbox" class="pl-check" style={colorMode === 'person' ? `--evt: ${personColor(staff.id)}` : ''} checked={selectedStaffIds.includes(staff.id)} onchange={() => toggleStaff(staff.id)} />
                            {@render avatar(staff.avatarUrl, staff.username)}
                            <span class="flex-1 min-w-0 truncate text-body-sm text-on-surface">{memberName(staff)}</span>
                          </label>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/each}
              </div>
            </details>
          </aside>
        {/if}

        <!-- ===== Calendrier ===== -->
        <div class="pl-main">
          {#if loadError}
            <div class="m-3">
              <Callout variant="danger" title={m.planning_load_error()}>
                {#snippet actions()}
                  <Button size="sm" icon="refresh" onclick={refreshAll}>{m.planning_retry()}</Button>
                {/snippet}
              </Callout>
            </div>
          {/if}
          {#if searchQuery.trim()}
            <p class="px-4 py-1.5 text-2xs text-on-surface-variant border-b border-outline-variant">
              {m.planning_search_results({ count: calendarEvents.length, q: searchQuery.trim() })}
            </p>
          {/if}
          <Calendar
            bind:view={calendarView}
            bind:currentDate={calendarCurrentDate}
            events={calendarEvents}
            selectedKey={eventKey(peek?.event)}
            {showWeekend}
            onRangeChange={handleRangeChange}
            onEventClick={handleEventClick}
            onSlotSelect={handleSlotSelect}
            onEventMove={handleEventMove}
            canMove={canMoveEvent}
            canResize={canResizeEvent}
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
                {#if nextUp}
                  <!-- « A suivre » : comme la carte « Prochain cours » de Tafac, aux couleurs du calendrier. -->
                  <button type="button" class="pl-next" style="--evt: {EVENT_TYPE_COLOR[nextUp.type]}" onclick={(e) => handleEventClick(nextUp, e.currentTarget.getBoundingClientRect())}>
                    <span class="text-2xs font-semibold" style="color: var(--evt)">
                      {m.planning_next_title()} · {nextUp.start.getTime() <= Date.now() ? m.planning_next_now() : formatCountdown(nextUp.start)}
                    </span>
                    <span class="block text-base font-semibold text-on-surface truncate">{nextUp.title}</span>
                    <span class="block text-2xs text-on-surface-variant">
                      {formatTime(nextUp.start)}{nextUp.end && !INSTANT_TYPES.includes(nextUp.type) ? ` – ${formatTime(nextUp.end)}` : ''} · {TYPE_META[nextUp.type as PlanningType].label()}
                    </span>
                  </button>
                {/if}
                {#if todayAgenda.length === 0}
                  <p class="px-1 text-body-sm text-on-surface-variant">{m.planning_today_empty()}</p>
                {:else}
                  <ul class="space-y-1">
                    {#each todayAgenda as event (eventKey(event))}
                      <li>
                        <button type="button" class="pl-agenda-item {event.end && event.end.getTime() < Date.now() ? 'opacity-60' : ''}" onclick={(e) => handleEventClick(event, e.currentTarget.getBoundingClientRect())}>
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
                      <input class="input pl-9 text-body-sm" bind:value={quickTaskTitle} maxlength="200" placeholder={m.planning_quick_task_ph()} aria-label={m.planning_add_task()} />
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
    {@render availability()}
    {#if formError}
      <Callout variant="danger">{formError}</Callout>
    {/if}
    <div class="flex items-center justify-between gap-2 pt-1">
      <Button variant="ghost" size="sm" onclick={expandQuickCreate}>{m.planning_quick_more()}</Button>
      <Button variant="primary" size="sm" type="submit">{m.common_save()}</Button>
    </div>
  </form>
</AnchoredPopover>

<!-- ===== Apercu d'un element ===== -->
<AnchoredPopover anchor={peek?.anchor ?? null} onClose={() => (peek = null)} label={peek?.event.title ?? ''} width={360}>
  {#if peek}
    {@const event = peek.event}
    {@const raw = event.raw}
    {@const type = event.type as PlanningType}
    {@const readOnly = isServerKind(type) || type === 'voice' || type === 'coverage'}
    <div class="pl-peek" style="--evt: {event.color ?? EVENT_TYPE_COLOR[type]}">
      <div class="flex items-center justify-end gap-0.5 px-2 pt-2">
        {#if type === 'meeting' && canManageMeetings}
          <Button variant="ghost" size="sm" icon="edit-2" aria-label={m.planning_detail_edit()} title={m.planning_detail_edit()} onclick={() => openEditMeeting(raw)} />
        {/if}
        {#if !readOnly}
          <Button variant="ghost" size="sm" icon="trash-2" aria-label={m.planning_detail_delete()} title={m.planning_detail_delete()} onclick={() => deleteItem(event)} />
        {/if}
        <Button variant="ghost" size="sm" icon="x" aria-label={m.planning_close_aria()} onclick={() => (peek = null)} />
      </div>
      <div class="px-4 pb-4 space-y-3">
        <div class="flex gap-3">
          <span class="pl-peek__square" aria-hidden="true"></span>
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-on-surface wrap-break-word">{event.title}</h3>
            <p class="text-body-sm text-on-surface-variant">
              {formatSpan(event.start, event.end, type)}
              {#if !INSTANT_TYPES.includes(type) && formatDuration(event.start, event.end)}
                <span class="whitespace-nowrap">· {formatDuration(event.start, event.end)}</span>
              {/if}
            </p>
          </div>
        </div>

        {#if type === 'meeting'}
          {@const stats = getAttendanceStats(raw)}
          {@const mine = myPresence(raw)}
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge {MEETING_BADGE[raw.status] ?? 'badge-neutral'}">{formatStatus(raw.status)}</span>
            {#if raw.presences?.length > 0}
              <span class="text-2xs text-on-surface-variant">{m.planning_presences_summary(stats)}</span>
            {/if}
          </div>
          {#if myStaffRecord && (raw.status === 'SCHEDULED' || raw.status === 'IN_PROGRESS')}
            <!-- Sa reponse, comme les boutons du message Discord de la reunion. -->
            <div class="space-y-2">
              <p class="text-2xs text-on-surface-variant">
                {mine ? m.planning_rsvp_current({ status: formatStatus(mine) }) : m.planning_rsvp_question()}
              </p>
              <div class="flex flex-wrap gap-1.5" role="group" aria-label={m.planning_rsvp_question()}>
                {#each [['PRESENT', m.planning_rsvp_present()], ['EXCUSED', m.planning_rsvp_excused()], ['ABSENT', m.planning_rsvp_absent()]] as [value, label] (value)}
                  <button
                    type="button"
                    class="pl-chip {mine === value ? 'pl-chip--active' : ''}"
                    aria-pressed={mine === value}
                    disabled={rsvpSaving}
                    onclick={() => answerMeeting(raw.id, value as 'PRESENT' | 'EXCUSED' | 'ABSENT')}
                  >
                    {label}
                  </button>
                {/each}
              </div>
              {#if rsvpExcuseOpen}
                <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); void answerMeeting(raw.id, 'EXCUSED'); }}>
                  <input class="input flex-1 text-body-sm" bind:value={rsvpNote} maxlength="500" placeholder={m.planning_rsvp_reason_ph()} aria-label={m.planning_rsvp_reason_ph()} />
                  <Button type="submit" size="sm" loading={rsvpSaving} disabled={!rsvpNote.trim()} disabledReason={m.common_reason_fill_field()}>{m.planning_rsvp_send()}</Button>
                </form>
              {/if}
            </div>
          {/if}
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
        {:else if type === 'server_event'}
          {@const status = EVENT_STATUS_LABEL[String(raw.meta.status)]}
          <div class="flex flex-wrap items-center gap-2 text-body-sm text-on-surface-variant">
            {#if status}<span class="badge {status.badge}">{status.label()}</span>{/if}
            {#if raw.meta.interested !== null}<span>{m.planning_event_interested({ count: Number(raw.meta.interested) })}</span>{/if}
          </div>
          {#if raw.meta.location || raw.meta.channelId}
            <p class="flex items-center gap-2 text-body-sm text-on-surface-variant">
              <Papicon icon="map-pin" size={14} />
              {raw.meta.location || `#${channelName(String(raw.meta.channelId))}`}
            </p>
          {/if}
        {:else if type === 'giveaway'}
          <div class="flex flex-wrap items-center gap-2 text-body-sm text-on-surface-variant">
            <span class="badge {raw.meta.ended ? 'badge-success' : 'badge-info'}">{raw.meta.ended ? m.planning_giveaway_ended() : m.planning_giveaway_ends()}</span>
            <span>{m.planning_giveaway_participants({ count: Number(raw.meta.participants), winners: Number(raw.meta.winnerCount) })}</span>
          </div>
        {:else if type === 'schedule'}
          <p class="flex flex-wrap items-center gap-2 text-body-sm text-on-surface-variant">
            <span class="badge badge-neutral">{SCHEDULE_TYPE_LABEL[String(raw.meta.taskType)]?.() ?? raw.meta.taskType}</span>
            {#if raw.meta.channelId}<span>{m.planning_schedule_in_channel({ channel: channelName(String(raw.meta.channelId)) })}</span>{/if}
          </p>
        {:else if type === 'testing_end'}
          <p class="text-body-sm text-on-surface-variant">
            {m.planning_testing_end_desc()}
            {#if raw.meta.targetGrade}· {m.planning_testing_target({ grade: String(raw.meta.targetGrade) })}{/if}
          </p>
          {#if raw.meta.mentor}
            <p class="text-body-sm text-on-surface-variant">{m.planning_testing_mentor({ name: String(raw.meta.mentor) })}</p>
          {/if}
        {:else if type === 'sanction_end'}
          <p class="flex flex-wrap items-center gap-2 text-body-sm text-on-surface-variant">
            <span class="badge badge-danger">{raw.meta.sanctionType === 'TEMP_BAN' ? m.planning_sanction_tempban() : m.planning_sanction_timeout()}</span>
            <span>{m.planning_sanction_end_desc()}</span>
          </p>
        {:else if type === 'voice'}
          <p class="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <Papicon icon="mic" size={14} />
            {raw.channelName ? `#${raw.channelName}` : m.planning_type_voice()}
            {#if !raw.leftAt}<span class="badge badge-success">{m.planning_voice_live()}</span>{/if}
          </p>
        {:else if type === 'coverage'}
          <p class="text-body-sm text-on-surface-variant">{m.planning_coverage_desc({ count: coverageThreshold })}</p>
          <ul class="flex flex-wrap gap-1.5">
            {#each raw.names as name (name)}
              <li class="pl-chip">{name}</li>
            {/each}
          </ul>
        {/if}

        {#if raw.description && type !== 'absence'}
          <p class="text-body-sm text-on-surface-variant line-clamp-3 whitespace-pre-wrap">{raw.description}</p>
        {/if}

        {#if type === 'voice' || type === 'coverage'}
          <!-- Calques deduits : rien a ouvrir ni a modifier. -->
        {:else if isServerKind(type)}
          <p class="text-2xs text-on-surface-variant">{m.planning_extra_readonly()}</p>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" iconRight="arrow-right" href={raw.href}>{SERVER_LINK_LABEL[type]()}</Button>
            {#if raw.externalUrl}
              <Button variant="ghost" size="sm" icon="external-link" href={raw.externalUrl} target="_blank">{m.planning_extra_discord()}</Button>
            {/if}
          </div>
        {:else}
          <Button variant="ghost" size="sm" iconRight="arrow-right" onclick={() => openDetail(event)}>{m.planning_peek_open()}</Button>
        {/if}
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

    {#if createType === 'meeting' || createType === 'call'}
      <div class="flex flex-wrap items-center gap-2 pl-6">
        <Papicon icon="refresh" size={14} class="text-on-surface-variant" />
        <select class="input w-auto text-body-sm" bind:value={formRepeat} aria-label={m.planning_repeat_aria()}>
          <option value="none">{m.planning_repeat_none()}</option>
          <option value="weekly">{m.planning_repeat_weekly()}</option>
          <option value="biweekly">{m.planning_repeat_biweekly()}</option>
          <option value="monthly">{m.planning_repeat_monthly()}</option>
        </select>
        {#if formRepeat !== 'none'}
          <label class="flex items-center gap-2 text-body-sm text-on-surface">
            <input type="number" class="input w-20 text-body-sm" min="2" max={MAX_REPEAT} bind:value={formRepeatCount} />
            {m.planning_repeat_times()}
          </label>
        {/if}
      </div>
    {/if}

    {@render availability()}

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

    {#if createType === 'server_event'}
      <div class="relative">
        <Papicon icon="map-pin" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
        <input class="input pl-9" bind:value={formLocation} maxlength="100" placeholder={m.planning_location_ph()} aria-label={m.planning_location_ph()} />
      </div>
      <p class="text-2xs text-on-surface-variant">{m.planning_server_event_hint()}</p>
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
    <Button variant="primary" type="submit" form="pl-create">{m.common_save()}</Button>
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

<!-- ===== Abonnement iCal ===== -->
<Modal bind:open={icalOpen} title={m.planning_ical_title()} subtitle={m.planning_ical_subtitle()}>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <code class="flex-1 min-w-0 truncate bg-surface-container rounded-lg px-3 py-2 text-2xs font-mono text-on-surface select-all">{icalUrl}</code>
      <Button icon="content_copy" onclick={copyIcal}>{m.recruit_copy_btn()}</Button>
    </div>
    <ul class="space-y-2 text-body-sm text-on-surface-variant">
      <li><strong class="text-on-surface">Google Agenda</strong> · {m.planning_ical_google()}</li>
      <li><strong class="text-on-surface">Outlook</strong> · {m.planning_ical_outlook()}</li>
      <li><strong class="text-on-surface">iPhone</strong> · {m.planning_ical_iphone()}</li>
    </ul>
    <Callout variant="warning">{m.planning_ical_private()}</Callout>
  </div>
  {#snippet footer()}
    <Button variant="primary" onclick={() => (icalOpen = false)}>{m.planning_detail_close()}</Button>
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
    <Button variant="danger" onclick={confirmDeleteMeeting}>{m.planning_detail_delete()}</Button>
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
  /* Sections repliables du volet : depliees par defaut, une fleche indique l'etat. */
  summary.pl-left-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    list-style: none;
    border-radius: 0.25rem;
  }
  summary.pl-left-title::-webkit-details-marker {
    display: none;
  }
  summary.pl-left-title::after {
    content: '';
    width: 0.4rem;
    height: 0.4rem;
    border-right: 1.5px solid var(--color-on-surface-variant);
    border-bottom: 1.5px solid var(--color-on-surface-variant);
    transform: rotate(-45deg);
    transition: transform 0.15s ease;
  }
  details[open] > summary.pl-left-title::after {
    transform: rotate(45deg);
  }
  summary.pl-left-title:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
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
  .pl-search {
    position: relative;
    width: 13rem;
  }
  @media (max-width: 767px) {
    .pl-search {
      width: 8.5rem;
    }
  }
  .pl-filter--group {
    padding-top: 0.125rem;
    padding-bottom: 0.125rem;
  }
  .pl-next {
    display: block;
    width: 100%;
    padding: 0.75rem;
    border-radius: 0.5rem;
    border-left: 4px solid var(--evt);
    background: color-mix(in srgb, var(--evt) 10%, var(--color-surface-container-lowest));
    text-align: left;
  }
  .pl-next:hover {
    background: color-mix(in srgb, var(--evt) 18%, var(--color-surface-container-lowest));
  }
  .pl-avail {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--color-warning) 10%, transparent);
    font-size: 0.75rem;
    color: var(--color-on-surface);
  }
  .pl-avail p {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
  }
</style>
