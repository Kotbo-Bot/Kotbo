import type { StarboardConfig } from '@prisma/client';

/**
 * Décompte Starlight, sans dépendance à Discord ni à la base : le service
 * traduit les réactions reçues en `ReactionVote` puis délègue ici.
 */

/**
 * Clé de comparaison d'un emoji configuré : l'id pour un emoji custom (seul
 * identifiant stable, le nom pouvant changer), le caractère sinon.
 */
export function normalizeEmojiKey(raw: string): string {
  const trimmed = raw.trim();
  const custom = trimmed.match(/^<?a?:([^:\s]+):(\d{15,25})>?$/);
  if (custom) return custom[2]!;
  return trimmed;
}

/** Une réaction d'un message, réduite à ce qui compte pour le score. */
export interface ReactionVote {
  /** Clé de l'emoji, au format de `normalizeEmojiKey`. */
  key: string;
  count: number;
  /** Le bot a posé cette réaction (amorçage) : ce n'est le vote de personne. */
  me: boolean;
  /** L'auteur du message a posé cette réaction et l'option l'exclut. */
  byAuthor: boolean;
}

type VoteEmojis = Pick<StarboardConfig, 'upvoteEmojis' | 'downvoteEmojis'>;

export function tallyVotes(reactions: Iterable<ReactionVote>, config: VoteEmojis): { up: number; down: number } {
  const upKeys = new Set(config.upvoteEmojis.map(normalizeEmojiKey));
  const downKeys = new Set(config.downvoteEmojis.map(normalizeEmojiKey));
  let up = 0;
  let down = 0;

  for (const reaction of reactions) {
    if (!reaction.key) continue;
    const count = Math.max(0, reaction.count - (reaction.me ? 1 : 0) - (reaction.byAuthor ? 1 : 0));
    if (upKeys.has(reaction.key)) up += count;
    else if (downKeys.has(reaction.key)) down += count;
  }

  return { up, down };
}
