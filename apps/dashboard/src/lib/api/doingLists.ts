/** Listes de suivi. */
import type { DoingListChecklistEntry, DoingListModule, DoingListPriority, DoingListSource } from '@kotbo/contracts';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type DoingList = {
  id: string;
  name: string;
  description: string | null;
  modules: DoingListModule[];
  counts?: { total: number; done: number };
};

export type DoingListColumn = {
  id: string;
  name: string;
  position: number;
  wipLimit: number | null;
  isDone: boolean;
};

export type DoingListAssignee = {
  id: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type DoingListItem = {
  id: string;
  listId: string;
  columnId: string;
  title: string;
  position: number;
  description: string | null;
  priority: DoingListPriority | null;
  dueDate: string | null;
  labels: string[];
  checklist: DoingListChecklistEntry[];
  sourceModule: DoingListSource | null;
  sourceId: string | null;
  staffTaskId: string | null;
  staffTask: { id: string; status: string; assignee: DoingListAssignee | null } | null;
  createdAt: string;
};

export type DoingListLinks = {
  lists: Array<{ id: string; name: string }>;
  items: Array<{ id: string; listId: string; sourceId: string }>;
};

type ListInput = { name?: string; description?: string | null; modules?: DoingListModule[]; columns?: string[] };
type ColumnInput = { name?: string; wipLimit?: number | null; isDone?: boolean };
type ItemInput = {
  title?: string;
  description?: string | null;
  priority?: DoingListPriority | null;
  dueDate?: string | null;
  labels?: string[];
  checklist?: DoingListChecklistEntry[];
  columnId?: string;
  index?: number;
  assigneeId?: string | null;
  sourceModule?: DoingListSource;
  sourceId?: string;
};

export async function fetchDoingLists(guildId = authStore.selectedGuildId): Promise<{ lists: DoingList[] }> {
  return dashboardRequest('/doing-lists', { method: 'GET', guildId });
}

export async function fetchDoingList(listId: string, guildId = authStore.selectedGuildId): Promise<{ list: DoingList; columns: DoingListColumn[]; items: DoingListItem[] }> {
  return dashboardRequest(`/doing-lists/${listId}`, { method: 'GET', guildId });
}

export async function fetchDoingListAssignees(guildId = authStore.selectedGuildId): Promise<{ members: DoingListAssignee[] }> {
  return dashboardRequest('/doing-lists/assignees', { method: 'GET', guildId });
}

export async function fetchDoingListLinks(source: DoingListSource, guildId = authStore.selectedGuildId): Promise<DoingListLinks> {
  return dashboardRequest(`/doing-lists/for/${source}`, { method: 'GET', guildId });
}

export async function createDoingList(payload: ListInput, guildId = authStore.selectedGuildId): Promise<{ list: DoingList }> {
  return dashboardRequest('/doing-lists', { method: 'POST', payload, guildId });
}

export async function updateDoingList(listId: string, payload: ListInput, guildId = authStore.selectedGuildId): Promise<{ list: DoingList }> {
  return dashboardRequest(`/doing-lists/${listId}`, { method: 'PATCH', payload, guildId });
}

export async function deleteDoingList(listId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/doing-lists/${listId}`, { method: 'DELETE', guildId });
}

export async function createDoingListColumn(listId: string, payload: ColumnInput, guildId = authStore.selectedGuildId): Promise<{ column: DoingListColumn }> {
  return dashboardRequest(`/doing-lists/${listId}/columns`, { method: 'POST', payload, guildId });
}

export async function updateDoingListColumn(listId: string, columnId: string, payload: ColumnInput, guildId = authStore.selectedGuildId): Promise<{ column: DoingListColumn }> {
  return dashboardRequest(`/doing-lists/${listId}/columns/${columnId}`, { method: 'PATCH', payload, guildId });
}

export async function reorderDoingListColumns(listId: string, ids: string[], guildId = authStore.selectedGuildId): Promise<{ columns: DoingListColumn[] }> {
  return dashboardRequest(`/doing-lists/${listId}/columns/order`, { method: 'PUT', payload: { ids }, guildId });
}

export async function deleteDoingListColumn(listId: string, columnId: string, moveTo: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/doing-lists/${listId}/columns/${columnId}?moveTo=${encodeURIComponent(moveTo)}`, { method: 'DELETE', guildId });
}

export async function addDoingListItem(listId: string, payload: ItemInput, guildId = authStore.selectedGuildId): Promise<{ item: DoingListItem }> {
  return dashboardRequest(`/doing-lists/${listId}/items`, { method: 'POST', payload, guildId });
}

export async function updateDoingListItem(listId: string, itemId: string, payload: ItemInput, guildId = authStore.selectedGuildId): Promise<{ item: DoingListItem }> {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}`, { method: 'PATCH', payload, guildId });
}

export async function removeDoingListItem(listId: string, itemId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}`, { method: 'DELETE', guildId });
}
