/**
 * Contrôle des réponses de l'API Starlight.
 *
 * Le dashboard et le bot ne sont pas toujours déployés en même temps : un bot
 * plus ancien ne renvoie que les réglages, sans statistiques. Une telle
 * réponse est refusée, la page affiche alors son état d'erreur ; un champ
 * ajouté plus tard prend sa valeur par défaut.
 */
import { defaultStarboardSettings, type StarboardSettings } from '@kotbo/shared';

export interface StarboardEntryItem {
  id: string;
  /** Salon (ou fil) du message d'origine. */
  channelId: string;
  authorId: string;
  /** Pseudo actuel ; `null` pour un membre parti. */
  authorName: string | null;
  avatarUrl: string | null;
  excerpt: string | null;
  /** Lien d'image Discord, qui peut avoir expiré. */
  imageUrl: string | null;
  upvotes: number;
  downvotes: number;
  score: number;
  /** Meilleur score atteint, gardé même si le score est retombé. */
  peakScore: number;
  /** La republication est affichée dans le salon des messages à la une. */
  onBoard: boolean;
  /** Retiré par le staff : n'y revient plus, quels que soient ses votes. Absent d'un bot plus ancien. */
  blocked?: boolean;
  /** Passage à la une. */
  createdAt: string;
  postedAt: string | null;
  messageUrl: string;
  starUrl: string | null;
}

export interface StarboardStats {
  postedRecent: number;
  avgPeakRecent: number | null;
  bestPeakRecent: number | null;
  onBoard: number;
  lastPostedAt: string | null;
}

/** Textes du message publié dans la langue du serveur ; `footerVotes` porte `{up}` et `{down}`. */
export interface StarboardMessageLabels {
  locale: string;
  jumpButton: string;
  footerVotes: string;
  attachmentsField: string;
}

export interface StarboardOverview {
  config: StarboardSettings;
  stats: StarboardStats;
  /** Meilleurs messages de la fenêtre des statistiques. */
  topEntries: StarboardEntryItem[];
  channelStats: Array<{ channelId: string; count: number }>;
  health: { channelFound: boolean | null; missingPermissions: string[] };
  /** Absent d'un bot plus ancien : l'aperçu du message est alors masqué. */
  messageLabels: StarboardMessageLabels | null;
  /** Membres exclus, avec leur identité actuelle. */
  blockedMembers: Array<{ userId: string; name: string | null; avatarUrl: string | null }>;
  /** Auteurs les plus souvent à la une sur la fenêtre des statistiques. */
  topAuthors: Array<{ authorId: string; name: string | null; avatarUrl: string | null; count: number; bestScore: number }>;
  /** Rôles de palier que le bot ne peut pas donner. */
  unmanageableTierRoleIds: string[];
}

export interface StarboardEntryPage {
  entries: StarboardEntryItem[];
  nextCursor: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/** Réglages du formulaire, et eux seuls : `enabled` appartient à l'en-tête du module. */
export function toStarboardConfig(raw: unknown): StarboardSettings | null {
  if (!isObject(raw)) return null;
  const config = defaultStarboardSettings();
  for (const key of Object.keys(config) as Array<keyof StarboardSettings>) {
    const value = raw[key];
    if (value === undefined) continue;
    const fallback = config[key];
    if (Array.isArray(fallback)) {
      if (Array.isArray(value)) (config as unknown as Record<string, unknown>)[key] = [...value];
    } else if (fallback !== null && typeof fallback === 'object') {
      if (isObject(value) && !Array.isArray(value)) (config as unknown as Record<string, unknown>)[key] = { ...value };
    } else {
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return config;
}

export function toStarboardOverview(raw: unknown): StarboardOverview | null {
  if (!isObject(raw) || !isObject(raw.stats)) return null;
  const config = toStarboardConfig(raw.config);
  if (!config) return null;
  const health = isObject(raw.health) ? raw.health : {};
  return {
    config,
    stats: raw.stats as unknown as StarboardOverview['stats'],
    topEntries: Array.isArray(raw.topEntries) ? (raw.topEntries as StarboardOverview['topEntries']) : [],
    channelStats: Array.isArray(raw.channelStats) ? (raw.channelStats as StarboardOverview['channelStats']) : [],
    health: {
      channelFound: typeof health.channelFound === 'boolean' ? health.channelFound : null,
      missingPermissions: Array.isArray(health.missingPermissions) ? (health.missingPermissions as string[]) : [],
    },
    messageLabels: isObject(raw.messageLabels) ? (raw.messageLabels as unknown as StarboardOverview['messageLabels']) : null,
    blockedMembers: Array.isArray(raw.blockedMembers) ? (raw.blockedMembers as StarboardOverview['blockedMembers']) : [],
    topAuthors: Array.isArray(raw.topAuthors) ? (raw.topAuthors as StarboardOverview['topAuthors']) : [],
    unmanageableTierRoleIds: Array.isArray(raw.unmanageableTierRoleIds) ? (raw.unmanageableTierRoleIds as string[]) : [],
  };
}
