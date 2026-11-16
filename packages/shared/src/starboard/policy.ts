/**
 * Règles de Starlight (messages à la une) partagées entre le bot et le
 * dashboard : ce que la page annonce est ce que l'API applique.
 */
import { validateReputationTiers, type ReputationTier } from '../reputation/tiers.js';

/**
 * Palier : à un nombre de messages passés à la une, l'auteur reçoit un rôle.
 * Même forme et mêmes règles que les paliers de réputation.
 */
export type StarboardTier = ReputationTier;

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
  /** Âge maximum d'un message pour entrer à la une, en jours. `0` = aucune limite. */
  maxMessageAgeDays: number;
  /** Seuils propres à certains salons (id du salon -> score). */
  channelThresholds: Record<string, number>;
  /** Membres dont les messages ne passent jamais à la une. */
  blockedUserIds: string[];
  /** Gains de l'auteur au premier passage à la une d'un message. `0` = rien. */
  rewardXp: number;
  rewardCoins: number;
  /** Rôles donnés à un nombre de messages passés à la une. */
  tiers: StarboardTier[];
  /** Prévenir l'auteur en message privé au premier passage à la une. */
  notifyAuthor: boolean;
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
  maxMessageAgeDays: 0,
  channelThresholds: {},
  blockedUserIds: [],
  rewardXp: 0,
  rewardCoins: 0,
  tiers: [],
  notifyAuthor: false,
});

/** Copie modifiable des valeurs par défaut : les tableaux ne sont pas partagés. */
export function defaultStarboardSettings(): StarboardSettings {
  return structuredClone({ ...DEFAULT_STARBOARD_CONFIG }) as StarboardSettings;
}

export const STARBOARD_THRESHOLD = { min: 1, max: 1000 } as const;
export const STARBOARD_EMOJIS_MAX = 10;
export const STARBOARD_CHANNELS_MAX = 100;
export const STARBOARD_MAX_AGE_DAYS = { min: 0, max: 365 } as const;
export const STARBOARD_CHANNEL_THRESHOLDS_MAX = 25;
export const STARBOARD_BLOCKED_USERS_MAX = 100;
export const STARBOARD_REWARD_XP = { min: 0, max: 5_000 } as const;
export const STARBOARD_REWARD_COINS = { min: 0, max: 100_000 } as const;

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

const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Seuil qui s'applique au message : celui de son salon, sinon celui du salon
 * parent pour un fil (personne ne règle ses fils un par un), sinon celui du
 * serveur.
 */
export function starboardThresholdFor(
  settings: Pick<StarboardSettings, 'threshold' | 'channelThresholds'>,
  channelId: string,
  parentId: string | null,
): number {
  return settings.channelThresholds[channelId]
    ?? (parentId ? settings.channelThresholds[parentId] : undefined)
    ?? settings.threshold;
}

export type StarboardChannelThresholdError = 'NOT_OBJECT' | 'TOO_MANY' | 'BAD_CHANNEL' | 'BAD_THRESHOLD';

export function normalizeStarboardChannelThresholds(
  raw: unknown,
): { thresholds: Record<string, number> } | { error: StarboardChannelThresholdError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'NOT_OBJECT' };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > STARBOARD_CHANNEL_THRESHOLDS_MAX) return { error: 'TOO_MANY' };
  const thresholds: Record<string, number> = {};
  for (const [channelId, value] of entries) {
    if (!SNOWFLAKE_RE.test(channelId)) return { error: 'BAD_CHANNEL' };
    if (typeof value !== 'number' || !Number.isInteger(value)
      || value < STARBOARD_THRESHOLD.min || value > STARBOARD_THRESHOLD.max) {
      return { error: 'BAD_THRESHOLD' };
    }
    thresholds[channelId] = value;
  }
  return { thresholds };
}

export type StarboardSkipReason = 'BLOCKED_MESSAGE' | 'BLOCKED_AUTHOR' | 'NSFW' | 'TOO_OLD';

export interface StarboardCandidate {
  authorId: string;
  /** Message retiré de la une par le staff. */
  blocked: boolean;
  /** Le salon du message (ou le parent d'un fil) est marqué NSFW, réservé aux adultes. */
  sourceNsfw: boolean;
  boardNsfw: boolean;
  messageCreatedAt: Date;
  /** Le message est déjà passé à la une : la limite d'âge ne le concerne plus. */
  alreadyEntered: boolean;
}

/**
 * Ce qui interdit au message d'être (ou de rester) à la une, ou `null`.
 *
 * Un message NSFW n'est jamais republié dans un salon tout public : il
 * contournerait la restriction aux adultes du salon d'origine. La limite d'âge du
 * message, elle, ne joue qu'à l'entrée : un message déjà à la une continue de
 * suivre ses votes.
 */
export function starboardSkipReason(
  settings: Pick<StarboardSettings, 'blockedUserIds' | 'maxMessageAgeDays'>,
  candidate: StarboardCandidate,
  now: Date = new Date(),
): StarboardSkipReason | null {
  if (candidate.blocked) return 'BLOCKED_MESSAGE';
  if (settings.blockedUserIds.includes(candidate.authorId)) return 'BLOCKED_AUTHOR';
  if (candidate.sourceNsfw && !candidate.boardNsfw) return 'NSFW';
  if (!candidate.alreadyEntered && settings.maxMessageAgeDays > 0
    && now.getTime() - candidate.messageCreatedAt.getTime() > settings.maxMessageAgeDays * DAY_MS) {
    return 'TOO_OLD';
  }
  return null;
}

/** Seuils par salon lus en base : une valeur abîmée vaut « aucun » plutôt qu'une erreur. */
export function readStarboardChannelThresholds(raw: unknown): Record<string, number> {
  const parsed = normalizeStarboardChannelThresholds(raw);
  return 'error' in parsed ? {} : parsed.thresholds;
}

/**
 * Image servie par Discord lui-même (pièces jointes, aperçus de liens relayés,
 * stickers). Le dashboard n'affiche rien d'autre : une image chargée depuis
 * le site d'origine d'un lien collé transmettrait l'adresse IP du staff à
 * n'importe quel site partagé par un membre.
 */
const DISCORD_MEDIA_HOST = /^(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/;

export function isDiscordMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && DISCORD_MEDIA_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** Paliers lus en base : une valeur abîmée vaut « aucun » plutôt qu'une erreur. */
export function readStarboardTiers(raw: unknown): StarboardTier[] {
  const parsed = validateReputationTiers(raw);
  return 'error' in parsed ? [] : parsed.tiers;
}

/**
 * Pourquoi un message quitte la une, transmis aux workflows : score retombé,
 * retrait par le staff, garde-fou (auteur exclu, salon NSFW), ou message
 * d'origine supprimé.
 */
export const STARBOARD_REMOVAL_REASONS = ['BELOW_THRESHOLD', 'STAFF', 'GUARD', 'SOURCE_DELETED'] as const;
export type StarboardRemovalReason = (typeof STARBOARD_REMOVAL_REASONS)[number];
