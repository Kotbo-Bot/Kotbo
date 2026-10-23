/**
 * spam/signals.ts - Collecteurs de signaux.
 *
 * Chaque collecteur est une fonction pure de (contexte) → signal | null.
 * Aucune dépendance à discord.js ni à la base : l'ensemble est testable
 * directement, et c'est ce qui permet de rejouer un raid enregistré contre une
 * configuration donnée.
 */

import type { RecentMessage, SpamEvaluationContext, SpamSignal } from './types.js';
import { containsInvite, containsUrl, detectUnicodeObfuscation, normalizeContent, similarity } from './normalize.js';

/**
 * Un message court n'a pas besoin d'être tapé longtemps : « ok » peut partir
 * plus vite que le déclenchement de l'indicateur de frappe. On n'exige une
 * trace de frappe qu'au-delà de cette longueur.
 */
const TYPING_MIN_LENGTH = 40;
/** Un indicateur de frappe Discord vit ~10 s ; on laisse une marge confortable. */
const TYPING_MAX_AGE_MS = 60_000;

/** En dessous, un message part vite sans que ce soit suspect : on ne parle de collage qu'au-delà. */
const PASTE_MIN_LENGTH = 200;
/**
 * Vitesse de frappe soutenue au-delà de laquelle le texte n'a pas pu être tapé.
 * 15 caractères/s, c'est ~180 mots/min : au-dessus des meilleurs dactylos.
 */
const MAX_HUMAN_CHARS_PER_SECOND = 15;
/** Au-delà, le texte est apparu d'un bloc : collage quasi certain. */
const INSTANT_PASTE_CHARS_PER_SECOND = 50;

function windowOf(ctx: SpamEvaluationContext): RecentMessage[] {
  const cutoff = ctx.now - ctx.tuning.windowSeconds * 1000;
  return ctx.history.filter((m) => m.at >= cutoff);
}

/**
 * Message conséquent posté sans le moindre événement de frappe.
 *
 * Un client Discord réel émet `typingStart` avant un message de cette taille.
 * Les selfbots, les comptes pilotés par script et les tokens volés ne le font
 * pratiquement jamais : réimplémenter le comportement de frappe coûte un aller-
 * retour API supplémentaire dont les campagnes de masse se passent.
 */
export function signalNoTyping(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.typingSignalEnabled) return null;
  // Sans preuve que le bot reçoit les événements de frappe, le signal
  // marquerait tout le monde : on s'abstient.
  if (!ctx.typingObservable) return null;
  if (ctx.content.length < TYPING_MIN_LENGTH) return null;

  const fresh = ctx.lastTypingAt !== null && ctx.now - ctx.lastTypingAt <= TYPING_MAX_AGE_MS;
  if (fresh) return null;

  return {
    type: 'no_typing',
    score: 40,
    label: 'Message posté sans indicateur de frappe',
    detail: `${ctx.content.length} caractères, aucune frappe observée dans les ${TYPING_MAX_AGE_MS / 1000} s précédentes`,
  };
}

/**
 * Gros message apparu après une frappe bien trop courte : copier-coller.
 *
 * Complète `no_typing` : un humain qui colle un texte depuis un vrai client
 * déclenche bien un `typingStart`, mais une ou deux secondes avant d'envoyer
 * 600 caractères. C'est le geste du spammeur manuel qui recopie la même
 * arnaque de serveur en serveur. Coller n'a rien d'illégitime en soi (citation,
 * annonce relayée…) : le score reste modeste et compte surtout en concordance.
 */
export function signalPasteBurst(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.pasteSignalEnabled) return null;
  if (!ctx.typingObservable) return null;
  if (ctx.content.length < PASTE_MIN_LENGTH) return null;
  // Du code se colle par nature : ce n'est pas ce qu'on cherche.
  if (ctx.content.includes('```')) return null;

  // Sans frappe récente, c'est le cas de `no_typing`, pas un collage.
  if (ctx.typingSessionStartAt === null || ctx.lastTypingAt === null) return null;
  if (ctx.now - ctx.lastTypingAt > TYPING_MAX_AGE_MS) return null;

  const typingMs = Math.max(0, ctx.now - ctx.typingSessionStartAt);
  const charsPerSecond = ctx.content.length / Math.max(1, typingMs / 1000);
  if (charsPerSecond <= MAX_HUMAN_CHARS_PER_SECOND) return null;

  return {
    type: 'paste_burst',
    score: charsPerSecond >= INSTANT_PASTE_CHARS_PER_SECOND ? 35 : 25,
    label: 'Gros message collé sans temps de frappe',
    detail: `${ctx.content.length} caractères après ${(typingMs / 1000).toFixed(1)} s de frappe (${Math.round(charsPerSecond)} car./s)`,
  };
}

