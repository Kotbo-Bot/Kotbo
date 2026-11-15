/** Pulse, reputation, satisfaction, evaluations. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

import { m } from '../i18n';
// ============================================================================
// PULSE - SERVER HEALTH SCORE
// ============================================================================

export async function fetchPulseData(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/pulse', { method: 'GET', guildId, errorContext: 'API Error (Pulse):' });
}

export async function refreshPulse(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/pulse/refresh', { method: 'POST', guildId, errorContext: 'API Error (Pulse Refresh):' });
}

// ============================================================================
// TICKET SATISFACTION
// ============================================================================

export async function fetchSatisfactionData(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/satisfaction', { method: 'GET', guildId, errorContext: 'API Error (Satisfaction):' });
}

export async function fetchStaffSatisfactionReviews(
  staffId: string,
  options: { limit?: number; offset?: number; commentsOnly?: boolean } = {},
  guildId = authStore.selectedGuildId,
) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  if (options.commentsOnly) params.set('commentsOnly', 'true');
  const query = params.toString();

  return dashboardRequest(
    `/satisfaction/staff/${encodeURIComponent(staffId)}/reviews${query ? `?${query}` : ''}`,
    { method: 'GET', guildId, errorContext: 'API Error (Staff Reviews):' },
  );
}

// ============================================================================
// ANALYTICS PREDICTIONS
// ============================================================================

export async function fetchPredictions(days = 30, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/predictions?days=${days}`, { method: 'GET', guildId, errorContext: 'API Error (Predictions):' });
}

// ============================================================================
// STAFF EVALUATIONS
// ============================================================================

export async function fetchEvaluations(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/evaluations', { method: 'GET', guildId, errorContext: 'API Error (Evaluations):' });
}

export async function generateEvaluation(staffUserId?: string, periodDays = 30, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/evaluations/generate', { method: 'POST', payload: { staffUserId, periodDays }, guildId, errorContext: 'API Error (Generate Evaluation):' });
}

export async function updateEvaluationNote(evaluationId: string, managerNote: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/evaluations/${evaluationId}`, { method: 'PATCH', successMessage: m.api_ok_update_evaluation_note(), payload: { managerNote }, guildId, errorContext: 'API Error (Update Evaluation):' });
}

// ============================================================================
// MARKETPLACE
// ============================================================================

export async function fetchMarketplaceData(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/marketplace', { method: 'GET', guildId, errorContext: 'API Error (Marketplace):' });
}
