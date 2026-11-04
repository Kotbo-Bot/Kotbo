/**
 * Raison pour laquelle le bot ne peut pas donner (ou retirer) un rôle d'un menu
 * à boutons. La règle vit dans les contrats : le dashboard l'applique aussi,
 * pour prévenir le staff avant qu'un membre ne clique.
 */

export { roleBlocker, type RoleBlocker } from '@kotbo/contracts';

const STAFF_ALERT_INTERVAL_MS = 60 * 60 * 1000;

/** Une alerte par heure et par rôle : chaque clic d'un membre n'en déclenche pas une. */
export function shouldAlertStaff(lastAlertAt: number | undefined, now: number): boolean {
  return lastAlertAt === undefined || now - lastAlertAt >= STAFF_ALERT_INTERVAL_MS;
}
