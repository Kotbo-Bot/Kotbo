/**
 * Règles des événements de voyage, sans accès à la base.
 *
 * Les bornes suivent ce que Discord accepte sur l'écran de voyage : cinq boutons par
 * rangée, quatre-vingts caractères par libellé. Au-delà, l'écran entier serait refusé.
 */
import { UserFacingError } from '../../../utils/userFacingError.js';

export const ADVENTURE_TITLE_MAX = 100;
export const ADVENTURE_DESCRIPTION_MAX = 1_000;
/** Une rangée de boutons Discord en porte cinq. */
export const ADVENTURE_CHOICES_MAX = 5;
/** Longueur maximale d'un libellé de bouton Discord. */
export const ADVENTURE_CHOICE_TEXT_MAX = 80;
export const ADVENTURE_HP_EFFECT_RANGE = { min: -1_000, max: 1_000 };
export const ADVENTURE_COIN_EFFECT_RANGE = { min: -100_000, max: 100_000 };
export const ADVENTURE_XP_EFFECT_RANGE = { min: 0, max: 100_000 };
export const ADVENTURE_MIN_LEVEL_RANGE = { min: 0, max: 1_000 };

export type AdventureChoice = {
  text: string;
  hpEffect: number;
  coinEffect: number;
  xpEffect: number;
  minLevel: number;
  /** Titre du serveur remis à qui fait ce choix, une seule fois par joueur. */
  titleId: string | null;
};

export type AdventureEventInput = {
  title?: unknown;
  description?: unknown;
  emoji?: unknown;
  choices?: unknown;
};

export class AdventureEventError extends UserFacingError {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AdventureEventError';
  }
}

function titleIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedInt(value: unknown, range: { min: number; max: number }, label: string): number {
  const number = value === undefined || value === null || value === '' ? 0 : Number(value);
  if (!Number.isFinite(number)) throw new AdventureEventError(`${label} : nombre attendu.`, 400);
  const int = Math.trunc(number);
  if (int < range.min || int > range.max) {
    throw new AdventureEventError(`${label} : entre ${range.min} et ${range.max}.`, 400);
  }
  return int;
}

/** Lit la colonne JSON telle qu'elle est en base, sans jamais lever : une ligne abîmée n'a simplement aucun choix. */
export function parseAdventureChoices(raw: unknown): AdventureChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const choice = entry as Record<string, unknown>;
    if (typeof choice.text !== 'string' || !choice.text.trim()) return [];
    const int = (value: unknown) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);
    return [{
      text: choice.text,
      hpEffect: int(choice.hpEffect),
      coinEffect: int(choice.coinEffect),
      xpEffect: int(choice.xpEffect),
      minLevel: int(choice.minLevel),
      titleId: titleIdOf(choice.titleId),
    }];
  });
}

/**
 * Valide un événement saisi au dashboard.
 *
 * Les bornes suivent ce que Discord accepte : cinq boutons par rangée, quatre-vingts
 * caractères par libellé. Au-delà, l'écran de voyage entier serait refusé.
 */
export function normalizeAdventureEventInput(input: AdventureEventInput): {
  title: string;
  description: string;
  emoji: string;
  choices: AdventureChoice[];
} {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > ADVENTURE_TITLE_MAX) {
    throw new AdventureEventError(`Le titre doit faire entre 1 et ${ADVENTURE_TITLE_MAX} caractères.`, 400);
  }

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description || description.length > ADVENTURE_DESCRIPTION_MAX) {
    throw new AdventureEventError(`La description doit faire entre 1 et ${ADVENTURE_DESCRIPTION_MAX} caractères.`, 400);
  }

  const emoji = typeof input.emoji === 'string' && input.emoji.trim() ? input.emoji.trim().slice(0, 64) : '🌲';

  if (!Array.isArray(input.choices) || input.choices.length === 0) {
    throw new AdventureEventError('Un événement propose au moins un choix.', 400);
  }
  if (input.choices.length > ADVENTURE_CHOICES_MAX) {
    throw new AdventureEventError(`Un événement propose au plus ${ADVENTURE_CHOICES_MAX} choix.`, 400);
  }

  const choices = input.choices.map((entry, index) => {
    const choice = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const label = `Choix ${index + 1}`;
    const text = typeof choice.text === 'string' ? choice.text.trim() : '';
    if (!text || text.length > ADVENTURE_CHOICE_TEXT_MAX) {
      throw new AdventureEventError(`${label} : le libellé doit faire entre 1 et ${ADVENTURE_CHOICE_TEXT_MAX} caractères.`, 400);
    }
    return {
      text,
      hpEffect: boundedInt(choice.hpEffect, ADVENTURE_HP_EFFECT_RANGE, `${label}, PV`),
      coinEffect: boundedInt(choice.coinEffect, ADVENTURE_COIN_EFFECT_RANGE, `${label}, pièces`),
      xpEffect: boundedInt(choice.xpEffect, ADVENTURE_XP_EFFECT_RANGE, `${label}, XP`),
      minLevel: boundedInt(choice.minLevel, ADVENTURE_MIN_LEVEL_RANGE, `${label}, niveau minimum`),
      titleId: titleIdOf(choice.titleId),
    };
  });

  return { title, description, emoji, choices };
}
