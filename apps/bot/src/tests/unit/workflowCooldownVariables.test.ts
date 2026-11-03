/**
 * Délai de récupération et variables persistantes.
 *
 * Le délai ne laisse passer qu'une fois par période (pour le membre, le salon
 * ou le serveur). Les variables sont des compteurs du serveur, partagés entre
 * ses automatisations, tenus pour un membre ou pour tout le serveur. Les deux
 * vivent hors du graphe : le moteur ne les touche qu'au travers des effets,
 * ce qui permet à l'essai à blanc de ne rien écrire.
 */
import { describe, expect, test } from 'bun:test';
import {
  compileRecipe,
  decompileGraph,
  hasBlockingIssue,
  validateGraph,
  type Recipe,
  type WorkflowGraph,
} from '@kotbo/shared';
import { runWorkflow, type WorkflowEffects } from '../../services/features/workflow/engine';
import { createDryRunEffects } from '../../services/features/workflow/dryRun';
import type { ChannelValue, MemberValue } from '../../services/features/workflow/values';

const alice: MemberValue = {
  kind: 'Member', id: 'u1', tag: 'Alice#0001', displayName: 'Alice', isBot: false,
  roleIds: [], accountCreatedAt: null, joinedAt: null,
};
const bob: MemberValue = { ...alice, id: 'u2', tag: 'Bob#0002', displayName: 'Bob' };
const general: ChannelValue = { kind: 'Channel', id: 'c1', name: 'general', categoryName: null };

/** Effets en mémoire : un délai réservé et des compteurs, comme en base. */
function memoryEffects() {
  const cooldowns = new Map<string, number>();
  const variables = new Map<string, number>();
  const actions: string[] = [];
  let clock = 0;

  const effects: WorkflowEffects = {
    getRole: async (id) => (id ? { kind: 'Role', id, name: `role-${id}` } : null),
    getChannel: async (id) => (id ? { kind: 'Channel', id, name: `salon-${id}`, categoryName: null } : null),
    getMember: async (id) => (id ? { ...alice, id } : null),
    getGuildInfo: async () => ({ name: 'Serveur', memberCount: 10 }),
    runAction: async (type) => {
      actions.push(type);
      return {};
    },
    claimCooldown: async (nodeId, subject, seconds) => {
      const key = `${nodeId}:${subject}`;
      const until = cooldowns.get(key) ?? -Infinity;
      if (until > clock) return false;
      cooldowns.set(key, clock + seconds * 1000);
      return true;
    },
    getVariable: async (name, subject) => variables.get(`${name}:${subject}`) ?? 0,
    updateVariable: async (name, subject, operation, amount) => {
      const key = `${name}:${subject}`;
      const next = operation === 'add' ? (variables.get(key) ?? 0) + amount : amount;
      variables.set(key, next);
      return next;
    },
  };

  return { effects, cooldowns, variables, actions, advance: (ms: number) => { clock += ms; } };
}

function node(id: string, type: string, config?: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, config };
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle };
}

// ── Recettes ─────────────────────────────────────────────────────────────────

const limitedReward: Recipe = {
  trigger: { type: 'OnMessageSend' },
  steps: [
    { id: 'cd', kind: 'cooldown', seconds: 3600, scope: 'member' },
    {
      id: 'give',
      kind: 'action',
      action: 'GiveXp',
      values: { amount: { from: 'number', value: 10 }, member: { from: 'context', path: 'member' } },
    },
  ],
};

describe('délai de récupération dans les recettes', () => {
  test('se compile en un nœud de délai valide', () => {
    const graph = compileRecipe(limitedReward);
    const cooldown = graph.nodes.find((entry) => entry.type === 'Cooldown');

    expect(cooldown?.config).toEqual({ seconds: 3600, scope: 'member' });
    expect(hasBlockingIssue(validateGraph(graph))).toBeFalse();
  });

  test('se relit tel qu il a été écrit', () => {
    expect(decompileGraph(compileRecipe(limitedReward))).toEqual(limitedReward);
  });

  test('un délai dont la sortie « En attente » mène quelque part reste au graphe', () => {
    const graph = compileRecipe(limitedReward);
    graph.nodes.push(node('late', 'SendMessage'));
    graph.edges.push(edge('cd', 'blocked', 'late', 'exec'));

    expect(decompileGraph(graph)).toBeNull();
  });

  test('prévient quand le déclencheur ne fournit pas le membre visé', () => {
    const graph: WorkflowGraph = {
      nodes: [node('t', 'OnSchedule', { cron: '0 9 * * *' }), node('cd', 'Cooldown', { seconds: 60, scope: 'member' })],
      edges: [edge('t', 'next', 'cd', 'exec')],
    };

    const issue = validateGraph(graph).find((entry) => entry.code === 'COOLDOWN_SCOPE');
    expect(issue?.severity).toBe('warning');
    expect(issue?.nodeId).toBe('cd');
  });
});

