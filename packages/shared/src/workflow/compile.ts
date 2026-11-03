/**
 * Compilation d'une recette vers le graphe exécuté par le bot.
 *
 * Tout ce que l'éditeur simple sait faire finit ici, traduit en nœuds et en
 * fils. Deux principes gouvernent la traduction :
 *
 *  - **Les identifiants sont déterministes.** Un nœud d'étape porte
 *    l'identifiant de l'étape, un nœud auxiliaire porte celui de son
 *    propriétaire suffixé. Recompiler une recette inchangée redonne exactement
 *    le même graphe, ce qui évite de réécrire la base à chaque frappe et permet
 *    de rattacher une erreur de validation à l'étape qui l'a causée.
 *
 *  - **Les nœuds auxiliaires sont mutualisés.** Deux étapes qui lisent le
 *    pseudo du membre partagent le même « Infos du membre », sinon une recette
 *    de dix lignes exploserait le budget de nœuds.
 */

import { getNodeDef, normalizeVariableName } from './catalog.js';
import { getAction, getCondition, INFO_NODES } from './library.js';
import {
  templateTokens,
  type ActionStep,
  type ConditionStep,
  type ConditionTest,
  type Recipe,
  type RecipeStep,
  type ValueRef,
  type VariableScope,
} from './recipe.js';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from './types.js';

/** Un point de branchement : un port de sortie d'un nœud. */
interface Outlet {
  nodeId: string;
  portId: string;
}

export const TRIGGER_NODE_ID = 'trigger';

/** Étape à l'origine d'un nœud compilé, pour rattacher erreurs et surbrillance. */
export function stepIdOfNode(nodeId: string): string {
  return nodeId.split('__')[0];
}

const COLUMN_WIDTH = 380;
const ROW_HEIGHT = 170;

class GraphBuilder {
  private readonly nodes = new Map<string, WorkflowNode>();
  private readonly edges: WorkflowEdge[] = [];
  /** Nœuds auxiliaires déjà créés, indexés par leur clé de mutualisation */
  private readonly shared = new Map<string, Outlet>();
  /** Compteur d'empilement des nœuds de données d'une même colonne */
  private readonly dataRows = new Map<number, number>();

  node(id: string, type: string, config: Record<string, unknown>, x: number, y: number): string {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, type, position: { x, y }, config });
    }
    return id;
  }

  /** Position libre pour un nœud de données, à gauche de la colonne courante. */
  dataPosition(column: number): { x: number; y: number } {
    const row = this.dataRows.get(column) ?? 0;
    this.dataRows.set(column, row + 1);
    return { x: column * COLUMN_WIDTH - COLUMN_WIDTH, y: row * 120 - 260 };
  }

  connect(from: Outlet, to: { nodeId: string; portId: string }): void {
    const id = `${from.nodeId}:${from.portId}->${to.nodeId}:${to.portId}`;
    if (this.edges.some((edge) => edge.id === id)) return;
    this.edges.push({
      id,
      source: from.nodeId,
      sourceHandle: from.portId,
      target: to.nodeId,
      targetHandle: to.portId,
    });
  }

  memo(key: string, create: () => Outlet): Outlet {
    const existing = this.shared.get(key);
    if (existing) return existing;
    const created = create();
    this.shared.set(key, created);
    return created;
  }

  build(): WorkflowGraph {
    return { nodes: [...this.nodes.values()], edges: this.edges };
  }
}

// ============================================================================
// VALEURS
// ============================================================================

