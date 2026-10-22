/**
 * Catalogue Unicode du sélecteur d'emoji : noms et mots-clés CLDR traduits
 * (emojibase-data), chargés à la première ouverture puis gardés pour la page.
 *
 * L'ancien sélecteur embarquait ~700 caractères sans nom : chercher « cœur » ou
 * « feu » ne trouvait rien, la recherche comparait le texte tapé au caractère.
 */

export interface CatalogEmoji {
  unicode: string;
  label: string;
  /** Libellé et mots-clés, en minuscules et sans accents. */
  search: string;
}

export interface CatalogGroup {
  key: string;
  label: string;
  icon: string;
  emojis: CatalogEmoji[];
}

interface RawEmoji {
  unicode: string;
  label: string;
  group?: number;
  order?: number;
  tags?: string[];
}

interface RawMessages {
  groups: { key: string; message: string; order: number }[];
}

const GROUP_ICONS: Record<string, string> = {
  'smileys-emotion': '😀',
  'people-body': '👋',
  'animals-nature': '🐱',
  'food-drink': '🍏',
  'travel-places': '🚗',
  activities: '⚽',
  objects: '💡',
  symbols: '❤️',
  flags: '🏁',
};

export function normalizeEmojiTerm(text: string): string {
  // NFD ne décompose pas « œ » : sans ce relais, « coeur » ne trouvait pas « cœur ».
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').trim();
}

export function buildCatalog(data: RawEmoji[], messages: RawMessages): CatalogGroup[] {
  const groups = messages.groups
    .filter((g) => GROUP_ICONS[g.key])
    .sort((a, b) => a.order - b.order)
    .map((g) => ({
      order: g.order,
      key: g.key,
      label: g.message.charAt(0).toUpperCase() + g.message.slice(1),
      icon: GROUP_ICONS[g.key],
      emojis: [] as (CatalogEmoji & { order: number })[],
    }));
  const byOrder = new Map(groups.map((g) => [g.order, g]));

  for (const raw of data) {
    // Sans groupe (lettres régionales isolées) ou « composants » : inutilisables seuls.
    const group = raw.group === undefined ? undefined : byOrder.get(raw.group);
    if (!group) continue;
    group.emojis.push({
      unicode: raw.unicode,
      label: raw.label,
      search: normalizeEmojiTerm(`${raw.label} ${(raw.tags ?? []).join(' ')}`),
      order: raw.order ?? 0,
    });
  }

  return groups.map(({ key, label, icon, emojis }) => ({
    key,
    label,
    icon,
    emojis: emojis.sort((a, b) => a.order - b.order).map(({ unicode, label, search }) => ({ unicode, label, search })),
  }));
}

/** Vrai si chaque mot tapé apparaît dans le texte indexé. */
export function matchesEmojiTerm(search: string, term: string): boolean {
  const words = normalizeEmojiTerm(term).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => search.includes(w));
}

/** Ceux dont le nom commence par le terme passent devant les simples mentions. */
export function searchCatalog(groups: CatalogGroup[], term: string, limit = 120): CatalogEmoji[] {
  const needle = normalizeEmojiTerm(term);
  if (!needle) return [];
  const first: CatalogEmoji[] = [];
  const rest: CatalogEmoji[] = [];
  for (const group of groups) {
    for (const emoji of group.emojis) {
      if (!matchesEmojiTerm(emoji.search, needle)) continue;
      (normalizeEmojiTerm(emoji.label).startsWith(needle) ? first : rest).push(emoji);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

const cache = new Map<string, Promise<CatalogGroup[]>>();

export function loadEmojiCatalog(locale: string): Promise<CatalogGroup[]> {
  const lang = locale === 'fr' ? 'fr' : 'en';
  let pending = cache.get(lang);
  if (!pending) {
    // Deux imports écrits en toutes lettres : Vite ne découpe que ce qu'il peut lire.
    const load = lang === 'fr'
      ? Promise.all([import('emojibase-data/fr/compact.json'), import('emojibase-data/fr/messages.json')])
      : Promise.all([import('emojibase-data/en/compact.json'), import('emojibase-data/en/messages.json')]);
    pending = load.then(([data, messages]) =>
      buildCatalog(data.default as RawEmoji[], messages.default as RawMessages),
    );
    // Un échec réseau ne doit pas condamner les ouvertures suivantes.
    pending.catch(() => cache.delete(lang));
    cache.set(lang, pending);
  }
  return pending;
}

/**
 * Ce qu'affiche une valeur déjà choisie : `<a:nom:id>` (animé), `<:nom:id>`,
 * l'identifiant nu (`format="id"`) ou un caractère Unicode.
 */
export function previewEmojiValue(raw: string | null | undefined):
  | { kind: 'image'; url: string; name: string }
  | { kind: 'text'; value: string }
  | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const mention = value.match(/^<(a?):([^:]+):(\d+)>$/);
  const id = mention ? mention[3] : (/^\d{17,20}$/.test(value) ? value : null);
  if (id) {
    return {
      kind: 'image',
      url: `https://cdn.discordapp.com/emojis/${id}.${mention?.[1] ? 'gif' : 'png'}?size=64`,
      name: mention ? `:${mention[2]}:` : '',
    };
  }
  return { kind: 'text', value };
}

// ── Récents ────────────────────────────────────────────

export type RecentEmoji =
  | { kind: 'unicode'; unicode: string; label: string }
  | { kind: 'custom'; id: string; name: string };

const RECENTS_KEY = 'kotbo:emoji-recents';
const RECENTS_MAX = 16;

export function readRecentEmojis(): RecentEmoji[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

function recentKey(entry: RecentEmoji): string {
  return entry.kind === 'unicode' ? `u:${entry.unicode}` : `c:${entry.id}`;
}

export function pushRecentEmoji(entry: RecentEmoji): RecentEmoji[] {
  const next = [entry, ...readRecentEmojis().filter((e) => recentKey(e) !== recentKey(entry))].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Stockage bloqué (navigation privée) : les récents restent pour la session.
  }
  return next;
}
