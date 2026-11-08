/**
 * Types des automatisations, sans dependance d execution : les modules purs
 * et leurs tests les lisent sans charger le client API ni les stores Svelte.
 */
import type { WorkflowGraph } from '@kotbo/shared';

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

/** Étape que le bot ne pourra pas faire, signalée à l'enregistrement. */
export interface WorkflowWarning {
  nodeId: string;
  message: string;
}

export interface SaveWorkflowPayload {
  name: string;
  description?: string | null;
  enabled: boolean;
  graph: WorkflowGraph;
}

/** Résultat d'un essai à blanc : la trace, sans rien d'exécuté sur Discord. */
export interface WorkflowTestResult {
  status: 'COMPLETED' | 'SUSPENDED' | 'FAILED';
  /** Événement rejoué : le dernier réel, ou un exemple à défaut. */
  source: 'sample' | 'last';
  error: string | null;
  steps: Array<Omit<WorkflowExecutionStep, 'id' | 'error'> & { error?: string }>;
}
