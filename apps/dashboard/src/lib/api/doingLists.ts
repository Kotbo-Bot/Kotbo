/** Listes de suivi. */
import type {
  DoingListChecklistEntry,
  DoingListItemType,
  DoingListLinkType,
  DoingListModule,
  DoingListPriority,
  DoingListSource,
} from '@kotbo/contracts';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type DoingList = {
  id: string;
  name: string;
  key: string;
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
  number: number;
  type: DoingListItemType;
  estimate: number | null;
  parentId: string | null;
  description: string | null;
  priority: DoingListPriority | null;
  dueDate: string | null;
  labels: string[];
  checklist: DoingListChecklistEntry[];
  sourceModule: DoingListSource | null;
  sourceId: string | null;
  staffTaskId: string | null;
  staffTask: { id: string; status: string; assignee: DoingListAssignee | null } | null;
  _count?: { events: number };
  createdAt: string;
};

/** Carte citée ailleurs : lien, résultat de recherche. */
export type DoingListRef = { id: string; listId: string; key: string; title: string; type: DoingListItemType; done: boolean };

export type DoingListLink = { id: string; type: DoingListLinkType; from: DoingListRef; to: DoingListRef };

export type DoingListEvent = {
  id: string;
  actorId: string;
  actorName: string;
  kind: 'comment' | 'created' | 'moved' | 'assigned' | 'unassigned' | 'updated' | 'linked' | 'unlinked';
  body: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type DoingListLinks = {
  lists: Array<{ id: string; name: string }>;
  items: Array<{ id: string; listId: string; sourceId: string }>;
};

type ListInput = { name?: string; key?: string; description?: string | null; modules?: DoingListModule[]; columns?: string[] };
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
  type?: DoingListItemType;
  estimate?: number | null;
  parentId?: string | null;
  sourceModule?: DoingListSource;
  sourceId?: string;
};

export async function fetchDoingLists(guildId = authStore.selectedGuildId): Promise<{ lists: DoingList[] }> {
  return dashboardRequest('/doing-lists', { method: 'GET', guildId });
}

export async function fetchDoingList(listId: string, guildId = authStore.selectedGuildId): Promise<{ list: DoingList; columns: DoingListColumn[]; items: DoingListItem[]; links: DoingListLink[] }> {
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

export async function searchDoingListItems(query: string, guildId = authStore.selectedGuildId): Promise<{ items: DoingListRef[] }> {
  return dashboardRequest(`/doing-lists/search?q=${encodeURIComponent(query)}`, { method: 'GET', guildId });
}

export async function fetchDoingListEvents(listId: string, itemId: string, guildId = authStore.selectedGuildId): Promise<{ events: DoingListEvent[] }> {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}/events`, { method: 'GET', guildId });
}

export async function addDoingListComment(listId: string, itemId: string, body: string, guildId = authStore.selectedGuildId): Promise<{ event: DoingListEvent }> {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}/comments`, { method: 'POST', payload: { body }, guildId });
}

export async function updateDoingListComment(listId: string, itemId: string, eventId: string, body: string, guildId = authStore.selectedGuildId): Promise<{ event: DoingListEvent }> {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}/comments/${eventId}`, { method: 'PATCH', payload: { body }, guildId });
}

export async function deleteDoingListComment(listId: string, itemId: string, eventId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}/comments/${eventId}`, { method: 'DELETE', guildId });
}

/** inward : la carte est la cible du lien (« est bloquée par », « est dupliquée par »). */
export async function addDoingListLink(
  listId: string,
  itemId: string,
  payload: { type: DoingListLinkType; targetId: string; inward: boolean },
  guildId = authStore.selectedGuildId,
): Promise<{ link: DoingListLink }> {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}/links`, { method: 'POST', payload, guildId });
}

export async function removeDoingListLink(listId: string, itemId: string, linkId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}/links/${linkId}`, { method: 'DELETE', guildId });
}
