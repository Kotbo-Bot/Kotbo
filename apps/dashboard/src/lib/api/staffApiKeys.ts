/** Clés d'API du staff : liste et suppression (la création passe par le profil). */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

export async function fetchMyApiKeys(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/api-keys', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch API Keys):'
  });
}

export async function deleteMyApiKey(keyId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/api-keys/${keyId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete API Key):'
  });
}
