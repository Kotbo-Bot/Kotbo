/** Repérages de la cellule de suivi : mots de détresse et signal aux modérateurs. */
import { DAY_MS } from './wellbeingPolicyShared.js';

// ── Mots de détresse ───────────────────────────────────────────────────────

/**
 * Formulations qui appellent l'attention de la cellule. Volontairement
 * étroites : « mourir de rire », « en finir avec ce boss » ou « going to die
 * in this raid » ne comptent pas.
 * Le repérage ne crée jamais de dossier : il propose, la cellule juge.
 */
/** « mourir de rire », « crever de faim » : des expressions, pas de la détresse. */
const NOT_LITERAL = String.raw`(?! de (rire|faim|chaud|froid|honte|fatigue|soif|ennui))`;
const DISTRESS_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\benvie de (mourir|crever|disparaitre)\b${NOT_LITERAL}`),
  /\benvie d'en finir\b/,
  new RegExp(String.raw`\b(veux|voudrais|prefererais) (mourir|disparaitre)\b${NOT_LITERAL}`),
  /\b(veux|voudrais|envie de) me tuer\b/,
  /\b(veux|envie de|besoin de) me faire du mal\b/,
  /\bme (suicider|scarifier|foutre en l'air)\b/,
  /\bsuicidaire\b/,
  /\bplus (envie|la force|aucune raison) de vivre\b/,
  /\ben finir avec (la vie|ma vie)\b/,
  /\bkill myself\b/,
  /\b(want|wanna) to die\b/,
  /\bwant to hurt myself\b/,
  /\bend it all\b/,
  /\bsuicidal\b/,
  /\bself[- ]?harm\b/,
  /\bno reason to live\b/,
];

export function detectDistress(content: string): boolean {
  const text = content
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase();
  return text.length > 0 && DISTRESS_PATTERNS.some((pattern) => pattern.test(text));
}

/** Un même membre ne déclenche qu'un signal par jour : la cellule n'est pas noyée. */
export const DISTRESS_COOLDOWN_MS = DAY_MS;
/** Signaux examinés ou non, effacés après ce délai. */
export const DISTRESS_SIGNAL_DAYS = 30;

export function shouldSignalDistress(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= DISTRESS_COOLDOWN_MS;
}

// ── Signal aux modérateurs ─────────────────────────────────────────────────

/**
 * Message privé au modérateur qui vient de sanctionner une personne suivie :
 * ni le motif ni le contenu du dossier, seulement de passer par la cellule.
 */
export function sanctionModeratorText(): string {
  return 'Cellule de suivi : la personne que vous venez de sanctionner est suivie par la cellule. Prenez contact avec la cellule avant toute suite à donner.';
}
