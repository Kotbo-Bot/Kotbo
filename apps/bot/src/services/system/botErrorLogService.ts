/**
 * Lecture et purge du journal des erreurs non rattrapées du bot (`BotErrorLog`).
 *
 * Une même panne se répète à chaque message ou à chaque tour de cron : la
 * liste brute des cinquante dernières lignes montrait cinquante fois la même
 * erreur et masquait les autres. On lit donc par groupe (même message, même
 * source), puis les occurrences d'un groupe page par page, pile comprise.
 *
 * Un groupe est désigné par l'identifiant d'une de ses lignes plutôt que par
 * son message : un message d'erreur peut être très long, et n'a rien à faire
 * dans une URL.
 */
import prisma from '../../utils/db.js';

export interface ErrorGroupKey {
  message: string;
  source: string | null;
}

export interface ErrorGroup extends ErrorGroupKey {
  /** Une ligne du groupe, qui sert à le désigner. */
  id: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
}

const MAX_GROUPS = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Taille de page demandée, ramenée dans les bornes. */
export function errorPageSize(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

/** Groupes d'erreurs, le plus récemment touché en tête. */
export async function listErrorGroups(): Promise<ErrorGroup[]> {
  const rows = await prisma.botErrorLog.groupBy({
    by: ['message', 'source'],
    _count: { _all: true },
    _min: { createdAt: true },
    _max: { createdAt: true, id: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: MAX_GROUPS,
  });

  // Un groupe a toujours au moins une ligne : sans identifiant ni date, il ne
  // serait plus désignable, et le purger viderait tout le journal.
  return rows.flatMap((row) => (row._max.id && row._min.createdAt && row._max.createdAt
    ? [{
        id: row._max.id,
        message: row.message,
        source: row.source,
        count: row._count._all,
        firstAt: row._min.createdAt,
        lastAt: row._max.createdAt,
      }]
    : []));
}

/** Message et source du groupe auquel appartient la ligne, ou `null` si elle a été purgée. */
export function resolveErrorGroup(id: string): Promise<ErrorGroupKey | null> {
  return prisma.botErrorLog.findUnique({ where: { id }, select: { message: true, source: true } });
}

/** Filtre Prisma d'un groupe, ou de tout le journal sans groupe. */
function whereGroup(group: ErrorGroupKey | null) {
  return group ? { message: group.message, source: group.source } : {};
}

/**
 * Occurrences d'un groupe (de tout le journal sans groupe), de la plus récente
 * à la plus ancienne, après `cursor`.
 */
export async function listErrorOccurrences(group: ErrorGroupKey | null, cursor: string | null, pageSize: number) {
  const rows = await prisma.botErrorLog.findMany({
    where: whereGroup(group),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // Une ligne de plus que demandé : sa présence dit s'il reste une page.
    take: pageSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const errors = rows.slice(0, pageSize);
  return { errors, nextCursor: rows.length > pageSize ? errors[errors.length - 1].id : null };
}

/** Purge un groupe, ou tout le journal sans groupe. Renvoie le nombre de lignes retirées. */
export async function purgeErrors(group: ErrorGroupKey | null): Promise<number> {
  const { count } = await prisma.botErrorLog.deleteMany({ where: whereGroup(group) });
  return count;
}
