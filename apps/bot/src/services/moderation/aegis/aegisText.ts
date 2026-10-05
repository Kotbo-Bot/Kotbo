/**
 * Préparation du texte envoyé à AegisAI.
 *
 * Le modèle note du langage : une mention `<@123…>`, un emoji maison ou une
 * URL ne lui apprennent rien et faussent le score (trois emojis seuls sortent
 * à 0,58). On les retire, et on n'envoie rien quand il ne reste pas de lettre.
 *
 * Au-delà de quelques centaines de caractères le modèle tronque et dilue :
 * « connard » répété sur 500 caractères sort à 0,56. Un long message est donc
 * découpé en morceaux notés séparément, et c'est le pire qui compte.
 */
import { createHash } from 'node:crypto';

const MENTION_RE = /<(?:@[!&]?|#)\d{17,20}>/g;
const CUSTOM_EMOJI_RE = /<a?:([A-Za-z0-9_]{2,32}):\d{17,20}>/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const TIMESTAMP_RE = /<t:\d+(?::[tTdDfFR])?>/g;
const LETTER_RE = /\p{L}/u;

export const CHUNK_SIZE = 400;
export const MAX_CHUNKS = 4;

/** Texte nettoyé, ou null s'il n'y a rien à noter. */
export function prepareText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(MENTION_RE, ' ')
    .replace(CUSTOM_EMOJI_RE, ' ')
    .replace(TIMESTAMP_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 2 || !LETTER_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Découpe aux espaces en morceaux d'au plus `size` caractères. Au-delà de
 * `maxChunks`, le reste est ignoré : un pavé de 2 000 caractères coûterait
 * sinon cinq appels à une API qui n'en sert que quinze par seconde.
 */
export function chunkText(text: string, size = CHUNK_SIZE, maxChunks = MAX_CHUNKS): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= size) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/** Empreinte du texte pour le cache des résultats (copier-coller de spam). */
export function textFingerprint(text: string): string {
  return createHash('sha1').update(text.toLowerCase()).digest('base64url');
}

/** Extrait conservé dans une détection : assez pour juger, pas plus. */
export function excerptOf(raw: string, max = 500): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
