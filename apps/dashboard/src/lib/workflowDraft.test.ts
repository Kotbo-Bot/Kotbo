import { describe, expect, it } from 'bun:test';
import type { WorkflowGraph } from '@kotbo/shared';
import { workflowDraftKey } from './workflowDraft';

const form = { name: 'Bienvenue', description: '', enabled: true };

const graph: WorkflowGraph = {
  nodes: [
    { id: 't', type: 'OnMemberJoin', position: { x: 0, y: 0 } },
    { id: 'a', type: 'SendMessage', position: { x: 200, y: 0 }, config: { content: 'Salut' } },
  ],
  edges: [{ id: 'e', source: 't', sourceHandle: 'next', target: 'a', targetHandle: 'exec' }],
};

describe('workflowDraftKey', () => {
  it('ignore le déplacement des nœuds sur le canevas', () => {
    const moved: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, position: { x: node.position.x + 40, y: 90 } })),
    };
    expect(workflowDraftKey(form, moved)).toBe(workflowDraftKey(form, graph));
  });

  it('change quand un réglage de nœud change', () => {
    const edited: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === 'a' ? { ...node, config: { content: 'Bonjour' } } : node)),
    };
    expect(workflowDraftKey(form, edited)).not.toBe(workflowDraftKey(form, graph));
  });

  it('change quand un fil est retiré', () => {
    expect(workflowDraftKey(form, { ...graph, edges: [] })).not.toBe(workflowDraftKey(form, graph));
  });

  it('change avec le nom, la description ou l activation', () => {
    const base = workflowDraftKey(form, graph);
    expect(workflowDraftKey({ ...form, name: 'Autre' }, graph)).not.toBe(base);
    expect(workflowDraftKey({ ...form, description: 'x' }, graph)).not.toBe(base);
    expect(workflowDraftKey({ ...form, enabled: false }, graph)).not.toBe(base);
  });

  it('un réglage vide équivaut à un réglage absent', () => {
    const withEmpty: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === 't' ? { ...node, config: {} } : node)),
    };
    expect(workflowDraftKey(form, withEmpty)).toBe(workflowDraftKey(form, graph));
  });
});
