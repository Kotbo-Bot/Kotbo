import { containsBannedWord } from '../moderation/bannedWordsService.js';

/**
 * Règles d'acceptation d'une confession, sans accès à Discord ni à la base :
 * le service charge la dernière confession du membre et les mots interdits,
 * puis décide ici.
 */

export const CONFESSION_MAX_LENGTH = 1500;
export const CONFESSION_DEFAULT_COOLDOWN_SECONDS = 60;
const CONFESSION_MAX_COOLDOWN_SECONDS = 86_400;

export type ConfessionRefusal = 'empty' | 'too_long' | 'cooldown' | 'blocked';

export type ConfessionCheck =
  | { ok: true; content: string }
  | { ok: false; reason: ConfessionRefusal; retryInSeconds?: number };

export function checkConfession(input: {
  content: string;
  bannedWords: string[];
  /** Date de la dernière confession du membre sur ce serveur. */
  lastSentAt: Date | null;
  cooldownSeconds: number;
  now: number;
}): ConfessionCheck {
  const content = input.content.trim();
  if (!content) return { ok: false, reason: 'empty' };
  if (content.length > CONFESSION_MAX_LENGTH) return { ok: false, reason: 'too_long' };

  if (input.lastSentAt) {
    const wait = input.lastSentAt.getTime() + input.cooldownSeconds * 1000 - input.now;
    if (wait > 0) return { ok: false, reason: 'cooldown', retryInSeconds: Math.ceil(wait / 1000) };
  }

  if (containsBannedWord(content, input.bannedWords)) return { ok: false, reason: 'blocked' };

  return { ok: true, content };
}

/** Délai saisi par le staff, ramené en secondes entières entre 0 et 24 h. */
export function normalizeConfessionCooldown(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(CONFESSION_MAX_COOLDOWN_SECONDS, Math.max(0, Math.round(value)));
}
