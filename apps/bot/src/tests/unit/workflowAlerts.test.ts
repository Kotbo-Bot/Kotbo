/**
 * Prévenir avant et après : les étapes que le bot ne pourra pas faire sont
 * signalées à l'enregistrement, et un échec est signalé à qui a créé
 * l'automatisation, une fois par série.
 */
import { describe, expect, test } from 'bun:test';
import type { WorkflowGraph } from '@kotbo/shared';
import { fixedEntityInputs } from '../../services/features/workflow/staticChecks';
import { failureAlertFor, failureAlertLink } from '../../services/features/workflow/failureAlert';

function node(id: string, type: string, config?: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, config };
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle };
}

describe('fixedEntityInputs', () => {
  const graph: WorkflowGraph = {
    nodes: [
      node('t', 'OnMemberJoin'),
      node('lit__chan_c9', 'SelectChannel', { channelId: 'c9' }),
      node('lit__role_r1', 'SelectRole', { roleId: 'r1' }),
      node('a1', 'SendMessage'),
      node('a2', 'AddRole'),
    ],
    edges: [
      edge('lit__chan_c9', 'channel', 'a1', 'channel'),
      edge('t', 'member', 'a2', 'member'),
      edge('lit__role_r1', 'role', 'a2', 'role'),
    ],
  };

  test('trouve le salon choisi dans l éditeur', () => {
    expect(fixedEntityInputs(graph, 'a1')).toEqual({ channel: { kind: 'channel', id: 'c9' } });
  });

  test('ignore ce qui vient du déclencheur, connu seulement à l exécution', () => {
    expect(fixedEntityInputs(graph, 'a2')).toEqual({ role: { kind: 'role', id: 'r1' } });
  });

  test('ignore un sélecteur laissé vide', () => {
    const empty: WorkflowGraph = {
      nodes: [node('s', 'SelectChannel', { channelId: '' }), node('a', 'SendMessage')],
      edges: [edge('s', 'channel', 'a', 'channel')],
    };
    expect(fixedEntityInputs(empty, 'a')).toEqual({});
  });
});

describe('failureAlertFor', () => {
  test('prévient le créateur au premier échec d une série', () => {
    expect(failureAlertFor({ previousLastError: null, createdById: 'u1' })).toBe('u1');
  });

  test('se tait tant que l automatisation reste en échec', () => {
    expect(failureAlertFor({ previousLastError: 'Salon : introuvable', createdById: 'u1' })).toBeNull();
  });

  test('se tait sans créateur connu', () => {
    expect(failureAlertFor({ previousLastError: null, createdById: null })).toBeNull();
  });
});

describe('failureAlertLink', () => {
  test('ouvre le rejeu de l exécution en échec', () => {
    expect(failureAlertLink('w1', 'e1')).toBe('/workflows?workflow=w1&execution=e1');
  });
});
