/** Instances marque blanche et bot personnalise. */
import { m } from '../i18n';
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, authorizedFetch, dashboardRequest } from './client';

// ============================================================================
// WHITE-LABEL ADMIN API
// ============================================================================

export async function fetchWhiteLabelInstances() {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel`);
  if (!res.ok) throw new Error(m.api_err_wl_list());
  return res.json();
}

export async function fetchWhiteLabelInstance(id: string) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${id}`);
  if (!res.ok) throw new Error(m.api_err_wl_get());
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
    throw new Error(err.error || m.api_err_create());
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
    throw new Error(err.error || m.api_err_update());
  }
  return res.json();
}

export async function deleteWhiteLabelInstance(id: string) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || m.api_err_delete());
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
    throw new Error(err.error || m.api_err_wl_attach());
  }
  return res.json();
}

async function adminInstanceAction(id: string, action: 'start' | 'stop') {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${id}/${action}`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || m.api_err_action());
  }
  return res.json();
}

/** Lance une instance sans redémarrer le launcher. */
export const startWhiteLabelInstance = (id: string) => adminInstanceAction(id, 'start');
export const stopWhiteLabelInstance = (id: string) => adminInstanceAction(id, 'stop');

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

export async function verifyCustomBotDomain(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot/domain/verify', { method: 'POST', guildId, errorContext: 'API Error (Custom Domain):' });
}

/** Le bot du serveur prend le relais, Kotbo quitte le serveur. */
export async function switchToCustomBot(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot/switch', { method: 'POST', guildId, errorContext: 'API Error (Custom Bot Switch):' });
}

/** Kotbo reprend le serveur, le bot perso est arrêté. */
export async function revertToKotbo(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot/revert', { method: 'POST', guildId, errorContext: 'API Error (Custom Bot Revert):' });
}

export async function stopCustomBot(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/custom-bot/stop', { method: 'POST', guildId, errorContext: 'API Error (Stop Bot):' });
}
