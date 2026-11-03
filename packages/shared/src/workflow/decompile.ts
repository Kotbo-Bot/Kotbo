/**
 * Lecture d'un graphe en recette - le chemin inverse de `compile.ts`.
 *
 * C'est ce qui rend la bascule liste ↔ graphe possible et ce qui reprend
 * automatiquement les workflows créés avec l'ancien éditeur : un graphe écrit à
 * la main est relu comme une suite de phrases dès qu'il en a la forme.
 *
 * La fonction est volontairement stricte. Au moindre motif qu'elle ne sait pas
 * nommer - une boucle, un aiguillage, un nœud orphelin - elle renvoie `null`
 * plutôt qu'une recette approximative : l'interface bascule alors sur la vue
 * graphe, où rien n'est perdu. Une lecture partielle qui effacerait des nœuds à
 * l'enregistrement serait bien pire qu'un refus franc.
 */

import { getNodeDef, isCooldownScope, isTriggerNode, normalizeVariableName } from './catalog.js';
import { CONDITION_LIBRARY, getAction, INFO_NODES } from './library.js';
import {
  newStepId,
  type ActionStep,
  type ConditionStep,
  type ConditionTest,
  type Recipe,
  type RecipeStep,
  type ValueRef,
} from './recipe.js';
import type { WorkflowGraph, WorkflowNode } from './types.js';

interface Source {
  node: WorkflowNode;
  portId: string;
}

class Reader {
  private readonly byId: Map<string, WorkflowNode>;
  /** Nœuds reconnus, pour détecter ce qui resterait sur le carreau */
  readonly consumed = new Set<string>();

  constructor(private readonly graph: WorkflowGraph, private readonly trigger: WorkflowNode) {
    this.byId = new Map(graph.nodes.map((node) => [node.id, node]));
  }

  /** Nœud branché sur une entrée, s'il y en a un. */
  incoming(nodeId: string, portId: string): Source | null {
    const edge = this.graph.edges.find((e) => e.target === nodeId && e.targetHandle === portId);
    if (!edge) return null;
    const node = this.byId.get(edge.source);
    return node ? { node, portId: edge.sourceHandle } : null;
  }

  /** Nœud atteint par une sortie d'exécution. */
  next(nodeId: string, portId: string): WorkflowNode | null {
    const edge = this.graph.edges.find((e) => e.source === nodeId && e.sourceHandle === portId);
    return edge ? this.byId.get(edge.target) ?? null : null;
  }

  // ── Valeurs ─────────────────────────────────────────────────────────────

  /** Chemin de contexte porté par une source, ou `null` si ce n'en est pas une. */
  contextPath(source: Source): string | null {
    if (source.node.id === this.trigger.id) {
      this.consumed.add(source.node.id);
      return source.portId;
    }

    if (source.node.type === 'GuildInfo') {
      this.consumed.add(source.node.id);
      return `guild.${source.portId}`;
    }

    if (source.node.type === 'RunInfo') {
      this.consumed.add(source.node.id);
      return `run.${source.portId}`;
    }

    const owner = Object.entries(INFO_NODES).find(([, info]) => info.node === source.node.type);
    if (!owner) return null;

    const [, info] = owner;
    const root = this.incoming(source.node.id, info.input);
    // Un nœud d'accès dont l'entité ne vient pas du déclencheur sort du modèle
    // linéaire : on refuse plutôt que d'inventer un chemin.
    if (!root || root.node.id !== this.trigger.id) return null;

    this.consumed.add(source.node.id);
    this.consumed.add(root.node.id);
    return `${root.portId}.${source.portId}`;
  }

  value(source: Source): ValueRef | null {
    const path = this.contextPath(source);
    if (path) return { from: 'context', path };

    const config = source.node.config ?? {};

    switch (source.node.type) {
      case 'ConstText':
        this.consumed.add(source.node.id);
        return { from: 'text', template: String(config.value ?? '') };

      case 'ConstNumber':
        this.consumed.add(source.node.id);
        return { from: 'number', value: Number(config.value ?? 0) };

      case 'ConstBoolean':
        this.consumed.add(source.node.id);
        return { from: 'boolean', value: Boolean(config.value) };

      case 'SelectRole':
        this.consumed.add(source.node.id);
        return { from: 'role', roleId: String(config.roleId ?? '') };

      case 'SelectChannel':
        this.consumed.add(source.node.id);
        return { from: 'channel', channelId: String(config.channelId ?? '') };

      case 'FormatText':
        return this.formatText(source.node);

      case 'GetVariable':
        return this.variable(source.node);

      default:
        return null;
    }
  }

