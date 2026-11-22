// ============================================================================
// ARCHIVAGE, VERROU D'APPEL ET SUPPRESSION DES SANCTIONS
//
// Trois gestes distincts, volontairement séparés :
//   - archiver   : la sanction est désactivée mais conservée. Elle quitte le
//                  casier actif et (sauf `countArchivedInWarnScore`) cesse de
//                  peser dans le score de warns et l'escalade automatique.
//   - verrouiller: la sanction reste au casier mais n'est plus contestable.
//   - supprimer  : la ligne disparaît, mais un instantané reste 90 jours
//                  (SanctionDeletion) pour la relire et la restaurer.
//
// Le module Appels et la page Sanctions du dashboard passent tous les deux par
// ici : le verdict d'un appel et l'action manuelle du staff doivent produire
// exactement le même effet.
// ============================================================================

import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

/** Filtre Prisma des sanctions « vivantes » (non archivées). */
export const NOT_ARCHIVED: Prisma.SanctionWhereInput = { archivedAt: null };

/**
 * Le score de warns doit-il inclure les sanctions archivées ?
 * Par défaut non : archiver, c'est désactiver.
 */
export async function countsArchivedInScore(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { countArchivedInWarnScore: true },
  });
  return guild?.countArchivedInWarnScore ?? false;
}

/**
 * Fragment `where` à fusionner dans les requêtes de score/escalade : vide si la
 * guilde compte les archives, sinon `archivedAt: null`.
 */
export async function archiveScoreFilter(guildId: string): Promise<Prisma.SanctionWhereInput> {
  return (await countsArchivedInScore(guildId)) ? {} : NOT_ARCHIVED;
}

export type ArchiveActor = { userId: string; tag?: string | null };

export type BulkSanctionResult = {
  /** Nombre de lignes réellement modifiées (les ids inconnus sont ignorés). */
  count: number;
  /** Ids retenus après filtrage sur la guilde. */
  ids: string[];
};

