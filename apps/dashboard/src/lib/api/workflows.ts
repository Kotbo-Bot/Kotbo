/** Node Workflow Builder - automatisations par blocs. */
export type * from './workflowTypes';
import type {
  SaveWorkflowPayload,
  WorkflowDetail,
  WorkflowExecutionDetail,
  WorkflowExecutionSummary,
  WorkflowSummary,
  WorkflowTestResult,
  WorkflowWarning,
} from './workflowTypes';
import type { ValidationIssue, WorkflowGraph } from '@kotbo/shared';
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

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
): Promise<{ workflow: WorkflowDetail; warnings?: WorkflowWarning[] }> {
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
): Promise<{ workflow: WorkflowDetail; warnings?: WorkflowWarning[] }> {
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

/** Fait tourner le brouillon sans enregistrer ni agir, et rend sa trace. */
export async function testWorkflowGraph(
  graph: WorkflowGraph,
  options: { workflowId?: string | null; memberId?: string | null; source?: 'sample' | 'last' } = {},
  guildId = authStore.selectedGuildId,
): Promise<{ test: WorkflowTestResult }> {
  return dashboardRequest('/workflows/test', {
    method: 'POST',
    payload: {
      graph,
      workflowId: options.workflowId ?? null,
      memberId: options.memberId ?? null,
      source: options.source ?? 'sample',
    },
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
