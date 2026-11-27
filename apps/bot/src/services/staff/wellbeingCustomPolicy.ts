/**
 * Ce que la cellule de suivi règle elle-même, sans accès à la base :
 * catégories de dossier et leurs trames, étapes du protocole de crise, plans
 * d'action types, étiquettes et trames de notes de fiche.
 *
 * Seuls des libellés et des délais se règlent. Ce qui porte une règle
 * (gravité critique, statut clos, motif « résolu ») reste fixe : relances,
 * effacement et bilan en dépendent.
 */
import { randomUUID } from 'node:crypto';
import { CRISIS_PROTOCOL_TASKS, TASK_LABEL_MAX } from './wellbeingCasePolicy.js';
import { sharesNetworkPool } from './wellbeingNetworkPolicy.js';
import { DAY_MS, trimmedText } from './wellbeingPolicyShared.js';

export interface LabeledItem {
  id: string;
  label: string;
}

/**
 * Liste reçue du dashboard ou lue en base, nettoyée : libellé non vide et
 * unique (sans tenir compte de la casse), identifiant valide et unique
 * (`newId` en fournit un sinon), au plus `max` entrées. `extra` lit les autres
 * champs d'une entrée, ou l'écarte en rendant `null`.
 */
export function cleanLabeledList<T extends object>(
  input: unknown,
  options: { max: number; labelMax: number; newId: () => string; idPattern: RegExp },
  extra: (raw: Record<string, unknown>) => T | null,
): Array<LabeledItem & T> {
  if (!Array.isArray(input)) return [];
  const items: Array<LabeledItem & T> = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const raw of input) {
    if (items.length >= options.max) break;
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const label = trimmedText(entry.label, options.labelMax);
    if (!label || labels.has(label.toLowerCase())) continue;
    const rest = extra(entry);
    if (!rest) continue;
    const id = typeof entry.id === 'string' && options.idPattern.test(entry.id) && !ids.has(entry.id) ? entry.id : options.newId();
    ids.add(id);
    labels.add(label.toLowerCase());
    items.push({ ...rest, id, label });
  }
  return items;
}

/** Identifiant d'une entrée créée par la cellule (minuscules), ou d'une catégorie de départ (majuscules). */
const ITEM_ID_RE = /^[A-Za-z0-9-]{1,32}$/;

/** Borne un nombre entier entre `min` et `max` ; `fallback` s'il n'en est pas un. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

// ── Catégories ─────────────────────────────────────────────────────────────

/** Catégories proposées tant que la cellule n'a rien réglé ; le dashboard les traduit. */
export const DEFAULT_CATEGORY_IDS = ['SOUTIEN', 'MEDIATION', 'SIGNALEMENT', 'SUIVI'] as const;
export const CATEGORY_MAX = 12;
export const CATEGORY_LABEL_MAX = 40;
export const CATEGORY_TEMPLATE_MAX = 2000;

export interface CaseCategory extends LabeledItem {
  /** Trame proposée comme résumé à la création d'un dossier. */
  template: string;
  /** Plan d'action type appliqué à un dossier créé dans cette catégorie. */
  planId: string | null;
}

export function cleanCaseCategories(input: unknown, newId: () => string): CaseCategory[] {
  return cleanLabeledList(input, { max: CATEGORY_MAX, labelMax: CATEGORY_LABEL_MAX, newId, idPattern: ITEM_ID_RE }, (raw) => ({
    template: typeof raw.template === 'string' ? raw.template.trim().slice(0, CATEGORY_TEMPLATE_MAX) : '',
    planId: typeof raw.planId === 'string' && ITEM_ID_RE.test(raw.planId) ? raw.planId : null,
  }));
}

/** Catégories acceptées pour un nouveau dossier ; la première sert par défaut. */
export function caseCategoryIds(categories: readonly CaseCategory[]): string[] {
  return categories.length > 0 ? categories.map((category) => category.id) : [...DEFAULT_CATEGORY_IDS];
}

// ── Protocole de crise ─────────────────────────────────────────────────────

