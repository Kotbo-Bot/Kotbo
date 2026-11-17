/** Widgets embarquables. */
import { m } from '../i18n';
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, authorizedFetch, dashboardRequest } from './client';

// ── Widget (Social Layer SDK) ───────────────────────────────────────────
export async function fetchWidgetData(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/widget', { guildId, errorContext: 'API Error (Widget):' });
}

export async function activateWidget(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/widget/activate', { method: 'POST', guildId, errorContext: 'API Error (Activate Widget):', silent: true });
}

export async function deactivateWidget(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/widget/deactivate', { method: 'POST', guildId, errorContext: 'API Error (Deactivate Widget):', silent: true });
}

export async function refreshWidget(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/widget/refresh', { method: 'POST', guildId, errorContext: 'API Error (Refresh Widget):', silent: true });
}

export async function refreshAllWidgets(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/widget/refresh-all', { method: 'POST', guildId, errorContext: 'API Error (Refresh All Widgets):', silent: true });
}

export async function rotateWidgetToken(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/widget/rotate-token', { method: 'POST', guildId, errorContext: 'API Error (Rotate Widget Token):', silent: true });
}

export async function unbindGuildFromInstance(instanceId: string, guildId: string) {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/whitelabel/${instanceId}/guilds/${guildId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || m.api_err_widget_detach());
  }
  return res.json();
}
