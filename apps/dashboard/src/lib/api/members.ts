/** Dossiers membres, sanctions et comptes lies. */
import type { MemberCaseResponse } from '@kotbo/contracts';
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

import { m } from '../i18n';
export async function createSanctionReport(report, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/sanctions/reports', {
    method: 'POST',
    payload: report,
    guildId,
    errorContext: 'API Error (Sanction Report):'
  });
}

export async function updateSanctionReport(reportId, report, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/sanctions/reports/${reportId}`, {
    method: 'PATCH',
    payload: report,
    guildId,
    errorContext: 'API Error (Update Sanction Report):'
  });
}

export async function fetchSanctionDiscordMessages(sanctionId: string, limit: number, guildId = authStore.selectedGuildId) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return dashboardRequest(`/sanctions/reports/discord-messages?sanctionId=${encodeURIComponent(sanctionId)}&limit=${safeLimit}`, {
    method: 'GET',
    guildId,
    silent: true,
    errorContext: 'API Error (Discord Evidence Preview):'
  });
}

export async function generateSanctionDiscordTranscripts(sanctionId: string, selections: Array<{ channelId: string; messageIds: string[] }>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/sanctions/reports/discord-transcripts', {
    method: 'POST',
    payload: { sanctionId, selections },
    guildId,
    silent: true,
    errorContext: 'API Error (Discord Evidence Transcript):'
  });
}


export type SanctionImportRow = {
  type: string;
  targetUserId: string;
  targetTag?: string | null;
  moderatorUserId?: string | null;
  moderatorTag?: string | null;
  reason: string;
  createdAt: string;
  durationSeconds?: number | null;
};

export async function importSanctions(rows: SanctionImportRow[], source?: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/sanctions/import', {
    method: 'POST',
    payload: { rows, source },
    guildId,
    silent: true,
    errorContext: 'API Error (Import Sanctions):'
  }) as Promise<{ ok: boolean; imported: number; skippedDuplicates: number; errors: Array<{ index: number; error: string }> } | null>;
}

export async function deleteSanction(sanctionId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/sanctions/${sanctionId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Sanction):'
  });
}

export async function fetchMemberCase(userId: string, guildId: string | null = authStore.selectedGuildId) {
  return dashboardRequest<MemberCaseResponse>(`/members/${userId}`, {
    method: 'GET',
    guildId: guildId ?? undefined,
    errorContext: 'API Error (Member Case):'
  });
}

export async function runMemberCaseAction(userId: string, action: string, { reason, durationMs }: { reason?: string; durationMs?: number } = {}, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/members/${userId}/actions`, {
    method: 'POST',
    payload: {
      type: action,
      reason,
      durationMs,
    },
    guildId,
    errorContext: 'API Error (Member Case Action):'
  });
}

export async function linkMemberAccount(userId, targetAccountId, reason = '', guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/members/${userId}/link`, {
    method: 'POST',
    payload: { targetAccountId, reason },
    guildId,
    errorContext: 'API Error (Link Member Account):'
  });
}

export async function unlinkMemberAccount(userId, targetAccountId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/members/${userId}/link/${targetAccountId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Unlink Member Account):'
  });
}

export async function updateMemberNote(userId, note, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/members/${userId}/note`, {
    method: 'PATCH',
    successMessage: m.api_ok_update_member_note(),
    payload: { note },
    guildId,
    errorContext: 'API Error (Update Member Note):'
  });
}

export async function fetchLinkedAccounts(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/linked-accounts', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Linked Accounts):'
  });
}

export async function updateLinkedAccountStatus(id: string, status: 'VALIDATED' | 'REJECTED', guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/linked-accounts/${id}`, {
    method: 'PATCH',
    payload: { status },
    guildId,
    errorContext: 'API Error (Update Linked Account):'
  });
}

export async function deleteLinkedAccount(id: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/linked-accounts/${id}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Linked Account):'
  });
}
