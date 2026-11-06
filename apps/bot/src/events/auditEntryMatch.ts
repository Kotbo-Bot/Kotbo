/**
 * Choix de l'entrée du journal d'audit qui correspond à un événement Discord.
 *
 * On ne regarde que les entrées récentes : au-delà de la fenêtre, ce serait une
 * action antérieure qu'on attribuerait à tort à l'événement du moment.
 */

type AuditEntryLike = { createdTimestamp?: number | null; targetId?: unknown };

export function pickRecentAuditEntry<T extends AuditEntryLike>(
  entries: Iterable<T>,
  targetId: string | null | undefined,
  now: number,
  lookbackMs: number,
): T | undefined {
  for (const entry of entries) {
    if (now - (entry.createdTimestamp ?? 0) > lookbackMs) continue;
    if (targetId && typeof entry.targetId === 'string' && entry.targetId !== targetId) continue;
    return entry;
  }
  return undefined;
}
