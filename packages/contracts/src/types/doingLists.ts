/**
 * Listes de suivi : ce que l'API et le dashboard doivent dire pareil.
 *
 * Un module figure ici quand ses éléments peuvent être épinglés un par un dans
 * une liste qui le relie. En ajouter un, c'est aussi apprendre à l'API à lire le
 * titre de ses éléments (`routes/dashboard/doingLists.ts`).
 */
export const DOING_LIST_MODULES = ['suggestions', 'tickets'] as const;
export type DoingListModule = (typeof DOING_LIST_MODULES)[number];

/**
 * D'où peut venir une carte : un module relié, ou une tâche du planning, que
 * l'on peut poser dans n'importe quelle liste sans la relier.
 */
export type DoingListSource = DoingListModule | 'tasks';

export const DOING_LIST_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DoingListPriority = (typeof DOING_LIST_PRIORITIES)[number];

export type DoingListChecklistEntry = { id: string; text: string; done: boolean };

export const DOING_LIST_ITEM_TYPES = ['TASK', 'BUG', 'STORY', 'EPIC'] as const;
export type DoingListItemType = (typeof DOING_LIST_ITEM_TYPES)[number];

/** Liens stockés dans un seul sens ; « est bloquée par » est un BLOCKS vu depuis la carte bloquée. */
export const DOING_LIST_LINK_TYPES = ['BLOCKS', 'RELATES', 'DUPLICATES'] as const;
export type DoingListLinkType = (typeof DOING_LIST_LINK_TYPES)[number];

/** Clé d'une liste : une lettre puis lettres ou chiffres, 2 à 10 en tout (BOUT, S3, KOTBO). */
export const DOING_LIST_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/** « bout-12 » → { key: 'BOUT', number: 12 } ; null si ce n'est pas une référence. */
export function parseDoingListRef(value: string): { key: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})$/.exec(value.trim());
  return match ? { key: match[1].toUpperCase(), number: Number(match[2]) } : null;
}

export function isDoingListItemType(value: unknown): value is DoingListItemType {
  return typeof value === 'string' && (DOING_LIST_ITEM_TYPES as readonly string[]).includes(value);
}

export function isDoingListLinkType(value: unknown): value is DoingListLinkType {
  return typeof value === 'string' && (DOING_LIST_LINK_TYPES as readonly string[]).includes(value);
}

export function isDoingListModule(value: unknown): value is DoingListModule {
  return typeof value === 'string' && (DOING_LIST_MODULES as readonly string[]).includes(value);
}

export function isDoingListSource(value: unknown): value is DoingListSource {
  return value === 'tasks' || isDoingListModule(value);
}

export function isDoingListPriority(value: unknown): value is DoingListPriority {
  return typeof value === 'string' && (DOING_LIST_PRIORITIES as readonly string[]).includes(value);
}
