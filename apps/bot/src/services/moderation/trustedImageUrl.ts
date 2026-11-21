/**
 * Hôtes dont le bot accepte de télécharger une image. Les pièces jointes et les
 * aperçus (`proxyURL`) viennent du CDN Discord ; l'URL d'origine d'un embed
 * (bot, webhook) peut viser n'importe quel hôte, dont le réseau interne.
 */
const IMAGE_HOST_SUFFIXES = ['discordapp.com', 'discordapp.net', 'discord.com', 'discord.media'];

export function isTrustedImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    return IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}
