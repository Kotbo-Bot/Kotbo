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
import { fetchGuildLanguage } from './api/guild';
import { authStore } from './stores/auth.svelte';
import { botLocale } from './stores/botLocale.svelte';

let current = $state<Locale>(getLocale());
let currentBot = $state<Locale>(getLocale());
let loadedFor: string | null = null;

overwriteGetLocale(() => current);

botLocale.connect(
  () => {
    const guildId = authStore.selectedGuildId;
    if (guildId && guildId !== loadedFor) {
      loadedFor = guildId;
      void fetchGuildLanguage(guildId).then((language) => {
        if (language && authStore.selectedGuildId === guildId) currentBot = language.locale;
      });
    }
    return currentBot;
  },
  (locale) => {
    currentBot = locale;
  },
);

/** Aligne la langue sur la preference utilisateur et la memorise, sans rechargement. */
export function applyLocale(lang: string): void {
  if (!locales.includes(lang as Locale) || lang === current) return;
  setLocale(lang as Locale, { reload: false });
  current = lang as Locale;
}
