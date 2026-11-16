/**
 * Règles de Starlight (messages à la une) partagées entre le bot et le
 * dashboard : ce que la page annonce est ce que l'API applique.
 */

export interface StarboardSettings {
  /** Salon de publication. Sans lui, le module reste inerte. */
  channelId: string | null;
  upvoteEmojis: string[];
  downvoteEmojis: string[];
  threshold: number;
  countEmbedReactions: boolean;
  autoReactEmbed: boolean;
  autoReactChannels: string[];
  watchedChannels: string[];
  ignoredChannels: string[];
  allowBots: boolean;
  ignoreAuthorVotes: boolean;
  embedColor: string;
  removeBelowThreshold: boolean;
}

/** Valeurs du schéma, rendues tant que le serveur n'a rien enregistré. */
export const DEFAULT_STARBOARD_CONFIG: Readonly<StarboardSettings> = Object.freeze({
  channelId: null,
  upvoteEmojis: ['👍'],
  downvoteEmojis: ['👎'],
  threshold: 5,
  countEmbedReactions: true,
  autoReactEmbed: true,
  autoReactChannels: [],
  watchedChannels: [],
  ignoredChannels: [],
  allowBots: false,
  ignoreAuthorVotes: true,
  embedColor: '#F5C518',
  removeBelowThreshold: true,
});

/** Copie modifiable des valeurs par défaut : les tableaux ne sont pas partagés. */
export function defaultStarboardSettings(): StarboardSettings {
  return structuredClone({ ...DEFAULT_STARBOARD_CONFIG }) as StarboardSettings;
}

export const STARBOARD_THRESHOLD = { min: 1, max: 1000 } as const;
export const STARBOARD_EMOJIS_MAX = 10;
export const STARBOARD_CHANNELS_MAX = 100;

/** Fenêtre des statistiques de la page, en jours. */
export const STARBOARD_STATS_DAYS = 30;

/**
 * Au-delà de ce rythme quotidien sur la fenêtre, le salon des messages à la
 * une ne met plus rien en avant : le seuil est trop bas.
 */
export const STARBOARD_BUSY_PER_DAY = 5;

/** Extrait du message gardé avec l'entrée, pour la galerie du dashboard. */
export const STARBOARD_EXCERPT_MAX = 300;

export const STARBOARD_PERIODS = ['week', 'month', 'all'] as const;
export type StarboardPeriod = (typeof STARBOARD_PERIODS)[number];

export const STARBOARD_SORTS = ['recent', 'score'] as const;
export type StarboardSort = (typeof STARBOARD_SORTS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Record<Exclude<StarboardPeriod, 'all'>, number> = { week: 7, month: 30 };

export function isStarboardPeriod(value: unknown): value is StarboardPeriod {
  return typeof value === 'string' && (STARBOARD_PERIODS as readonly string[]).includes(value);
}

export function isStarboardSort(value: unknown): value is StarboardSort {
  return typeof value === 'string' && (STARBOARD_SORTS as readonly string[]).includes(value);
}

/** Début de la période en jours glissants ; `null` pour « depuis toujours ». */
export function starboardPeriodStart(period: StarboardPeriod, now: Date = new Date()): Date | null {
  if (period === 'all') return null;
  return new Date(now.getTime() - PERIOD_DAYS[period] * DAY_MS);
}

/** Texte du message, sans espaces autour, plafonné pour la galerie. */
export function starboardExcerpt(content: string | null | undefined): string | null {
  const text = content?.trim();
  if (!text) return null;
  return text.length <= STARBOARD_EXCERPT_MAX ? text : `${text.slice(0, STARBOARD_EXCERPT_MAX - 1)}…`;
}

/**
 * Curseur du classement au meilleur score : score et id de la dernière ligne
 * affichée, la reprise se fait « sous » ce couple.
 */
const SCORE_CURSOR_RE = /^(-?\d{1,9})_([A-Za-z0-9]{1,40})$/;

export function encodeScoreCursor(score: number, id: string): string {
  return `${score}_${id}`;
}

export function decodeScoreCursor(raw: string): { score: number; id: string } | null {
  const match = SCORE_CURSOR_RE.exec(raw);
  return match ? { score: Number(match[1]), id: match[2] } : null;
}

export type StarboardAdvice = 'NO_CHANNEL' | 'CHANNEL_GONE' | 'MISSING_PERMISSIONS' | 'QUIET' | 'BUSY';

export interface StarboardAdviceInput {
  channelId: string | null;
  /** `null` : non vérifiable (serveur absent du cache de ce shard). */
  channelFound: boolean | null;
  missingPermissions: readonly string[];
  /** Messages mis à la une sur les `STARBOARD_STATS_DAYS` derniers jours. */
  postedRecent: number;
  lastPostedAt: Date | string | null;
}

/**
 * Conseils de la page, le plus bloquant d'abord. Un salon absent ou
 * injoignable rend les autres sans objet : rien ne peut être publié.
 */
export function starboardAdvice(input: StarboardAdviceInput): StarboardAdvice[] {
  if (!input.channelId) return ['NO_CHANNEL'];
  if (input.channelFound === false) return ['CHANNEL_GONE'];
  if (input.missingPermissions.length > 0) return ['MISSING_PERMISSIONS'];

  if (input.postedRecent === 0) return input.lastPostedAt ? ['QUIET'] : [];
  if (input.postedRecent >= STARBOARD_BUSY_PER_DAY * STARBOARD_STATS_DAYS) return ['BUSY'];
  return [];
}
