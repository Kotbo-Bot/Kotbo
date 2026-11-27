/** Repérages de la cellule de suivi : mots de détresse, météo du staff et signal aux modérateurs. */
import { createHmac } from 'node:crypto';
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

// ── Météo du staff ─────────────────────────────────────────────────────────

/** Une semaine n'affiche sa moyenne qu'à partir de ce nombre de réponses : personne n'est reconnaissable. */
export const PULSE_MIN_RESPONSES = 5;
/** Membres interrogés au plus, par serveur et par semaine. */
export const PULSE_MAX_RECIPIENTS = 200;
export const PULSE_WEEKS_SHOWN = 8;
export const PULSE_BUTTON_PREFIX = 'wellbeing:pulse:';

/** Semaine ISO 8601 (`2026-W48`) : le sondage et ses réponses s'y rattachent. */
export function pulseWeekKey(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  // Le jeudi de la semaine décide de son année.
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function cleanPulseScore(input: string): 1 | 2 | 3 | 4 | 5 | null {
  const score = Number(input);
  return Number.isInteger(score) && score >= 1 && score <= 5 ? (score as 1 | 2 | 3 | 4 | 5) : null;
}

/**
 * Empreinte d'un votant pour une semaine : elle empêche de voter deux fois,
 * sans relier un vote à une personne (les notes sont de simples compteurs).
 * Clé secrète : l'empreinte ne se recalcule pas à partir des membres du serveur.
 */
export function pulseVoterHash(guildId: string, week: string, userId: string): string {
  const key = process.env.WELLBEING_ENCRYPTION_KEY || process.env.JWT_SECRET || 'kotbo-wellbeing-pulse';
  return createHmac('sha256', key).update(`${guildId}:${week}:${userId}`).digest('hex');
}

export interface PulseWeekCounts {
  week: string;
  score1: number;
  score2: number;
  score3: number;
  score4: number;
  score5: number;
}

export function pulseSummary(weeks: readonly PulseWeekCounts[]): Array<{ week: string; responses: number; average: number | null }> {
  return [...weeks]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((row) => {
      const counts = [row.score1, row.score2, row.score3, row.score4, row.score5];
      const responses = counts.reduce((sum, n) => sum + n, 0);
      const total = counts.reduce((sum, n, index) => sum + n * (index + 1), 0);
      return {
        week: row.week,
        responses,
        average: responses >= PULSE_MIN_RESPONSES ? Math.round((total / responses) * 10) / 10 : null,
      };
    });
}

// ── Signal aux modérateurs ─────────────────────────────────────────────────

/**
 * Message privé au modérateur qui vient de sanctionner une personne suivie :
 * ni le motif ni le contenu du dossier, seulement de passer par la cellule.
 */
export function sanctionModeratorText(): string {
  return 'Cellule de suivi : la personne que vous venez de sanctionner est suivie par la cellule. Prenez contact avec la cellule avant toute suite à donner.';
}
