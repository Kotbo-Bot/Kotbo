/**
 * Écriture de l'historique d'un dossier de la cellule de suivi.
 *
 * Chaque entrée porte une empreinte liée à la précédente (`caseEventHash`) :
 * une entrée modifiée ou retirée directement en base se voit à la relecture
 * (`verifyCaseEventChain`). Toute entrée passe donc par ici, jamais par un
 * `create` direct, sinon la chaîne se casserait d'elle-même.
 */
import prisma from '../../utils/db.js';
import { caseEventHash } from './wellbeingPolicy.js';

export interface CaseEventInput {
  type: string;
  actorId: string | null;
  actorName: string;
  fromValue?: string | null;
  toValue?: string | null;
}

export async function appendCaseEvents(caseId: string, inputs: readonly CaseEventInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await prisma.$transaction(async (tx) => {
    // Verrou sur la ligne du dossier : deux gestes simultanés ne partent pas de la même entrée.
    await tx.$queryRaw`SELECT "id" FROM "wellbeing_cases" WHERE "id" = ${caseId} FOR UPDATE`;
    const last = await tx.wellbeingCaseEvent.findFirst({
      where: { caseId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { hash: true, createdAt: true },
    });
    let previous = last?.hash ?? null;
    // Dates strictement croissantes : la relecture remet les entrées dans l'ordre de la chaîne.
    let at = Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1);
    const data = inputs.map((input) => {
      const event = {
        caseId,
        type: input.type,
        actorId: input.actorId,
        actorName: input.actorName,
        fromValue: input.fromValue ?? null,
        toValue: input.toValue ?? null,
        createdAt: new Date(at++),
      };
      const hash = caseEventHash(previous, event);
      previous = hash;
      return { ...event, hash };
    });
    await tx.wellbeingCaseEvent.createMany({ data });
  });
}
