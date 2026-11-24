/**
 * Rôles Discord de la cellule bien-être et de sa direction. Seul le
 * propriétaire du serveur les distribue (voir events/wellbeingRoleWatch.ts) :
 * les outils de Kotbo refusent d'y toucher.
 */
import prisma from '../../utils/db.js';

export const CELL_ROLE_REFUSAL =
  'Ce rôle donne accès à la cellule bien-être : seul le propriétaire du serveur peut le donner ou le retirer, depuis Discord.';

export async function cellRoleIds(guildId: string): Promise<Set<string>> {
  const config = await prisma.wellbeingConfig.findUnique({
    where: { guildId },
    select: { teamRoleIds: true, directorRoleIds: true },
  });
  return new Set([...(config?.teamRoleIds ?? []), ...(config?.directorRoleIds ?? [])]);
}
