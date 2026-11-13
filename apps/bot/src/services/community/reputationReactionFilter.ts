/**
 * Une réaction vaut-elle un remerciement ? Règle pure, sans Discord ni base :
 * le gestionnaire réunit les faits, cette fonction tranche.
 */
export interface ThanksReaction {
  enabled: boolean;
  /** Emoji réglé, au format de `normalizeEmojiKey` (unicode brut ou id d'emoji custom). */
  configuredEmoji: string | null;
  /** Emoji de la réaction reçue, même format. */
  emojiKey: string;
  reactorId: string;
  reactorIsBot: boolean;
  /** Auteur du message. `null` pour un message de webhook. */
  authorId: string | null;
  authorIsBot: boolean;
}

export function isThanksReaction(reaction: ThanksReaction): boolean {
  if (!reaction.enabled || !reaction.configuredEmoji) return false;
  if (reaction.emojiKey !== reaction.configuredEmoji) return false;
  if (reaction.reactorIsBot) return false;
  if (!reaction.authorId || reaction.authorIsBot) return false;
  return reaction.authorId !== reaction.reactorId;
}
