/**
 * Raison pour laquelle le bot ne peut pas donner (ou retirer) un rôle d'un menu
 * à boutons. Sans dépendance à Discord : le service lit le serveur et décide ici.
 */

export type RoleBlocker = 'missing' | 'managed' | 'no_permission' | 'too_high';

export function roleBlocker(input: {
  exists: boolean;
  /** Rôle tenu par une intégration (bot, boost) : Discord refuse de l'attribuer. */
  managed: boolean;
  botCanManageRoles: boolean;
  rolePosition: number;
  /** Position du rôle le plus haut du bot. */
  botTopPosition: number;
}): RoleBlocker | null {
  if (!input.exists) return 'missing';
  if (input.managed) return 'managed';
  if (!input.botCanManageRoles) return 'no_permission';
  // Discord n'autorise que les rôles strictement sous le plus haut du bot.
  if (input.rolePosition >= input.botTopPosition) return 'too_high';
  return null;
}

const STAFF_ALERT_INTERVAL_MS = 60 * 60 * 1000;

/** Une alerte par heure et par rôle : chaque clic d'un membre n'en déclenche pas une. */
export function shouldAlertStaff(lastAlertAt: number | undefined, now: number): boolean {
  return lastAlertAt === undefined || now - lastAlertAt >= STAFF_ALERT_INTERVAL_MS;
}
