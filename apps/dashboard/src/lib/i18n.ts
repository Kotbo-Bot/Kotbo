/**
 * Point d'entrée i18n du dashboard (Paraglide-JS / Inlang).
 *
 * - `m` : messages compilés, type-safe et tree-shakés → `m.home_greeting({ name })`.
 * - `getLocale` : langue active, réactive (voir liveLocale.svelte.ts).
 *
 * La langue est persistée par Paraglide (stratégie `localStorage`, clé
 * `PARAGLIDE_LOCALE`) et reste synchronisée avec `userPrefs.language`
 * via `applyLocale()` ci-dessous.
 */
import { m } from './paraglide/messages.js';
import { getLocale, locales, baseLocale, type Locale } from './paraglide/runtime.js';
import { switchLocale } from './liveLocale.svelte';

/**
 * Aligne la langue Paraglide sur la préférence utilisateur, sans recharger :
 * l'interface se retraduit d'elle-même.
 */
export function applyLocale(lang: string) {
  if (!locales.includes(lang as Locale)) return;
  switchLocale(lang as Locale);
}

/** Locale BCP 47 pour `toLocaleDateString`/`toLocaleTimeString`. */
export function dateLocale(): string {
  return getLocale() === 'fr' ? 'fr-FR' : 'en-GB';
}

export { m, getLocale, locales, baseLocale };
export type { Locale };
