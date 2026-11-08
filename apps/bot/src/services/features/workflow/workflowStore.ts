/**
 * État durable des automatisations, hors du graphe : délais de récupération en
 * cours et variables du serveur. Le moteur n'y accède qu'au travers des effets
 * (`effects.ts`), ce qui laisse l'essai à blanc lire sans jamais écrire.
 */
import prisma from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import type { VariableOperation } from './engine.js';

/**
 * Réserve le passage d'un délai. Deux déclenchements simultanés ne peuvent pas
 * passer tous les deux : la mise à jour ne prend qu'une ligne échue, et la
 * création d'une ligne neuve se heurte à la clé primaire pour le second.
 */
export async function claimCooldown(
  workflowId: string,
  nodeId: string,
  subjectKey: string,
  seconds: number,
  now = new Date(),
): Promise<boolean> {
  const until = new Date(now.getTime() + seconds * 1000);

  const renewed = await prisma.workflowCooldown.updateMany({
    where: { workflowId, nodeId, subjectKey, until: { lte: now } },
    data: { until },
  });
  if (renewed.count > 0) return true;

  try {
    await prisma.workflowCooldown.create({ data: { workflowId, nodeId, subjectKey, until } });
    return true;
  } catch (error) {
    // P2002 : la ligne existe et le délai court encore, ou un autre passage
    // vient de la créer.
    if ((error as { code?: string })?.code === 'P2002') return false;
    throw error;
  }
}

/** Efface les délais échus depuis plus d'un jour : ils ne bloquent plus rien. */
export async function pruneExpiredCooldowns(now = new Date()): Promise<number> {
  const { count } = await prisma.workflowCooldown.deleteMany({
    where: { until: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });
  return count;
}

export async function getVariable(guildId: string, name: string, subjectKey: string): Promise<number> {
  const row = await prisma.workflowVariable.findUnique({
    where: { guildId_name_subjectKey: { guildId, name, subjectKey } },
    select: { value: true },
  });
  return row?.value ?? 0;
}

/** Ajout atomique (`increment`) ou remplacement ; rend la valeur enregistrée. */
export async function updateVariable(
  guildId: string,
  name: string,
  subjectKey: string,
  operation: VariableOperation,
  amount: number,
): Promise<number> {
  const row = await upsertRetryingRace(() => prisma.workflowVariable.upsert({
    where: { guildId_name_subjectKey: { guildId, name, subjectKey } },
    create: { guildId, name, subjectKey, value: amount },
    update: { value: operation === 'add' ? { increment: amount } : amount },
    select: { value: true },
  }));
  return row.value;
}
