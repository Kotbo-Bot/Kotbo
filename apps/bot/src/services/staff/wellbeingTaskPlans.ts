/**
 * Plan d'action type appliqué à un dossier : ses tâches rejoignent le plan
 * d'action, chiffrées comme les autres, dans la limite de MAX_CASE_TASKS.
 * Sert au bouton « Appliquer » et à la création d'un dossier dont la
 * catégorie porte un plan.
 */
import prisma from '../../utils/db.js';
import { sealNote } from './wellbeingCrypto.js';
import { appendCaseEvents } from './wellbeingEvents.js';
import { MAX_CASE_TASKS } from './wellbeingCasePolicy.js';
import { planTaskDrafts, type TaskPlan } from './wellbeingCustomPolicy.js';

/** Ajoute les tâches du plan au dossier ; rend le nombre de tâches ajoutées. */
export async function addPlanTasks(
  caseId: string,
  plan: TaskPlan,
  actor: { id: string; name: string },
  now: Date = new Date(),
): Promise<number> {
  const room = MAX_CASE_TASKS - (await prisma.wellbeingCaseTask.count({ where: { caseId } }));
  const drafts = planTaskDrafts(plan, now, room);
  if (drafts.length === 0) return 0;
  await prisma.wellbeingCaseTask.createMany({
    data: drafts.map((draft) => ({
      caseId,
      label: sealNote(caseId, draft.label),
      dueAt: draft.dueAt,
      createdById: actor.id,
      createdByName: actor.name,
    })),
  });
  await appendCaseEvents(caseId, drafts.map(() => ({ type: 'TASK_ADDED', actorId: actor.id, actorName: actor.name })));
  return drafts.length;
}
