/**
 * Décisions et signaux du module, sans effet de bord : ce qu'il faut faire
 * d'une note de toxicité, et les trois détecteurs dérivés (escalade d'un
 * salon, harcèlement d'un membre, détresse). Les effets (suppression,
 * alertes, mode lent) vivent dans aegisActions.ts.
 *
 * Tout tient en mémoire : un seul process bot, et ces fenêtres se comptent en
 * minutes. Un redémarrage remet les compteurs à zéro, ce qui est sans gravité.
 */
import type { AegisEmotion } from './aegisClient.js';

export type ToxicDecision = 'auto' | 'review' | 'none';

/**
 * Au-dessus du seuil automatique le bot agit seul, sauf :
 * - si la note arrive en retard : supprimer un message vieux de plusieurs
 *   minutes déroute le salon ;
 * - si l'auteur est exempté (administrateur, rôle ou salon exempté) : il est
 *   noté comme tout le monde, mais c'est le staff qui tranche.
 */
export function decideToxicity(
  toxicity: number,
  thresholds: { reviewThreshold: number; autoThreshold: number },
  late: boolean,
  exempt = false,
): ToxicDecision {
  const points = toxicity * 100;
  if (points >= thresholds.autoThreshold) return late || exempt ? 'review' : 'auto';
  if (points >= thresholds.reviewThreshold) return 'review';
  return 'none';
}

/** Colère nette : compte pour l'escalade même sans insulte. */
const ANGER_POINTS = 80;

export function isHeated(toxicity: number | undefined, emotion: { label: AegisEmotion; score: number } | undefined, reviewThreshold: number): boolean {
  if (toxicity !== undefined && toxicity * 100 >= reviewThreshold) return true;
  return emotion?.label === 'anger' && emotion.score * 100 >= ANGER_POINTS;
}

/**
 * Détresse : tristesse ou peur très marquée, dans un message qui n'est pas
 * lui-même toxique (une insulte sort souvent en « sad » chez AegisAI).
 */
export function isDistress(
  emotion: { label: AegisEmotion; score: number } | undefined,
  toxicity: number | undefined,
  thresholds: { distressThreshold: number; reviewThreshold: number },
): boolean {
  if (!emotion || (emotion.label !== 'sad' && emotion.label !== 'fear')) return false;
  if (emotion.score * 100 < thresholds.distressThreshold) return false;
  return toxicity === undefined || toxicity * 100 < thresholds.reviewThreshold;
}

const MAX_KEYS = 20_000;

function prune(map: Map<string, unknown>): void {
  if (map.size <= MAX_KEYS) return;
  // Les plus anciennes clés d'abord (ordre d'insertion).
  for (const key of map.keys()) {
    map.delete(key);
    if (map.size <= MAX_KEYS * 0.9) return;
  }
}

/**
 * Escalade : `threshold` messages échauffés d'au moins deux membres dans le
 * même salon sur `windowMs`. Après un déclenchement, le salon est tenu pour
 * calmé par le mode lent jusqu'à `cooldownUntil`.
 */
export class ConflictTracker {
  private events = new Map<string, Array<{ at: number; authorId: string }>>();
  private cooldownUntil = new Map<string, number>();

  record(
    key: string,
    authorId: string,
    at: number,
    opts: { windowMs: number; threshold: number; cooldownMs: number },
  ): { triggered: false } | { triggered: true; authors: string[]; count: number } {
    if ((this.cooldownUntil.get(key) ?? 0) > at) return { triggered: false };
    const recent = (this.events.get(key) ?? []).filter((e) => at - e.at <= opts.windowMs);
    recent.push({ at, authorId });
    this.events.set(key, recent);
    prune(this.events);

    const authors = [...new Set(recent.map((e) => e.authorId))];
    if (recent.length < opts.threshold || authors.length < 2) return { triggered: false };

    this.events.delete(key);
    this.cooldownUntil.set(key, at + opts.cooldownMs);
    prune(this.cooldownUntil);
    return { triggered: true, authors, count: recent.length };
  }
}

/**
 * Harcèlement : `threshold` messages toxiques d'un même auteur vers une même
 * cible sur `windowMs`. Le compteur repart de zéro après une alerte, pour ne
 * pas en émettre une à chaque message suivant.
 */
export class HarassmentTracker {
  private events = new Map<string, number[]>();

  record(key: string, at: number, opts: { windowMs: number; threshold: number }): { triggered: boolean; count: number } {
    const recent = (this.events.get(key) ?? []).filter((t) => at - t <= opts.windowMs);
    recent.push(at);
    if (recent.length >= opts.threshold) {
      this.events.delete(key);
      return { triggered: true, count: recent.length };
    }
    this.events.set(key, recent);
    prune(this.events);
    return { triggered: false, count: recent.length };
  }
}

/** Une alerte par membre et par période, pour ne pas assaillir le staff. */
export class CooldownGate {
  private last = new Map<string, number>();

  tryPass(key: string, at: number, cooldownMs: number): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && at - previous < cooldownMs) return false;
    this.last.set(key, at);
    prune(this.last);
    return true;
  }
}
