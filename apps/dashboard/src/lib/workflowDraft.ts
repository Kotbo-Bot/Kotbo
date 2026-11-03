import type { WorkflowGraph } from '@kotbo/shared';

export interface WorkflowDraftForm {
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * Empreinte de ce qu'un enregistrement changerait.
 *
 * Les positions en sont exclues : le canevas les réécrit de lui-même (mesure
 * des cartes, mise en page automatique), et la page se croirait modifiée à la
 * simple ouverture. Un réglage vide et un réglage absent s'enregistrent de la
 * même façon, ils comptent donc pour un.
 */
export function workflowDraftKey(form: WorkflowDraftForm, graph: WorkflowGraph): string {
  return JSON.stringify({
    name: form.name,
    description: form.description,
    enabled: form.enabled,
    nodes: (graph.nodes ?? []).map((node) => ({
      id: node.id,
      type: node.type,
      config: node.config && Object.keys(node.config).length > 0 ? node.config : null,
    })),
    edges: (graph.edges ?? []).map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle]),
  });
}
