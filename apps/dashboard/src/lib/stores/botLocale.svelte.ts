/**
 * Langue du bot sur le serveur selectionne.
 *
 * Un texte qui part sur Discord (message d'accueil par defaut, noms de roles,
 * regles proposees...) doit etre dans la langue du serveur, pas dans celle de
 * l'admin qui regarde le dashboard. Usage : `m.bot_xxx({}, bot())`.
 *
 * Tant que la langue n'est pas chargee, on prend celle du dashboard.
 */
import { getLocale, type Locale } from '../i18n';

let getCurrent: () => Locale = () => getLocale();
let setCurrent: (locale: Locale) => void = (locale) => {
  getCurrent = () => locale;
};

export const botLocale = {
  get value(): Locale {
    return getCurrent();
  },
  /** A appeler apres un changement de langue du bot, pour ne pas attendre un rechargement. */
  set(locale: Locale) {
    setCurrent(locale);
  },
  /** Branche la lecture et l'ecriture sur l'etat Svelte du dashboard (appele par liveLocale.svelte.ts). */
  connect(get: () => Locale, set: (locale: Locale) => void) {
    getCurrent = get;
    setCurrent = set;
  },
};

/** Options Paraglide pour ecrire dans la langue du bot. */
export function bot(): { locale: Locale } {
  return { locale: botLocale.value };
}
