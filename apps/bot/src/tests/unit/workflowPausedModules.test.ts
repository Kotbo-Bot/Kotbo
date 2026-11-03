/**
 * Un déclencheur dont le module est en pause ne part jamais : son événement
 * n'est plus émis. Le catalogue ne doit plus le proposer, et l'enregistrement
 * doit le refuser, que la recette vienne du dashboard ou d'un agent MCP.
 */
import { describe, expect, test } from 'bun:test';
import { isModulePaused } from '@kotbo/contracts';
import { NODE_CATALOG, isNodeAvailable, pausedModuleIssues, type WorkflowGraph } from '@kotbo/shared';

function graphWith(triggerType: string): WorkflowGraph {
  return {
    nodes: [
      { id: 't', type: triggerType, position: { x: 0, y: 0 } },
      { id: 'a', type: 'SendMessage', position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e', source: 't', sourceHandle: 'next', target: 'a', targetHandle: 'exec' }],
  };
}

describe('nœuds des modules en pause', () => {
  test('les déclencheurs des partenariats sont rattachés à leur module', () => {
    for (const type of ['OnPartnershipStage', 'OnPartnershipCommitmentFailed', 'OnPartnershipReferral']) {
      expect(NODE_CATALOG.find((def) => def.type === type)?.module).toBe('partnerships');
    }
  });

  test('un nœud rattaché à un module en pause n est pas disponible', () => {
    expect(isNodeAvailable('OnPartnershipStage', isModulePaused)).toBeFalse();
    expect(isNodeAvailable('OnMemberJoin', isModulePaused)).toBeTrue();
    expect(isNodeAvailable('TypeInconnu', isModulePaused)).toBeTrue();
  });

  test('chaque module déclaré par un nœud existe dans le registre', async () => {
    const { getModuleDefinition } = await import('@kotbo/contracts');
    for (const def of NODE_CATALOG.filter((entry) => entry.module)) {
      expect(getModuleDefinition(def.module as string)).toBeDefined();
    }
  });

  test('l enregistrement signale le nœud fautif', () => {
    const issues = pausedModuleIssues(graphWith('OnPartnershipStage'), isModulePaused);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.code).toBe('PAUSED_MODULE');
    expect(issues[0]!.nodeId).toBe('t');
  });

  test('un graphe sans nœud en pause passe', () => {
    expect(pausedModuleIssues(graphWith('OnMemberJoin'), isModulePaused)).toEqual([]);
  });
});