  /**
   * Une variable n'est lisible en phrase que pour le membre du déclencheur ou
   * pour tout le serveur : un membre venu d'ailleurs sort du modèle.
   */
  private variable(node: WorkflowNode): ValueRef | null {
    const name = normalizeVariableName(node.config?.name);
    if (!name) return null;

    const member = this.incoming(node.id, 'member');
    if (member && (member.node.id !== this.trigger.id || member.portId !== 'member')) return null;

    this.consumed.add(node.id);
    return { from: 'variable', name, scope: member ? 'member' : 'server' };
  }

  /** Reconstitue le texte d'origine en réinjectant les chemins dans le gabarit. */
  private formatText(node: WorkflowNode): ValueRef | null {
    const slots = Array.isArray(node.config?.slots) ? (node.config.slots as { id: string }[]) : [];
    let template = String(node.config?.template ?? '');

    for (const slot of slots) {
      const source = this.incoming(node.id, slot.id);
      const path = source ? this.contextPath(source) : null;
      if (!path) return null;
      template = template.split(`{${slot.id}}`).join(`{${path}}`);
    }

    this.consumed.add(node.id);
    return { from: 'text', template };
  }

  // ── Conditions ──────────────────────────────────────────────────────────

  /**
   * Lit l'arbre booléen alimentant un « Si ».
   *
   * Les combinaisons mélangeant ET et OU n'ont pas d'équivalent dans la liste
   * de tests - qui n'offre qu'un seul opérateur pour toute l'étape - et sont
   * donc refusées.
   */
  tests(source: Source, expected: 'and' | 'or' | null): { match: 'all' | 'any'; tests: ConditionTest[] } | null {
    if (source.node.type === 'Logic') {
      const operator = source.node.config?.operator === 'or' ? 'or' : 'and';
      if (expected && operator !== expected) return null;

      const left = this.incoming(source.node.id, 'a');
      const right = this.incoming(source.node.id, 'b');
      if (!left || !right) return null;

      const a = this.tests(left, operator);
      const b = this.tests(right, operator);
      if (!a || !b) return null;

      this.consumed.add(source.node.id);
      return { match: operator === 'or' ? 'any' : 'all', tests: [...a.tests, ...b.tests] };
    }

    const single = this.test(source);
    if (!single) return null;
    return { match: expected === 'or' ? 'any' : 'all', tests: [single] };
  }

  private test(source: Source): ConditionTest | null {
    if (source.node.type === 'Not') {
      const inner = this.incoming(source.node.id, 'value');
      if (!inner) return null;
      const test = this.test(inner);
      if (!test) return null;
      this.consumed.add(source.node.id);
      return { ...test, negate: !test.negate };
    }

    for (const def of CONDITION_LIBRARY) {
      const operator = String(source.node.config?.operator ?? def.defaultOperator ?? '');
      const shape = def.build({ id: '', condition: def.key, operator });

      if ('direct' in shape) {
        if (shape.direct.from !== 'context') continue;
        if (this.contextPath(source) !== shape.direct.path) continue;
        return { id: newStepId('t'), condition: def.key };
      }

      if (shape.node !== source.node.type) continue;

      // Les entrées fixées par la condition doivent correspondre exactement ;
      // celle qui reste porte la valeur saisie par l'utilisateur.
      let matches = true;
      let value: ValueRef | undefined;
      let name: string | undefined;

      for (const [portId, ref] of Object.entries(shape.inputs)) {
        const wired = this.incoming(source.node.id, portId);
        if (!wired) { matches = false; break; }

        if (ref.from === 'context') {
          if (this.contextPath(wired) !== ref.path) { matches = false; break; }
        } else if (ref.from === 'variable') {
          // Le nom de la variable est porté par la condition, pas par sa valeur.
          if (wired.node.type !== 'GetVariable') { matches = false; break; }
          const read = this.value(wired);
          if (read?.from !== 'variable' || read.scope !== ref.scope) { matches = false; break; }
          name = read.name;
        } else {
          const read = this.value(wired);
          if (!read) { matches = false; break; }
          value = read;
        }
      }

      if (!matches) continue;

      this.consumed.add(source.node.id);
      return {
        id: newStepId('t'),
        condition: def.key,
        ...(def.operators ? { operator } : {}),
        ...(value ? { value } : {}),
        ...(name ? { name } : {}),
      };
    }

    return null;
  }

