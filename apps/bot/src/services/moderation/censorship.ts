/**
 * Censure d'un message : les passages interdits sont remplacés par des
 * symboles, le reste du message est conservé.
 *
 * Ce module ne fait que du calcul sur du texte. La republication sous
 * l'identité du membre vit dans `censorService.ts`.
 */

export type CensorKind = 'word' | 'link' | 'invite';

export interface CensorRange {
  start: number;
  end: number;
  kind: CensorKind;
}

/** Limite Discord d'un message. */
const MAX_MESSAGE_LENGTH = 2000;

/** Pas d'accent grave : le masque est affiché dans un bloc de code en ligne. */
const GRAWLIX_CHARS = 'ß@?€£&%#!æ$§¤';
const GRAWLIX_MIN = 4;
const GRAWLIX_MAX = 16;

/** Une invitation l'emporte sur un lien, un lien sur un mot. */
const KIND_PRIORITY: Record<CensorKind, number> = { word: 0, link: 1, invite: 2 };

const KIND_LABEL: Record<CensorKind, string | null> = {
  word: null,
  link: '*(lien censuré)*',
  invite: '*(invitation censurée)*',
};

/** Mots-clés des règles natives Kotbo, repris ici pour retrouver chaque occurrence. */
export const LINK_KEYWORDS = ['*http://*', '*https://*'];
export const INVITE_KEYWORDS = ['*discord.gg/*', '*discord.com/invite/*', '*discordapp.com/invite/*'];

const WORD_CHAR = '[\\p{L}\\p{N}]';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Traduit un mot-clé AutoMod Discord en expression régulière, avec la même
 * sémantique : sans astérisque le mot doit être entier, un astérisque en tête
 * ou en queue étend la correspondance au reste du mot.
 */
export function keywordToRegex(keyword: string): RegExp | null {
  const trimmed = keyword.trim().toLowerCase();
  const core = trimmed.replace(/^\*+|\*+$/g, '');
  if (!core) return null;

  const start = trimmed.startsWith('*') ? '\\S*' : `(?<!${WORD_CHAR})`;
  const end = trimmed.endsWith('*') ? '\\S*' : `(?!${WORD_CHAR})`;
  try {
    return new RegExp(start + escapeRegex(core) + end, 'giu');
  } catch {
    return null;
  }
}

/**
 * Toutes les occurrences des mots-clés dans le contenu, en écartant celles
 * couvertes par la liste d'exceptions (même sémantique que Discord).
 */
export function findKeywordRanges(
  content: string,
  keywords: string[],
  allowList: string[],
  kind: CensorKind,
): CensorRange[] {
  const allowRegexes = allowList
    .map(keywordToRegex)
    .filter((r): r is RegExp => r !== null);

  const ranges: CensorRange[] = [];
  for (const keyword of keywords) {
    const regex = keywordToRegex(keyword);
    if (!regex) continue;

    for (const match of content.matchAll(regex)) {
      const text = match[0];
      if (!text) continue;
      const allowed = allowRegexes.some((allow) => {
        allow.lastIndex = 0;
        return allow.test(text);
      });
      if (allowed) continue;
      ranges.push({ start: match.index, end: match.index + text.length, kind });
    }
  }
  return ranges;
}

/** Toutes les occurrences d'un passage précis, sans tenir compte de la casse. */
export function findLiteralRanges(content: string, literal: string, kind: CensorKind): CensorRange[] {
  const needle = literal.trim().toLowerCase();
  if (!needle) return [];

  const haystack = content.toLowerCase();
  const ranges: CensorRange[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    ranges.push({ start: index, end: index + needle.length, kind });
    from = index + needle.length;
  }
  return ranges;
}

/** Fusionne les plages qui se chevauchent ou se touchent. */
export function mergeRanges(ranges: CensorRange[]): CensorRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: CensorRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      if (KIND_PRIORITY[range.kind] > KIND_PRIORITY[last.kind]) last.kind = range.kind;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function grawlix(length: number, random: () => number = Math.random): string {
  const size = Math.max(GRAWLIX_MIN, Math.min(GRAWLIX_MAX, length));
  let out = '';
  for (let i = 0; i < size; i++) {
    out += GRAWLIX_CHARS[Math.floor(random() * GRAWLIX_CHARS.length)];
  }
  return out;
}

/**
 * Remplace chaque plage par un masque. Un lien ou une invitation est suivi
 * d'une mention qui explique le trou dans la phrase.
 */
export function censorContent(
  content: string,
  ranges: CensorRange[],
  random: () => number = Math.random,
): string {
  const merged = mergeRanges(ranges);
  let out = content;

  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end, kind } = merged[i];
    const label = KIND_LABEL[kind];
    const mask = `\`${grawlix(end - start, random)}\`${label ? ` ${label}` : ''}`;
    out = out.slice(0, start) + mask + out.slice(end);
  }

  if (out.length > MAX_MESSAGE_LENGTH) out = `${out.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
  return out;
}

/** Une invitation Discord se repère au contenu, quelle que soit la règle qui l'a captée. */
export function classifyLink(text: string): CensorKind {
  return /discord(?:app)?\.(?:gg|com\/invite)\//i.test(text) ? 'invite' : 'link';
}
