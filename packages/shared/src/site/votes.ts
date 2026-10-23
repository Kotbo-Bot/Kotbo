/**
 * Sites de vote pour un serveur : catalogue des sites de classement reconnus
 * et de leur façon de vérifier un vote.
 *
 * - `webhook` : le site de classement appelle Kotbo à chaque vote (top.gg),
 *   authentifié par un secret que Kotbo génère ;
 * - `user` : Kotbo demande au site si tel membre a voté (identifiant Discord
 *   transmis dans le lien de vote) ;
 * - `ip` : Kotbo demande au site si l'adresse IP du visiteur vient de voter
 *   (sites de classement de serveurs de jeu), quand le membre clique
 *   « J'ai voté ».
 *
 * Adresses de vérification reprises du plugin Vote d'Azuriom (MIT).
 */

export const SITE_VOTE_PROVIDERS = {
  topgg: { label: 'top.gg', verification: 'webhook', cooldownHours: 12, keyLabel: null, host: 'top.gg' },
  discordtop: { label: 'DiscordTop', verification: 'user', cooldownHours: 24, keyLabel: 'api_key', host: 'discordtop.net' },
  topserveurs: { label: 'Top-Serveurs', verification: 'ip', cooldownHours: 2, keyLabel: 'token', host: 'top-serveurs.net' },
  topgames: { label: 'Top-Games', verification: 'ip', cooldownHours: 2, keyLabel: 'token', host: 'top-games.net' },
  serveurprive: { label: 'Serveur Privé', verification: 'ip', cooldownHours: 2, keyLabel: 'api_key', host: 'serveur-prive.net' },
  serveursminecraft: { label: 'Serveurs-Minecraft.org', verification: 'ip', cooldownHours: 24, keyLabel: 'server_id', host: 'serveurs-minecraft.org' },
  listeserveurs: { label: 'Liste-Serveurs.fr', verification: 'ip', cooldownHours: 3, keyLabel: 'server_id', host: 'liste-serveurs.fr' },
  serveurliste: { label: 'ServeurListe', verification: 'ip', cooldownHours: 3, keyLabel: 'api_key', host: 'serveurliste.com' },
  serveurminecraftvote: { label: 'Serveur-Minecraft-Vote.fr', verification: 'ip', cooldownHours: 3, keyLabel: 'server_id', host: 'serveur-minecraft-vote.fr' },
} as const;

export type SiteVoteProvider = keyof typeof SITE_VOTE_PROVIDERS;
export type SiteVoteVerification = 'webhook' | 'user' | 'ip';
export const SITE_VOTE_PROVIDER_KEYS = Object.keys(SITE_VOTE_PROVIDERS) as SiteVoteProvider[];

export function isSiteVoteProvider(value: unknown): value is SiteVoteProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SITE_VOTE_PROVIDERS, value);
}

/** Lien de vote : HTTPS, sur le domaine du site de classement (ou un sous-domaine). */
export function normalizeVoteUrl(provider: SiteVoteProvider, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const host = SITE_VOTE_PROVIDERS[provider].host;
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== host && !url.hostname.endsWith(`.${host}`)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Lien envoyé au membre : avec son identifiant quand le site vérifie par membre. */
export function memberVoteUrl(provider: SiteVoteProvider, voteUrl: string, userId: string | null): string {
  if (SITE_VOTE_PROVIDERS[provider].verification !== 'user' || !userId) return voteUrl;
  const url = new URL(voteUrl);
  url.searchParams.set('external_id', userId);
  return url.toString();
}

/** Délai entre deux votes comptés, borné (1 h à 7 jours). */
export function normalizeVoteCooldown(value: unknown, provider: SiteVoteProvider): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return SITE_VOTE_PROVIDERS[provider].cooldownHours;
  return Math.min(168, Math.max(1, Math.round(n)));
}

/**
 * Fenêtre de vote : numéro de la tranche de `cooldownHours` dans laquelle tombe
 * l'instant. Un seul vote récompensé par fenêtre et par site.
 */
export function voteWindow(date: Date, cooldownHours: number): number {
  return Math.floor(date.getTime() / (cooldownHours * 3_600_000));
}
