/**
 * Validation humaine des actions critiques de l'agent MCP.
 *
 * Une demande est une ligne du journal d'audit (`module: 'MCP'`) : `PENDING` à l'envoi,
 * `APPROVED` ou `REJECTED` au clic d'un administrateur, `CONSUMED` à l'exécution. L'outil critique
 * présente l'identifiant de la demande et ne s'exécute que si la consommation atomique réussit :
 * une approbation sert une fois, pour une action précise, dans l'heure.
 */
import prisma from '../../utils/db.js';

export const APPROVAL_PREFIX = 'mcp_approve:';
const APPROVAL_TTL_MS = 60 * 60 * 1000;

const contextOf = (requestId: string) => `${APPROVAL_PREFIX}${requestId}`;
export const approvalActionLabel = (actionName: string) => `Demande d'approbation : ${actionName}`;

/** Enregistre une demande en attente. */
export async function createApprovalRequest(opts: {
  guildId: string;
  requestId: string;
  actionName: string;
  requestedBy: string;
  details: string;
}): Promise<void> {
  await prisma.dashboardAuditLog.create({
    data: {
      guildId: opts.guildId,
      user: opts.requestedBy,
      action: approvalActionLabel(opts.actionName),
      context: contextOf(opts.requestId),
      module: 'MCP',
      eventType: 'Action',
      details: `PENDING - Détails : ${opts.details}`,
      dateIso: new Date(),
    },
  });
}

/** Décision d'un administrateur sur une demande encore en attente. Faux si déjà tranchée ou inconnue. */
export async function decideApproval(
  guildId: string,
  requestId: string,
  approved: boolean,
  deciderUserId: string,
): Promise<boolean> {
  const row = await prisma.dashboardAuditLog.findFirst({
    where: { guildId, module: 'MCP', context: contextOf(requestId), details: { startsWith: 'PENDING' } },
    select: { id: true, details: true },
  });
  if (!row) return false;
  const decided = await prisma.dashboardAuditLog.updateMany({
    where: { id: row.id, details: { startsWith: 'PENDING' } },
    data: { details: row.details.replace(/^PENDING/, `${approved ? 'APPROVED' : 'REJECTED'} by ${deciderUserId}`) },
  });
  return decided.count === 1;
}

/**
 * Consomme une approbation : vraie seulement si la demande existe sur ce serveur, a été approuvée
 * par un humain, porte exactement cette action, a moins d'une heure et n'a pas déjà servi.
 */
export async function consumeApproval(guildId: string, requestId: string | undefined, actionName: string): Promise<boolean> {
  if (!requestId || !/^[0-9a-f]{16}$/.test(requestId)) return false;
  const consumed = await prisma.dashboardAuditLog.updateMany({
    where: {
      guildId,
      module: 'MCP',
      context: contextOf(requestId),
      action: approvalActionLabel(actionName),
      details: { startsWith: 'APPROVED' },
      dateIso: { gte: new Date(Date.now() - APPROVAL_TTL_MS) },
    },
    data: { details: 'CONSUMED' },
  });
  return consumed.count === 1;
}
