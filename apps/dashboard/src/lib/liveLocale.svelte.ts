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

class LiveLocaleStore {
  current = $state<Locale>(getLocale());
  currentBot = $state<Locale>(getLocale());
  private loadedFor: string | null = null;

  constructor() {
    overwriteGetLocale(() => this.current);

    botLocale.connect(
      () => {
        const guildId = authStore.selectedGuildId;
        if (guildId && guildId !== this.loadedFor) {
          this.loadedFor = guildId;
          void fetchGuildLanguage(guildId).then((language) => {
            if (language && authStore.selectedGuildId === guildId) {
              this.currentBot = language.locale;
            }
          });
        }
        return this.currentBot;
      },
      (locale) => {
        this.currentBot = locale;
      },
    );
  }

  apply(lang: string): void {
    if (!locales.includes(lang as Locale) || lang === this.current) return;
    setLocale(lang as Locale, { reload: false });
    this.current = lang as Locale;
  }
}

// `var` et non `let` : userPreferences appelle applyLocale pendant le cycle
// d'import, avant cette ligne. Un `let` serait encore en TDZ (ReferenceError).
// eslint-disable-next-line no-var
var liveLocaleStore: LiveLocaleStore | undefined;

liveLocaleStore = new LiveLocaleStore();

/** Aligne la langue sur la preference utilisateur et la memorise, sans rechargement. */
export function applyLocale(lang: string): void {
  if (liveLocaleStore) {
    liveLocaleStore.apply(lang);
    return;
  }
  // Appel premature : on memorise via Paraglide, le store la relira a sa creation.
  if (locales.includes(lang as Locale)) setLocale(lang as Locale, { reload: false });
}
