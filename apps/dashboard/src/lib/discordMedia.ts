const EMBED_AVATAR = (index = 0) =>
  `https://cdn.discordapp.com/embed/avatars/${Math.abs(index) % 5}.png`;

/**
 * Avatars par defaut de Discord : cinq images identiques pour tout le monde.
 *
 * Elles arrivent encore par la base pour les profils enregistres avant que le
 * bot cesse de stocker `displayAvatarURL()` (issue #211). On les traite comme
 * une absence d'avatar pour rendre l'initiale locale a la place, sinon une
 * liste de membres affiche plusieurs fois la meme vignette.
 */
const DEFAULT_AVATAR_PATTERN = /cdn\.discordapp\.com\/embed\/avatars\//i;

/**
 * Palette des avatars a initiale. Teintes distinctes et suffisamment sombres
 * pour rester lisibles sous un texte blanc, en clair comme en sombre.
 */
const INITIAL_AVATAR_COLORS = [
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#ca8a04',
  '#ea580c',
  '#dc2626',
  '#db2777',
  '#4f46e5',
  '#475569',
];

/** Hash stable (FNV-1a 32 bits) : la meme graine donne toujours la meme couleur. */
function seedHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Avatar de repli genere localement, sans transmettre le nom a un service tiers.
 *
 * `seed` (l'identifiant Discord en pratique) choisit la couleur de fond : deux
 * membres sans photo restent ainsi visuellement distincts dans une liste.
 */
export function localInitialAvatar(
  name: string | null | undefined,
  seed?: string | null
): string {
  // Premier point de code, pas charAt(0) : un emoji coupe en deux fait lever encodeURIComponent.
  const initial = (Array.from(name?.trim() ?? '')[0] || '?').toUpperCase().replace(/[<>&"']/g, '');
  const key = seed?.trim() || name?.trim() || '';
  const background = key
    ? INITIAL_AVATAR_COLORS[seedHash(key) % INITIAL_AVATAR_COLORS.length]
    : '#334155';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${background}"/><text x="32" y="40" text-anchor="middle" font-family="system-ui,sans-serif" font-size="30" font-weight="700" fill="#f8fafc">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Vrai si l'URL n'est rien d'autre que l'avatar generique de Discord. */
export function isDefaultDiscordAvatar(url: string | null | undefined): boolean {
  return typeof url === 'string' && DEFAULT_AVATAR_PATTERN.test(url);
}

/**
 * Avatar affichable d'un membre : sa photo si elle existe, sinon une vignette
 * a initiale coloree par son identifiant.
 *
 * A preferer partout ou l'on affiche un membre. Retomber sur
 * `embed/avatars/N.png` donne la meme image a tous les profils sans photo (et a
 * tous ceux dont le profil Discord n'est pas resolvable), ce qui rend les
 * classements illisibles.
 */
export function memberAvatarSrc(
  url: string | null | undefined,
  name?: string | null,
  userId?: string | null
): string {
  if (typeof url === 'string') {
    const trimmed = url.trim();
    if (
      trimmed
      && (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('data:'))
      && !isDefaultDiscordAvatar(trimmed)
    ) {
      return trimmed;
    }
  }
  return localInitialAvatar(name, userId);
}

/** URL sûre pour un avatar (évite les chemins relatifs type "0.png"). */
export function resolveAvatarSrc(
  url: string | null | undefined,
  fallbackIndex = 0
): string {
  const fallback = EMBED_AVATAR(fallbackIndex);
  if (!url || typeof url !== 'string') return fallback;
  const trimmed = url.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return trimmed;
  return fallback;
}

/** Icône de serveur Discord (hash ou URL complète). */
export function resolveGuildIconSrc(
  guildId: string,
  icon: string | null | undefined
): string | null {
  if (!icon || typeof icon !== 'string') return null;
  const trimmed = icon.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return trimmed;
  const ext = trimmed.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${trimmed}.${ext}`;
}

/** Avatar utilisateur Discord à partir de l'id + hash. */
export function resolveUserAvatarSrc(
  userId: string | null | undefined,
  avatarHash: string | null | undefined
): string {
  if (!userId || !avatarHash) return EMBED_AVATAR(0);
  const hash = avatarHash.trim();
  if (!hash) return EMBED_AVATAR(0);
  if (hash.startsWith('https://') || hash.startsWith('http://')) return hash;
  const ext = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}`;
}
