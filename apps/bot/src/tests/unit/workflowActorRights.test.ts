import { describe, expect, test } from 'bun:test';
import type { WorkflowGraph } from '@kotbo/shared';
import { collectActorRightChecks } from '../../services/features/workflow/actorRights.js';

/** Graphe minimal : seuls les types, les configs et les arêtes comptent ici. */
function graph(nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>, edges: Array<{ source: string; target: string; targetHandle: string }>): WorkflowGraph {
  return {
    nodes: nodes.map((node) => ({ position: { x: 0, y: 0 }, config: {}, ...node })),
    edges: edges.map((edge, i) => ({ id: `e${i}`, sourceHandle: 'out', ...edge })),
  } as unknown as WorkflowGraph;
}

describe('collectActorRightChecks', () => {
  test('relève le rôle choisi en dur d\'une action de rôle', () => {
    const checks = collectActorRightChecks(graph(
      [
        { id: 'r', type: 'SelectRole', config: { roleId: '111111111111111111' } },
        { id: 'a', type: 'AddRole' },
      ],
      [{ source: 'r', target: 'a', targetHandle: 'role' }],
    ));
    expect(checks.roleIds).toEqual(['111111111111111111']);
    expect(checks.permissions).toEqual([]);
  });

  test('couvre le retrait et le rôle temporaire, sans doublon', () => {
    const checks = collectActorRightChecks(graph(
      [
        { id: 'r', type: 'SelectRole', config: { roleId: '222222222222222222' } },
        { id: 'a', type: 'RemoveRole' },
        { id: 'b', type: 'AddTemporaryRole' },
      ],
      [
        { source: 'r', target: 'a', targetHandle: 'role' },
        { source: 'r', target: 'b', targetHandle: 'role' },
      ],
    ));
    expect(checks.roleIds).toEqual(['222222222222222222']);
  });

  test('exige la permission Discord de chaque sanction', () => {
    const checks = collectActorRightChecks(graph(
      [{ id: 'k', type: 'KickMember' }, { id: 'b', type: 'BanMember' }, { id: 't', type: 'TimeoutMember' }],
      [],
    ));
    expect(new Set(checks.permissions)).toEqual(new Set(['KickMembers', 'BanMembers', 'ModerateMembers']));
  });

  test('ignore un rôle qui nourrit autre chose qu\'une action de rôle', () => {
    const checks = collectActorRightChecks(graph(
      [
        { id: 'r', type: 'SelectRole', config: { roleId: '333333333333333333' } },
        { id: 'm', type: 'SendMessage' },
      ],
      [{ source: 'r', target: 'm', targetHandle: 'text' }],
    ));
    expect(checks.roleIds).toEqual([]);
  });

  test('un graphe sans action sensible ne demande rien', () => {
    expect(collectActorRightChecks(graph([{ id: 'm', type: 'SendMessage' }], []))).toEqual({ roleIds: [], permissions: [] });
  });
});
