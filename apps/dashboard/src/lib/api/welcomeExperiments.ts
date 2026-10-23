/** Tests A/B de l'accueil. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type ExperimentMetric = 'retained_d1' | 'retained_d7' | 'retained_d30' | 'activated_d7';
export type ExperimentStatus = 'DRAFT' | 'RUNNING' | 'STOPPED';

export interface ExperimentVariant {
  key: string;
  name: string;
  weight: number;
  message: string | null;
  imageEnabled: boolean | null;
  threadEnabled: boolean | null;
}

export interface WelcomeExperiment {
  id: string;
  name: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  primaryMetric: ExperimentMetric;
  variants: ExperimentVariant[];
  winnerKey: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  assigned: Record<string, number>;
}

export interface WelcomeExperimentList {
  experiments: WelcomeExperiment[];
  welcome: { welcomeEnabled: boolean; welcomeChannelId: string | null; welcomeMessage: string; welcomeImageEnabled: boolean };
  canEdit: boolean;
}

export interface RateComparison {
  uplift: number | null;
  chanceToBeat: number | null;
  pValue: number | null;
}

export interface MetricResult {
  eligible: number;
  success: number;
  rate: number | null;
  vsControl: RateComparison | null;
}

export interface ExperimentResults {
  variants: Array<{
    key: string;
    name: string;
    weight: number;
    assigned: number;
    metrics: Record<ExperimentMetric, MetricResult>;
    messagesFirstWeek: number | null;
  }>;
  primaryMetric: ExperimentMetric;
  recommendation: { status: 'collecting' | 'winner' | 'control_wins' | 'no_difference'; winnerKey: string | null; neededPerVariant: number | null };
}

export interface ExperimentInput {
  name: string;
  hypothesis: string | null;
  primaryMetric: ExperimentMetric;
  variants: Array<Omit<ExperimentVariant, 'key'>>;
}

const base = '/welcome-experiments';

export function fetchWelcomeExperiments(guildId = authStore.selectedGuildId) {
  return dashboardRequest<WelcomeExperimentList>(base, { guildId, errorContext: 'API Error (Welcome experiments):' });
}

export function createWelcomeExperiment(input: ExperimentInput, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ experiment: WelcomeExperiment }>(base, { method: 'POST', payload: input, guildId, errorContext: 'API Error (Create experiment):' });
}

export function updateWelcomeExperiment(id: string, patch: Partial<ExperimentInput>, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ experiment: WelcomeExperiment }>(`${base}/${id}`, { method: 'PATCH', payload: patch, guildId, errorContext: 'API Error (Update experiment):' });
}

export function startWelcomeExperiment(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ experiment: WelcomeExperiment }>(`${base}/${id}/start`, { method: 'POST', guildId, errorContext: 'API Error (Start experiment):' });
}

export function stopWelcomeExperiment(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ experiment: WelcomeExperiment }>(`${base}/${id}/stop`, { method: 'POST', guildId, errorContext: 'API Error (Stop experiment):' });
}

export function shipWelcomeVariant(id: string, variantKey: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ ok: boolean }>(`${base}/${id}/ship`, { method: 'POST', payload: { variantKey }, guildId, errorContext: 'API Error (Ship variant):' });
}

export function deleteWelcomeExperiment(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<{ ok: boolean }>(`${base}/${id}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete experiment):' });
}

export function fetchWelcomeExperimentResults(id: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest<ExperimentResults>(`${base}/${id}/results`, { guildId, errorContext: 'API Error (Experiment results):' });
}
