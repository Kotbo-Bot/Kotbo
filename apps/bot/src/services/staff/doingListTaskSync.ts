/**
 * Lien entre une carte de liste de suivi et la tâche du planning qui porte son
 * attribution. La carte attribuée apparaît dans le planning de la personne ; ce
 * qui change d'un côté (titre, détails, avancement) suit de l'autre.
 *
 * L'avancement se lit dans l'étape de la carte : une étape « terminée » vaut une
 * tâche faite, la première étape une tâche pas commencée, les autres une tâche
 * en cours.
 */
import prisma from '../../utils/db.js';

type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
type ColumnShape = { id: string; position: number; isDone: boolean };

function byPosition(columns: ColumnShape[]) {
  return [...columns].sort((a, b) => a.position - b.position);
}

export function taskStatusForColumn(columns: ColumnShape[], columnId: string): TaskStatus {
  const sorted = byPosition(columns);
  if (sorted.find((column) => column.id === columnId)?.isDone) return 'COMPLETED';
  return sorted.find((column) => !column.isDone)?.id === columnId ? 'PENDING' : 'IN_PROGRESS';
}

/** Étape où ranger une carte dont la tâche a pris ce statut ; null : elle reste où elle est. */
export function columnForTaskStatus(columns: ColumnShape[], status: TaskStatus): string | null {
  const sorted = byPosition(columns);
  if (status === 'COMPLETED') return sorted.find((column) => column.isDone)?.id ?? null;
  const open = sorted.filter((column) => !column.isDone);
  if (status === 'PENDING') return open[0]?.id ?? null;
  return open[1]?.id ?? open[0]?.id ?? null;
}

/** Une tâche modifiée depuis le planning met sa carte à jour, et la change d'étape si son avancement a bougé. */
export async function syncDoingListItemFromTask(task: {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: Date | null;
  status: TaskStatus;
}): Promise<void> {
  const item = await prisma.doingListItem.findUnique({
    where: { staffTaskId: task.id },
    select: { id: true, columnId: true, list: { select: { columns: { select: { id: true, position: true, isDone: true } } } } },
  });
  if (!item) return;

  const data: { title: string; description: string | null; priority: string; dueDate: Date | null; columnId?: string; position?: number } = {
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueDate: task.dueDate,
  };
  const columns = item.list.columns;
  if (taskStatusForColumn(columns, item.columnId) !== task.status) {
    const target = columnForTaskStatus(columns, task.status);
    if (target && target !== item.columnId) {
      const last = await prisma.doingListItem.findFirst({ where: { columnId: target }, orderBy: { position: 'desc' }, select: { position: true } });
      data.columnId = target;
      data.position = (last?.position ?? -1) + 1;
    }
  }
  await prisma.doingListItem.update({ where: { id: item.id }, data });
}

/** Après un changement d'étapes (ordre, étape terminée, suppression), recale l'avancement des tâches de la liste. */
export async function pushListProgressToTasks(listId: string): Promise<void> {
  const [columns, items] = await Promise.all([
    prisma.doingListColumn.findMany({ where: { listId }, select: { id: true, position: true, isDone: true } }),
    prisma.doingListItem.findMany({
      where: { listId, staffTaskId: { not: null } },
      select: { columnId: true, staffTask: { select: { id: true, status: true } } },
    }),
  ]);
  for (const item of items) {
    if (!item.staffTask) continue;
    const status = taskStatusForColumn(columns, item.columnId);
    if (status !== item.staffTask.status) {
      await prisma.staffTask.update({ where: { id: item.staffTask.id }, data: { status } });
    }
  }
}
