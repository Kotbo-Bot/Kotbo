/**
 * Plusieurs tags d'un coup dans l'assistant : une règle par tag, mêmes
 * réglages pour toutes. Un tag Discord fait de 1 à 4 caractères.
 */
import { MAX_SERVER_TAG_LENGTH, normalizeTagList } from '@kotbo/shared';
import type { TagScanResult } from '../../api/tagAutomod';

/** Tags saisis en une fois ; au-delà, la liste se découpe en plusieurs passages. */
export const MAX_BULK_TAGS = 20;

/** Lit la saisie : un tag par ligne, virgules et espaces acceptés. Les entrées trop longues sont rendues à part. */
export function parseBulkTags(text: string): { tags: string[]; tooLong: string[] } {
  const entries = text.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean);
  return {
    tags: normalizeTagList(entries),
    tooLong: entries.filter((entry) => entry.length > MAX_SERVER_TAG_LENGTH),
  };
}

/**
 * Aperçu commun aux tags saisis. Les totaux s'additionnent ; un membre visé
 * par deux tags (mode « contient ») n'est compté et listé qu'une fois.
 */
export function mergeScans(results: readonly TagScanResult[]): TagScanResult {
  const seen = new Set<string>();
  const listed = results.flatMap((result) => result.matches);
  const matches = listed.filter((match) => {
    if (seen.has(match.userId)) return false;
    seen.add(match.userId);
    return true;
  });
  return {
    scanned: Math.max(0, ...results.map((result) => result.scanned)),
    withTag: Math.max(0, ...results.map((result) => result.withTag)),
    total: results.reduce((sum, result) => sum + result.total, 0) - (listed.length - matches.length),
    matches,
  };
}
