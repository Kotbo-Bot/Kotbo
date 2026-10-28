/**
 * Regles et textes des convocations. Fichier sans dependance : la commande
 * /convoquer le charge au demarrage sans tirer le service (qui depend des
 * sanctions, donc indirectement du registre des commandes).
 */

export const EXPIRY_ACTIONS = ['ALERT', 'WARN', 'TIMEOUT', 'NONE'] as const;
export type ExpiryAction = (typeof EXPIRY_ACTIONS)[number];

/** Ce qui arrive sans reponse, en pied du message. Null quand rien n'arrive. */
export function expiryNotice(action: string, hours: number): string | null {
  const consequence: Record<string, string> = {
    ALERT: 'la modération en sera avertie',
    WARN: 'un avertissement sera appliqué',
    TIMEOUT: 'une exclusion temporaire de 24 h sera appliquée',
  };
  return consequence[action] ? `Sans réponse sous ${hours} h, ${consequence[action]}.` : null;
}

/** Ligne « Accusé de réception » du message de convocation. */
export function ackLine(c: { status: string; acknowledgedAt: Date | null }): string {
  if (c.status === 'CLOSED') return '🔒 Convocation close';
  if (c.acknowledgedAt) return `✅ Reçu <t:${Math.floor(c.acknowledgedAt.getTime() / 1000)}:R>`;
  if (c.status === 'EXPIRED') return '⌛ Délai dépassé sans réponse';
  return '⏳ En attente';
}