/** Débit incompatible avec une saisie humaine. */
export function signalInhumanRate(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.cadenceEnabled) return null;

  const recent = ctx.history.filter((m) => m.at >= ctx.now - 3000);
  if (recent.length < 4) return null;

  const perSecond = (recent.length + 1) / 3;
  return {
    type: 'inhuman_rate',
    score: perSecond >= 3 ? 50 : 35,
    label: 'Débit de messages inhumain',
    detail: `${recent.length + 1} messages en 3 s`,
  };
}

/**
 * Intervalles quasi constants entre messages.
 *
 * Un humain a une cadence irrégulière ; une boucle programmée poste à intervalle
 * fixe. C'est un signal indépendant du débit : il attrape aussi les bots lents.
 */
export function signalRegularIntervals(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.cadenceEnabled) return null;

  const times = [...windowOf(ctx).map((m) => m.at), ctx.now].sort((a, b) => a - b);
  if (times.length < 5) return null;

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);

  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (mean === 0) return null;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const stdDev = Math.sqrt(variance);

  // Coefficient de variation : un humain dépasse largement 0.35.
  const cv = stdDev / mean;
  if (cv > 0.15) return null;

  return {
    type: 'regular_intervals',
    score: 32,
    label: 'Intervalles de publication réguliers',
    detail: `${gaps.length} intervalles, écart-type ${Math.round(stdDev)} ms pour une moyenne de ${Math.round(mean)} ms`,
  };
}

/**
 * Même contenu diffusé dans plusieurs salons en quelques secondes.
 *
 * C'est la signature du compte compromis : le script parcourt la liste des
 * salons accessibles. Un humain ne recopie pas le même message dans cinq
 * salons en dix secondes.
 */
export function signalCrossChannelBurst(ctx: SpamEvaluationContext, normalized: string): SpamSignal | null {
  if (!ctx.tuning.crossChannelEnabled) return null;
  if (!normalized) return null;

  const channels = new Set<string>([ctx.channelId]);
  for (const msg of windowOf(ctx)) {
    if (msg.channelId === ctx.channelId) continue;
    if (similarity(msg.normalized, normalized) >= 0.9) channels.add(msg.channelId);
  }

  if (channels.size < ctx.tuning.crossChannelThreshold) return null;

  // Au-delà du seuil, chaque salon supplémentaire renforce fortement la preuve.
  const extra = channels.size - ctx.tuning.crossChannelThreshold;
  return {
    type: 'cross_channel_burst',
    score: Math.min(75, 55 + extra * 10),
    label: 'Même message diffusé dans plusieurs salons',
    detail: `${channels.size} salons en ${ctx.tuning.windowSeconds} s`,
  };
}

/** Répétition quasi identique dans l'historique récent. */
export function signalNearDuplicate(ctx: SpamEvaluationContext, normalized: string): SpamSignal | null {
  if (!ctx.tuning.duplicateEnabled) return null;
  if (!normalized || normalized.length < 6) return null;

  let exact = 0;
  let near = 0;
  for (const msg of windowOf(ctx)) {
    if (msg.normalized === normalized) exact++;
    else if (similarity(msg.normalized, normalized) >= ctx.tuning.duplicateSimilarity) near++;
  }

  const total = exact + near;
  if (total < 2) return null;

  if (exact >= 2 && near === 0) {
    return {
      type: 'repeat_identical',
      score: Math.min(55, 28 + exact * 9),
      label: 'Message identique répété',
      detail: `${exact + 1} occurrences en ${ctx.tuning.windowSeconds} s`,
    };
  }

  return {
    type: 'near_duplicate',
    score: Math.min(50, 26 + total * 8),
    label: 'Messages quasi identiques répétés',
    detail: `${total + 1} variantes en ${ctx.tuning.windowSeconds} s`,
  };
}

