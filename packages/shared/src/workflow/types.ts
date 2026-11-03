/**
 * Node Workflow Builder - contrat partagé entre l'éditeur et le moteur.
 *
 * L'éditeur du dashboard et l'interpréteur du bot lisent exactement les mêmes
 * définitions de nœuds : un port ajouté ici apparaît des deux côtés, et une
 * connexion refusée dans l'éditeur est refusée à l'identique à l'enregistrement.
 */

// ============================================================================
// TYPES DE PORTS
// ============================================================================

/**
 * `Exec` matérialise le flux d'exécution (les fils blancs) ; tous les autres
 * types circulent sur les fils de données.
 */
export type PortDataType =
  | 'Exec'
  | 'Member'
  | 'Role'
  | 'Channel'
  | 'Message'
  | 'Guild'
  | 'String'
  | 'Number'
  | 'Boolean'
  | 'List';

export const PORT_COLORS: Record<PortDataType, string> = {
  Exec: '#e2e8f0',
  Member: '#10b981',
  Role: '#f97316',
  Channel: '#0ea5e9',
  Message: '#6366f1',
  Guild: '#a855f7',
  String: '#ec4899',
  Number: '#14b8a6',
  Boolean: '#eab308',
  List: '#94a3b8',
};

/**
 * Une valeur peut-elle circuler d'un port de sortie vers un port d'entrée ?
 *
 * Règle unique en dehors de l'égalité : tout type métier se convertit
 * implicitement en `String`, pour ne pas imposer un nœud de conversion dès
 * qu'on veut afficher un pseudo dans un message.
 */
export function canConnect(from: PortDataType, to: PortDataType): boolean {
  if (from === 'Exec' || to === 'Exec') return from === to;
  if (from === to) return true;
  return to === 'String';
}

/** true quand la connexion est acceptée mais nécessite une conversion en texte. */
export function needsCoercion(from: PortDataType, to: PortDataType): boolean {
  return from !== to && to === 'String' && from !== 'Exec';
}

// ============================================================================
// DÉFINITION DES NŒUDS
// ============================================================================

export type NodeCategory = 'trigger' | 'flow' | 'action' | 'data' | 'logic';

export interface PortDef {
  id: string;
  label: string;
  type: PortDataType;
  /** Type des éléments quand `type` vaut 'List' */
  itemType?: PortDataType;
  /** Une entrée de données non connectée et non optionnelle bloque la validation */
  optional?: boolean;
}

export type ConfigFieldType =
  | 'text' | 'textarea' | 'number' | 'boolean' | 'role' | 'channel' | 'select' | 'cases'
  /** Plusieurs salons ou catégories ; la valeur est une liste d'identifiants */
  | 'channels'
  /** Plusieurs rôles ; la valeur est une liste d'identifiants */
  | 'roles'
  /** Emplacements d'un texte composé ; alimente des entrées dynamiques */
  | 'slots';

/** Emplacement nommé dans le texte d'un nœud `FormatText`. */
export interface TextSlot {
  id: string;
  label: string;
}

export interface ConfigFieldDef {
  key: string;
  label: string;
  type: ConfigFieldType;
  /** Valeurs proposées quand `type` vaut 'select' */
  options?: { value: string; label: string }[];
  placeholder?: string;
  min?: number;
  max?: number;
  defaultValue?: unknown;
}

export interface NodeDef {
  type: string;
  label: string;
  category: NodeCategory;
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  config?: ConfigFieldDef[];
  /**
   * Nom de l'événement du bus qui déclenche ce nœud.
   * Présent uniquement sur les nœuds de catégorie `trigger`.
   */
  event?: string;
  /**
   * Clé du module (registre `@kotbo/contracts`) sans lequel le nœud ne fait
   * rien. Le dashboard s'en sert pour ne pas proposer un nœud dont le module
   * est retiré du produit.
   */
  module?: string;
}

// ============================================================================
// GRAPHE
// ============================================================================

export interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

// ============================================================================
// BUDGET D'EXÉCUTION
// ============================================================================

/**
 * Garde-fous du moteur.
 *
 * Le nœud ForEach rend le graphe volontairement cyclique : refuser les cycles à
 * l'enregistrement n'a donc plus de sens, la protection contre les boucles
 * infinies repose entièrement sur ce budget mesuré à l'exécution.
 */
export interface ExecutionBudget {
  /** Nombre maximum de nœuds dans un graphe enregistré */
  maxNodes: number;
  /** Nombre maximum de nœuds traversés sur une exécution */
  maxNodeVisits: number;
  /** Nombre maximum d'itérations cumulées, toutes boucles confondues */
  maxIterations: number;
  /** Durée maximale d'une exécution, hors attente d'un nœud Delay */
  maxDurationMs: number;
  /** Profondeur maximale d'imbrication des boucles */
  maxLoopDepth: number;
}

export const DEFAULT_BUDGET: ExecutionBudget = {
  // Une automatisation écrite en quelques phrases se compile en bien plus de
  // nœuds qu'elle n'a d'étapes : chaque valeur du contexte, chaque texte
  // composé et chaque condition en ajoutent. La limite porte sur la taille du
  // graphe produit, pas sur la complexité perçue par l'utilisateur.
  maxNodes: 120,
  maxNodeVisits: 200,
  maxIterations: 500,
  maxDurationMs: 15_000,
  maxLoopDepth: 4,
};
