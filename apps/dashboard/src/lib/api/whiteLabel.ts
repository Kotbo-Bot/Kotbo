/** Instances marque blanche et bot personnalise. */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, authorizedFetch, dashboardRequest } from './client';

// ============================================================================
// WHITE-LABEL ADMIN API
// ============================================================================

export async function fetchWhiteLabelInstances() {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel`);
  if (!res.ok) throw new Error('Erreur lors de la récupération des instances');
  return res.json();
}

export async function fetchWhiteLabelInstance(id: string) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${id}`);
  if (!res.ok) throw new Error('Erreur lors de la récupération de l\'instance');
  return res.json();
}

export async function createWhiteLabelInstance(data: Record<string, unknown>) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erreur lors de la création');
  }
  return res.json();
}

export async function updateWhiteLabelInstance(id: string, data: Record<string, unknown>) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erreur lors de la mise à jour');
  }
  return res.json();
}

export async function deleteWhiteLabelInstance(id: string) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erreur lors de la suppression');
  }
  return res.json();
}

export async function bindGuildToInstance(instanceId: string, guildId: string) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${instanceId}/guilds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erreur lors du rattachement');
  }
  return res.json();
}

// ============================================================================
// CUSTOM BOT API (per-guild)
// ============================================================================

export async function fetchCustomBotConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot', { method: 'GET', guildId, errorContext: 'API Error (Custom Bot):' });
}

export async function updateCustomBotConfig(data: Record<string, unknown>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot', { method: 'PATCH', payload: data, guildId, errorContext: 'API Error (Custom Bot Update):' });
}

export async function validateCustomBotToken(botToken: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot/validate', { method: 'POST', payload: { botToken }, guildId, errorContext: 'API Error (Token Validation):' });
}

export async function startCustomBot(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot/start', { method: 'POST', guildId, errorContext: 'API Error (Start Bot):' });
}

export async function stopCustomBot(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot/stop', { method: 'POST', guildId, errorContext: 'API Error (Stop Bot):' });
}
