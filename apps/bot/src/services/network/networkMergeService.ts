import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getGuildLevelCurve, getLevelFromXp } from '../progression/levelingService.js';
import { isSynced } from './networkScope.js';

export interface MergeReport {
  /** Lignes déplacées vers le principal (sans doublon, ou additionnées avec le sien). */
  moved: number;
  /** Doublons additionnés avec la ligne du principal (niveaux et profils de membres). */
  combined: number;
  /** Modèles où des doublons restent intacts sur le sous-serveur (réglages : le principal garde les siens). */
  kept: string[];
  /** Modèles que la base a refusé de traiter. Rien n'y a été modifié. */
  skipped: string[];
}

const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Requête qui déplace les lignes de `$2` vers `$1` sans entrer en conflit : une
 * ligne reste en place si le principal a déjà la même clé unique.
 * `uniqueIndexes` : colonnes de chaque index unique de la table qui contient `guildId`.
 */
export function buildMoveSql(table: string, uniqueIndexes: string[][]): string {
  const guards = uniqueIndexes.map((cols) => {
    const same = cols.filter((c) => c !== 'guildId').map((c) => ` AND o.${q(c)} = s.${q(c)}`).join('');
    return `NOT EXISTS (SELECT 1 FROM ${q(table)} o WHERE o."guildId" = $1${same})`;
  });
  return `UPDATE ${q(table)} AS s SET "guildId" = $1 WHERE s."guildId" = $2${guards.map((g) => ` AND ${g}`).join('')}`;
}

/** Index uniques de la base qui portent `guildId`, par table : une ligne ne peut les violer qu'en changeant de serveur. */
async function uniqueIndexesByTable(): Promise<Map<string, string[][]>> {
  const rows = await prisma.$queryRaw<Array<{ table: string; cols: string[] }>>`
    SELECT t.relname AS "table", array_agg(a.attname::text ORDER BY k.ord) AS cols
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = current_schema()
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
    GROUP BY t.relname, i.indexrelid`;
  const byTable = new Map<string, string[][]>();
  for (const row of rows) {
    if (!row.cols.includes('guildId')) continue;
    byTable.set(row.table, [...(byTable.get(row.table) ?? []), row.cols]);
  }
  return byTable;
}

const CHUNK = 200;
function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const later = (a: Date | null, b: Date | null): Date | null => (a && b ? (a > b ? a : b) : a ?? b);
const earlier = (a: Date, b: Date): Date => (a < b ? a : b);

/** Niveaux : l'XP s'additionne, le niveau en est déduit avec la courbe du principal. */
async function combineMemberLevels(from: string, primary: string): Promise<number> {
  const rows = await prisma.memberLevel.findMany({ where: { guildId: from } });
  if (rows.length === 0) return 0;
  const curve = await getGuildLevelCurve(primary);
  for (const batch of chunks(rows)) {
    const mine = new Map(
      (await prisma.memberLevel.findMany({ where: { guildId: primary, userId: { in: batch.map((r) => r.userId) } } }))
        .map((p) => [p.userId, p]),
    );
    await prisma.$transaction(batch.flatMap((r) => {
      const p = mine.get(r.userId);
      if (!p) return [prisma.memberLevel.update({ where: { id: r.id }, data: { guildId: primary } })];
      const xp = p.xp + r.xp;
      return [
        prisma.memberLevel.update({
          where: { id: p.id },
          data: { xp, level: getLevelFromXp(xp, curve), lastXpGain: later(p.lastXpGain, r.lastXpGain)! },
        }),
        prisma.memberLevel.delete({ where: { id: r.id } }),
      ];
    }));
  }
  return rows.length;
}

/** Profils : les compteurs s'additionnent, les dates de première et dernière activité s'élargissent. */
async function combineMemberProfiles(from: string, primary: string): Promise<number> {
  const rows = await prisma.memberProfile.findMany({ where: { guildId: from } });
  for (const batch of chunks(rows)) {
    const mine = new Map(
      (await prisma.memberProfile.findMany({ where: { guildId: primary, userId: { in: batch.map((r) => r.userId) } } }))
        .map((p) => [p.userId, p]),
    );
    await prisma.$transaction(batch.flatMap((r) => {
      const p = mine.get(r.userId);
      if (!p) return [prisma.memberProfile.update({ where: { id: r.id }, data: { guildId: primary } })];
      return [
        prisma.memberProfile.update({
          where: { id: p.id },
          data: {
            messageCount: p.messageCount + r.messageCount,
            voiceSessionCount: p.voiceSessionCount + r.voiceSessionCount,
            voiceTimeSeconds: p.voiceTimeSeconds + r.voiceTimeSeconds,
            interactionCount: p.interactionCount + r.interactionCount,
            firstSeenAt: earlier(p.firstSeenAt, r.firstSeenAt),
            lastSeenAt: later(p.lastSeenAt, r.lastSeenAt)!,
            lastMessageAt: later(p.lastMessageAt, r.lastMessageAt),
          },
        }),
        prisma.memberProfile.delete({ where: { id: r.id } }),
      ];
    }));
  }
  return rows.length;
}

const COMBINERS: Record<string, (from: string, primary: string) => Promise<number>> = {
  MemberLevel: combineMemberLevels,
  MemberProfile: combineMemberProfiles,
};

/**
 * Déplace les données d'un sous-serveur vers le serveur principal, juste avant
 * son rattachement (donc avant que la redirection ne s'applique). Rien n'est
 * jamais supprimé sans que son contenu soit dans le principal.
 *
 * 1. Toute ligne sans doublon chez le principal est déplacée (SQL, d'après les
 *    index uniques de la base : aucune liste à tenir à jour).
 * 2. Un doublon de niveau ou de profil est additionné avec la ligne du principal.
 * 3. Les autres doublons (réglages : une seule ligne possible par serveur) restent
 *    tels quels sur le sous-serveur ; le principal garde les siens. Ils reviennent
 *    si le serveur quitte le réseau, et le rapport les nomme dans `kept`.
 *
 * shortcut: seuls les niveaux et profils s'additionnent ; ajouter ici un autre
 * modèle dès qu'un doublon de compteurs d'un autre type apparaît dans `kept`.
 */
export async function mergeGuildIntoPrimary(fromGuildId: string, primaryGuildId: string): Promise<MergeReport> {
  const report: MergeReport = { moved: 0, combined: 0, kept: [], skipped: [] };
  const indexes = await uniqueIndexesByTable();
  const models = Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'guildId' && f.kind === 'scalar'))
    .filter((m) => isSynced(m.name));

  for (const model of models) {
    const table = model.dbName ?? model.name;
    const guild = indexes.get(table) ?? [];
    try {
      report.moved += await prisma.$executeRawUnsafe(buildMoveSql(table, guild), primaryGuildId, fromGuildId);
      if (guild.length === 0) continue;

      const combine = COMBINERS[model.name];
      if (combine) {
        const n = await combine(fromGuildId, primaryGuildId);
        report.combined += n;
        report.moved += n;
      }
      const left = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM ${q(table)} WHERE "guildId" = $1`, fromGuildId,
      );
      if (Number(left[0]?.n ?? 0) > 0) report.kept.push(model.name);
    } catch (err) {
      report.skipped.push(model.name);
      logger.warn('Network', `Fusion de ${model.name} ignorée (${fromGuildId} -> ${primaryGuildId}) :`, err);
    }
  }
  return report;
}
