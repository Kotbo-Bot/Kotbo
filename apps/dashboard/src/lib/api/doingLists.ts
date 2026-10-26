/** Listes de suivi. */
import type { DoingListModule, DoingListStatus } from '@kotbo/contracts';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type DoingList = {
  id: string;
  name: string;
  description: string | null;
  modules: DoingListModule[];
  counts?: Record<DoingListStatus, number>;
};

export type DoingListItem = {
  id: string;
  listId: string;
  title: string;
  status: DoingListStatus;
  position: number;
  sourceModule: DoingListModule | null;
  sourceId: string | null;
  createdAt: string;
};

export type DoingListLinks = {
  lists: Array<{ id: string; name: string }>;
  items: Array<{ id: string; listId: string; sourceId: string; status: DoingListStatus }>;
};

type ListInput = { name?: string; description?: string | null; modules?: DoingListModule[] };
type ItemInput = { title?: string; status?: DoingListStatus; position?: number; sourceModule?: DoingListModule; sourceId?: string };

export async function fetchDoingLists(guildId = authStore.selectedGuildId): Promise<{ lists: DoingList[] }> {
  return dashboardRequest('/doing-lists', { method: 'GET', guildId });
}

export async function fetchDoingList(listId: string, guildId = authStore.selectedGuildId): Promise<{ list: DoingList; items: DoingListItem[] }> {
  return dashboardRequest(`/doing-lists/${listId}`, { method: 'GET', guildId });
}

export async function fetchDoingListLinks(module: DoingListModule, guildId = authStore.selectedGuildId): Promise<DoingListLinks> {
  return dashboardRequest(`/doing-lists/for/${module}`, { method: 'GET', guildId });
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

export async function addDoingListItem(listId: string, payload: ItemInput, guildId = authStore.selectedGuildId): Promise<{ item: DoingListItem }> {
  return dashboardRequest(`/doing-lists/${listId}/items`, { method: 'POST', payload, guildId });
}

export async function updateDoingListItem(listId: string, itemId: string, payload: ItemInput, guildId = authStore.selectedGuildId): Promise<{ item: DoingListItem }> {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}`, { method: 'PATCH', payload, guildId });
}

export async function removeDoingListItem(listId: string, itemId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/doing-lists/${listId}/items/${itemId}`, { method: 'DELETE', guildId });
}
