/**
 * Listes de suivi : ce que l'API et le dashboard doivent dire pareil.
 *
 * Un module figure ici quand ses éléments peuvent être épinglés un par un dans
 * une liste. En ajouter un, c'est aussi apprendre à l'API à lire le titre de
 * ses éléments (`routes/dashboard/doingLists.ts`).
 */
export const DOING_LIST_MODULES = ['suggestions', 'tickets'] as const;
export type DoingListModule = (typeof DOING_LIST_MODULES)[number];

export const DOING_LIST_STATUSES = ['TODO', 'DOING', 'DONE'] as const;
export type DoingListStatus = (typeof DOING_LIST_STATUSES)[number];

export function isDoingListModule(value: unknown): value is DoingListModule {
  return typeof value === 'string' && (DOING_LIST_MODULES as readonly string[]).includes(value);
}

export function isDoingListStatus(value: unknown): value is DoingListStatus {
  return typeof value === 'string' && (DOING_LIST_STATUSES as readonly string[]).includes(value);
}
