/** Tutorat. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type TutoringMember = {
  id: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  grade: string;
};

export type TutoringStatus = 'ONGOING' | 'PASSED' | 'FAILED';
export type TutoringObjectiveState = 'UNCHECKED' | 'KNOWN' | 'ACQUIRED';
export type TutoringReportType = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
export type TutoringRole = 'manager' | 'mentor' | 'apprentice';

export type TutoringSummary = {
  id: string;
  status: TutoringStatus;
  startDate: string;
  endDate: string | null;
  plannedDurationDays: number;
  targetGrade: string | null;
  hierarchyId: string | null;
  notes: string | null;
  doingListId: string | null;
  apprentice: TutoringMember;
  mentor: TutoringMember | null;
  daysElapsed: number;
  progress: { total: number; acquired: number; learning: number };
  reports: number;
  lastReportAt: string | null;
  nextReportAt: string | null;
  reportOverdue: boolean;
};

export type TutoringDetail = TutoringSummary & {
  objectives: Array<{ id: string; category: string; title: string; description: string | null; state: TutoringObjectiveState; completedAt: string | null }>;
  reports: Array<{ id: string; type: TutoringReportType; content: string; createdAt: string; author: TutoringMember }>;
  logs: Array<{ id: string; content: string; date: string }>;
  absences: Array<{ id: string; startDate: string; endDate: string | null; isIndefinite: boolean; reason: string; status: string }>;
  vocalStats: { voiceTimeSeconds: number; voiceSessionCount: number } | null;
  missions: {
    list: { id: string; name: string; key: string };
    items: Array<{ id: string; key: string; title: string; dueDate: string | null; column: string; done: boolean; assignedToApprentice: boolean }>;
  } | null;
  readiness: Array<{ key: 'duration' | 'objectives' | 'reports'; ok: boolean; blocking: boolean; value: number; target: number }>;
  config: { minTestDays: number; reportIntervalDays: number };
};

export type TutoringOverview = {
  canManage: boolean;
  isTutor: boolean;
  mine: TutoringSummary | null;
  mentoring: TutoringSummary[];
  all: TutoringSummary[];
  config: { minTestDays: number; reportIntervalDays: number };
};

export type TutoringCandidates = {
  members: Array<TutoringMember & { isTutor: boolean; inTutoring: boolean }>;
  hierarchies: Array<{ id: string; name: string }>;
  grades: Array<{ name: string; hierarchyId: string | null }>;
};

export type TutoringItem = {
  id: string;
  category: string;
  title: string;
  description: string | null;
  sortOrder: number;
  hierarchyId: string | null;
  grade: string | null;
};

export type TutoringConfig = {
  reportIntervalDays: number;
  reminderDaysBefore: number;
  minTestDays: number;
  showVocalActivity: boolean;
  showAbsences: boolean;
};

type PeriodResponse = { period: TutoringDetail; role: TutoringRole };

export async function fetchTutoringOverview(guildId = authStore.selectedGuildId): Promise<TutoringOverview> {
  return dashboardRequest('/tutoring/overview', { method: 'GET', guildId });
}

export async function fetchTutoringCandidates(guildId = authStore.selectedGuildId): Promise<TutoringCandidates> {
  return dashboardRequest('/tutoring/candidates', { method: 'GET', guildId });
}

export async function fetchTutoringPeriod(periodId: string, guildId = authStore.selectedGuildId): Promise<PeriodResponse> {
  return dashboardRequest(`/tutoring/periods/${periodId}`, { method: 'GET', guildId });
}

export async function createTutoring(
  payload: { staffMemberId: string; mentorId?: string | null; plannedDurationDays: number; targetGrade?: string | null; hierarchyId?: string | null; withMissions: boolean },
  guildId = authStore.selectedGuildId,
): Promise<{ period: TutoringDetail }> {
  return dashboardRequest('/tutoring/periods', { method: 'POST', payload, guildId });
}

export async function updateTutoring(
  periodId: string,
  payload: { mentorId?: string | null; plannedDurationDays?: number; targetGrade?: string | null; hierarchyId?: string | null },
  guildId = authStore.selectedGuildId,
): Promise<PeriodResponse> {
  return dashboardRequest(`/tutoring/periods/${periodId}`, { method: 'PATCH', payload, guildId });
}

export async function deleteTutoring(periodId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/tutoring/periods/${periodId}`, { method: 'DELETE', guildId });
}

export async function createTutoringMissionsBoard(periodId: string, guildId = authStore.selectedGuildId): Promise<PeriodResponse> {
  return dashboardRequest(`/tutoring/periods/${periodId}/missions-board`, { method: 'POST', guildId });
}

export async function setTutoringObjective(periodId: string, itemId: string, state: TutoringObjectiveState, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/tutoring/periods/${periodId}/objectives/${itemId}`, { method: 'PUT', payload: { state }, guildId });
}

export async function addTutoringReport(periodId: string, type: TutoringReportType, content: string, guildId = authStore.selectedGuildId): Promise<PeriodResponse> {
  return dashboardRequest(`/tutoring/periods/${periodId}/reports`, { method: 'POST', payload: { type, content }, guildId });
}

export async function addTutoringLog(periodId: string, content: string, guildId = authStore.selectedGuildId): Promise<{ log: { id: string; content: string; date: string } }> {
  return dashboardRequest(`/tutoring/periods/${periodId}/logs`, { method: 'POST', payload: { content }, guildId });
}

export async function decideTutoring(
  periodId: string,
  payload: { status: 'PASSED' | 'FAILED'; notes?: string; force?: boolean },
  guildId = authStore.selectedGuildId,
): Promise<PeriodResponse> {
  return dashboardRequest(`/tutoring/periods/${periodId}/decision`, { method: 'POST', payload, guildId });
}

export async function fetchTutoringConfig(guildId = authStore.selectedGuildId): Promise<{ config: TutoringConfig }> {
  return dashboardRequest('/tutoring/config', { method: 'GET', guildId });
}

export async function updateTutoringConfig(config: Partial<TutoringConfig>, guildId = authStore.selectedGuildId): Promise<{ config: TutoringConfig }> {
  return dashboardRequest('/tutoring/config', { method: 'PATCH', payload: config, guildId });
}

export async function fetchTutoringItems(guildId = authStore.selectedGuildId): Promise<{ items: TutoringItem[] }> {
  return dashboardRequest('/tutoring/items', { method: 'GET', guildId });
}

export async function saveTutoringItem(item: Partial<TutoringItem> & { title: string; category: string }, guildId = authStore.selectedGuildId): Promise<{ item: TutoringItem }> {
  return dashboardRequest('/tutoring/items', { method: 'POST', payload: item, guildId });
}

export async function deleteTutoringItem(itemId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/tutoring/items/${itemId}`, { method: 'DELETE', guildId });
}

/** Lu par le menu à chaque ouverture : un tutoré voit l'entrée Tutorat même sans accès à la section. */
export async function fetchApprenticeProgress(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/tutoring/apprentice-progress', { method: 'GET', guildId });
}
