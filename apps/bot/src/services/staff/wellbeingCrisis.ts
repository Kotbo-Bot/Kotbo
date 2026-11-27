/**
 * Protocole de crise de la cellule de suivi.
 *
 * Un dossier qui devient critique reçoit, une seule fois, les étapes du
 * protocole dans son plan d'action, et une échéance de suivi à 48 heures s'il
 * n'en avait pas. La cellule les coche comme toute tâche ; l'historique garde
 * la trace de l'application (CRISIS_PROTOCOL).
 */
import prisma from '../../utils/db.js';
import { sealNote } from './wellbeingCrypto.js';
import { appendCaseEvents } from './wellbeingEvents.js';
import { CRISIS_REVIEW_HOURS, MAX_CASE_TASKS, crisisProtocolDue, crisisTaskDrafts } from './wellbeingCasePolicy.js';

export const CRISIS_PROTOCOL_EVENT = 'CRISIS_PROTOCOL';

/**
 * Applique le protocole si le dossier vient de devenir critique. Rend `true`
 * s'il a été appliqué. `previousSeverity` vaut `null` à la création.
 */
export async function applyCrisisProtocolIfDue(
  item: { id: string; reviewAt: Date | null },
  previousSeverity: string | null,
  nextSeverity: string,
  enabled: boolean,
  actor: { id: string | null; name: string },
  now: Date = new Date(),
): Promise<boolean> {
  if (!crisisProtocolDue(previousSeverity, nextSeverity, { enabled, applied: false })) return false;
  const applied = await prisma.wellbeingCaseEvent.count({ where: { caseId: item.id, type: CRISIS_PROTOCOL_EVENT } });
  if (!crisisProtocolDue(previousSeverity, nextSeverity, { enabled, applied: applied > 0 })) return false;

  // Le plan d'action garde sa limite : les étapes en trop ne sont pas ajoutées.
  const room = Math.max(0, MAX_CASE_TASKS - (await prisma.wellbeingCaseTask.count({ where: { caseId: item.id } })));
  const drafts = crisisTaskDrafts(now).slice(0, room);
  if (drafts.length > 0) {
    await prisma.wellbeingCaseTask.createMany({
      data: drafts.map((draft) => ({
        caseId: item.id,
        label: sealNote(item.id, draft.label),
        dueAt: draft.dueAt,
        createdById: actor.id ?? 'SYSTEM',
        createdByName: actor.name,
      })),
    });
  }
  const reviewAt = item.reviewAt ? null : new Date(now.getTime() + CRISIS_REVIEW_HOURS * 60 * 60 * 1000);
  if (reviewAt) await prisma.wellbeingCase.update({ where: { id: item.id }, data: { reviewAt, reviewRemindedAt: null } });
  await appendCaseEvents(item.id, [
    { type: CRISIS_PROTOCOL_EVENT, actorId: actor.id, actorName: actor.name, toValue: String(drafts.length) },
    ...(reviewAt ? [{ type: 'REVIEW', actorId: actor.id, actorName: actor.name, toValue: reviewAt.toISOString() }] : []),
  ]);
  return true;
}
