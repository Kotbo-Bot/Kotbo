/**
 * Lectures de la page Starlight du dashboard : statistiques de la fenêtre,
 * meilleurs messages et galerie paginée. Sur le réplica : rien ici n'écrit.
 *
 * Une entrée n'est créée qu'au franchissement du seuil : chaque ligne est un
 * message passé à la une, même si son highlight a été retiré depuis.
 */
import type { Prisma } from '@prisma/client';
import {
  STARBOARD_STATS_DAYS,
  decodeScoreCursor,
  decodeTimeCursor,
  encodeScoreCursor,
  encodeTimeCursor,
  starboardPeriodStart,
  type StarboardPeriod,
  type StarboardSort,
} from '@kotbo/shared';
import { prismaRead } from '../../utils/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const STARBOARD_PAGE = 24;
/** Meilleurs messages de la fenêtre montrés en vue d'ensemble. */
export const STARBOARD_TOP_MAX = 5;
/** Salons les plus mis à la une montrés en vue d'ensemble. */
export const STARBOARD_CHANNELS_TOP = 5;
/** Auteurs du classement, en vue d'ensemble comme dans `/starlight top`. */
export const STARBOARD_AUTHORS_TOP = 10;

export interface StarboardStats {
  /** Messages passés à la une sur les `STARBOARD_STATS_DAYS` derniers jours. */
  postedRecent: number;
  /** Meilleur score moyen de ces messages ; `null` sans message. */
  avgPeakRecent: number | null;
  bestPeakRecent: number | null;
  /** Highlights actuellement affichés dans le salon. */
  onBoard: number;
  lastPostedAt: Date | null;
}

export async function getStarboardOverview(guildId: string, now: Date = new Date()) {
  const since = new Date(now.getTime() - STARBOARD_STATS_DAYS * DAY_MS);
  // Un message retiré par le staff n'a pas sa place dans les chiffres ni le
  // palmarès ; la galerie le garde, avec son badge.
  const recent = { guildId, createdAt: { gte: since }, blockedAt: null };

  const [postedRecent, aggregate, last, onBoard, byChannel, topEntries] = await Promise.all([
    prismaRead.starboardEntry.count({ where: recent }),
    prismaRead.starboardEntry.aggregate({ where: recent, _avg: { peakScore: true }, _max: { peakScore: true } }),
    prismaRead.starboardEntry.findFirst({ where: { guildId, blockedAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prismaRead.starboardEntry.count({ where: { guildId, starMessageId: { not: null } } }),
    prismaRead.starboardEntry.groupBy({
      by: ['channelId'],
      where: recent,
      _count: { _all: true },
      orderBy: { _count: { channelId: 'desc' } },
      take: STARBOARD_CHANNELS_TOP,
    }),
    prismaRead.starboardEntry.findMany({
      where: recent,
      orderBy: [{ peakScore: 'desc' }, { id: 'desc' }],
      take: STARBOARD_TOP_MAX,
    }),
  ]);

  const stats: StarboardStats = {
    postedRecent,
    avgPeakRecent: aggregate._avg.peakScore ?? null,
    bestPeakRecent: aggregate._max.peakScore ?? null,
    onBoard,
    lastPostedAt: last?.createdAt ?? null,
  };
  const channelStats = byChannel.map((row) => ({ channelId: row.channelId, count: row._count._all }));
  const topAuthors = await getStarboardAuthorLeaderboard(guildId, 'month', STARBOARD_AUTHORS_TOP, now);
  return { stats, topEntries, channelStats, topAuthors };
}

export interface StarboardAuthorRank {
  authorId: string;
  /** Messages passés à la une sur la période. */
  count: number;
  bestScore: number;
}

/**
 * Auteurs les plus souvent à la une sur la période, hors messages retirés par
 * le staff. À nombre égal, le meilleur score départage.
 */
export async function getStarboardAuthorLeaderboard(
  guildId: string,
  period: StarboardPeriod,
  limit: number = STARBOARD_AUTHORS_TOP,
  now: Date = new Date(),
): Promise<StarboardAuthorRank[]> {
  const since = starboardPeriodStart(period, now);
  const rows = await prismaRead.starboardEntry.groupBy({
    by: ['authorId'],
    where: { guildId, blockedAt: null, ...(since ? { createdAt: { gte: since } } : {}) },
    _count: { _all: true },
    _max: { peakScore: true },
    orderBy: [{ _count: { authorId: 'desc' } }, { _max: { peakScore: 'desc' } }],
    take: limit,
  });
  return rows.map((row) => ({ authorId: row.authorId, count: row._count._all, bestScore: row._max.peakScore ?? 0 }));
}

/** Bilan d'un membre, depuis toujours : messages à la une, record, dernier passage. */
export async function getStarboardAuthorSummary(guildId: string, authorId: string) {
  const [aggregate, last] = await Promise.all([
    prismaRead.starboardEntry.aggregate({
      where: { guildId, authorId, blockedAt: null },
      _count: { _all: true },
      _max: { peakScore: true },
    }),
    prismaRead.starboardEntry.findFirst({
      where: { guildId, authorId, blockedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, channelId: true, messageId: true },
    }),
  ]);
  return {
    count: aggregate._count._all,
    bestScore: aggregate._max.peakScore ?? null,
    last: last ? { at: last.createdAt, url: `https://discord.com/channels/${guildId}/${last.channelId}/${last.messageId}` } : null,
  };
}

export interface StarboardListFilter {
  period: StarboardPeriod;
  sort: StarboardSort;
  channelId?: string;
  authorId?: string;
  /** Au format du tri : date + id pour `recent`, score + id pour `score`. */
  cursor?: string;
  limit?: number;
}

/** Reprise sous la dernière ligne rendue, selon le tri. */
function afterCursor(sort: StarboardSort, cursor: string | undefined): Prisma.StarboardEntryWhereInput {
  if (!cursor) return {};
  if (sort === 'score') {
    const after = decodeScoreCursor(cursor);
    return after
      ? { OR: [{ peakScore: { lt: after.score } }, { peakScore: after.score, id: { lt: after.id } }] }
      : {};
  }
  const after = decodeTimeCursor(cursor);
  return after
    ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }
    : {};
}

/**
 * Galerie paginée : la plus récente d'abord, ou au meilleur score atteint (le
 * score actuel peut être retombé). Une ligne de plus est lue pour savoir s'il
 * en reste.
 */
export async function listStarboardEntries(guildId: string, filter: StarboardListFilter, now: Date = new Date()) {
  const limit = filter.limit ?? STARBOARD_PAGE;
  const since = starboardPeriodStart(filter.period, now);
  const rows = await prismaRead.starboardEntry.findMany({
    where: {
      guildId,
      ...(since ? { createdAt: { gte: since } } : {}),
      ...(filter.channelId ? { channelId: filter.channelId } : {}),
      ...(filter.authorId ? { authorId: filter.authorId } : {}),
      ...afterCursor(filter.sort, filter.cursor),
    },
    orderBy: filter.sort === 'score'
      ? [{ peakScore: 'desc' }, { id: 'desc' }]
      : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const entries = rows.slice(0, limit);
  const last = entries[entries.length - 1];
  const nextCursor = rows.length > limit && last
    ? filter.sort === 'score' ? encodeScoreCursor(last.peakScore, last.id) : encodeTimeCursor(last.createdAt, last.id)
    : null;
  return { entries, nextCursor };
}
