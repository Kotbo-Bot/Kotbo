/** Quetes. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
// ============================================================================
// QUESTS
// ============================================================================

export async function fetchQuestsData(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/quests', { method: 'GET', guildId, errorContext: 'API Error (Quests):' });
}

/** Cree la quete, ou la remplace quand `id` est fourni. */
export async function saveQuest(data: Record<string, unknown>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/quests', { method: 'POST', successMessage: data.id ? m.api_ok_update_quest() : m.api_ok_create_quest(), payload: data, guildId, errorContext: 'API Error (Save Quest):' });
}

export async function updateQuest(questId: string, data: Record<string, unknown>, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/quests/${questId}`, { method: 'PATCH', successMessage: m.api_ok_update_quest(), payload: data, guildId, errorContext: 'API Error (Update Quest):' });
}

export async function deleteQuest(questId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/quests/${questId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Quest):' });
}
