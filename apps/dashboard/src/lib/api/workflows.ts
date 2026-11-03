/** Node Workflow Builder - automatisations par blocs. */
import type { ValidationIssue, WorkflowGraph } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: string;
  triggerEvent: string;
  runCount: number;
  successCount: number;
  failureCount: number;
  lastRunAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  graph: WorkflowGraph;
}

export interface WorkflowExecutionSummary {
  id: string;
  workflowId: string;
  status: 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error: string | null;
  nodeVisits: number;
  iterations: number;
  resumeAt: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Type du nœud en échec, quand une étape a échoué */
  failedStep: string | null;
}

export interface WorkflowExecutionStep {
  id: string;
  order: number;
  nodeId: string;
  nodeType: string;
  status: 'OK' | 'ERROR' | 'SKIPPED';
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
}

export interface WorkflowExecutionDetail extends WorkflowExecutionSummary {
  steps: WorkflowExecutionStep[];
}

export interface SaveWorkflowPayload {
  name: string;
  description?: string | null;
  enabled: boolean;
  graph: WorkflowGraph;
}

export async function fetchWorkflows(
  guildId = authStore.selectedGuildId,
): Promise<{ workflows: WorkflowSummary[] }> {
  return dashboardRequest('/workflows', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflows):',
  });
}

export async function fetchWorkflow(
  id: string,
  guildId = authStore.selectedGuildId,
): Promise<{ workflow: WorkflowDetail }> {
  return dashboardRequest(`/workflows/${id}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflow):',
  });
}

export async function createWorkflow(
  payload: SaveWorkflowPayload,
  guildId = authStore.selectedGuildId,
): Promise<{ workflow: WorkflowDetail }> {
  // `silent` : la page annonce elle-même l'enregistrement, la duplication et la
  // suppression. Sans ça, le toast générique du client s'ajoute au sien.
  return dashboardRequest('/workflows', {
    method: 'POST',
    payload,
    guildId,
    silent: true,
    errorContext: 'API Error (Create Workflow):',
  });
}

export async function updateWorkflow(
  id: string,
  payload: SaveWorkflowPayload,
  guildId = authStore.selectedGuildId,
): Promise<{ workflow: WorkflowDetail }> {
  return dashboardRequest(`/workflows/${id}`, {
    method: 'PUT',
    payload,
    guildId,
    silent: true,
    errorContext: 'API Error (Update Workflow):',
  });
}

export async function toggleWorkflow(
  id: string,
  enabled: boolean,
  guildId = authStore.selectedGuildId,
): Promise<{ success: boolean }> {
  return dashboardRequest(`/workflows/${id}/toggle`, {
    method: 'POST',
    payload: { enabled },
    guildId,
    errorContext: 'API Error (Toggle Workflow):',
  });
}

export async function deleteWorkflow(
  id: string,
  guildId = authStore.selectedGuildId,
): Promise<{ success: boolean }> {
  return dashboardRequest(`/workflows/${id}`, {
    method: 'DELETE',
    guildId,
    silent: true,
    errorContext: 'API Error (Delete Workflow):',
  });
}

/** Valide un graphe côté serveur, sans l'enregistrer. */
export async function validateWorkflowGraph(
  graph: WorkflowGraph,
  guildId = authStore.selectedGuildId,
): Promise<{ issues: ValidationIssue[] }> {
  return dashboardRequest('/workflows/validate', {
    method: 'POST',
    payload: { graph },
    guildId,
    errorContext: 'API Error (Validate Workflow):',
  });
}

/** Résultat d'un essai à blanc : la trace, sans rien d'exécuté sur Discord. */
export interface WorkflowTestResult {
  status: 'COMPLETED' | 'SUSPENDED' | 'FAILED';
  /** Événement rejoué : le dernier réel, ou un exemple à défaut. */
  source: 'sample' | 'last';
  error: string | null;
  steps: Array<Omit<WorkflowExecutionStep, 'id' | 'error'> & { error?: string }>;
}

/** Fait tourner le brouillon sans enregistrer ni agir, et rend sa trace. */
export async function testWorkflowGraph(
  graph: WorkflowGraph,
  options: { workflowId?: string | null; source?: 'sample' | 'last' } = {},
  guildId = authStore.selectedGuildId,
): Promise<{ test: WorkflowTestResult }> {
  return dashboardRequest('/workflows/test', {
    method: 'POST',
    payload: { graph, workflowId: options.workflowId ?? null, source: options.source ?? 'sample' },
    guildId,
    silent: true,
    errorContext: 'API Error (Test Workflow):',
  });
}

export async function fetchWorkflowExecutions(
  filters: { workflowId?: string; status?: WorkflowExecutionSummary['status']; before?: string; take?: number } = {},
  guildId = authStore.selectedGuildId,
): Promise<{ executions: WorkflowExecutionSummary[] }> {
  const params = new URLSearchParams();
  if (filters.workflowId) params.set('workflowId', filters.workflowId);
  if (filters.status) params.set('status', filters.status);
  if (filters.before) params.set('before', filters.before);
  if (filters.take) params.set('take', String(filters.take));
  const search = params.toString();
  const query = search ? `?${search}` : '';
  return dashboardRequest(`/workflows/executions${query}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflow Executions):',
  });
}

export async function fetchWorkflowExecution(
  executionId: string,
  guildId = authStore.selectedGuildId,
): Promise<{ execution: WorkflowExecutionDetail }> {
  return dashboardRequest(`/workflows/executions/${executionId}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Workflow Execution):',
  });
}
