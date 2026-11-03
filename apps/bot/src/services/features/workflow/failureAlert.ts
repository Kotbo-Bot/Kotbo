/**
 * Qui prévenir quand une automatisation échoue.
 *
 * Une fois par série : au premier échec après un succès (ou une première
 * exécution). Tant que l'automatisation reste cassée, chaque déclenchement
 * échouerait de nouveau, et prévenir à chaque fois noierait l'alerte utile.
 * `lastError` est remis à vide par chaque succès, c'est lui qui marque la série.
 */
export function failureAlertFor(input: { previousLastError: string | null; createdById: string | null }): string | null {
  if (input.previousLastError !== null) return null;
  return input.createdById || null;
}

/** Page des automatisations ouverte sur le rejeu de l'exécution en échec. */
export function failureAlertLink(workflowId: string, executionId: string): string {
  const params = new URLSearchParams({ workflow: workflowId, execution: executionId });
  return `/workflows?${params.toString()}`;
}
