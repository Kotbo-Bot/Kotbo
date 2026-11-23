/** Sauvegardes de configuration. */
import { authStore } from '../stores/auth.svelte';
import { BASE_URL, authorizedFetch, getGuildId, dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
// Backup API functions
export async function fetchBackups(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/backups', { method: 'GET', guildId, errorContext: 'API Error (Fetch Backups):' });
}

export async function createBackup(payload: {
  name?: string;
  description?: string;
  includeMessages?: boolean;
  includeMembers?: boolean;
  includeRoles?: boolean;
  includeChannels?: boolean;
  includeEmojis?: boolean;
  includeStickers?: boolean;
  includeKotbo?: boolean;
  messagesDays?: number;
}, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/backups', { method: 'POST', successMessage: m.api_ok_create_backup(), payload, guildId, errorContext: 'API Error (Create Backup):' });
}

export async function deleteBackup(backupId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/backups/${backupId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete Backup):' });
}

export async function exportBackup(backupId: string, guildId = authStore.selectedGuildId) {
  const selectedGuildId = getGuildId(guildId);
  if (!selectedGuildId) return null;

  try {
    const response = await authorizedFetch(`${BASE_URL}/guilds/${selectedGuildId}/backups/${backupId}/export`);
    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }
    return response;
  } catch (error) {
    console.error('API Error (Export Backup):', error);
    throw error;
  }
}

export async function importBackup(fileContent: string, name?: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/backups/import', {
    method: 'POST',
    successMessage: m.api_ok_import_backup(),
    payload: { file: fileContent, name },
    guildId,
    errorContext: 'API Error (Import Backup):'
  });
}

export async function restoreBackup(backupId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/backups/${backupId}/restore`, {
    method: 'POST',
    successMessage: m.api_ok_restore_backup(),
    guildId,
    errorContext: 'API Error (Restore Backup):'
  });
}