/** Rafale de pièces jointes : diffusion d'images de scam. */
export function signalAttachmentFlood(ctx: SpamEvaluationContext): SpamSignal | null {
  if (ctx.attachmentCount === 0) return null;

  const withAttachments = windowOf(ctx).filter((m) => m.hasAttachment).length;
  if (withAttachments < 2) return null;

  return {
    type: 'attachment_flood',
    score: Math.min(45, 22 + withAttachments * 8),
    label: 'Rafale de pièces jointes',
    detail: `${withAttachments + 1} messages avec fichier en ${ctx.tuning.windowSeconds} s`,
  };
}

/** Excès de mentions dans un seul message. */
export function signalMentionBurst(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.contentEnabled) return null;
  if (ctx.mentionCount < 5) return null;

  return {
    type: 'mention_burst',
    score: ctx.mentionCount >= 10 ? 45 : 26,
    label: 'Mentions en masse',
    detail: `${ctx.mentionCount} mentions dans un seul message`,
  };
}

/**
 * Tentative de mention globale sans en avoir la permission.
 *
 * Le texte contient `@everyone` mais Discord n'a résolu aucune mention globale :
 * l'auteur a essayé et n'y avait pas droit. Un membre légitime ne tente pas
 * l'appât à `@everyone` - c'est un réflexe de script de spam.
 */
export function signalEveryoneAttempt(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.contentEnabled) return null;
  if (ctx.mentionedEveryone) return null;
  if (!/@(everyone|here)\b/i.test(ctx.content)) return null;

  return {
    type: 'everyone_attempt',
    score: 28,
    label: 'Tentative de mention globale sans permission',
  };
}

/** Obfuscation unicode délibérée. */
export function signalUnicodeObfuscation(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.contentEnabled) return null;

  const result = detectUnicodeObfuscation(ctx.content);
  if (!result.detected) return null;

  return {
    type: 'unicode_obfuscation',
    score: 32,
    label: 'Contenu volontairement obfusqué',
    detail: result.reason,
  };
}

/** Invitation Discord postée par un compte sans historique. */
export function signalInviteLink(ctx: SpamEvaluationContext): SpamSignal | null {
  if (!ctx.tuning.contentEnabled) return null;
  if (!containsInvite(ctx.content)) return null;
  if (ctx.trust.messageCount > 50) return null;

  return {
    type: 'invite_link',
    score: 26,
    label: 'Invitation Discord postée par un compte sans historique',
    detail: `${ctx.trust.messageCount} messages connus`,
  };
}

/** Un lien dans les tout premiers messages d'un membre. */
export function signalFirstMessageLink(ctx: SpamEvaluationContext): SpamSignal | null {
  if (ctx.trust.messageCount > 2) return null;
  if (!containsUrl(ctx.content)) return null;

  return {
    type: 'first_message_link',
    score: 34,
    label: 'Lien dès les premiers messages',
    detail: `message n°${ctx.trust.messageCount + 1} du membre`,
  };
}

/** Lien posté par un membre arrivé il y a moins de 24 h. */
export function signalLinkFromNewcomer(ctx: SpamEvaluationContext): SpamSignal | null {
  const { membershipMs, accountAgeMs } = ctx.trust;
  if (membershipMs === null || membershipMs > 24 * 60 * 60 * 1000) return null;
  if (!containsUrl(ctx.content)) return null;

  // Un compte récent *et* fraîchement arrivé est bien plus suspect.
  const youngAccount = accountAgeMs !== null && accountAgeMs < 7 * 24 * 60 * 60 * 1000;
  return {
    type: 'link_from_newcomer',
    score: youngAccount ? 38 : 24,
    label: 'Lien posté par une arrivée récente',
    detail: youngAccount ? 'compte de moins de 7 jours, arrivé il y a moins de 24 h' : 'arrivé il y a moins de 24 h',
  };
}

/** Exécute tous les collecteurs et retourne les signaux déclenchés. */
export function collectSignals(ctx: SpamEvaluationContext): SpamSignal[] {
  const normalized = normalizeContent(ctx.content);

  const candidates = [
    signalNoTyping(ctx),
    signalPasteBurst(ctx),
    signalInhumanRate(ctx),
    signalRegularIntervals(ctx),
    signalCrossChannelBurst(ctx, normalized),
    signalNearDuplicate(ctx, normalized),
    signalAttachmentFlood(ctx),
    signalMentionBurst(ctx),
    signalEveryoneAttempt(ctx),
    signalUnicodeObfuscation(ctx),
    signalInviteLink(ctx),
    signalFirstMessageLink(ctx),
    signalLinkFromNewcomer(ctx),
  ];

  return candidates.filter((s): s is SpamSignal => s !== null);
}
