/**
 * Essai à blanc d'une automatisation.
 *
 * Le moteur tourne comme en production et lit le serveur pour de vrai (membres,
 * rôles, salons), mais aucune action ne part : chacune est seulement consignée
 * avec les valeurs qu'elle aurait reçues. Une automatisation se vérifie ainsi
 * sans attendre que son événement survienne, et sans en subir les effets.
 */
import { getNodeDef, type PortDef, type WorkflowGraph } from '@kotbo/shared';
import { runWorkflow, type ExecutionOutcome, type StepRecord, type WorkflowEffects } from './engine.js';
import type { ChannelValue, MemberValue, MessageValue, RoleValue } from './values.js';

/** Entités d'exemple dont l'essai remplit l'événement et les sorties d'actions. */
export interface DryRunSample {
  member: MemberValue | null;
  channel: ChannelValue | null;
  role: RoleValue | null;
  message: MessageValue | null;
}

const SAMPLE_TEXT = 'Exemple';
const SAMPLE_NUMBER = 1;

function sampleForPort(port: PortDef, sample: DryRunSample): unknown {
  switch (port.type) {
    case 'Member': return sample.member;
    case 'Channel': return sample.channel;
    case 'Role': return sample.role;
    case 'Message': return sample.message;
    case 'String': return SAMPLE_TEXT;
    case 'Number': return SAMPLE_NUMBER;
    case 'Boolean': return true;
    case 'List': return [];
    default: return null;
  }
}

function sampleOutputs(ports: PortDef[], sample: DryRunSample): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const port of ports) {
    if (port.type === 'Exec') continue;
    outputs[port.id] = sampleForPort(port, sample);
  }
  return outputs;
}

/**
 * Événement d'exemple : chaque sortie du déclencheur reçoit une valeur de son
 * type. Il n'a pas à être réaliste, seulement à alimenter chaque étape.
 */
export function sampleTriggerOutputs(triggerType: string, sample: DryRunSample): Record<string, unknown> {
  const def = getNodeDef(triggerType);
  return def ? sampleOutputs(def.outputs, sample) : {};
}

const ENTITY_TYPES = new Set(['Member', 'Role', 'Channel', 'Message']);

/**
 * Effets de l'essai : lectures réelles, actions consignées, ni délai réservé
 * ni variable écrite.
 *
 * Une action dont une entrée obligatoire arrive vide échoue comme elle le ferait
 * en production (membre parti, rôle supprimé) : c'est précisément ce que
 * l'essai doit montrer, et la validation du graphe ne peut pas le voir.
 */
export function createDryRunEffects(real: WorkflowEffects, sample: DryRunSample): WorkflowEffects {
  return {
    getRole: (roleId) => real.getRole(roleId),
    getChannel: (channelId) => real.getChannel(channelId),
    getMember: (userId) => real.getMember(userId),
    getGuildInfo: () => real.getGuildInfo(),
    // Un essai ne réserve aucun délai : il passe toujours, sans gêner le
    // prochain vrai déclenchement.
    claimCooldown: async () => true,
    getVariable: async (name, subject) => (real.getVariable ? real.getVariable(name, subject) : 0),
    // Calcule la valeur qui serait écrite, à partir de la vraie, sans l'écrire.
    async updateVariable(name, subject, operation, amount) {
      if (operation === 'set') return amount;
      const current = real.getVariable ? await real.getVariable(name, subject) : 0;
      return current + amount;
    },
    async runAction(type, inputs) {
      const def = getNodeDef(type);
      if (!def) return {};
      for (const port of def.inputs) {
        if (port.optional || !ENTITY_TYPES.has(port.type)) continue;
        if (inputs[port.id] === null || inputs[port.id] === undefined) {
          throw new Error(`« ${port.label} » est vide : ${def.label} échouerait.`);
        }
      }
      return sampleOutputs(def.outputs, sample);
    },
  };
}

export interface TestPlanInput {
  /** Membre qui lance l'essai. */
  userId: string;
  /** Membre choisi pour jouer l'événement, s'il y en a un. */
  memberId?: string | null;
  source: 'sample' | 'last';
}

export interface TestPlan {
  memberId: string;
  source: 'sample' | 'last';
  /** Le membre a été choisi, et non pris par défaut. */
  chosen: boolean;
}

/**
 * Qui joue le membre de l'événement, et sur quel événement.
 *
 * Un membre choisi impose un événement d'exemple : la dernière exécution porte
 * son propre membre, et la rejouer ignorerait le choix.
 */
export function resolveTestPlan(input: TestPlanInput): TestPlan {
  if (input.memberId) return { memberId: input.memberId, source: 'sample', chosen: true };
  return { memberId: input.userId, source: input.source, chosen: false };
}

export interface DryRunOptions {
  graph: WorkflowGraph;
  effects: WorkflowEffects;
  triggerOutputs: Record<string, unknown>;
  /** Plafond de reprises après un « Attendre », au cas où le graphe en enchaîne beaucoup. */
  maxResumes?: number;
}

export interface DryRunResult {
  status: ExecutionOutcome['status'];
  steps: StepRecord[];
  error: string | null;
}

/**
 * Parcourt le graphe d'un bout à l'autre. Une attente n'y suspend rien : elle
 * est consignée, puis l'essai reprend aussitôt là où la vraie exécution
 * reprendrait plus tard.
 */
export async function dryRunWorkflow(options: DryRunOptions): Promise<DryRunResult> {
  const maxResumes = options.maxResumes ?? 20;
  const steps: StepRecord[] = [];

  let outcome = await runWorkflow({
    graph: options.graph,
    effects: options.effects,
    triggerOutputs: options.triggerOutputs,
  });
  steps.push(...outcome.steps);

  for (let resumes = 0; outcome.status === 'SUSPENDED' && resumes < maxResumes; resumes++) {
    outcome = await runWorkflow({ graph: options.graph, effects: options.effects, state: outcome.state });
    steps.push(...outcome.steps);
  }

  return {
    status: outcome.status,
    steps,
    error: outcome.status === 'FAILED' ? outcome.error : null,
  };
}
