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
    fetchStaffRoles,
    searchDiscordMembers,
    fetchCallPermissionConfig,
    updateCallPermissionConfig,
    fetchMemberCase,
    createReminder,
    deleteReminder,
  } from '../lib/api';
  import { parseDiscordEmojisAndMarkdown } from '../lib/emojiParser';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import { formatWallClockInTimezone, parseDateTimeInTimezone } from '@kotbo/contracts';
  import TimezoneHint from '../lib/components/TimezoneHint.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Calendar, { EVENT_TYPE_COLOR } from '../lib/components/Calendar.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import DiscordMarkdownEditor from '../lib/components/DiscordMarkdownEditor.svelte';
  import { Button, Callout, Field, FilterPills, Modal, ToggleSwitch, type FilterOption } from '../lib/components/ui';
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

  const TYPE_META: Record<PlanningType, { label: () => string; calendar: () => string; icon: string }> = {
    meeting: { label: m.planning_type_meeting, calendar: m.planning_cal_meetings, icon: 'calendar' },
    call: { label: m.planning_type_call, calendar: m.planning_cal_calls, icon: 'phone' },
    absence: { label: m.planning_type_absence, calendar: m.planning_cal_absences, icon: 'sun' },
    task: { label: m.planning_type_task, calendar: m.planning_cal_tasks, icon: 'check-square' },
  };
  const TYPES: PlanningType[] = ['meeting', 'call', 'absence', 'task'];

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

  // ── Etat ────────────────────────────────────────────────
  let loading = $state(true);
  let allStaff = $state<any[]>([]);
  let allRoles = $state<any[]>([]);
  let calendarData = $state<CalendarData>(emptyCalendarData());
  // Journee en cours pour toute l'equipe, quel que soit le filtre ou la periode affichee.
  let todayData = $state<CalendarData>(emptyCalendarData());
  let userTasks = $state<any[]>([]);

  let calendarView = $state<string>('week');
  let calendarCurrentDate = $state(new Date());

  let selectedStaffIds = $state<string[]>([]);
  let visibleTypes = $state<string[]>([...TYPES]);
  let peopleQuery = $state('');

  let showTaskPanel = $state(true);
  let sidebarCollapsed = $state(false);
  let showDoneTasks = $state(false);
  let quickTaskTitle = $state('');
  let quickTaskSaving = $state(false);

  let creationModalOpen = $state(false);
  let detailModalOpen = $state(false);
  const planningTabs = ['meeting', 'absence', 'call', 'task'] as const;
  // L'onglet de l'URL (/planning/absence...) choisit le type propose par defaut a la creation.
  let currentTab = $state<PlanningType>('meeting');
  let createType = $state<PlanningType>('meeting');

  $effect(() => {
    const _path = $router.path;
    currentTab = resolveTabFromUrl('/planning', planningTabs, 'meeting') as PlanningType;
  });

  let selectedStartDate = $state(new Date());
  let selectedEndDate = $state(new Date(Date.now() + 3600000));
  // Fuseau choisi par l'organisateur pour la reunion en cours de creation ;
  // reset a `null` a chaque ouverture du formulaire.
  let formTimezone = $state<string | null>(null);
  let currentItemDetail = $state<any>(null);

  let formTitle = $state('');
  let formDescription = $state('');
  let formPriority = $state<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  let formAssigneeId = $state('');
  let formSuperiorId = $state('');
  let formAbsenceType = $state('Autre');
  let formChannelMode = $state('CREATE_NEW');
  let formChannelType = $state('VOICE');
  let formDiscordChannelId = $state('');
  let formIsTempChannel = $state(true);
  let formInviteeUserIds = $state<string[]>([]);
  let formError = $state('');
  let saving = $state(false);

  let newReminderTime = $state('');
  let newReminderMessage = $state('');
  let newReminderChannel = $state('DM');

  let memberSearchQuery = $state('');
  let memberSearchResults = $state<any[]>([]);
  let memberSearchLoading = $state(false);
  let memberSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  let formInviteeMemberIds = $state<string[]>([]);
  let selectedMembers = $state<Map<string, any>>(new Map());

  // Qui peut creer des appels
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

  const isAdmin = $derived(authStore.guilds.find(g => g.id === authStore.selectedGuildId)?.accessLevel === 'admin');
  const canManageSettings = $derived(isAdmin || !!dashboardStore.state.access?.canManageSettings);
  const meetingsFeatureAccess = $derived((dashboardStore.state.featureAccess as any)?.meetings || {});
  const canManageMeetings = $derived(canManageSettings || !!meetingsFeatureAccess.canConfigure);
  const canModerateMeetings = $derived(canManageMeetings || !!meetingsFeatureAccess.canModerate);
  const absencesFeatureAccess = $derived((dashboardStore.state.featureAccess as any)?.absences || {});
  const canModerateAbsences = $derived(canManageSettings || !!absencesFeatureAccess.canModerate || !!absencesFeatureAccess.canConfigure);

  // Dossier membre
  let userCaseModalOpen = $state(false);
  let selectedUserIdForCase = $state<string | null>(null);
  let selectedUserNameForCase = $state('');
  let caseData = $state<any>(null);
  let loadingCase = $state(false);
  let caseError = $state('');

  // Suppression de reunion
  let meetingDeleteModalOpen = $state(false);
  let meetingToDeleteId = $state<string | null>(null);
  let deleteDiscordEvent = $state(true);
  let deleteDiscordMessage = $state(false);
  let deleteDiscordNotification = $state(true);
  let deletingMeeting = $state(false);

  // Edition de reunion
  let meetingEditModalOpen = $state(false);
  let editMeetingTitle = $state('');
  let editMeetingDesc = $state('');
  let editMeetingDate = $state('');
  let editMeetingEndDate = $state('');
  let editMeetingError = $state('');
  let editMeetingTimezone = $state<string | null>(null);
  let savingMeetingEdit = $state(false);

  /**
   * Le dossier membre est la fiche de la section Membres : un role a qui le
   * centre de gestion l'a fermee ne doit pas la rouvrir depuis cette page.
   */
  const canOpenMemberCase = $derived(canViewFeature('members'));

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

  // ── Reunions ────────────────────────────────────────────
  async function updateMeetingStatus(id: string, status: string) {
    if (!canModerateMeetings) return;
    try {
      await updateMeeting(id, { status });
      if (currentItemDetail?.id === id) currentItemDetail.raw.status = status;
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

  function openEditMeeting(meeting: any) {
    if (!canManageMeetings) return;
    editMeetingTitle = meeting.title;
    editMeetingDesc = meeting.description || '';
    // Le fuseau est passe explicitement : `formatLocal` suit `activeTimezone`,
    // qui ne bascule sur celui de l'edition qu'une fois la modale marquee comme
    // ouverte - c'est-a-dire apres ces deux lignes. Nommer la zone ici evite de
    // dependre de l'ordre des affectations.
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
      const payload: any = {
        title: editMeetingTitle,
        description: editMeetingDesc,
        scheduledAt: start.toISOString(),
        endedAt: end.toISOString(),
        timezone: editMeetingTimezone,
      };
      if (currentItemDetail?.id) {
        await updateMeeting(currentItemDetail.id, payload);
        meetingEditModalOpen = false;
        currentItemDetail.title = editMeetingTitle;
        currentItemDetail.start = start;
        currentItemDetail.end = end;
        currentItemDetail.raw.title = editMeetingTitle;
        currentItemDetail.raw.description = editMeetingDesc;
        currentItemDetail.raw.scheduledAt = start.toISOString();
        currentItemDetail.raw.endedAt = end.toISOString();
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

  // ── Recherche de membres (invites d'appel, permissions) ─
  async function searchMembers(query: string) {
    if (!query.trim()) {
      memberSearchResults = [];
      return;
    }
    memberSearchLoading = true;
    try {
      const data = await searchDiscordMembers(query, 15);
      memberSearchResults = (data?.members || []).filter(
        (mem: any) => !activeStaff.some(s => s.userId === mem.id) && mem.id !== (authStore.user as any)?.id,
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

  // ── Periode, filtres et evenements ──────────────────────
  let currentRangeStart = new Date();
  let currentRangeEnd = new Date();
  let miniCalDate = $state(new Date());

  const myId = $derived((authStore.user as any)?.id);
  const myStaffRecord = $derived(allStaff.find(s => s.userId === myId));
  const activeStaff = $derived(allStaff.filter(s => !s.blacklistEntries || s.blacklistEntries.length === 0));
  const filteredStaff = $derived.by(() => {
    const q = peopleQuery.trim().toLowerCase();
    return q ? activeStaff.filter(s => `${s.displayName ?? ''} ${s.username ?? ''}`.toLowerCase().includes(q)) : activeStaff;
  });

  const eligibleSuperiors = $derived.by(() => {
    if (!myStaffRecord || allRoles.length === 0) return [];
    const myRole = allRoles.find(r => r.name === myStaffRecord.grade);
    if (!myRole) return activeStaff;
    return activeStaff.filter(s => {
      if (s.userId === myId) return false;
      if (s.testingPeriods && s.testingPeriods.length > 0) return false;
      const sRole = allRoles.find(r => r.name === s.grade);
      if (!sRole) return false;
      return (sRole.sortOrder ?? 0) >= (myRole.sortOrder ?? 0);
    });
  });

  /** Forme commune d'un element du planning, pour le calendrier comme pour les listes. */
  function toEvent(type: PlanningType, raw: any) {
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
    const events: any[] = [];
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

  // Mini calendrier
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  function isToday(date: Date) {
    return isSameDay(date, new Date());
  }

  function isSameDay(a: Date, b: Date) {
    return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  }

  function isOverdue(task: any) {
    return task.dueDate && task.status !== 'COMPLETED' && new Date(task.dueDate).getTime() < Date.now();
  }

  const miniCalDays = $derived.by(() => {
    const year = miniCalDate.getFullYear();
    const month = miniCalDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const offset = firstDay === 0 ? 6 : firstDay - 1;
    const days: { date: Date; isCurrentMonth: boolean }[] = [];
    const prevDays = new Date(year, month, 0).getDate();
    for (let i = offset - 1; i >= 0; i--) days.push({ date: new Date(year, month - 1, prevDays - i), isCurrentMonth: false });
    for (let i = 1; i <= daysInMonth; i++) days.push({ date: new Date(year, month, i), isCurrentMonth: true });
    while (days.length % 7 !== 0) {
      const nextDay = days.length - offset - daysInMonth + 1;
      days.push({ date: new Date(year, month + 1, nextDay), isCurrentMonth: false });
    }
    return days;
  });

  // ── Fuseaux ─────────────────────────────────────────────
  // Fuseau utilise pour lire et rendre les inputs `datetime-local` du formulaire
  // de creation et de la modale d'edition.
  //
  // Seule une reunion porte son propre fuseau, et le selecteur n'apparait que
  // pour ce type-la. Le retenir au-dela ferait lire une absence, un appel ou
  // une tache dans le fuseau d'une reunion creee juste avant, alors que le
  // libelle affiche sous le champ annonce celui du serveur.
  const activeTimezone = $derived(
    meetingEditModalOpen
      ? (editMeetingTimezone ?? timezoneStore.timezone)
      : creationModalOpen && createType === 'meeting'
        ? (formTimezone ?? timezoneStore.timezone)
        : timezoneStore.timezone,
  );
  const formatLocal = (date: Date) => formatWallClockInTimezone(date, activeTimezone);
  const parseLocal = (input: string): Date => parseDateTimeInTimezone(input, activeTimezone) ?? new Date();

  /**
   * Un rappel ne porte pas de fuseau propre : il se lit toujours dans celui du
   * serveur. Il vit hors des deux modales, donc `activeTimezone` ne le decrit
   * pas - c'est ce qui le faisait heriter du fuseau de la derniere reunion.
   */
  const parseServerLocal = (input: string): Date => parseDateTimeInTimezone(input, timezoneStore.timezone) ?? new Date();

  /** Meme heure au mur, relue dans un autre fuseau. */
  function reinterpretWallClock(date: Date, from: string, to: string): Date {
    return parseDateTimeInTimezone(formatWallClockInTimezone(date, from), to) ?? date;
  }

  /**
   * Changer le fuseau reinterprete l'heure affichee, il ne la reecrit pas :
   * declarer une reunion sur Montreal apres avoir tape 15:00 doit donner 15:00
   * a Montreal. Passe par le binding plutot que par un effet sur `formTimezone` :
   * seul un choix explicite dans le selecteur doit deplacer les dates.
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
      const [membersData, rolesData, callPermData] = await Promise.all([
        fetchStaffMembers(),
        fetchStaffRoles(),
        fetchCallPermissionConfig().catch(() => null),
      ]);
      allStaff = membersData?.members || [];
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
    try {
      calendarData = normalize(await fetchStaffCalendarData(currentRangeStart, currentRangeEnd, selectedStaffIds));
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
  }

  /** Relit l'element ouvert apres un rechargement, pour que la fiche suive. */
  function syncDetail() {
    if (!currentItemDetail) return;
    const list = (calendarData as any)[currentItemDetail.type + 's'] as any[] | undefined;
    const updated = list?.find(x => x.id === currentItemDetail.raw.id) || userTasks.find(x => x.id === currentItemDetail.raw.id);
    if (updated) currentItemDetail = { ...currentItemDetail, raw: updated };
  }

  // ── Rappels ─────────────────────────────────────────────
  async function handleAddReminder(event: SubmitEvent) {
    event.preventDefault();
    if (!newReminderTime || !newReminderMessage.trim()) {
      toast.error(m.planning_reminder_required());
      return;
    }
    try {
      const payload: any = {
        message: newReminderMessage,
        targetTime: parseServerLocal(newReminderTime).toISOString(),
        channelId: newReminderChannel === 'CURRENT' ? currentItemDetail.raw.discordChannelId || null : null,
      };
      if (currentItemDetail.type === 'task') payload.taskId = currentItemDetail.raw.id;
      else if (currentItemDetail.type === 'call') payload.callId = currentItemDetail.raw.id;
      else if (currentItemDetail.type === 'meeting') payload.meetingId = currentItemDetail.raw.id;

      await createReminder(payload);
      toast.success(m.planning_reminder_created());
      newReminderMessage = '';
      newReminderTime = '';
      await refreshAll();
      syncDetail();
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
      syncDetail();
    } catch (e) {
      console.error('Failed to delete reminder:', e);
      toast.error(errorMessage(e) || m.planning_reminder_err_delete());
    }
  }

  async function handleRangeChange(start: Date, end: Date) {
    currentRangeStart = start;
    currentRangeEnd = end;
    await refreshCalendar();
  }

  function handleEventClick(event: any) {
    currentItemDetail = event;
    newReminderMessage = '';
    newReminderTime = '';
    detailModalOpen = true;
  }

  /**
   * Creneau propose a l'ouverture du formulaire : une heure d'avance. Partir
   * de l'instant d'ouverture laissait passer l'heure le temps de saisir un
   * titre, et Discord refuse un evenement planifie dans le passe.
   */
  function defaultStart(): Date {
    return new Date(Date.now() + 3600000);
  }

  function openCreateModal(start: Date, end?: Date, type: PlanningType = currentTab) {
    createType = type === 'call' && !callPermCanCreate ? 'meeting' : type;
    selectedStartDate = start;
    selectedEndDate = end || new Date(start.getTime() + 3600000);
    formTitle = '';
    formDescription = '';
    formTimezone = null;
    formPriority = 'MEDIUM';
    formAssigneeId = myStaffRecord?.id || '';
    formSuperiorId = eligibleSuperiors[0]?.userId || '';
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
    creationModalOpen = true;
  }

  function setDuration(minutes: number) {
    selectedEndDate = new Date(selectedStartDate.getTime() + minutes * 60000);
  }

  const durationMinutes = $derived(Math.round((selectedEndDate.getTime() - selectedStartDate.getTime()) / 60000));

  async function handleCreateItem(event?: SubmitEvent) {
    event?.preventDefault();
    if (!formTitle && createType !== 'absence') {
      formError = m.planning_err_title_required();
      return;
    }
    saving = true;
    formError = '';

    try {
      if (createType === 'meeting') {
        // Un creneau du calendrier peut lui aussi etre deja passe. Le dire ici
        // vaut mieux que de laisser remonter le refus brut de Discord.
        if (selectedStartDate.getTime() <= Date.now()) {
          formError = m.planning_err_meeting_in_past();
          return;
        }
        if (selectedEndDate.getTime() <= selectedStartDate.getTime()) {
          formError = m.meetings_err_end_before_start();
          return;
        }
        const ok = await createMeeting(formTitle, formDescription, selectedStartDate.toISOString(), selectedEndDate.toISOString(), formTimezone);
        if (!ok) throw new Error(m.planning_err_create_meeting());
      } else if (createType === 'absence') {
        if (!myStaffRecord) { formError = m.planning_err_not_staff(); return; }
        if (!formDescription.trim()) { formError = m.planning_err_absence_reason(); return; }
        if (!formSuperiorId) { formError = m.planning_err_superior_required(); return; }
        if (selectedEndDate && selectedEndDate < selectedStartDate) { formError = m.planning_err_end_before_start(); return; }
        await createAbsence({
          staffUserId: myStaffRecord.userId,
          startDate: selectedStartDate.toISOString(),
          endDate: selectedEndDate ? selectedEndDate.toISOString() : undefined,
          reason: formDescription.trim(),
          type: formAbsenceType,
          superiorUserId: formSuperiorId,
          confirmIndefinite: !selectedEndDate,
        });
      } else if (createType === 'call') {
        if (!callPermCanCreate) { formError = m.planning_err_no_call_permission(); return; }
        await createCall({
          title: formTitle,
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
          title: formTitle,
          description: formDescription,
          priority: formPriority,
          dueDate: selectedStartDate ? selectedStartDate.toISOString() : null,
          assigneeId: formAssigneeId,
        });
      }

      creationModalOpen = false;
      await refreshAll();
    } catch (err) {
      console.error(err);
      formError = errorMessage(err) || m.planning_err_create_generic();
    } finally {
      saving = false;
    }
  }

  // ── Taches ──────────────────────────────────────────────
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

  async function toggleTaskCompletion(task: any) {
    const nextStatus = task.status === 'COMPLETED' ? 'PENDING' : 'COMPLETED';
    try {
      await updateTask(task.id, { status: nextStatus });
      if (currentItemDetail?.raw?.id === task.id) currentItemDetail.raw.status = nextStatus;
      await refreshAll();
    } catch (e) {
      console.error(e);
    }
  }

  // ── Absences ────────────────────────────────────────────
  async function decideAbsence(status: 'APPROVED' | 'REJECTED') {
    const id = currentItemDetail?.raw?.id;
    if (!id) return;
    if (await updateAbsenceStatus(id, status, undefined)) {
      toast.success(m.planning_absence_decided());
      currentItemDetail.raw.status = status;
      await refreshAll();
    }
  }

  async function handleDeleteDetail() {
    if (!currentItemDetail) return;
    const { id, type } = currentItemDetail;
    if (type === 'meeting') {
      meetingToDeleteId = id;
      deleteDiscordEvent = true;
      deleteDiscordMessage = false;
      deleteDiscordNotification = true;
      meetingDeleteModalOpen = true;
      return;
    }
    if (!(await confirmDialog.danger(m.planning_confirm_delete_item()))) return;
    try {
      if (type === 'absence') await deleteAbsence(id);
      else if (type === 'call') await deleteCall(id);
      else if (type === 'task') await deleteTask(id);
      detailModalOpen = false;
      await refreshAll();
    } catch (e) {
      console.error(e);
    }
  }

  function toggleType(type: string) {
    visibleTypes = visibleTypes.includes(type) ? visibleTypes.filter(t => t !== type) : [...visibleTypes, type];
  }

  function toggleStaff(staffId: string) {
    selectedStaffIds = selectedStaffIds.includes(staffId) ? selectedStaffIds.filter(id => id !== staffId) : [...selectedStaffIds, staffId];
    void refreshCalendar();
  }

  function toggleEveryone() {
    selectedStaffIds = selectedStaffIds.length === activeStaff.length ? [] : activeStaff.map(s => s.id);
    void refreshCalendar();
  }

  function onlyMe() {
    if (!myStaffRecord) return;
    selectedStaffIds = [myStaffRecord.id];
    void refreshCalendar();
  }

  const typeOptions = $derived<FilterOption<PlanningType>[]>(
    (['meeting', 'call', 'absence', 'task'] as PlanningType[])
      .filter(t => t !== 'call' || callPermCanCreate)
      .map(t => ({ value: t, label: TYPE_META[t].label() })),
  );

  const formatTime = (date: Date) => date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  const memberName = (x: any) => x?.displayName || x?.username || m.planning_member_fallback();

  onMount(() => {
    const handleDashboardRefresh = () => loadData();
    window.addEventListener('kotbo-dashboard-refresh-request', handleDashboardRefresh);
    // Fuseau du serveur avant loadData : les formulaires seedent sinon leurs
    // dates en heure navigateur, puis basculent au chargement du store.
    void timezoneStore.ensureLoaded();
    void loadData();
    return () => window.removeEventListener('kotbo-dashboard-refresh-request', handleDashboardRefresh);
  });
</script>

{#snippet typeDot(type: string)}
  <span class="pl-dot" style="--evt: {EVENT_TYPE_COLOR[type]}" aria-hidden="true"></span>
{/snippet}

{#snippet avatar(src: string | null | undefined, name: string, size = 'w-6 h-6')}
  <img src={src || localInitialAvatar(name)} alt="" class="{size} rounded-full shrink-0" />
{/snippet}

<ModulePage title={m.planning_page_title()} description={m.planning_page_desc()} icon="calendar" featureKey="absences">
  {#snippet actions()}
    <RefreshButton onClick={refreshAll} {loading} label={m.planning_refresh()} />
    <Button variant={showTaskPanel ? 'secondary' : 'ghost'} icon="sun" aria-pressed={showTaskPanel} onclick={() => (showTaskPanel = !showTaskPanel)}>
      {m.planning_my_day()}
      {#if pendingTasks.length > 0}
        <span class="badge badge-info ml-1">{pendingTasks.length}</span>
      {/if}
    </Button>
    {#if isAdmin}
      <Button variant="ghost" icon="shield" title={m.planning_call_perms_tooltip()} onclick={openPermissionModal}>{m.planning_call_perms_btn()}</Button>
    {/if}
    <Button variant="primary" icon="plus" onclick={() => openCreateModal(defaultStart())}>{m.planning_new_event()}</Button>
  {/snippet}

  {#if loading && allStaff.length === 0}
    <div class="flex flex-col xl:flex-row gap-4">
      <Skeleton height="560px" radius="1rem" width="w-full xl:w-60" />
      <Skeleton height="560px" radius="1rem" />
    </div>
  {:else}
    <div class="flex flex-col xl:flex-row gap-4">
      <!-- ===== Colonne gauche : mini calendrier, calendriers, personnes ===== -->
      <aside class="w-full flex flex-col gap-4 shrink-0 {sidebarCollapsed ? 'xl:w-10' : 'xl:w-64'}">
        {#if !sidebarCollapsed}
          <section class="section-card p-4">
            <div class="flex items-center justify-between mb-2">
              <Button variant="ghost" size="sm" icon="chevron-left" aria-label={m.cal_prev()} onclick={() => (miniCalDate = new Date(miniCalDate.getFullYear(), miniCalDate.getMonth() - 1, 1))} />
              <span class="text-body-sm font-semibold text-on-surface">
                {capitalize(miniCalDate.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }))}
              </span>
              <Button variant="ghost" size="sm" icon="chevron-right" aria-label={m.cal_next()} onclick={() => (miniCalDate = new Date(miniCalDate.getFullYear(), miniCalDate.getMonth() + 1, 1))} />
            </div>
            <div class="grid grid-cols-7 text-center">
              {#each [m.planning_weekday_mon(), m.planning_weekday_tue(), m.planning_weekday_wed(), m.planning_weekday_thu(), m.planning_weekday_fri(), m.planning_weekday_sat(), m.planning_weekday_sun()] as day, i (i)}
                <span class="text-2xs font-semibold text-on-surface-variant py-1">{day}</span>
              {/each}
              {#each miniCalDays as { date, isCurrentMonth } (date.toDateString())}
                <button
                  type="button"
                  onclick={() => (calendarCurrentDate = new Date(date))}
                  aria-label={date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long' })}
                  class="pl-mini-day {isCurrentMonth ? 'text-on-surface' : 'text-on-surface-variant opacity-40'} {isToday(date) ? 'pl-mini-day--today' : ''} {isSameDay(date, calendarCurrentDate) && !isToday(date) ? 'pl-mini-day--selected' : ''}"
                >
                  {date.getDate()}
                </button>
              {/each}
            </div>
          </section>

          <section class="section-card p-4">
            <h3 class="text-body-sm font-semibold text-on-surface mb-2">{m.planning_my_calendars()}</h3>
            <ul class="flex flex-col gap-0.5">
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

          <section class="section-card p-4">
            <div class="flex items-center justify-between gap-2 mb-2">
              <h3 class="text-body-sm font-semibold text-on-surface">{m.planning_people()}</h3>
              <div class="flex gap-1">
                {#if myStaffRecord}
                  <Button variant="ghost" size="sm" onclick={onlyMe}>{m.planning_only_me()}</Button>
                {/if}
                <Button variant="ghost" size="sm" onclick={toggleEveryone}>
                  {selectedStaffIds.length === activeStaff.length ? m.planning_select_none() : m.planning_select_all()}
                </Button>
              </div>
            </div>
            {#if activeStaff.length > 8}
              <input type="search" class="input mb-2 text-body-sm" bind:value={peopleQuery} placeholder={m.planning_people_search_ph()} aria-label={m.planning_people_search_ph()} />
            {/if}
            <ul class="flex flex-col gap-0.5 max-h-64 overflow-y-auto pr-1">
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
        {/if}

        <Button
          variant="ghost"
          size="sm"
          class="hidden xl:inline-flex"
          icon={sidebarCollapsed ? 'chevrons-right' : 'chevrons-left'}
          aria-label={sidebarCollapsed ? m.planning_sidebar_expand() : m.planning_sidebar_collapse()}
          onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
        />
      </aside>

      <!-- ===== Calendrier ===== -->
      <main class="flex-1 min-w-0 space-y-2">
        <Calendar
          bind:view={calendarView}
          bind:currentDate={calendarCurrentDate}
          events={calendarEvents}
          onRangeChange={handleRangeChange}
          onEventClick={handleEventClick}
          onDateClick={(start: any, end: any) => openCreateModal(start, end)}
        />
        <p class="hidden md:block text-2xs text-on-surface-variant">{m.planning_shortcuts_hint()}</p>
      </main>

      <!-- ===== Ma journee ===== -->
      {#if showTaskPanel}
        <aside class="w-full xl:w-80 shrink-0">
          <div class="section-card flex flex-col xl:max-h-[75vh] overflow-hidden">
            <header class="px-4 py-3 border-b border-outline-variant flex items-center justify-between">
              <div>
                <h2 class="text-body-sm font-semibold text-on-surface">{m.planning_my_day()}</h2>
                <p class="text-2xs text-on-surface-variant">
                  {capitalize(new Date().toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' }))}
                </p>
              </div>
              <Button variant="ghost" size="sm" icon="x" aria-label={m.planning_close_aria()} onclick={() => (showTaskPanel = false)} />
            </header>

            <div class="flex-1 overflow-y-auto px-4 py-3 space-y-5">
              <section>
                <h3 class="pl-section-title">{m.planning_today_title()}</h3>
                {#if todayAgenda.length === 0}
                  <p class="text-2xs text-on-surface-variant">{m.planning_today_empty()}</p>
                {:else}
                  <ul class="space-y-1">
                    {#each todayAgenda as event (event.type + event.id)}
                      <li>
                        <button type="button" class="pl-row" onclick={() => handleEventClick(event)}>
                          <span class="w-11 shrink-0 text-2xs font-medium text-on-surface-variant tabular-nums">{formatTime(event.start)}</span>
                          {@render typeDot(event.type)}
                          <span class="flex-1 min-w-0 truncate text-body-sm text-on-surface {event.end.getTime() < Date.now() ? 'opacity-60' : ''}">{event.title}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>

              {#if absentToday.length > 0}
                <section>
                  <h3 class="pl-section-title">{m.planning_absent_today()} · {absentToday.length}</h3>
                  <ul class="space-y-1">
                    {#each absentToday as absence (absence.id)}
                      <li>
                        <button type="button" class="pl-row" onclick={() => handleEventClick(toEvent('absence', absence))}>
                          {@render avatar(absence.staffMember?.avatarUrl, absence.staffMember?.username ?? '', 'w-5 h-5')}
                          <span class="flex-1 min-w-0 truncate text-body-sm text-on-surface">{memberName(absence.staffMember)}</span>
                          <span class="text-2xs text-on-surface-variant truncate max-w-24">{absence.type || ''}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                </section>
              {/if}

              <section>
                <h3 class="pl-section-title">{m.planning_my_tasks()} · {pendingTasks.length}</h3>
                {#if myStaffRecord}
                  <form class="mb-2" onsubmit={addQuickTask}>
                    <input
                      class="input text-body-sm"
                      bind:value={quickTaskTitle}
                      maxlength="200"
                      disabled={quickTaskSaving}
                      placeholder={m.planning_quick_task_ph()}
                      aria-label={m.planning_add_task()}
                    />
                  </form>
                {/if}
                {#if pendingTasks.length === 0}
                  <p class="text-2xs text-on-surface-variant">{m.planning_no_task()} · {m.planning_day_free()}</p>
                {:else}
                  <ul class="space-y-0.5">
                    {#each pendingTasks as task (task.id)}
                      {@render taskRow(task)}
                    {/each}
                  </ul>
                {/if}
                {#if doneTasks.length > 0}
                  <button type="button" class="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-on-surface-variant hover:text-on-surface" aria-expanded={showDoneTasks} onclick={() => (showDoneTasks = !showDoneTasks)}>
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
                {/if}
              </section>
            </div>

            <footer class="px-4 py-2 border-t border-outline-variant">
              <Button variant="ghost" size="sm" icon="plus" fullWidth onclick={() => openCreateModal(defaultStart(), undefined, 'task')}>{m.planning_add_task()}</Button>
            </footer>
          </div>
        </aside>
      {/if}
    </div>
  {/if}
</ModulePage>

{#snippet taskRow(task: any)}
  <li class="flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-surface-container">
    <input
      type="checkbox"
      class="pl-check mt-0.5"
      style="--evt: {EVENT_TYPE_COLOR.task}"
      checked={task.status === 'COMPLETED'}
      onchange={() => toggleTaskCompletion(task)}
      aria-label={task.status === 'COMPLETED' ? m.planning_task_mark_todo() : m.planning_task_mark_done()}
    />
    <button type="button" class="flex-1 min-w-0 text-left" onclick={() => handleEventClick(toEvent('task', task))}>
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

<!-- ===== Creation ===== -->
<Modal bind:open={creationModalOpen} title={m.planning_new_event()} size="lg">
  <form id="pl-create" class="space-y-4" onsubmit={handleCreateItem}>
    <FilterPills label={m.planning_type_aria()} options={typeOptions} value={createType} onchange={(v) => { createType = v; formError = ''; }} />

    {#if createType !== 'absence'}
      <input class="input text-base font-semibold" bind:value={formTitle} placeholder={m.planning_title_ph()} aria-label={m.planning_title_ph()} />
    {/if}

    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <Papicon icon="clock" size={16} class="text-on-surface-variant shrink-0" />
        <input
          type="datetime-local"
          class="input w-auto"
          aria-label={m.meetings_field_start_label()}
          value={formatLocal(selectedStartDate)}
          onchange={(e) => {
            const duration = selectedEndDate.getTime() - selectedStartDate.getTime();
            selectedStartDate = parseLocal((e.target as HTMLInputElement).value);
            // Deplacer le debut garde la duree, comme dans un agenda.
            if (duration > 0) selectedEndDate = new Date(selectedStartDate.getTime() + duration);
          }}
        />
        {#if createType !== 'task'}
          <span class="text-on-surface-variant">–</span>
          <input
            type="datetime-local"
            class="input w-auto"
            aria-label={m.meetings_field_end_label()}
            value={formatLocal(selectedEndDate)}
            onchange={(e) => (selectedEndDate = parseLocal((e.target as HTMLInputElement).value))}
          />
        {/if}
      </div>
      {#if createType === 'meeting' || createType === 'call'}
        <div class="flex flex-wrap items-center gap-1.5 pl-6" role="group" aria-label={m.planning_duration()}>
          {#each [30, 60, 120] as minutes (minutes)}
            <button
              type="button"
              class="pl-chip {durationMinutes === minutes ? 'pl-chip--active' : ''}"
              aria-pressed={durationMinutes === minutes}
              onclick={() => setDuration(minutes)}
            >
              {minutes === 30 ? m.planning_duration_30() : minutes === 60 ? m.planning_duration_60() : m.planning_duration_120()}
            </button>
          {/each}
        </div>
      {/if}
      {#if timezoneStore.loaded && createType === 'meeting'}
        <div class="pl-6">
          <TimezoneHint bind:value={() => formTimezone, (zone) => applyFormTimezone(zone)} />
        </div>
      {:else if timezoneStore.loaded}
        <p class="pl-6 text-2xs text-on-surface-variant">
          {#if timezoneStore.differsFromBrowser}
            {m.planning_datetime_hint_diff({ server: timezoneStore.timezone, browser: timezoneStore.browserTimezone })}
          {:else}
            {m.planning_datetime_hint_same({ zone: timezoneStore.timezone })}
          {/if}
        </p>
      {/if}
    </div>

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
        <SearchableSelect
          bind:value={formSuperiorId}
          options={eligibleSuperiors.map(s => ({ id: s.userId, name: memberName(s) }))}
          placeholder={m.planning_superior_ph()}
          showId={false}
          className="w-full"
        />
      </div>
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
              <button
                type="button"
                class="pl-chip {on ? 'pl-chip--active' : ''}"
                aria-pressed={on}
                onclick={() => (formInviteeUserIds = on ? formInviteeUserIds.filter(id => id !== staff.id) : [...formInviteeUserIds, staff.id])}
              >
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
        <SearchableSelect
          bind:value={formAssigneeId}
          options={activeStaff.map(s => ({ id: s.id, name: memberName(s) }))}
          placeholder={m.planning_assign_ph()}
          showId={false}
          className="w-full"
        />
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

<!-- ===== Fiche d'un element ===== -->
<Modal open={detailModalOpen && !!currentItemDetail} onClose={() => (detailModalOpen = false)} title={currentItemDetail?.title ?? ''} size="md">
  {#if currentItemDetail}
    {@const raw = currentItemDetail.raw}
    {@const type = currentItemDetail.type as PlanningType}
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-on-surface-variant">
        <span class="inline-flex items-center gap-1.5 font-medium text-on-surface">{@render typeDot(type)} {TYPE_META[type]?.label() ?? type}</span>
        <span class="inline-flex items-center gap-1.5">
          <Papicon icon="clock" size={14} />
          {new Date(currentItemDetail.start).toLocaleString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          {#if currentItemDetail.end && type !== 'task'}
            – {new Date(currentItemDetail.end).toLocaleString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}
          {/if}
        </span>
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
          {#if canModerateMeetings}
            {#if raw.status === 'SCHEDULED'}
              <Button size="sm" icon="play" onclick={() => updateMeetingStatus(currentItemDetail.id, 'IN_PROGRESS')}>{m.meetings_start_btn()}</Button>
            {:else if raw.status === 'IN_PROGRESS'}
              <Button size="sm" icon="check" onclick={() => updateMeetingStatus(currentItemDetail.id, 'COMPLETED')}>{m.meetings_finish_btn()}</Button>
            {/if}
          {/if}
        </div>
        <dl class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-lg bg-surface-container p-2"><dt class="text-2xs text-on-surface-variant">{m.meetings_stat_present()}</dt><dd class="text-base font-semibold text-success">{stats.present}</dd></div>
          <div class="rounded-lg bg-surface-container p-2"><dt class="text-2xs text-on-surface-variant">{m.meetings_stat_excused()}</dt><dd class="text-base font-semibold text-warning">{stats.excused}</dd></div>
          <div class="rounded-lg bg-surface-container p-2"><dt class="text-2xs text-on-surface-variant">{m.meetings_stat_absent()}</dt><dd class="text-base font-semibold text-error">{stats.absent}</dd></div>
        </dl>
        {#if raw.presences?.length > 0}
          <div>
            <h4 class="pl-section-title">{m.meetings_presence_list_title()}</h4>
            <ul class="max-h-56 overflow-y-auto divide-y divide-outline-variant">
              {#each raw.presences as presence (presence.id ?? presence.staffUserId)}
                <li class="flex items-center gap-2.5 py-2">
                  <button
                    type="button"
                    class="flex items-center gap-2.5 min-w-0 flex-1 text-left hover:text-primary disabled:hover:text-on-surface"
                    disabled={!canOpenMemberCase}
                    onclick={() => openMemberCase(presence.staffUserId, memberName(presence.staffMember))}
                  >
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
              <span class="pl-chip">
                {@render avatar(invitee.staffMember?.avatarUrl, memberName(invitee.staffMember), 'w-4 h-4')}
                {memberName(invitee.staffMember)}
              </span>
            {/each}
          </div>
        {/if}
      {/if}

      {#if type === 'task'}
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge {raw.priority === 'HIGH' ? 'badge-danger' : raw.priority === 'MEDIUM' ? 'badge-warning' : 'badge-neutral'}">{PRIORITY_LABEL[raw.priority]?.() ?? raw.priority}</span>
          <span class="badge {raw.status === 'COMPLETED' ? 'badge-success' : 'badge-info'}">{TASK_STATUS_LABEL[raw.status]?.() ?? raw.status}</span>
          {#if raw.assignee}
            <span class="inline-flex items-center gap-1.5 text-body-sm text-on-surface">
              {@render avatar(raw.assignee.avatarUrl, memberName(raw.assignee), 'w-5 h-5')}
              {memberName(raw.assignee)}
            </span>
          {/if}
        </div>
        <Button size="sm" icon={raw.status === 'COMPLETED' ? 'rotate-ccw' : 'check'} onclick={() => toggleTaskCompletion(raw)}>
          {raw.status === 'COMPLETED' ? m.planning_task_mark_todo() : m.planning_task_mark_done()}
        </Button>
      {/if}

      {#if type === 'absence'}
        {@const status = ABSENCE_STATUS[raw.status]}
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex items-center gap-2 text-body-sm font-medium text-on-surface">
            {@render avatar(currentItemDetail.avatarUrl, currentItemDetail.staffName || raw.staffMember?.username || '', 'w-7 h-7')}
            {currentItemDetail.staffName || raw.staffMember?.username || m.planning_unknown_member()}
          </span>
          <span class="badge badge-neutral">{raw.type || m.planning_absence_type_default()}</span>
          <span class="badge {status?.badge ?? 'badge-neutral'}">{status?.label() ?? raw.status}</span>
        </div>
        {#if canModerateAbsences && (raw.status === 'PENDING' || raw.status === 'ACKNOWLEDGED')}
          <div class="flex gap-2">
            <Button size="sm" variant="primary" icon="check" onclick={() => decideAbsence('APPROVED')}>{m.planning_absence_approve()}</Button>
            <Button size="sm" variant="danger" icon="x" onclick={() => decideAbsence('REJECTED')}>{m.planning_absence_reject()}</Button>
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
    <Button variant="ghost" icon="trash-2" class="mr-auto text-error" onclick={handleDeleteDetail}>{m.planning_detail_delete()}</Button>
    {#if currentItemDetail?.type === 'meeting' && canManageMeetings}
      <Button icon="edit-2" onclick={() => openEditMeeting(currentItemDetail.raw)}>{m.planning_detail_edit()}</Button>
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
              <button type="button" class="pl-chip {permRoleIds.includes(role.id) ? 'pl-chip--active' : ''}" aria-pressed={permRoleIds.includes(role.id)} onclick={() => togglePermRole(role.id)}>
                @{role.name}
              </button>
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
  .pl-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    flex-shrink: 0;
    background: var(--evt);
  }
  .pl-check {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    accent-color: var(--evt, var(--color-primary));
  }
  .pl-filter {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    cursor: pointer;
  }
  .pl-filter:hover,
  .pl-row:hover {
    background: var(--color-surface-container);
  }
  .pl-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    text-align: left;
  }
  .pl-section-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-on-surface);
    margin-bottom: 0.5rem;
  }
  .pl-mini-day {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    font-size: 0.75rem;
  }
  .pl-mini-day:hover {
    background: var(--color-surface-container-high);
  }
  .pl-mini-day--today {
    background: var(--color-primary);
    color: var(--color-on-primary);
    font-weight: 600;
  }
  .pl-mini-day--today:hover {
    background: var(--color-primary);
  }
  .pl-mini-day--selected {
    box-shadow: inset 0 0 0 1.5px var(--color-primary);
    color: var(--color-primary);
    font-weight: 600;
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
    transition: background-color 0.15s ease, border-color 0.15s ease;
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
