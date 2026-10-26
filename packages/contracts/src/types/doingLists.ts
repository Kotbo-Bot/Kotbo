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

export function isDoingListModule(value: unknown): value is DoingListModule {
  return typeof value === 'string' && (DOING_LIST_MODULES as readonly string[]).includes(value);
}

export function isDoingListSource(value: unknown): value is DoingListSource {
  return value === 'tasks' || isDoingListModule(value);
}

export function isDoingListPriority(value: unknown): value is DoingListPriority {
  return typeof value === 'string' && (DOING_LIST_PRIORITIES as readonly string[]).includes(value);
}