export const CRISIS_TASK_MAX = 10;
export const CRISIS_DUE_HOURS_MAX = 168;
const CRISIS_DUE_HOURS_DEFAULT = 24;

export interface CrisisTask {
  label: string;
  dueHours: number;
}

/** Étapes réglées par la cellule : libellé obligatoire, délai entre 1 heure et une semaine. */
export function cleanCrisisTasks(input: unknown): CrisisTask[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object')
    .map((raw) => ({ label: trimmedText(raw.label, TASK_LABEL_MAX), dueHours: clampInt(raw.dueHours, 1, CRISIS_DUE_HOURS_MAX, CRISIS_DUE_HOURS_DEFAULT) }))
    .filter((task): task is CrisisTask => !!task.label)
    .slice(0, CRISIS_TASK_MAX);
}

/** Étapes appliquées à un dossier critique : celles de la cellule, sinon celles de départ. */
export function crisisTasksOf(configured: readonly CrisisTask[]): ReadonlyArray<CrisisTask> {
  return configured.length > 0 ? configured : CRISIS_PROTOCOL_TASKS;
}

// ── Plans d'action types ───────────────────────────────────────────────────

export const PLAN_MAX = 10;
export const PLAN_LABEL_MAX = 40;
export const PLAN_TASK_MAX = 15;
export const PLAN_DUE_DAYS_MAX = 90;

export interface PlanTask {
  label: string;
  /** Échéance en jours après l'application du plan, ou aucune. */
  dueDays: number | null;
}

export interface TaskPlan extends LabeledItem {
  tasks: PlanTask[];
}

function cleanPlanTasks(input: unknown): PlanTask[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object')
    .map((raw) => ({
      label: trimmedText(raw.label, TASK_LABEL_MAX),
      dueDays: raw.dueDays === null || raw.dueDays === undefined ? null : clampInt(raw.dueDays, 0, PLAN_DUE_DAYS_MAX, 0),
    }))
    .filter((task): task is PlanTask => !!task.label)
    .slice(0, PLAN_TASK_MAX);
}

export function cleanTaskPlans(input: unknown, newId: () => string): TaskPlan[] {
  return cleanLabeledList(input, { max: PLAN_MAX, labelMax: PLAN_LABEL_MAX, newId, idPattern: ITEM_ID_RE }, (raw) => {
    const tasks = cleanPlanTasks(raw.tasks);
    return tasks.length > 0 ? { tasks } : null;
  });
}

/** Tâches d'un plan appliqué à un dossier, dans la place qui reste à son plan d'action. */
export function planTaskDrafts(plan: TaskPlan, now: Date, room: number): Array<{ label: string; dueAt: Date | null }> {
  return plan.tasks.slice(0, Math.max(0, room)).map((task) => ({
    label: task.label,
    dueAt: task.dueDays === null ? null : new Date(now.getTime() + task.dueDays * DAY_MS),
  }));
}

// ── Étiquettes ─────────────────────────────────────────────────────────────

export const TAG_MAX = 12;
export const TAG_LABEL_MAX = 30;

export function cleanTags(input: unknown, newId: () => string): LabeledItem[] {
  return cleanLabeledList(input, { max: TAG_MAX, labelMax: TAG_LABEL_MAX, newId, idPattern: ITEM_ID_RE }, () => ({}));
}

/** Entrée d'historique quand les étiquettes d'un dossier changent. */
export const TAGS_EVENT = 'TAGS';

/** Noms des étiquettes posées, pour l'historique ; null s'il n'y en a aucune. */
export function tagNames(tags: readonly LabeledItem[], ids: readonly string[]): string | null {
  const names = ids.map((id) => tags.find((tag) => tag.id === id)?.label).filter((name): name is string => !!name);
  return names.length > 0 ? names.join(', ') : null;
}

/** Étiquettes d'un dossier ou d'une fiche : seulement celles de la cellule, sans doublon. */
export function cleanTagIds(input: unknown, tags: readonly LabeledItem[]): string[] {
  if (!Array.isArray(input)) return [];
  const known = new Set(tags.map((tag) => tag.id));
  return [...new Set(input.filter((id): id is string => typeof id === 'string' && known.has(id)))];
}

