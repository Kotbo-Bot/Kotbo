/**
 * Listes de suivi : ce que l'API du dashboard et Discord partagent pour créer
 * et faire vivre une carte (numérotation, clé de liste, limite d'étape, fil).
 */
import { DOING_LIST_KEY_PATTERN } from '@kotbo/contracts';
import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export type DoingListEventKind = 'comment' | 'created' | 'moved' | 'assigned' | 'unassigned' | 'updated' | 'linked' | 'unlinked';

/** Clé proposée pour un nom de liste : ses 4 premières lettres ou chiffres, sans accents. */
export function deriveListKey(name: string): string {
  const letters = name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const key = /^[A-Z]/.test(letters) ? letters.slice(0, 4) : `L${letters.slice(0, 3)}`;
  return key.length >= 2 ? key : 'LS';
}

/**
 * Clé libre sur le serveur : celle demandée si elle l'est, sinon suffixée d'un
 * numéro (BOUT, BOUT2…). null si la clé demandée n'a pas la bonne forme.
 */
export async function freeListKey(guildId: string, wanted: string, excludingListId?: string): Promise<string | null> {
  const base = wanted.trim().toUpperCase();
  if (!DOING_LIST_KEY_PATTERN.test(base)) return null;
  const taken = new Set(
    (await prisma.doingList.findMany({
      where: { guildId, key: { startsWith: base }, ...(excludingListId ? { id: { not: excludingListId } } : {}) },
      select: { key: true },
    })).map((list) => list.key),
  );
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, 10 - String(suffix).length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** Réserve le prochain numéro de carte de la liste ; un numéro n'est jamais réutilisé. */
export async function nextItemNumber(listId: string, tx: Prisma.TransactionClient = prisma): Promise<number> {
  const list = await tx.doingList.update({ where: { id: listId }, data: { nextNumber: { increment: 1 } }, select: { nextNumber: true } });
  return list.nextNumber - 1;
}

/** Message d'erreur si l'étape est pleine pour une carte de plus, sinon null. */
export async function fullColumnMessage(
  column: { id: string; name: string; wipLimit: number | null },
  excludingItemId?: string,
): Promise<string | null> {
  if (!column.wipLimit) return null;
  const count = await prisma.doingListItem.count({ where: { columnId: column.id, ...(excludingItemId ? { id: { not: excludingItemId } } : {}) } });
  return count >= column.wipLimit ? `L'étape « ${column.name} » est pleine (${column.wipLimit} au plus).` : null;
}

/** Ajoute une ligne au fil d'une carte. Un fil incomplet ne doit pas faire échouer l'action. */
export async function logDoingListEvent(event: {
  guildId: string;
  itemId: string;
  actorId: string;
  actorName: string;
  kind: DoingListEventKind;
  body?: string | null;
  data?: Prisma.InputJsonValue;
}) {
  return prisma.doingListEvent.create({ data: event }).catch((err) => {
    logger.warn('DoingLists', "Fil de la carte non mis à jour :", err);
    return null;
  });
}

/**
 * Carte libre posée dans la première étape (ou celle donnée) : c'est ce que fait
 * « Créer une carte de suivi » depuis un message Discord.
 */
export async function createFreeCard(params: {
  guildId: string;
  listId: string;
  title: string;
  description?: string | null;
  actorId: string;
  actorName: string;
}) {
  const column = await prisma.doingListColumn.findFirst({ where: { listId: params.listId }, orderBy: { position: 'asc' } });
  if (!column) throw new Error("La liste n'a aucune étape.");
  const full = await fullColumnMessage(column);
  if (full) throw new Error(full);
  const last = await prisma.doingListItem.findFirst({ where: { columnId: column.id }, orderBy: { position: 'desc' }, select: { position: true } });
  const item = await prisma.$transaction(async (tx) => tx.doingListItem.create({
    data: {
      listId: params.listId,
      guildId: params.guildId,
      columnId: column.id,
      number: await nextItemNumber(params.listId, tx),
      title: params.title,
      description: params.description ?? null,
      position: (last?.position ?? -1) + 1,
      createdById: params.actorId,
    },
  }));
  await logDoingListEvent({ guildId: params.guildId, itemId: item.id, actorId: params.actorId, actorName: params.actorName, kind: 'created' });
  return item;
}
