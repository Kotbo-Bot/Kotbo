/**
 * Point d'entrée i18n du dashboard (Paraglide-JS / Inlang).
 *
 * - `m` : messages compilés, type-safe et tree-shakés → `m.home_greeting({ name })`.
 * - `getLocale` : langue active, réactive dans l'application (voir
 *   liveLocale.svelte.ts, qui la change sans recharger la page).
 *
 * La langue est persistée par Paraglide (stratégie `localStorage`, clé
 * `PARAGLIDE_LOCALE`) et reste synchronisée avec `userPrefs.language`.
 */
import { m } from './paraglide/messages.js';
import { getLocale, locales, baseLocale, type Locale } from './paraglide/runtime.js';

/** Locale BCP 47 pour `toLocaleDateString`/`toLocaleTimeString`. */
export function dateLocale(): string {
  return getLocale() === 'fr' ? 'fr-FR' : 'en-GB';
}

export { m, getLocale, locales, baseLocale };
export type { Locale };