/** Bilan : dossiers actifs portant chaque étiquette, dans l'ordre de la cellule. */
export function tagCounts(
  cases: ReadonlyArray<{ status: string; tagIds?: readonly string[] }>,
  tags: readonly LabeledItem[],
): Array<{ label: string; count: number }> {
  return tags.map((tag) => ({
    label: tag.label,
    count: cases.filter((item) => item.status !== 'CLOSED' && (item.tagIds ?? []).includes(tag.id)).length,
  }));
}

// ── Trames de notes de fiche ───────────────────────────────────────────────

export const NOTE_TEMPLATE_MAX = 10;
export const NOTE_TEMPLATE_LABEL_MAX = 40;
export const NOTE_TEMPLATE_TEXT_MAX = 2000;

export interface NoteTemplate extends LabeledItem {
  text: string;
}

export function cleanNoteTemplates(input: unknown, newId: () => string): NoteTemplate[] {
  return cleanLabeledList(input, { max: NOTE_TEMPLATE_MAX, labelMax: NOTE_TEMPLATE_LABEL_MAX, newId, idPattern: ITEM_ID_RE }, (raw) => {
    const text = trimmedText(raw.text, NOTE_TEMPLATE_TEXT_MAX);
    return text ? { text } : null;
  });
}

// ── Journal ────────────────────────────────────────────────────────────────

export type CustomizationKind = 'categories' | 'crisisTasks' | 'taskPlans' | 'tags' | 'noteTemplates';

const CUSTOMIZATION_NAMES: Record<CustomizationKind, { name: string; none: string }> = {
  categories: { name: 'Catégories', none: 'catégories de départ' },
  crisisTasks: { name: 'Protocole de crise', none: 'protocole de départ' },
  taskPlans: { name: "Plans d'action types", none: 'aucun' },
  tags: { name: 'Étiquettes', none: 'aucune' },
  noteTemplates: { name: 'Trames de notes', none: 'aucune' },
};

/** Colonne de la configuration et nettoyage de chaque réglage. */
export const CUSTOMIZATION_FIELDS: Record<CustomizationKind, { column: string; clean: (input: unknown, newId: () => string) => Array<{ label: string }> }> = {
  categories: { column: 'caseCategories', clean: cleanCaseCategories },
  crisisTasks: { column: 'crisisTasks', clean: (input) => cleanCrisisTasks(input) },
  taskPlans: { column: 'taskPlans', clean: cleanTaskPlans },
  tags: { column: 'caseTags', clean: cleanTags },
  noteTemplates: { column: 'noteTemplates', clean: cleanNoteTemplates },
};

/** Réglage connu ; `Object.hasOwn` écarte les noms hérités (`constructor`, `toString`...). */
const isKind = (value: unknown): value is CustomizationKind => typeof value === 'string' && Object.hasOwn(CUSTOMIZATION_FIELDS, value);

/**
 * Réglages qu'une cellule reprend d'une autre cellule de son réseau, prêts à
 * enregistrer (colonne, valeur nettoyée), ou `null` si cette cellule ne
 * partage pas avec le réseau. Seuls des libellés passent : aucun dossier.
 */
export function copyableCustomization(
  source: { enabled: boolean; networkPool?: boolean } & Record<string, unknown>,
  kinds: readonly unknown[],
  newId: () => string = () => randomUUID().slice(0, 8),
): Record<string, Array<{ label: string }>> | null {
  if (!sharesNetworkPool(source)) return null;
  return Object.fromEntries([...new Set(kinds.filter(isKind))].map((kind) => {
    const { column, clean } = CUSTOMIZATION_FIELDS[kind];
    return [column, clean(source[column], newId)];
  }));
}

/** Ligne d'audit d'un réglage de la cellule. */
export function describeCustomization(kind: CustomizationKind, items: ReadonlyArray<{ label: string }>): string {
  const { name, none } = CUSTOMIZATION_NAMES[kind];
  return `${name} : ${items.length > 0 ? items.map((item) => item.label).join(', ') : none}`;
}
