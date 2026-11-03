/**
 * Essai à blanc d'une automatisation : le moteur tourne pour de vrai, lit le
 * serveur pour de vrai, mais aucune action n'atteint Discord. C'est ce qui
 * permet de vérifier une automatisation sans la déclencher.
 */
import { describe, expect, test } from 'bun:test';
import type { WorkflowGraph } from '@kotbo/shared';
import type { WorkflowEffects } from '../../services/features/workflow/engine';
import type { ChannelValue, MemberValue, MessageValue, RoleValue } from '../../services/features/workflow/values';
import {
  createDryRunEffects,
  dryRunWorkflow,
  resolveTestPlan,
  sampleTriggerOutputs,
  type DryRunSample,
} from '../../services/features/workflow/dryRun';

const member: MemberValue = {
  kind: 'Member', id: 'u1', tag: 'Alice#0001', displayName: 'Alice', isBot: false,
  roleIds: [], accountCreatedAt: null, joinedAt: null,
};
const channel: ChannelValue = { kind: 'Channel', id: 'c1', name: 'general', categoryName: null };
const role: RoleValue = { kind: 'Role', id: 'r1', name: 'Membre' };
const message: MessageValue = { kind: 'Message', id: 'm1', content: 'Bonjour', channelId: 'c1', authorId: 'u1' };
const sample: DryRunSample = { member, channel, role, message };

function realEffects() {
  const actions: string[] = [];
  const effects: WorkflowEffects = {
    getRole: async (id) => (id ? { kind: 'Role', id, name: `role-${id}` } : null),
    getChannel: async (id) => (id ? { kind: 'Channel', id, name: `salon-${id}`, categoryName: null } : null),
    getMember: async (id) => (id ? { ...member, id } : null),
    getGuildInfo: async () => ({ name: 'Serveur', memberCount: 10 }),
    runAction: async (type) => {
      actions.push(type);
      return {};
    },
  };
  return { effects, actions };
}

function node(id: string, type: string, config?: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, config };
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle };
}

describe('sampleTriggerOutputs', () => {
  test('remplit chaque sortie du déclencheur selon son type', () => {
    const outputs = sampleTriggerOutputs('OnVoiceLeave', sample);

    expect(outputs.member).toEqual(member);
    expect(outputs.channel).toEqual(channel);
    expect(typeof outputs.minutes).toBe('number');
    expect(outputs).not.toHaveProperty('next');
  });

  test('donne un texte d exemple aux sorties textuelles', () => {
    const outputs = sampleTriggerOutputs('OnTicketCreated', sample);
    expect(typeof outputs.subject).toBe('string');
    expect((outputs.subject as string).length).toBeGreaterThan(0);
  });

  test('un déclencheur inconnu ne produit rien', () => {
    expect(sampleTriggerOutputs('TypeInconnu', sample)).toEqual({});
  });
});

describe('createDryRunEffects', () => {
  test('n exécute aucune action réelle', async () => {
    const { effects, actions } = realEffects();
    const dry = createDryRunEffects(effects, sample);

    await dry.runAction('SendMessage', { channel, text: 'x' }, {});
    await dry.runAction('BanMember', { member }, {});

    expect(actions).toEqual([]);
  });

  test('garde les vraies lectures du serveur', async () => {
    const { effects } = realEffects();
    const dry = createDryRunEffects(effects, sample);

    expect((await dry.getRole('r9'))?.name).toBe('role-r9');
    expect((await dry.getGuildInfo()).memberCount).toBe(10);
  });

  test('rend des sorties d exemple aux actions qui en ont', async () => {
    const { effects } = realEffects();
    const dry = createDryRunEffects(effects, sample);

    const thread = await dry.runAction('CreateThread', { channel, name: 'Suivi' }, {});
    const coins = await dry.runAction('GiveCoins', { member, amount: 10 }, {});

    expect((thread.thread as ChannelValue).kind).toBe('Channel');
    expect(typeof coins.balance).toBe('number');
  });
});

describe('dryRunWorkflow', () => {
  const welcome: WorkflowGraph = {
    nodes: [node('t', 'OnMemberJoin'), node('r', 'SelectRole', { roleId: 'r9' }), node('a', 'AddRole')],
    edges: [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member'), edge('r', 'role', 'a', 'role')],
  };

  test('parcourt le graphe sans toucher au serveur', async () => {
    const { effects, actions } = realEffects();

    const result = await dryRunWorkflow({
      graph: welcome,
      effects: createDryRunEffects(effects, sample),
      triggerOutputs: { member },
    });

    expect(result.status).toBe('COMPLETED');
    expect(actions).toEqual([]);
    expect(result.steps.map((step) => step.nodeType)).toContain('AddRole');
  });

  test('franchit les attentes au lieu de s y arrêter', async () => {
    const { effects } = realEffects();
    const delayed: WorkflowGraph = {
      nodes: [node('t', 'OnMemberJoin'), node('d', 'Delay', { seconds: 3600 }), node('r', 'SelectRole', { roleId: 'r9' }), node('a', 'AddRole')],
      edges: [
        edge('t', 'next', 'd', 'exec'),
        edge('d', 'next', 'a', 'exec'),
        edge('t', 'member', 'a', 'member'),
        edge('r', 'role', 'a', 'role'),
      ],
    };

    const result = await dryRunWorkflow({
      graph: delayed,
      effects: createDryRunEffects(effects, sample),
      triggerOutputs: { member },
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.steps.map((step) => step.nodeType)).toEqual(expect.arrayContaining(['Delay', 'AddRole']));
    // Les rangs se suivent d'une reprise à l'autre.
    const orders = result.steps.map((step) => step.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  test('signale l action qui échouerait faute d entrée', async () => {
    const { effects, actions } = realEffects();
    const broken: WorkflowGraph = {
      nodes: [node('t', 'OnMemberJoin'), node('a', 'AddRole')],
      edges: [edge('t', 'next', 'a', 'exec'), edge('t', 'member', 'a', 'member')],
    };

    const result = await dryRunWorkflow({
      graph: broken,
      effects: createDryRunEffects(effects, sample),
      triggerOutputs: { member },
    });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('Rôle');
    expect(result.steps.find((step) => step.nodeId === 'a')?.status).toBe('ERROR');
    expect(actions).toEqual([]);
  });
});

describe('resolveTestPlan', () => {
  test('sans membre choisi, celui qui lance l essai joue le membre', () => {
    expect(resolveTestPlan({ userId: 'u1', source: 'last' })).toEqual({ memberId: 'u1', source: 'last', chosen: false });
  });

  test('un membre choisi joue l événement, qui devient un exemple', () => {
    // La dernière exécution porte son propre membre : la rejouer ignorerait
    // le choix.
    expect(resolveTestPlan({ userId: 'u1', memberId: 'u2', source: 'last' })).toEqual({ memberId: 'u2', source: 'sample', chosen: true });
  });

  test('un membre vide compte comme aucun choix', () => {
    expect(resolveTestPlan({ userId: 'u1', memberId: '', source: 'sample' })).toEqual({ memberId: 'u1', source: 'sample', chosen: false });
  });
});
