/**
 * Lectures de la page Suggestions du dashboard : file d'attente, statistiques
 * et historique paginé. Sur le réplica : rien ici n'écrit.
 */
import {
  SUGGESTION_QUEUE_MAX,
  SUGGESTION_STALE_DAYS,
  SUGGESTION_STATS_DAYS,
  decodeTimeCursor,
  encodeTimeCursor,
  summarizeSuggestionResolutions,
  type SuggestionResolutionRow,
  type SuggestionStatus,
} from '@kotbo/shared';
import { prismaRead } from '../../utils/db.js';
import { getSuggestionSettings } from './suggestionSettings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SUGGESTION_HISTORY_PAGE = 25;

export interface SuggestionStats {
  pending: number;
  /** En attente depuis plus de `SUGGESTION_STALE_DAYS` jours. */
  stalePending: number;
  /** Proposées sur les `SUGGESTION_STATS_DAYS` derniers jours. */
  createdRecent: number;
  /** Décisions prises sur la même fenêtre. */
  resolvedRecent: number;
  acceptanceRate: number | null;
  avgResponseHours: number | null;
  lastCreatedAt: Date | null;
}

export async function getSuggestionsOverview(guildId: string, now: Date = new Date()) {
  const since = new Date(now.getTime() - SUGGESTION_STATS_DAYS * DAY_MS);
  const staleBefore = new Date(now.getTime() - SUGGESTION_STALE_DAYS * DAY_MS);

  const [config, queue, pending, stalePending, createdRecent, resolutions, last] = await Promise.all([
    getSuggestionSettings(guildId),
    // La plus ancienne d'abord : c'est elle qui attend le plus.
    prismaRead.suggestion.findMany({
      where: { guildId, status: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SUGGESTION_QUEUE_MAX,
    }),
    prismaRead.suggestion.count({ where: { guildId, status: 'PENDING' } }),
    prismaRead.suggestion.count({ where: { guildId, status: 'PENDING', createdAt: { lt: staleBefore } } }),
    prismaRead.suggestion.count({ where: { guildId, createdAt: { gte: since } } }),
    prismaRead.$queryRaw<SuggestionResolutionRow[]>`
      SELECT "status",
             COUNT(*)::int AS "count",
             AVG(EXTRACT(EPOCH FROM ("respondedAt" - "createdAt")))::float8 AS "avgSeconds"
        FROM "suggestions"
       WHERE "guildId" = ${guildId}
         AND "status" <> 'PENDING'
         AND "respondedAt" >= ${since}
       GROUP BY "status"`,
    prismaRead.suggestion.findFirst({ where: { guildId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);

  const summary = summarizeSuggestionResolutions(resolutions);
  const stats: SuggestionStats = {
    pending,
    stalePending,
    createdRecent,
    resolvedRecent: summary.resolved,
    acceptanceRate: summary.acceptanceRate,
    avgResponseHours: summary.avgResponseHours,
    lastCreatedAt: last?.createdAt ?? null,
  };
  return { config, stats, queue, queueTruncated: pending > queue.length };
}

export interface SuggestionListFilter {
  status?: SuggestionStatus;
  userId?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Historique paginé, de la plus récente à la plus ancienne. La page suivante
 * reprend sous la date et l'id de la dernière rendue ; une ligne de plus est
 * lue pour savoir s'il en reste.
 */
export async function listSuggestions(guildId: string, filter: SuggestionListFilter = {}) {
  const limit = filter.limit ?? SUGGESTION_HISTORY_PAGE;
  const after = filter.cursor ? decodeTimeCursor(filter.cursor) : null;
  const rows = await prismaRead.suggestion.findMany({
    where: {
      guildId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(after
        ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const suggestions = rows.slice(0, limit);
  const last = suggestions[suggestions.length - 1];
  return { suggestions, nextCursor: rows.length > limit && last ? encodeTimeCursor(last.createdAt, last.id) : null };
}