describe('variables dans les recettes', () => {
  const counting: Recipe = {
    trigger: { type: 'OnMessageSend' },
    steps: [
      {
        id: 'add',
        kind: 'action',
        action: 'AddToVariable',
        values: { amount: { from: 'number', value: 1 }, member: { from: 'context', path: 'member' }, name: { from: 'text', template: 'messages' } },
      },
      {
        id: 'check',
        kind: 'condition',
        match: 'all',
        tests: [{ id: 't1', condition: 'variable.member', name: 'messages', operator: 'gte', value: { from: 'number', value: 10 } }],
        then: [{
          id: 'reset',
          kind: 'action',
          action: 'SetVariable',
          values: { amount: { from: 'number', value: 0 }, name: { from: 'text', template: 'messages' } },
        }],
        otherwise: [],
      },
    ],
  };

  test('se compile en nœuds de variable valides', () => {
    const graph = compileRecipe(counting);

    expect(graph.nodes.find((entry) => entry.id === 'add')?.config).toEqual({ name: 'messages' });
    expect(graph.nodes.some((entry) => entry.type === 'GetVariable' && entry.config?.name === 'messages')).toBeTrue();
    expect(hasBlockingIssue(validateGraph(graph))).toBeFalse();
  });

  test('se relit avec le nom de la variable et sa portée', () => {
    const read = decompileGraph(compileRecipe(counting));
    const condition = read?.steps[1];

    expect(read?.steps[0]).toEqual(counting.steps[0]);
    expect(condition?.kind).toBe('condition');
    if (condition?.kind === 'condition') {
      expect(condition.tests[0]).toMatchObject({ condition: 'variable.member', name: 'messages', operator: 'gte', value: { from: 'number', value: 10 } });
      expect(condition.then).toEqual((counting.steps[1] as { then: unknown }).then);
    }
  });

  test('distingue la variable du serveur de celle du membre', () => {
    const server: Recipe = {
      trigger: { type: 'OnMessageSend' },
      steps: [{
        id: 'check',
        kind: 'condition',
        match: 'all',
        tests: [{ id: 't1', condition: 'variable.server', name: 'total', operator: 'gt', value: { from: 'number', value: 100 } }],
        then: [],
        otherwise: [],
      }],
    };

    const read = decompileGraph(compileRecipe(server));
    const condition = read?.steps[0];
    expect(condition?.kind === 'condition' && condition.tests[0]).toMatchObject({ condition: 'variable.server', name: 'total' });
  });

  test('refuse une variable sans nom', () => {
    const graph = compileRecipe({
      trigger: { type: 'OnMessageSend' },
      steps: [{ id: 'add', kind: 'action', action: 'AddToVariable', values: { amount: { from: 'number', value: 1 } } }],
    });

    expect(validateGraph(graph).some((entry) => entry.code === 'VARIABLE_NAME' && entry.severity === 'error')).toBeTrue();
  });
});

// ── Moteur ───────────────────────────────────────────────────────────────────

describe('moteur : délai de récupération', () => {
  const graph: WorkflowGraph = {
    nodes: [
      node('t', 'OnMessageSend'),
      node('cd', 'Cooldown', { seconds: 60, scope: 'member' }),
      node('ok', 'SendMessage'),
      node('wait', 'SendDM'),
    ],
    edges: [
      edge('t', 'next', 'cd', 'exec'),
      edge('cd', 'next', 'ok', 'exec'),
      edge('cd', 'blocked', 'wait', 'exec'),
    ],
  };

  test('laisse passer une fois, puis bloque jusqu à la fin du délai', async () => {
    const memory = memoryEffects();

    await runWorkflow({ graph, effects: memory.effects, triggerOutputs: { member: alice, channel: general } });
    await runWorkflow({ graph, effects: memory.effects, triggerOutputs: { member: alice, channel: general } });
    memory.advance(61_000);
    await runWorkflow({ graph, effects: memory.effects, triggerOutputs: { member: alice, channel: general } });

    expect(memory.actions).toEqual(['SendMessage', 'SendDM', 'SendMessage']);
  });

  test('compte séparément chaque membre', async () => {
    const memory = memoryEffects();

    await runWorkflow({ graph, effects: memory.effects, triggerOutputs: { member: alice, channel: general } });
    await runWorkflow({ graph, effects: memory.effects, triggerOutputs: { member: bob, channel: general } });

    expect(memory.actions).toEqual(['SendMessage', 'SendMessage']);
  });

  test('un délai pour tout le serveur bloque tout le monde', async () => {
    const memory = memoryEffects();
    const server: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((entry) => (entry.id === 'cd' ? { ...entry, config: { seconds: 60, scope: 'guild' } } : entry)),
    };

    await runWorkflow({ graph: server, effects: memory.effects, triggerOutputs: { member: alice } });
    await runWorkflow({ graph: server, effects: memory.effects, triggerOutputs: { member: bob } });

    expect(memory.actions).toEqual(['SendMessage', 'SendDM']);
  });

  test('consigne l issue du passage', async () => {
    const memory = memoryEffects();
    const result = await runWorkflow({ graph, effects: memory.effects, triggerOutputs: { member: alice } });

    expect(result.steps.find((entry) => entry.nodeId === 'cd')?.outputs).toEqual({ disponible: true });
  });
});

