/** Une entrée par ligne de textarea, telle que l'enregistrement la garde. */
export function parseListLines(input: string, lowercase: boolean): string[] {
  return input
    .split('\n')
    .map((x) => (lowercase ? x.trim().toLowerCase() : x.trim()))
    .filter((x) => x.length > 0);
}

/** Listes en textarea, et si l'enregistrement les passe en minuscules. */
const LISTS = { linksWhitelist: true, customWords: true, customWordsAllowList: true, profanityAllowList: true, inviteFilterAllowedGuilds: false };
type ListKey = keyof typeof LISTS;

function withLists(config: object, text: (key: ListKey) => string): object {
  return { ...config, ...Object.fromEntries(Object.entries(LISTS).map(([key, lowercase]) => [key, parseListLines(text(key as ListKey), lowercase)])) };
}

/**
 * Les listes des textarea ne rejoignent `config` qu'à l'enregistrement : la
 * comparaison leur applique la même normalisation, des deux côtés, car une
 * liste écrite ailleurs (MCP) n'est pas forcément normalisée.
 */
export function hasUnsavedAutoModChanges(config: object, savedConfig: object, lists: Record<ListKey, string>): boolean {
  const saved = savedConfig as Partial<Record<ListKey, string[]>>;
  return JSON.stringify(withLists(config, (key) => lists[key]))
    !== JSON.stringify(withLists(savedConfig, (key) => (saved[key] ?? []).join('\n')));
}