  // ── Étapes ──────────────────────────────────────────────────────────────

  steps(from: WorkflowNode | null): RecipeStep[] | null {
    const out: RecipeStep[] = [];
    let current = from;

    while (current) {
      const def = getNodeDef(current.type);
      if (!def) return null;

      if (current.type === 'Delay') {
        // Une attente dont la durée vient d'un fil n'est pas exprimable par le
        // champ « secondes » de l'étape.
        if (this.incoming(current.id, 'seconds')) return null;
        this.consumed.add(current.id);
        out.push({ id: current.id, kind: 'wait', seconds: Number(current.config?.seconds ?? 60) });
        current = this.next(current.id, 'next');
        continue;
      }

      if (current.type === 'Cooldown') {
        // Une sortie « En attente » branchée n'a pas d'équivalent en phrase.
        if (this.next(current.id, 'blocked')) return null;
        const scope = current.config?.scope;
        this.consumed.add(current.id);
        out.push({
          id: current.id,
          kind: 'cooldown',
          seconds: Number(current.config?.seconds ?? 3600),
          scope: isCooldownScope(scope) ? scope : 'member',
        });
        current = this.next(current.id, 'next');
        continue;
      }

      if (current.type === 'If') {
        const step = this.condition(current);
        if (!step) return null;
        out.push(step);
        // Les deux branches consomment la suite : rien ne peut suivre un « Si ».
        return out;
      }

      if (def.category === 'action') {
        const step = this.action(current);
        if (!step) return null;
        out.push(step);
        current = this.next(current.id, 'next');
        continue;
      }

      return null;
    }

    return out;
  }

  private condition(node: WorkflowNode): ConditionStep | null {
    const wired = this.incoming(node.id, 'condition');
    const read = wired ? this.tests(wired, null) : { match: 'all' as const, tests: [] };
    if (!read) return null;

    const then = this.steps(this.next(node.id, 'true'));
    const otherwise = this.steps(this.next(node.id, 'false'));
    if (!then || !otherwise) return null;

    this.consumed.add(node.id);
    return { id: node.id, kind: 'condition', match: read.match, tests: read.tests, then, otherwise };
  }

  private action(node: WorkflowNode): ActionStep | null {
    const def = getAction(node.type);
    if (!def) return null;

    const values: Record<string, ValueRef> = {};

    for (const field of def.fields) {
      // Un réglage revient dans `values`, là où l'éditeur le lit : rangé à part,
      // il réapparaissait vide à la réouverture (couleur d'embed, nom de variable).
      if (field.option) {
        const stored = node.config?.[field.key];
        if (stored === undefined || stored === '') continue;
        values[field.key] = field.kind === 'number'
          ? { from: 'number', value: Number(stored) }
          : { from: 'text', template: String(stored) };
        continue;
      }

      const wired = this.incoming(node.id, field.key);
      if (!wired) continue;

      const value = this.value(wired);
      if (!value) return null;
      values[field.key] = value;
    }

    this.consumed.add(node.id);
    return {
      id: node.id,
      kind: 'action',
      action: node.type,
      values,
    };
  }
}

/**
 * Traduit un graphe en recette, ou renvoie `null` s'il sort du modèle linéaire.
 */
export function decompileGraph(graph: WorkflowGraph): Recipe | null {
  const triggers = graph.nodes.filter((node) => isTriggerNode(node.type));
  if (triggers.length !== 1) return null;

  const trigger = triggers[0];
  const reader = new Reader(graph, trigger);
  reader.consumed.add(trigger.id);

  const steps = reader.steps(reader.next(trigger.id, 'next'));
  if (!steps) return null;

  // Un nœud laissé de côté serait perdu au réenregistrement : on préfère la
  // vue graphe, qui le conserve.
  if (reader.consumed.size !== graph.nodes.length) return null;

  const config = trigger.config ?? {};

  return {
    trigger: { type: trigger.type, ...(Object.keys(config).length > 0 ? { config } : {}) },
    steps,
  };
}

/** Le graphe est-il lisible comme une suite de phrases ? */
export function isLinear(graph: WorkflowGraph): boolean {
  return decompileGraph(graph) !== null;
}
