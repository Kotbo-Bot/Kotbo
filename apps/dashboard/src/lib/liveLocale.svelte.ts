/**
 * Langue du dashboard sous forme d'etat Svelte.
 *
 * Paraglide lit la langue a chaque appel de message via `getLocale` : en la
 * remplacant par la lecture d'un `$state`, tout `m.cle()` lu dans un template
 * ou un `$derived` se retraduit seul quand la langue change, sans recharger la
 * page (issue 671). La persistance reste celle de Paraglide (localStorage).
 *
 * Module a part de i18n.ts : les tests Bun importent `m` sans compiler les
 * runes. Il est charge des l'entree (main.ts), avant le premier rendu.
 */
import { getLocale, locales, overwriteGetLocale, setLocale, type Locale } from './paraglide/runtime.js';

let current = $state<Locale>(getLocale());

overwriteGetLocale(() => current);

/** Aligne la langue sur la preference utilisateur et la memorise, sans rechargement. */
export function applyLocale(lang: string): void {
  if (!locales.includes(lang as Locale) || lang === current) return;
  setLocale(lang as Locale, { reload: false });
  current = lang as Locale;
}
