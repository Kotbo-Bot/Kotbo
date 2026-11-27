/**
 * Colonnes de la vue en colonnes de la cellule de suivi, sans accès à la base.
 *
 * En plus des statuts (Ouvert, Sous surveillance, Clos), la cellule ajoute
 * ses propres étapes de travail (« À contacter », « En médiation »...). Un
 * dossier rangé dans une étape garde son statut : les relances, l'effacement
 * et le bilan ne dépendent que du statut. Clore un dossier le sort de son
 * étape ; supprimer une colonne renvoie ses dossiers à leur statut.
 */
import { cleanLabeledList, type LabeledItem } from './wellbeingCustomPolicy.js';

export const BOARD_COLUMN_MAX = 6;
export const BOARD_COLUMN_LABEL_MAX = 40;
/** Entrée d'historique quand l'étape d'un dossier change. */
export const STAGE_EVENT = 'STAGE';

const COLUMN_ID_RE = /^[a-z0-9-]{1,32}$/;

export type BoardColumn = LabeledItem;

/**
 * Colonnes reçues du dashboard ou lues en base, nettoyées : libellé non vide
 * et unique (sans tenir compte de la casse), identifiant valide et unique
 * (`newId` en fournit un sinon), au plus `BOARD_COLUMN_MAX`.
 */
export function cleanBoardColumns(input: unknown, newId: () => string): BoardColumn[] {
  return cleanLabeledList(input, { max: BOARD_COLUMN_MAX, labelMax: BOARD_COLUMN_LABEL_MAX, newId, idPattern: COLUMN_ID_RE }, () => ({}));
}

/** Ligne d'audit d'une modification des colonnes. */
export function describeBoardColumns(columns: readonly BoardColumn[]): string {
  return `Colonnes du suivi : ${columns.length > 0 ? columns.map((column) => column.label).join(', ') : 'aucune'}`;
}

/** Nom d'une étape pour l'historique ; null si aucune, ou si la colonne n'existe plus. */
export function stageLabel(columns: readonly BoardColumn[], stage: string | null): string | null {
  return stage ? columns.find((column) => column.id === stage)?.label ?? null : null;
}

/**
 * Nouvelle étape d'un dossier après une modification, une erreur, ou null
 * s'il n'y a rien à changer. `patch.stage` absent : l'étape ne bouge que si
 * le dossier est clos.
 */
export function stageChange(
  existing: { stage: string | null; status: string },
  patch: { stage?: string | null; status?: string },
  columns: readonly BoardColumn[],
): { stage: string | null } | { error: string } | null {
  const status = patch.status ?? existing.status;
  if (patch.stage === undefined) {
    return status === 'CLOSED' && existing.stage ? { stage: null } : null;
  }
  if (patch.stage === null) return existing.stage ? { stage: null } : null;
  if (!columns.some((column) => column.id === patch.stage)) return { error: "Cette colonne n'existe plus." };
  if (status === 'CLOSED') return { error: "Un dossier clos ne se range pas dans une étape : rouvrez-le d'abord." };
  return patch.stage === existing.stage ? null : { stage: patch.stage };
}

/** Bilan : dossiers actifs rangés dans chaque étape, dans l'ordre des colonnes. */
export function stageCounts(
  cases: ReadonlyArray<{ status: string; stage: string | null }>,
  columns: readonly BoardColumn[],
): Array<{ label: string; count: number }> {
  return columns.map((column) => ({
    label: column.label,
    count: cases.filter((item) => item.status !== 'CLOSED' && item.stage === column.id).length,
  }));
}
