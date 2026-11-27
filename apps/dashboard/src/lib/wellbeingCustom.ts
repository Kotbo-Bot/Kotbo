/**
 * Réglages de la cellule de suivi (catégories et trames, protocole de crise,
 * plans d'action types, étiquettes) tels que le bot les renvoie, et les
 * libellés qui en découlent. Sans réglage, les catégories de départ gardent
 * leurs libellés et trames traduits.
 */
import { m } from './i18n';
import { WB_CATEGORIES, wbCategoryLabel, wbSummaryTemplate } from './wellbeingLabels';

export interface WbCategory {
  id: string;
  label: string;
  template: string;
}

export interface WbTag {
  id: string;
  label: string;
}

export interface WbCrisisTask {
  label: string;
  dueHours: number;
}

export interface WbTaskPlan {
  id: string;
  label: string;
  tasks: Array<{ label: string; dueDays: number | null }>;
}

export interface WbCustomization {
  categories: WbCategory[];
  /** Protocole appliqué ; `crisisDefault` : la cellule n'a rien réglé. */
  crisisTasks: WbCrisisTask[];
  crisisDefault: boolean;
  taskPlans: WbTaskPlan[];
  tags: WbTag[];
}

export const WB_EMPTY_CUSTOMIZATION: WbCustomization = { categories: [], crisisTasks: [], crisisDefault: true, taskPlans: [], tags: [] };

/** Catégories proposées : celles de la cellule, sinon celles de départ. */
export function wbCategories(custom: WbCustomization): WbCategory[] {
  if (custom.categories.length > 0) return custom.categories;
  return WB_CATEGORIES.map((id) => ({ id, label: wbCategoryLabel(id), template: wbSummaryTemplate(id) }));
}

/** Nom d'une catégorie ; une catégorie retirée depuis garde un nom lisible. */
export function wbCategoryName(custom: WbCustomization, id: string): string {
  const found = wbCategories(custom).find((category) => category.id === id);
  if (found) return found.label;
  return (WB_CATEGORIES as readonly string[]).includes(id) ? wbCategoryLabel(id) : m.wb_cat_other();
}

/** Trame proposée comme résumé pour une catégorie. */
export function wbCategoryTemplate(custom: WbCustomization, id: string): string {
  return wbCategories(custom).find((category) => category.id === id)?.template ?? '';
}

/** Résumé encore vide ou resté tel qu'une trame : changer de catégorie peut le remplacer. */
export function wbIsCategoryTemplate(custom: WbCustomization, summary: string): boolean {
  const text = summary.trim();
  return text === '' || wbCategories(custom).some((category) => category.template.trim() === text);
}

/** Étiquettes posées qui existent encore, dans l'ordre de la cellule. */
export function wbCaseTags(custom: WbCustomization, tagIds: readonly string[] | undefined): WbTag[] {
  const ids = new Set(tagIds ?? []);
  return custom.tags.filter((tag) => ids.has(tag.id));
}

/** Dossiers ou personnes portant une étiquette ; `null` : tous. */
export function wbFilterByTag<T extends { tagIds?: readonly string[] }>(items: readonly T[], tagId: string | null): T[] {
  return tagId ? items.filter((item) => (item.tagIds ?? []).includes(tagId)) : [...items];
}
