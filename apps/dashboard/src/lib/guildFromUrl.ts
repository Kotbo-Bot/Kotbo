/**
 * Ouvrir le dashboard sur un serveur precis depuis un lien : `?guild=<id>`.
 *
 * Les messages prives du bot (relances, avis) menent a une page du dashboard,
 * mais celui-ci rouvrait le dernier serveur consulte : un administrateur de
 * plusieurs serveurs arrivait sur le mauvais. Ce module, importe avant tout
 * store, pose le serveur demande comme serveur courant puis retire le
 * parametre de l'adresse. Le store de session verifie ensuite l'acces comme
 * pour n'importe quel serveur choisi a la main.
 */
const GUILD_ID = /^\d{17,20}$/;

if (typeof window !== 'undefined') {
  try {
    const url = new URL(window.location.href);
    const guildId = url.searchParams.get('guild');
    if (guildId && GUILD_ID.test(guildId)) {
      localStorage.setItem('kotbo_guild_id', guildId);
      url.searchParams.delete('guild');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    // Stockage ou URL indisponible : le dashboard garde son serveur habituel.
  }
}

export {};
