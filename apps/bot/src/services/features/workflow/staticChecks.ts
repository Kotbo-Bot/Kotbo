import type { WorkflowGraph } from '@kotbo/shared';

/**
 * Salons et rôles choisis en dur dans l'éditeur, connus dès l'enregistrement.
 *
 * Ce qui vient du déclencheur (le membre arrivé, le salon du message) n'est
 * connu qu'à l'exécution : seuls les sélecteurs fixes permettent de vérifier
 * les permissions du bot avant que l'automatisation ne tourne.
 */
export interface FixedEntity {
  kind: 'channel' | 'role';
  id: string;
}

const SELECTORS: Record<string, { kind: FixedEntity['kind']; key: string }> = {
  SelectChannel: { kind: 'channel', key: 'channelId' },
  SelectRole: { kind: 'role', key: 'roleId' },
};

/** Entrées d'un nœud alimentées par un sélecteur fixe, par port. */
export function fixedEntityInputs(graph: WorkflowGraph, nodeId: string): Record<string, FixedEntity> {
  const fixed: Record<string, FixedEntity> = {};
  for (const edge of graph.edges) {
    if (edge.target !== nodeId) continue;
    const source = graph.nodes.find((node) => node.id === edge.source);
    const selector = source ? SELECTORS[source.type] : undefined;
    const id = selector ? source?.config?.[selector.key] : undefined;
    if (selector && typeof id === 'string' && id) fixed[edge.targetHandle] = { kind: selector.kind, id };
  }
  return fixed;
}