/** Empreinte courte et stable d'une chaîne, pour identifier une constante. */
function hash(input: string): string {
  let value = 0;
  for (let i = 0; i < input.length; i++) {
    value = (value * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(value).toString(36);
}

class Compiler {
  constructor(
    private readonly builder: GraphBuilder,
    private readonly triggerType: string,
  ) {}

  /**
   * Branche une valeur du contexte et renvoie le port qui la porte.
   *
   * Un chemin simple (`member`) sort directement du déclencheur ; un chemin
   * composé (`member.tag`) passe par le nœud d'accès correspondant, créé une
   * seule fois pour toute la recette.
   */
  private contextOutlet(path: string, column: number): Outlet | null {
    const [root, property] = path.split('.');

    if (root === 'guild') {
      const infoId = this.builder.memo('info:guild', () => {
        const at = this.builder.dataPosition(column);
        this.builder.node('ctx__guild', 'GuildInfo', {}, at.x, at.y);
        return { nodeId: 'ctx__guild', portId: property };
      });
      return { nodeId: infoId.nodeId, portId: property };
    }

    if (root === 'run') {
      const infoId = this.builder.memo('info:run', () => {
        const at = this.builder.dataPosition(column);
        this.builder.node('ctx__run', 'RunInfo', {}, at.x, at.y);
        return { nodeId: 'ctx__run', portId: property };
      });
      return { nodeId: infoId.nodeId, portId: property };
    }

    const triggerDef = getNodeDef(this.triggerType);
    const rootPort = triggerDef?.outputs.find((port) => port.id === root);
    if (!rootPort) return null;

    if (!property) return { nodeId: TRIGGER_NODE_ID, portId: root };

    const info = INFO_NODES[rootPort.type];
    if (!info) return null;

    const infoNodeId = `ctx__${root}`;
    this.builder.memo(`info:${root}`, () => {
      const at = this.builder.dataPosition(column);
      this.builder.node(infoNodeId, info.node, {}, at.x, at.y);
      this.builder.connect(
        { nodeId: TRIGGER_NODE_ID, portId: root },
        { nodeId: infoNodeId, portId: info.input },
      );
      return { nodeId: infoNodeId, portId: property };
    });

    return { nodeId: infoNodeId, portId: property };
  }

  /**
   * Branche une valeur littérale, mutualisée entre toutes ses utilisations :
   * deux étapes qui écrivent dans le même salon partagent le même sélecteur.
   */
  private literalOutlet(ref: ValueRef, column: number): Outlet | null {
    const place = (id: string, type: string, config: Record<string, unknown>, portId: string): Outlet => (
      this.builder.memo(id, () => {
        const at = this.builder.dataPosition(column);
        this.builder.node(id, type, config, at.x, at.y);
        return { nodeId: id, portId };
      })
    );

    switch (ref.from) {
      case 'role':
        return ref.roleId ? place(`lit__role_${ref.roleId}`, 'SelectRole', { roleId: ref.roleId }, 'role') : null;
      case 'channel':
        return ref.channelId
          ? place(`lit__chan_${ref.channelId}`, 'SelectChannel', { channelId: ref.channelId }, 'channel')
          : null;
      case 'number':
        return place(`lit__num_${hash(String(ref.value))}`, 'ConstNumber', { value: ref.value }, 'value');
      case 'boolean':
        return place(`lit__bool_${ref.value}`, 'ConstBoolean', { value: ref.value }, 'value');
      case 'variable':
        return this.variableOutlet(ref.name, ref.scope, column);
      default:
        return null;
    }
  }

  /**
   * Lecture d'une variable, mutualisée par nom et par portée. Celle d'un membre
   * reçoit le membre du déclencheur ; celle du serveur n'en reçoit aucun.
   */
  private variableOutlet(rawName: string, scope: VariableScope, column: number): Outlet | null {
    const name = normalizeVariableName(rawName);
    if (!name) return null;

    const id = `var__${scope}_${hash(name)}`;
    return this.builder.memo(id, () => {
      const at = this.builder.dataPosition(column);
      this.builder.node(id, 'GetVariable', { name }, at.x, at.y);
      if (scope === 'member') {
        const member = this.contextOutlet('member', column);
        if (member) this.builder.connect(member, { nodeId: id, portId: 'member' });
      }
      return { nodeId: id, portId: 'value' };
    });
  }

  /**
   * Branche un texte.
   *
   * Sans jeton, c'est une constante mutualisable. Avec jetons, chaque `{chemin}`
   * devient un emplacement du nœud « Texte composé », alimenté par la valeur du
   * contexte correspondante. Le gabarit stocké ne contient que des noms
   * d'emplacements, ce qui le rend insensible au renommage des chemins.
   */
  private textOutlet(template: string, ownerId: string, field: string, column: number): Outlet | null {
    if (template.trim() === '') return null;

    const tokens = templateTokens(template).filter((path) => this.contextOutlet(path, column) !== null);

    if (tokens.length === 0) {
      const id = `lit__text_${hash(template)}`;
      return this.builder.memo(id, () => {
        const at = this.builder.dataPosition(column);
        this.builder.node(id, 'ConstText', { value: template }, at.x, at.y);
        return { nodeId: id, portId: 'value' };
      });
    }

    const nodeId = `${ownerId}__fmt_${field}`;
    const slots = tokens.map((path, index) => ({ id: `slot${index}`, label: path }));
    let compiled = template;
    tokens.forEach((path, index) => {
      compiled = compiled.split(`{${path}}`).join(`{slot${index}}`);
    });

    const at = this.builder.dataPosition(column);
    this.builder.node(nodeId, 'FormatText', { template: compiled, slots }, at.x, at.y);

    tokens.forEach((path, index) => {
      const source = this.contextOutlet(path, column);
      if (source) this.builder.connect(source, { nodeId, portId: `slot${index}` });
    });

    return { nodeId, portId: 'value' };
  }

  /** Port portant la valeur, ou `null` si le champ est vide. */
  outletFor(ref: ValueRef | undefined, ownerId: string, field: string, column: number): Outlet | null {
    if (!ref) return null;
    if (ref.from === 'context') return ref.path ? this.contextOutlet(ref.path, column) : null;
    if (ref.from === 'text') return this.textOutlet(ref.template, ownerId, field, column);
    return this.literalOutlet(ref, column);
  }

  // ── Conditions ──────────────────────────────────────────────────────────

  /**
   * Assemble les tests d'une étape conditionnelle en un unique port booléen.
   *
   * Les tests sont combinés deux à deux, de gauche à droite : `A et B et C`
   * devient `(A et B) et C`. Sans test, il n'y a pas de port à renvoyer et la
   * condition sera signalée comme incomplète par la validation.
   */
  conditionOutlet(step: ConditionStep, column: number): Outlet | null {
    const outlets = step.tests
      .map((test, index) => this.testOutlet(step.id, test, index, column))
      .filter((outlet): outlet is Outlet => outlet !== null);

    if (outlets.length === 0) return null;

    return outlets.reduce((left, right, index) => {
      const nodeId = `${step.id}__join${index}`;
      const at = this.builder.dataPosition(column);
      this.builder.node(nodeId, 'Logic', { operator: step.match === 'any' ? 'or' : 'and' }, at.x, at.y);
      this.builder.connect(left, { nodeId, portId: 'a' });
      this.builder.connect(right, { nodeId, portId: 'b' });
      return { nodeId, portId: 'result' };
    });
  }

  private testOutlet(stepId: string, test: ConditionTest, index: number, column: number): Outlet | null {
    const def = getCondition(test.condition);
    if (!def) return null;

    const shape = def.build(test);
    const ownerId = `${stepId}__test${index}`;

    let outlet: Outlet | null;

    if ('direct' in shape) {
      outlet = this.outletFor(shape.direct, ownerId, 'value', column);
    } else {
      const at = this.builder.dataPosition(column);
      this.builder.node(ownerId, shape.node, shape.config ?? {}, at.x, at.y);

      for (const [portId, ref] of Object.entries(shape.inputs)) {
        const source = this.outletFor(ref, ownerId, portId, column);
        if (source) this.builder.connect(source, { nodeId: ownerId, portId });
      }
      outlet = { nodeId: ownerId, portId: 'result' };
    }

    if (!outlet || !test.negate) return outlet;

    const notId = `${ownerId}__not`;
    const at = this.builder.dataPosition(column);
    this.builder.node(notId, 'Not', {}, at.x, at.y);
    this.builder.connect(outlet, { nodeId: notId, portId: 'value' });
    return { nodeId: notId, portId: 'result' };
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  compileAction(step: ActionStep, column: number, row: number): void {
    const def = getAction(step.action);
    if (!def) return;

    const config: Record<string, unknown> = { ...(step.options ?? {}) };
    for (const field of def.fields) {
      if (!field.option) continue;
      const ref = step.values[field.key];
      if (ref && 'value' in ref) config[field.key] = ref.value;
      if (ref && ref.from === 'text') config[field.key] = ref.template;
    }

    this.builder.node(step.id, step.action, config, column * COLUMN_WIDTH, row * ROW_HEIGHT);

    for (const field of def.fields) {
      if (field.option) continue;
      const source = this.outletFor(step.values[field.key], step.id, field.key, column);
      if (source) this.builder.connect(source, { nodeId: step.id, portId: field.key });
    }
  }
}

// ============================================================================
// COMPILATION
// ============================================================================

export function compileRecipe(recipe: Recipe): WorkflowGraph {
  const builder = new GraphBuilder();
  const compiler = new Compiler(builder, recipe.trigger.type);

  if (!recipe.trigger.type) return builder.build();

  builder.node(TRIGGER_NODE_ID, recipe.trigger.type, recipe.trigger.config ?? {}, 0, 0);

  /**
   * Émet une suite d'étapes et renvoie le port d'exécution laissé libre à la
   * fin, pour que l'appelant y raccorde la suite. Une branche vide renvoie son
   * propre point d'entrée : la suite se raccorde alors directement en amont.
   */
  function emit(steps: RecipeStep[], entry: Outlet, column: number, startRow: number): Outlet | null {
    let previous: Outlet | null = entry;
    let row = startRow;

    for (const step of steps) {
      if (!previous) break;
      row += 1;

      if (step.kind === 'action') {
        compiler.compileAction(step, column, row);
        builder.connect(previous, { nodeId: step.id, portId: 'exec' });
        previous = { nodeId: step.id, portId: 'next' };
        continue;
      }

      if (step.kind === 'wait') {
        builder.node(step.id, 'Delay', { seconds: step.seconds }, column * COLUMN_WIDTH, row * ROW_HEIGHT);
        builder.connect(previous, { nodeId: step.id, portId: 'exec' });
        previous = { nodeId: step.id, portId: 'next' };
        continue;
      }

      // La suite part de « Disponible » ; « En attente » ne mène nulle part,
      // ce qui arrête l'automatisation tant que le délai court.
      if (step.kind === 'cooldown') {
        builder.node(step.id, 'Cooldown', { seconds: step.seconds, scope: step.scope }, column * COLUMN_WIDTH, row * ROW_HEIGHT);
        builder.connect(previous, { nodeId: step.id, portId: 'exec' });
        previous = { nodeId: step.id, portId: 'next' };
        continue;
      }

      // Embranchement : les deux branches partent du même nœud « Si » et ne se
      // rejoignent jamais - une sortie d'exécution n'accepte qu'un seul fil, et
      // fusionner les branches demanderait de dupliquer toute la suite.
      builder.node(step.id, 'If', {}, column * COLUMN_WIDTH, row * ROW_HEIGHT);
      builder.connect(previous, { nodeId: step.id, portId: 'exec' });

      const condition = compiler.conditionOutlet(step, column);
      if (condition) builder.connect(condition, { nodeId: step.id, portId: 'condition' });

      emit(step.then, { nodeId: step.id, portId: 'true' }, column + 1, row);
      emit(step.otherwise, { nodeId: step.id, portId: 'false' }, column + 2, row);
      previous = null;
    }

    return previous;
  }

  emit(recipe.steps, { nodeId: TRIGGER_NODE_ID, portId: 'next' }, 0, 0);

  return builder.build();
}
