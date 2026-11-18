/**
 * Langue du dashboard sous forme d'etat Svelte.
 *
 * Paraglide lit la langue a chaque appel de message via `getLocale` : en la
 * remplacant par la lecture d'un `$state`, tout `m.cle()` lu dans un template
 * ou un `$derived` se retraduit seul quand la langue change, sans recharger la
 * page (issue 671). La persistance reste celle de Paraglide (localStorage).
 */
import { getLocale, overwriteGetLocale, setLocale, type Locale } from './paraglide/runtime.js';

let current = $state<Locale>(getLocale());

overwriteGetLocale(() => current);

/** Change la langue active et la memorise, sans rechargement. */
export function switchLocale(next: Locale): void {
  if (next === current) return;
  setLocale(next, { reload: false });
  current = next;
}
