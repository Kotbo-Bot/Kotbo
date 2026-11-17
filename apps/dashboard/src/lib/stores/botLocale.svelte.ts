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
import { fetchGuildLanguage } from '../api/guild';
import { authStore } from './auth.svelte';

let current = $state<Locale>(getLocale());
let loadedFor: string | null = null;

function load() {
  const guildId = authStore.selectedGuildId;
  if (!guildId || guildId === loadedFor) return;
  loadedFor = guildId;
  void fetchGuildLanguage(guildId).then((language) => {
    if (language && authStore.selectedGuildId === guildId) current = language.locale;
  });
}

export const botLocale = {
  get value(): Locale {
    load();
    return current;
  },
  /** A appeler apres un changement de langue du bot, pour ne pas attendre un rechargement. */
  set(locale: Locale) {
    current = locale;
  },
};

/** Options Paraglide pour ecrire dans la langue du bot. */
export function bot(): { locale: Locale } {
  return { locale: botLocale.value };
}
