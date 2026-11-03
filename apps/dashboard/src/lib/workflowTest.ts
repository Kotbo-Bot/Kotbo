import type { WorkflowExecutionSummary, WorkflowTestResult } from './api/workflows';

/**
 * Statut sous lequel le rejeu montre un essai.
 *
 * Un essai suspendu s'est arrêté sur une attente, faute de reprises : la suite
 * n'a pas été parcourue, et le dire terminé ferait croire qu'elle a été vérifiée.
 */
export function testReplayStatus(status: WorkflowTestResult['status']): WorkflowExecutionSummary['status'] {
  return status === 'SUSPENDED' ? 'WAITING' : status;
}
