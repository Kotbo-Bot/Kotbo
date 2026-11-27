/**
 * Dissolution différée de la cellule de suivi.
 *
 * Désactiver la cellule, vider sa composition ou éteindre son module coupe la
 * cellule de ses dossiers. Le propriétaire seul peut le demander ; la demande
 * est annoncée à la cellule et ne prend effet que 24 heures plus tard, ce qui
 * laisse le temps de réagir à une fermeture impulsive ou discrète. Elle reste
 * annulable jusque-là.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { sendWellbeingAlert } from './wellbeingAlerts.js';
import { dissolutionDate } from './wellbeingAccessPolicy.js';

export type DissolutionKind = 'CONFIG' | 'MODULE';

/** Membres nommés de la cellule : prévenus en privé, que l'alerte soit cochée ou non. */
async function teamOf(guildId: string) {
  return prisma.wellbeingConfig.findUnique({ where: { guildId } });
}

export async function requestDissolution(
  client: Client,
  guildId: string,
  actor: { id: string; name: string },
  kind: DissolutionKind,
  now: Date = new Date(),
): Promise<Date | null> {
  const config = await teamOf(guildId);
  if (!config) return null;
  const at = config.dissolutionAt ?? dissolutionDate(now);
  await prisma.wellbeingConfig.update({
    where: { guildId },
    data: { dissolutionAt: at, dissolutionById: actor.id, dissolutionByName: actor.name, dissolutionKind: kind },
  });
  void sendWellbeingAlert(client, guildId, config, 'DISSOLUTION', { actorId: actor.id, stage: 'dissolution_requested', expiresAt: at }, config.teamUserIds);
  return at;
}

export async function cancelDissolution(client: Client, guildId: string, actor: { id: string }): Promise<boolean> {
  const config = await teamOf(guildId);
  if (!config?.dissolutionAt) return false;
  await prisma.wellbeingConfig.update({
    where: { guildId },
    data: { dissolutionAt: null, dissolutionById: null, dissolutionByName: null, dissolutionKind: null },
  });
  void sendWellbeingAlert(client, guildId, config, 'DISSOLUTION', { actorId: actor.id, stage: 'dissolution_cancelled' }, config.teamUserIds);
  return true;
}

/**
 * Applique les dissolutions arrivées à échéance (relances horaires). Le module
 * est éteint par `setModule`, passé par l'appelant pour ne pas lier ce service
 * à l'activation des modules.
 */
export async function applyDueDissolutions(
  client: Client,
  now: Date,
  setModule: (guildId: string, active: boolean) => Promise<unknown>,
): Promise<void> {
  const due = await prisma.wellbeingConfig.findMany({ where: { dissolutionAt: { lte: now } } });
  for (const config of due) {
    try {
      await prisma.wellbeingConfig.update({
        where: { guildId: config.guildId },
        data: { enabled: false, dissolutionAt: null, dissolutionById: null, dissolutionByName: null, dissolutionKind: null },
      });
      if (config.dissolutionKind === 'MODULE') await setModule(config.guildId, false);
      await sendWellbeingAlert(client, config.guildId, config, 'DISSOLUTION', { actorId: '', stage: 'dissolution_applied' }, config.teamUserIds);
    } catch (error) {
      logger.error('Wellbeing', `Dissolution de la cellule de ${config.guildId} en échec :`, error);
    }
  }
}