/** Ne garde que les ids de sanctions appartenant réellement à la guilde. */
async function scopeToGuild(guildId: string, sanctionIds: string[]): Promise<string[]> {
  const unique = [...new Set(sanctionIds.filter(id => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return [];
  const rows = await prisma.sanction.findMany({
    where: { guildId, id: { in: unique } },
    select: { id: true },
  });
  return rows.map(r => r.id);
}

/**
 * Archive une ou plusieurs sanctions (désactivées mais conservées).
 * Les sanctions déjà archivées sont laissées telles quelles pour ne pas écraser
 * l'auteur et la date d'archivage d'origine.
 */
export async function archiveSanctions(
  guildId: string,
  sanctionIds: string[],
  actor: ArchiveActor,
  reason?: string | null
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  const result = await prisma.sanction.updateMany({
    where: { guildId, id: { in: ids }, archivedAt: null },
    data: {
      archivedAt: new Date(),
      archivedByUserId: actor.userId,
      archiveReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
    },
  });

  logger.info('SanctionArchive', `${result.count} sanction(s) archivée(s) sur ${guildId} par ${actor.tag || actor.userId}`);
  return { count: result.count, ids };
}

/** Remet des sanctions archivées dans le casier actif. */
export async function unarchiveSanctions(
  guildId: string,
  sanctionIds: string[],
  actor: ArchiveActor
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  const result = await prisma.sanction.updateMany({
    where: { guildId, id: { in: ids }, archivedAt: { not: null } },
    data: { archivedAt: null, archivedByUserId: null, archiveReason: null },
  });

  logger.info('SanctionArchive', `${result.count} sanction(s) désarchivée(s) sur ${guildId} par ${actor.tag || actor.userId}`);
  return { count: result.count, ids };
}

/**
 * Verrouille (ou déverrouille) la contestation d'une ou plusieurs sanctions.
 * Verrouillée = le membre ne peut plus jamais la contester, même après cooldown.
 */
export async function setSanctionAppealLock(
  guildId: string,
  sanctionIds: string[],
  locked: boolean,
  actor: ArchiveActor,
  reason?: string | null
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  const result = await prisma.sanction.updateMany({
    where: { guildId, id: { in: ids } },
    data: locked
      ? {
          appealable: false,
          appealLockedAt: new Date(),
          appealLockedByUserId: actor.userId,
          appealLockReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
        }
      : {
          appealable: true,
          appealLockedAt: null,
          appealLockedByUserId: null,
          appealLockReason: null,
        },
  });

  return { count: result.count, ids };
}

/**
 * Supprime définitivement des sanctions.
 *
 * Les lignes `BanAppealSanction` qui les référencent passent à `sanctionId:
 * null` (onDelete: SetNull) et conservent la photo du type/raison/date : un
 * appel tranché par une suppression reste lisible.
 */
export async function deleteSanctions(
  guildId: string,
  sanctionIds: string[],
  actor: ArchiveActor
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  // Les rapports et preuves ne sont pas effacés (onDelete: SetNull) : on
  // retient leurs ids avant que le lien saute, pour pouvoir les rattacher.
  const [rows, reports, files] = await Promise.all([
    prisma.sanction.findMany({ where: { guildId, id: { in: ids } } }),
    prisma.sanctionReport.findMany({ where: { guildId, sanctionId: { in: ids } }, select: { id: true, sanctionId: true } }),
    prisma.sanctionEvidenceFile.findMany({ where: { guildId, sanctionId: { in: ids } }, select: { id: true, sanctionId: true } }),
  ]);

  const [, result] = await prisma.$transaction([
    prisma.sanctionDeletion.createMany({
      data: rows.map(row => ({
        guildId,
        sanctionId: row.id,
        snapshot: row as unknown as Prisma.InputJsonValue,
        reportIds: reports.filter(r => r.sanctionId === row.id).map(r => r.id),
        evidenceFileIds: files.filter(f => f.sanctionId === row.id).map(f => f.id),
        deletedByUserId: actor.userId,
        deletedByTag: actor.tag ?? null,
      })),
    }),
    prisma.sanction.deleteMany({ where: { guildId, id: { in: ids } } }),
  ]);
  logger.info('SanctionArchive', `${result.count} sanction(s) supprimée(s) sur ${guildId} par ${actor.tag || actor.userId}`);
  return { count: result.count, ids };
}

/** Durée de conservation de la corbeille (RGPD : pas d'archive éternelle d'une suppression volontaire). */
export const DELETION_RETENTION_DAYS = 90;

/** Sanctions supprimées encore restaurables, les plus récentes d'abord. */
export async function listDeletedSanctions(guildId: string, limit = 100) {
  return prisma.sanctionDeletion.findMany({
    where: { guildId, restoredAt: null },
    orderBy: { deletedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

export type RestoreResult =
  | { ok: true; sanctionId: string }
  | { ok: false; reason: 'not_found' | 'already_restored' | 'id_taken' };

/**
 * Recrée la sanction supprimée avec son id d'origine et rattache ses rapports
 * et preuves. Ne touche pas à Discord : un ban restauré ne rebannit personne.
 */
export async function restoreDeletedSanction(
  guildId: string,
  deletionId: string,
  actor: ArchiveActor
): Promise<RestoreResult> {
  const deletion = await prisma.sanctionDeletion.findFirst({ where: { id: deletionId, guildId } });
  if (!deletion) return { ok: false, reason: 'not_found' };
  if (deletion.restoredAt) return { ok: false, reason: 'already_restored' };

  const exists = await prisma.sanction.findUnique({ where: { id: deletion.sanctionId }, select: { id: true } });
  if (exists) return { ok: false, reason: 'id_taken' };

  // Les dates JSON redeviennent des chaînes : Prisma les accepte en ISO.
  const data = deletion.snapshot as unknown as Prisma.SanctionUncheckedCreateInput;
  // La table de sanctions a pu être supprimée entre-temps (FK) : on la retire si absente.
  if (data.sanctionTableId) {
    const table = await prisma.sanctionTable.findUnique({ where: { id: data.sanctionTableId }, select: { id: true } });
    if (!table) data.sanctionTableId = null;
  }

  await prisma.$transaction([
    prisma.sanction.create({ data }),
    prisma.sanctionReport.updateMany({
      where: { guildId, id: { in: deletion.reportIds }, sanctionId: null },
      data: { sanctionId: deletion.sanctionId },
    }),
    prisma.sanctionEvidenceFile.updateMany({
      where: { guildId, id: { in: deletion.evidenceFileIds }, sanctionId: null },
      data: { sanctionId: deletion.sanctionId },
    }),
    prisma.sanctionDeletion.update({ where: { id: deletion.id }, data: { restoredAt: new Date() } }),
  ]);

  logger.info('SanctionArchive', `Sanction ${deletion.sanctionId} restaurée sur ${guildId} par ${actor.tag || actor.userId}`);
  return { ok: true, sanctionId: deletion.sanctionId };
}

/** Purge la corbeille au-delà de la rétention. */
export async function purgeOldSanctionDeletions(): Promise<number> {
  const cutoff = new Date(Date.now() - DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.sanctionDeletion.deleteMany({ where: { deletedAt: { lt: cutoff } } });
  return count;
}

// ============================================================================
// EXPIRATION AUTOMATIQUE DES WARNS
// ============================================================================

const AUTO_ARCHIVE_ACTOR: ArchiveActor = { userId: 'system', tag: 'Kotbo' };
const AUTO_ARCHIVE_BATCH = 500;

/**
 * Archive les warns dépassant `warnAutoArchiveDays` sur les guildes qui ont
 * activé l'expiration automatique. Un warn expiré n'est pas effacé : il rejoint
 * les archives, exactement comme s'il avait été archivé à la main.
 */
export async function runWarnAutoArchive(): Promise<number> {
  const guilds = await prisma.guild.findMany({
    where: { warnAutoArchiveDays: { not: null, gt: 0 } },
    select: { id: true, warnAutoArchiveDays: true },
  });
  if (guilds.length === 0) return 0;

  let total = 0;

  for (const guild of guilds) {
    const days = guild.warnAutoArchiveDays;
    if (!days || days <= 0) continue;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const expired = await prisma.sanction.findMany({
      where: { guildId: guild.id, type: 'WARN', archivedAt: null, createdAt: { lt: cutoff } },
      select: { id: true },
      take: AUTO_ARCHIVE_BATCH,
    });
    if (expired.length === 0) continue;

    const result = await prisma.sanction.updateMany({
      where: { id: { in: expired.map(s => s.id) } },
      data: {
        archivedAt: new Date(),
        archivedByUserId: AUTO_ARCHIVE_ACTOR.userId,
        archiveReason: `Expiration automatique après ${days} jours`,
      },
    });

    total += result.count;
    if (result.count > 0) {
      logger.info('SanctionArchive', `${result.count} warn(s) archivé(s) automatiquement sur ${guild.id} (> ${days} jours)`);
    }
  }

  return total;
}