describe('moteur : variables', () => {
  function counter(withMember: boolean): WorkflowGraph {
    return {
      nodes: [
        node('t', 'OnMessageSend'),
        node('n', 'ConstNumber', { value: 2 }),
        node('add', 'AddToVariable', { name: 'points' }),
      ],
      edges: [
        edge('t', 'next', 'add', 'exec'),
        edge('n', 'value', 'add', 'amount'),
        ...(withMember ? [edge('t', 'member', 'add', 'member')] : []),
      ],
    };
  }

  test('ajoute au compteur du membre et rend la nouvelle valeur', async () => {
    const memory = memoryEffects();

    await runWorkflow({ graph: counter(true), effects: memory.effects, triggerOutputs: { member: alice } });
    const result = await runWorkflow({ graph: counter(true), effects: memory.effects, triggerOutputs: { member: alice } });

    expect(memory.variables.get('points:u1')).toBe(4);
    expect(result.steps.find((entry) => entry.nodeId === 'add')?.outputs).toEqual({ value: 4 });
    expect(memory.actions).toEqual([]);
  });

  test('sans membre branché, tient le compteur du serveur', async () => {
    const memory = memoryEffects();

    await runWorkflow({ graph: counter(false), effects: memory.effects, triggerOutputs: { member: alice } });
    await runWorkflow({ graph: counter(false), effects: memory.effects, triggerOutputs: { member: bob } });

    expect(memory.variables.get('points:')).toBe(4);
  });

  test('échoue plutôt que d écrire au serveur quand le membre branché manque', async () => {
    const memory = memoryEffects();

    const result = await runWorkflow({ graph: counter(true), effects: memory.effects, triggerOutputs: {} });

    expect(result.status).toBe('FAILED');
    expect(result.steps.find((entry) => entry.nodeId === 'add')?.status).toBe('ERROR');
    expect(memory.variables.size).toBe(0);
  });

  test('lit la valeur d une variable dans une condition', async () => {
    const memory = memoryEffects();
    memory.variables.set('points:u1', 12);
    const graph: WorkflowGraph = {
      nodes: [
        node('t', 'OnMessageSend'),
        node('get', 'GetVariable', { name: 'points' }),
        node('ten', 'ConstNumber', { value: 10 }),
        node('cmp', 'Compare', { operator: 'gte' }),
        node('if', 'If'),
        node('ok', 'SendMessage'),
      ],
      edges: [
        edge('t', 'next', 'if', 'exec'),
        edge('t', 'member', 'get', 'member'),
        edge('get', 'value', 'cmp', 'a'),
        edge('ten', 'value', 'cmp', 'b'),
        edge('cmp', 'result', 'if', 'condition'),
        edge('if', 'true', 'ok', 'exec'),
      ],
    };

    await runWorkflow({ graph, effects: memory.effects, triggerOutputs: { member: alice } });

    expect(memory.actions).toEqual(['SendMessage']);
  });
});

describe('essai à blanc', () => {
  test('ne réserve aucun délai et n écrit aucune variable', async () => {
    const memory = memoryEffects();
    memory.variables.set('points:u1', 5);
    const dry = createDryRunEffects(memory.effects, { member: alice, channel: general, role: null, message: null });

    expect(await dry.claimCooldown?.('cd', 'u1', 60)).toBeTrue();
    expect(await dry.claimCooldown?.('cd', 'u1', 60)).toBeTrue();
    expect(memory.cooldowns.size).toBe(0);

    expect(await dry.updateVariable?.('points', 'u1', 'add', 3)).toBe(8);
    expect(await dry.updateVariable?.('points', 'u1', 'set', 1)).toBe(1);
    expect(memory.variables.get('points:u1')).toBe(5);
    expect(await dry.getVariable?.('points', 'u1')).toBe(5);
  });
});
