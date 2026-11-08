import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

/**
 * Chaque flush écrivait un `upsert` par ligne bufferisée, le tout dans un
 * `$transaction` unique : un serveur actif ouvrait ainsi une transaction de
 * plusieurs milliers d'instructions toutes les 60 s, et les quatre partaient
 * en parallèle. Le pool saturait, Postgres refusait d'ouvrir la transaction
 * suivante (`P2028`) et le CPU partait en vrille sur des lots rejoués.
 *
 * Ici, une table se flushe en une seule instruction par lot, quel que soit le
 * nombre de lignes : `INSERT ... ON CONFLICT DO UPDATE` sur la clé primaire
 * composée de la table (`<table>_pkey`), que `keys` doit couvrir. Une ligne
 * nouvelle est écrite une fois avec ses compteurs, au lieu d'être créée à zéro
 * puis réécrite par un UPDATE (deux versions de ligne, donc deux fois plus de
 * WAL et de nettoyage par VACUUM).
 */

export type BulkKeyColumn = { name: string; type: 'text' | 'int' };

export type BulkRow = {
  keys: Array<string | number>;
  counters: Record<string, number>;
  overwrites?: Record<string, number>;
};

export type BulkTarget = {
  label: string;
  table: string;
  keys: BulkKeyColumn[];
  counterColumns: readonly string[];
  overwriteColumns?: readonly string[];
  /** false pour une table sans `createdAt` ni `updatedAt`. */
  timestamps?: boolean;
};

const ANALYTICS_CHUNK_SIZE =
  Number.parseInt(process.env.ANALYTICS_CHUNK_SIZE ?? '200', 10) || 200;

/**
 * Postgres refuse un lot où deux lignes visent la même clé (« ON CONFLICT DO
 * UPDATE command cannot affect row a second time ») et perdrait tout le lot.
 * Les tampons sont des Map, mais une clé reconstruite par `split` peut en
 * rejoindre une autre (séparateur présent dans un chemin de site, par exemple) :
 * on fusionne ces lignes plutôt que de risquer le lot.
 */
function mergeDuplicateKeys(rows: BulkRow[]): BulkRow[] {
  const merged = new Map<string, BulkRow>();
  for (const row of rows) {
    const id = JSON.stringify(row.keys.map(String));
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, { keys: row.keys, counters: { ...row.counters }, overwrites: row.overwrites });
      continue;
    }
    for (const [col, value] of Object.entries(row.counters)) {
      existing.counters[col] = (existing.counters[col] ?? 0) + value;
    }
    if (row.overwrites) existing.overwrites = row.overwrites;
  }
  return [...merged.values()];
}

async function flushBulkChunk(target: BulkTarget, chunk: BulkRow[]): Promise<void> {
  const overwriteColumns = target.overwriteColumns ?? [];
  const timestamps = target.timestamps !== false;
  const columnTypes = [
    ...target.keys.map((key) => key.type),
    ...target.counterColumns.map(() => 'int' as const),
    ...overwriteColumns.map(() => 'int' as const),
  ];

  const params: unknown[] = [];
  const tuples = chunk.map((row) => {
    const base = params.length;
    params.push(
      ...row.keys,
      ...target.counterColumns.map((col) => row.counters[col] ?? 0),
      ...overwriteColumns.map((col) => row.overwrites?.[col] ?? 0),
    );
    const values = columnTypes.map((type, index) => `$${base + 1 + index}::${type}`);
    if (timestamps) values.push('NOW()', 'NOW()');
    return `(${values.join(', ')})`;
  });

  const insertColumns = [
    ...target.keys.map((key) => key.name),
    ...target.counterColumns,
    ...overwriteColumns,
    ...(timestamps ? ['createdAt', 'updatedAt'] : []),
  ]
    .map((col) => `"${col}"`)
    .join(', ');

  const setClause = [
    ...target.counterColumns.map((col) => `"${col}" = m."${col}" + EXCLUDED."${col}"`),
    ...overwriteColumns.map((col) => `"${col}" = EXCLUDED."${col}"`),
    ...(timestamps ? ['"updatedAt" = NOW()'] : []),
  ].join(', ');

  await prisma.$executeRawUnsafe(
    `INSERT INTO ${target.table} AS m (${insertColumns})
     VALUES ${tuples.join(', ')}
     ON CONFLICT ON CONSTRAINT "${target.table}_pkey" DO UPDATE SET ${setClause}`,
    ...params,
  );
}

export async function flushBulk(target: BulkTarget, rows: BulkRow[]): Promise<void> {
  // Une clé coupée en trop de morceaux décalerait les paramètres de tout le lot.
  const unique = mergeDuplicateKeys(rows.filter((row) => row.keys.length === target.keys.length));
  for (let i = 0; i < unique.length; i += ANALYTICS_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + ANALYTICS_CHUNK_SIZE);
    await flushBulkChunk(target, chunk).catch((error) => {
      logger.error('Analytics', `Error flushing ${target.label} batch (offset ${i}):`, error);
    });
  }
}

/**
 * Une ligne sans aucun compteur non nul ne mérite ni création ni UPDATE : on
 * la laisse tomber ici plutôt que d'alourdir le lot.
 */
export function buildBulkRow(
  keys: Array<string | number>,
  counterColumns: readonly string[],
  data: Record<string, number | undefined>,
  overwrites?: Record<string, number>,
): BulkRow | null {
  const counters: Record<string, number> = {};
  let hasValue = false;

  for (const col of counterColumns) {
    const value = data[col];
    if (value) {
      counters[col] = value;
      hasValue = true;
    } else {
      counters[col] = 0;
    }
  }

  if (overwrites && Object.values(overwrites).some((value) => value > 0)) hasValue = true;
  if (!hasValue) return null;

  return { keys, counters, overwrites };
}
