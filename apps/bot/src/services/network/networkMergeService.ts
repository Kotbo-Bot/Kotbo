import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isSynced } from './networkScope.js';

type Delegate = { updateMany: (args: unknown) => Promise<{ count: number }> };

export interface MergeReport {
  moved: number;
  /** Modèles où des lignes n'ont pas pu être déplacées (conflit avec le principal). */
  skipped: string[];
}

/**
 * Déplace les données d'un sous-serveur vers le serveur principal, juste avant
 * son rattachement (donc avant que la redirection ne s'applique).
 *
 * shortcut: un modèle est déplacé en bloc ; au premier conflit d'unicité avec une
 * ligne du principal, tout le modèle est laissé tel quel (le principal l'emporte,
 * les lignes du sous-serveur restent en base, invisibles, et reviennent si le
 * serveur quitte le réseau). Un fusion ligne à ligne viendra si le besoin se confirme.
 */
export async function mergeGuildIntoPrimary(fromGuildId: string, primaryGuildId: string): Promise<MergeReport> {
  const report: MergeReport = { moved: 0, skipped: [] };
  const models = Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'guildId' && f.kind === 'scalar'))
    .map((m) => m.name)
    .filter(isSynced);

  for (const model of models) {
    const delegate = (prisma as unknown as Record<string, Delegate | undefined>)[model[0]!.toLowerCase() + model.slice(1)];
    if (!delegate) continue;
    try {
      const { count } = await delegate.updateMany({ where: { guildId: fromGuildId }, data: { guildId: primaryGuildId } });
      report.moved += count;
    } catch (err) {
      report.skipped.push(model);
      logger.warn('Network', `Fusion de ${model} ignorée (${fromGuildId} -> ${primaryGuildId}) :`, err);
    }
  }
  return report;
}
