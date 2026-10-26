import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import {
  DOING_LIST_MODULES,
  isDoingListModule,
  isDoingListPriority,
  isDoingListSource,
  type DoingListChecklistEntry,
  type DoingListModule,
  type DoingListSource,
} from '@kotbo/contracts';
import type { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, pushAudit, getGuildName, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import { getCachedFeatureAccess } from './featureGate.js';
import { createTask } from '../../../services/staff/staffLeadershipService.js';
import { columnForTaskStatus, pushListProgressToTasks, taskStatusForColumn } from '../../../services/staff/doingListTaskSync.js';

const SEGMENT = 'doing-lists';
const LOG = 'DoingListsAPI';
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const TITLE_MAX = 200;
const ITEM_DESCRIPTION_MAX = 4000;
const MAX_LISTS_PER_GUILD = 50;
const MAX_COLUMNS_PER_LIST = 20;
const MAX_ITEMS_PER_LIST = 500;
const MAX_LABELS = 10;
const LABEL_MAX = 30;
const MAX_CHECKLIST = 50;
const DEFAULT_COLUMNS = ['À faire', 'En cours', 'Terminé'];

const ITEM_INCLUDE = {
  staffTask: {
    select: {
      id: true,
      status: true,
      assignee: { select: { id: true, userId: true, username: true, displayName: true, avatarUrl: true } },
    },
  },
} satisfies Prisma.DoingListItemInclude;

type ColumnRow = { id: string; name: string; position: number; wipLimit: number | null; isDone: boolean };

function readText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().slice(0, max);
  return text || null;
}

function readModules(raw: unknown): DoingListModule[] {
  return Array.isArray(raw) ? [...new Set(raw.filter(isDoingListModule))] : [];
}

function readLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const labels = raw.map((label) => readText(label, LABEL_MAX)).filter((label): label is string => !!label);
  return [...new Set(labels)].slice(0, MAX_LABELS);
}

function readChecklist(raw: unknown): DoingListChecklistEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CHECKLIST).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, text, done } = entry as Record<string, unknown>;
    const label = readText(text, TITLE_MAX);
    if (!label) return [];
    return [{ id: readText(id, 40) ?? `c${Date.now().toString(36)}${index}`, text: label, done: done === true }];
  });
}

/** undefined : valeur illisible ; null : pas d'échéance. */
function readDueDate(raw: unknown): Date | null | undefined {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readWipLimit(raw: unknown): number | null | undefined {
  if (raw === null || raw === '' || raw === 0) return null;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 999 ? raw : undefined;
}

type SourceRead = { title: string; description?: string | null; priority?: string; dueDate?: Date | null; status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' };

/**
 * Ce qu'on reprend d'un élément à l'épinglage. Ne renvoie rien si l'élément
 * n'appartient pas au serveur : c'est aussi la vérification d'appartenance.
 */
async function readSource(guildId: string, source: DoingListSource, sourceId: string): Promise<SourceRead | null> {
  if (source === 'suggestions') {
    const suggestion = await prisma.suggestion.findFirst({ where: { id: sourceId, guildId }, select: { content: true } });
    return suggestion ? { title: suggestion.content.replace(/\s+/g, ' ').slice(0, TITLE_MAX) } : null;
  }
  if (source === 'tasks') {
    const task = await prisma.staffTask.findFirst({
      where: { id: sourceId, guildId },
      select: { title: true, description: true, priority: true, dueDate: true, status: true },
    });
    return task ? { ...task, title: task.title.slice(0, TITLE_MAX) } : null;
  }
  const ticket = await prisma.ticket.findFirst({ where: { id: sourceId, guildId }, select: { reason: true, username: true } });
  return ticket ? { title: `${ticket.reason} (${ticket.username})`.slice(0, TITLE_MAX) } : null;
}

/** Range une carte à l'indice voulu de l'étape et renumérote ses voisines. */
async function placeItem(tx: Prisma.TransactionClient, itemId: string, columnId: string, index: number) {
  const siblings = await tx.doingListItem.findMany({
    where: { columnId, id: { not: itemId } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, position: true },
  });
  const order = siblings.map((sibling) => sibling.id);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, itemId);
  const current = new Map(siblings.map((sibling) => [sibling.id, sibling.position]));
  for (const [position, id] of order.entries()) {
    if (id === itemId) await tx.doingListItem.update({ where: { id }, data: { columnId, position } });
    else if (current.get(id) !== position) await tx.doingListItem.update({ where: { id }, data: { position } });
  }
}

/**
 * Listes de suivi : plusieurs tableaux par serveur, découpés en étapes, reliés
 * à des modules dont on y épingle les éléments, plus des cartes libres.
 *
 * Lecture ouverte à qui voit la section (garde du répartiteur). Travailler sur
 * les cartes et les étapes relève de la modération de la section : c'est
 * l'outil du staff, pas un réglage. Supprimer une liste demande le droit de
 * suppression.
 */
export async function handleDoingListRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  if (parts[4] !== SEGMENT) return false;
  const method = req.method ?? 'GET';
  const auditUser = user.username ?? `User${user.userId}`;

  if (method !== 'GET' && !access.canManageSettings) {
    const rights = (await getCachedFeatureAccess(client, guildId, access, user.userId)).doing_lists;
    const deletesList = method === 'DELETE' && parts.length === 6;
    if (!(deletesList ? rights?.canDelete : rights?.canModerate || rights?.canConfigure)) {
      json(res, 403, { error: 'Action sur les listes de suivi non autorisée.' });
      return true;
    }
  }

  const audit = (action: string, details: string) => pushAudit(guildId, {
    user: auditUser,
    action,
    context: getGuildName(client, guildId),
    module: 'Listes de suivi',
    eventType: 'Settings',
    details,
    channelId: null,
  }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err));

  const listId = parts[5];
  const findList = () => prisma.doingList.findFirst({ where: { id: listId, guildId } });
  const findColumns = (): Promise<ColumnRow[]> => prisma.doingListColumn.findMany({
    where: { listId },
    orderBy: { position: 'asc' },
    select: { id: true, name: true, position: true, wipLimit: true, isDone: true },
  });
  /** Message d'erreur si l'étape est pleine pour une carte de plus, sinon null. */
  const fullColumnError = async (column: ColumnRow, excludingItemId?: string) => {
    if (!column.wipLimit) return null;
    const count = await prisma.doingListItem.count({ where: { columnId: column.id, ...(excludingItemId ? { id: { not: excludingItemId } } : {}) } });
    return count >= column.wipLimit ? `L'étape « ${column.name} » est pleine (${column.wipLimit} au plus).` : null;
  };

  try {
    // GET /doing-lists : les listes et leur avancement.
    if (parts.length === 5 && method === 'GET') {
      const [lists, columns, grouped] = await Promise.all([
        prisma.doingList.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
        prisma.doingListColumn.findMany({ where: { guildId }, select: { id: true, listId: true, isDone: true } }),
        prisma.doingListItem.groupBy({ by: ['columnId'], where: { guildId }, _count: { _all: true } }),
      ]);
      const columnById = new Map(columns.map((column) => [column.id, column]));
      const counts = new Map<string, { total: number; done: number }>();
      for (const row of grouped) {
        const column = columnById.get(row.columnId);
        if (!column) continue;
        const entry = counts.get(column.listId) ?? { total: 0, done: 0 };
        entry.total += row._count._all;
        if (column.isDone) entry.done += row._count._all;
        counts.set(column.listId, entry);
      }
      json(res, 200, {
        lists: lists.map((list) => ({ ...list, counts: counts.get(list.id) ?? { total: 0, done: 0 } })),
        modules: DOING_LIST_MODULES,
      });
      return true;
    }

    // POST /doing-lists : création, avec ses étapes de départ.
    if (parts.length === 5 && method === 'POST') {
      const body = (await readJsonBody<{ name?: unknown; description?: unknown; modules?: unknown; columns?: unknown }>(req)) ?? {};
      const name = readText(body.name, NAME_MAX);
      if (!name) {
        json(res, 400, { error: 'Donne un nom à la liste.' });
        return true;
      }
      if (await prisma.doingList.count({ where: { guildId } }) >= MAX_LISTS_PER_GUILD) {
        json(res, 400, { error: `${MAX_LISTS_PER_GUILD} listes au plus par serveur.` });
        return true;
      }
      const names = Array.isArray(body.columns)
        ? body.columns.map((column) => readText(column, NAME_MAX)).filter((column): column is string => !!column).slice(0, MAX_COLUMNS_PER_LIST)
        : [];
      const columnNames = names.length > 0 ? names : DEFAULT_COLUMNS;
      const list = await prisma.doingList.create({
        data: {
          guildId,
          name,
          description: readText(body.description, DESCRIPTION_MAX),
          modules: readModules(body.modules),
          createdById: user.userId,
          // La dernière étape de départ est celle des cartes terminées.
          columns: {
            create: columnNames.map((columnName, position) => ({
              guildId,
              name: columnName,
              position,
              isDone: columnNames.length > 1 && position === columnNames.length - 1,
            })),
          },
        },
      });
      await audit('Création liste de suivi', `« ${list.name} ».`);
      json(res, 201, { list: { ...list, counts: { total: 0, done: 0 } } });
      return true;
    }

    // GET /doing-lists/assignees : le staff à qui attribuer une carte.
    if (parts.length === 6 && parts[5] === 'assignees' && method === 'GET') {
      const members = await prisma.staffMember.findMany({
        where: { guildId },
        select: { id: true, userId: true, username: true, displayName: true, avatarUrl: true },
        orderBy: { username: 'asc' },
      });
      json(res, 200, { members });
      return true;
    }

    // GET /doing-lists/for/:source : listes où l'on peut poser un élément de
    // cette source, et celles qui l'ont déjà, pour le bouton des pages du module.
    if (parts.length === 7 && parts[5] === 'for' && method === 'GET') {
      const source = parts[6];
      if (!isDoingListSource(source)) {
        json(res, 400, { error: 'Module non reliable.' });
        return true;
      }
      // Une tâche du planning se pose dans n'importe quelle liste.
      const lists = await prisma.doingList.findMany({
        where: source === 'tasks' ? { guildId } : { guildId, modules: { has: source } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });
      const listIds = lists.map((list) => list.id);
      const items = listIds.length === 0
        ? []
        : source === 'tasks'
          ? (await prisma.doingListItem.findMany({
            where: { guildId, listId: { in: listIds }, staffTaskId: { not: null } },
            select: { id: true, listId: true, staffTaskId: true },
          })).map((item) => ({ id: item.id, listId: item.listId, sourceId: item.staffTaskId as string }))
          : (await prisma.doingListItem.findMany({
            where: { guildId, sourceModule: source, listId: { in: listIds } },
            select: { id: true, listId: true, sourceId: true },
          })).map((item) => ({ id: item.id, listId: item.listId, sourceId: item.sourceId as string }));
      json(res, 200, { lists, items });
      return true;
    }

    if (!listId) return false;

    // GET /doing-lists/:id : la liste, ses étapes et ses cartes.
    if (parts.length === 6 && method === 'GET') {
      const list = await findList();
      if (!list) {
        json(res, 404, { error: 'Liste introuvable.' });
        return true;
      }
      const [columns, items] = await Promise.all([
        findColumns(),
        prisma.doingListItem.findMany({
          where: { listId },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          include: ITEM_INCLUDE,
        }),
      ]);
      json(res, 200, { list, columns, items });
      return true;
    }

    // PATCH /doing-lists/:id : nom, description, modules reliés.
    if (parts.length === 6 && method === 'PATCH') {
      const existing = await findList();
      if (!existing) {
        json(res, 404, { error: 'Liste introuvable.' });
        return true;
      }
      const body = (await readJsonBody<{ name?: unknown; description?: unknown; modules?: unknown }>(req)) ?? {};
      const data: { name?: string; description?: string | null; modules?: DoingListModule[] } = {};
      if (body.name !== undefined) {
        const name = readText(body.name, NAME_MAX);
        if (!name) {
          json(res, 400, { error: 'Donne un nom à la liste.' });
          return true;
        }
        data.name = name;
      }
      if (body.description !== undefined) data.description = readText(body.description, DESCRIPTION_MAX);
      // Délier un module garde ses éléments déjà épinglés : on ne perd pas le
      // suivi en cours, on cesse seulement d'en ajouter.
      if (body.modules !== undefined) data.modules = readModules(body.modules);
      const list = await prisma.doingList.update({ where: { id: listId }, data });
      await audit('Modification liste de suivi', `« ${list.name} » : ${Object.keys(data).join(', ') || 'aucun changement'}.`);
      json(res, 200, { list });
      return true;
    }

    // DELETE /doing-lists/:id : les tâches attribuées restent dans le planning.
    if (parts.length === 6 && method === 'DELETE') {
      const existing = await findList();
      if (!existing) {
        json(res, 404, { error: 'Liste introuvable.' });
        return true;
      }
      await prisma.doingList.delete({ where: { id: listId } });
      await audit('Suppression liste de suivi', `« ${existing.name} ».`);
      json(res, 200, { ok: true });
      return true;
    }

    const list = await findList();
    if (!list) {
      json(res, 404, { error: 'Liste introuvable.' });
      return true;
    }

    // ── Étapes ─────────────────────────────────────────────────
    if (parts[6] === 'columns') {
      // PUT /doing-lists/:id/columns/order : nouvel ordre des étapes.
      if (parts.length === 8 && parts[7] === 'order' && method === 'PUT') {
        const body = (await readJsonBody<{ ids?: unknown }>(req)) ?? {};
        const columns = await findColumns();
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
        if (ids.length !== columns.length || new Set(ids).size !== ids.length || !columns.every((column) => ids.includes(column.id))) {
          json(res, 400, { error: 'Ordre des étapes invalide.' });
          return true;
        }
        await prisma.$transaction(ids.map((id, position) => prisma.doingListColumn.update({ where: { id }, data: { position } })));
        await pushListProgressToTasks(listId);
        json(res, 200, { columns: await findColumns() });
        return true;
      }

      // POST /doing-lists/:id/columns : nouvelle étape, en dernier.
      if (parts.length === 7 && method === 'POST') {
        const body = (await readJsonBody<{ name?: unknown; wipLimit?: unknown; isDone?: unknown }>(req)) ?? {};
        const name = readText(body.name, NAME_MAX);
        if (!name) {
          json(res, 400, { error: "Donne un nom à l'étape." });
          return true;
        }
        const columns = await findColumns();
        if (columns.length >= MAX_COLUMNS_PER_LIST) {
          json(res, 400, { error: `${MAX_COLUMNS_PER_LIST} étapes au plus par liste.` });
          return true;
        }
        const column = await prisma.doingListColumn.create({
          data: {
            listId,
            guildId,
            name,
            position: (columns.at(-1)?.position ?? -1) + 1,
            wipLimit: readWipLimit(body.wipLimit) ?? null,
            isDone: body.isDone === true,
          },
        });
        await audit('Nouvelle étape', `« ${name} » dans « ${list.name} ».`);
        json(res, 201, { column });
        return true;
      }

      const columnId = parts[7];
      if (parts.length !== 8 || !columnId) return false;
      const columns = await findColumns();
      const column = columns.find((entry) => entry.id === columnId);
      if (!column) {
        json(res, 404, { error: 'Étape introuvable.' });
        return true;
      }

      // PATCH /doing-lists/:id/columns/:columnId : nom, limite, étape terminée.
      if (method === 'PATCH') {
        const body = (await readJsonBody<{ name?: unknown; wipLimit?: unknown; isDone?: unknown }>(req)) ?? {};
        const data: { name?: string; wipLimit?: number | null; isDone?: boolean } = {};
        if (body.name !== undefined) {
          const name = readText(body.name, NAME_MAX);
          if (!name) {
            json(res, 400, { error: "Donne un nom à l'étape." });
            return true;
          }
          data.name = name;
        }
        if (body.wipLimit !== undefined) {
          const wipLimit = readWipLimit(body.wipLimit);
          if (wipLimit === undefined) {
            json(res, 400, { error: 'La limite est un nombre entier entre 1 et 999.' });
            return true;
          }
          data.wipLimit = wipLimit;
        }
        if (typeof body.isDone === 'boolean') data.isDone = body.isDone;
        const updated = await prisma.doingListColumn.update({ where: { id: columnId }, data });
        if (data.isDone !== undefined && data.isDone !== column.isDone) await pushListProgressToTasks(listId);
        json(res, 200, { column: updated });
        return true;
      }

      // DELETE /doing-lists/:id/columns/:columnId?moveTo= : ses cartes passent
      // dans une autre étape, la première par défaut.
      if (method === 'DELETE') {
        const others = columns.filter((entry) => entry.id !== columnId);
        const target = others.find((entry) => entry.id === url.searchParams.get('moveTo')) ?? others[0];
        if (!target) {
          json(res, 400, { error: 'Une liste garde au moins une étape.' });
          return true;
        }
        await prisma.$transaction(async (tx) => {
          const [moving, last] = await Promise.all([
            tx.doingListItem.findMany({ where: { columnId }, orderBy: { position: 'asc' }, select: { id: true } }),
            tx.doingListItem.findFirst({ where: { columnId: target.id }, orderBy: { position: 'desc' }, select: { position: true } }),
          ]);
          const start = (last?.position ?? -1) + 1;
          for (const [offset, item] of moving.entries()) {
            await tx.doingListItem.update({ where: { id: item.id }, data: { columnId: target.id, position: start + offset } });
          }
          await tx.doingListColumn.delete({ where: { id: columnId } });
        });
        await pushListProgressToTasks(listId);
        await audit('Suppression étape', `« ${column.name} » de « ${list.name} », cartes passées dans « ${target.name} ».`);
        json(res, 200, { ok: true });
        return true;
      }
      return false;
    }

    if (parts[6] !== 'items') return false;
    const columns = await findColumns();

    // POST /doing-lists/:id/items : carte libre ({ title }), élément d'un module
    // relié ou tâche du planning ({ sourceModule, sourceId }).
    if (parts.length === 7 && method === 'POST') {
      if (await prisma.doingListItem.count({ where: { listId } }) >= MAX_ITEMS_PER_LIST) {
        json(res, 400, { error: `${MAX_ITEMS_PER_LIST} éléments au plus par liste.` });
        return true;
      }
      const body = (await readJsonBody<{ title?: unknown; sourceModule?: unknown; sourceId?: unknown; columnId?: unknown }>(req)) ?? {};
      let title = readText(body.title, TITLE_MAX);
      let source: SourceRead | null = null;
      let sourceModule: DoingListSource | null = null;
      let sourceId: string | null = null;

      if (body.sourceModule !== undefined || body.sourceId !== undefined) {
        const linked = body.sourceModule === 'tasks' || (isDoingListModule(body.sourceModule) && list.modules.includes(body.sourceModule));
        if (!isDoingListSource(body.sourceModule) || !linked) {
          json(res, 400, { error: "Ce module n'est pas relié à la liste." });
          return true;
        }
        sourceId = readText(body.sourceId, 64);
        source = sourceId ? await readSource(guildId, body.sourceModule, sourceId) : null;
        if (!source) {
          json(res, 404, { error: 'Élément introuvable sur ce serveur.' });
          return true;
        }
        sourceModule = body.sourceModule;
        title = title ?? source.title;
        const duplicate = sourceModule === 'tasks'
          ? await prisma.doingListItem.findUnique({ where: { staffTaskId: sourceId as string }, select: { list: { select: { name: true } } } })
          : await prisma.doingListItem.findFirst({ where: { listId, sourceModule, sourceId }, select: { list: { select: { name: true } } } });
        if (duplicate) {
          json(res, 409, { error: `Cet élément est déjà dans la liste « ${duplicate.list.name} ».` });
          return true;
        }
      }
      if (!title) {
        json(res, 400, { error: "Donne un titre à l'élément." });
        return true;
      }

      // Une tâche du planning arrive dans l'étape qui correspond à son avancement.
      const preferredId = typeof body.columnId === 'string'
        ? body.columnId
        : source?.status ? columnForTaskStatus(columns, source.status) : null;
      const column = columns.find((entry) => entry.id === preferredId) ?? columns[0];
      if (!column) {
        json(res, 400, { error: "La liste n'a aucune étape." });
        return true;
      }
      const full = await fullColumnError(column);
      if (full) {
        json(res, 409, { error: full });
        return true;
      }

      const last = await prisma.doingListItem.findFirst({ where: { columnId: column.id }, orderBy: { position: 'desc' }, select: { position: true } });
      const staffTaskId = sourceModule === 'tasks' ? sourceId : null;
      const item = await prisma.doingListItem.create({
        data: {
          listId,
          guildId,
          columnId: column.id,
          title,
          position: (last?.position ?? -1) + 1,
          description: source?.description ?? null,
          priority: source?.priority ?? null,
          dueDate: source?.dueDate ?? null,
          sourceModule,
          sourceId,
          staffTaskId,
          createdById: user.userId,
        },
        include: ITEM_INCLUDE,
      });
      if (staffTaskId && item.staffTask && item.staffTask.status !== taskStatusForColumn(columns, column.id)) {
        await prisma.staffTask.update({ where: { id: staffTaskId }, data: { status: taskStatusForColumn(columns, column.id) } });
      }
      json(res, 201, { item });
      return true;
    }

    const itemId = parts[7];
    if (parts.length !== 8 || !itemId) return false;
    const existingItem = await prisma.doingListItem.findFirst({ where: { id: itemId, listId, guildId } });
    if (!existingItem) {
      json(res, 404, { error: 'Élément introuvable.' });
      return true;
    }

    // PATCH /doing-lists/:id/items/:itemId : détails, étape et place
    // ({ columnId, index }), attribution ({ assigneeId } : membre du staff ou null).
    if (method === 'PATCH') {
      const body = (await readJsonBody<{
        title?: unknown;
        description?: unknown;
        priority?: unknown;
        dueDate?: unknown;
        labels?: unknown;
        checklist?: unknown;
        columnId?: unknown;
        index?: unknown;
        assigneeId?: unknown;
      }>(req)) ?? {};

      const data: Prisma.DoingListItemUncheckedUpdateInput = {};
      if (body.title !== undefined) {
        const title = readText(body.title, TITLE_MAX);
        if (!title) {
          json(res, 400, { error: "Donne un titre à l'élément." });
          return true;
        }
        data.title = title;
      }
      if (body.description !== undefined) data.description = readText(body.description, ITEM_DESCRIPTION_MAX);
      if (body.priority !== undefined) {
        if (body.priority !== null && !isDoingListPriority(body.priority)) {
          json(res, 400, { error: 'Priorité inconnue.' });
          return true;
        }
        data.priority = body.priority;
      }
      if (body.dueDate !== undefined) {
        const dueDate = readDueDate(body.dueDate);
        if (dueDate === undefined) {
          json(res, 400, { error: 'Échéance illisible.' });
          return true;
        }
        data.dueDate = dueDate;
      }
      if (body.labels !== undefined) data.labels = readLabels(body.labels);
      if (body.checklist !== undefined) data.checklist = readChecklist(body.checklist);

      let targetColumnId = existingItem.columnId;
      if (body.columnId !== undefined) {
        const column = columns.find((entry) => entry.id === body.columnId);
        if (!column) {
          json(res, 400, { error: 'Étape introuvable.' });
          return true;
        }
        if (column.id !== existingItem.columnId) {
          const full = await fullColumnError(column, itemId);
          if (full) {
            json(res, 409, { error: full });
            return true;
          }
        }
        targetColumnId = column.id;
      }
      const index = typeof body.index === 'number' && Number.isInteger(body.index) ? body.index : null;

      let assignee: { id: string } | null | undefined;
      if (body.assigneeId === null) {
        if (existingItem.sourceModule === 'tasks') {
          json(res, 400, { error: 'Une tâche du planning garde toujours une personne attitrée.' });
          return true;
        }
        assignee = null;
      } else if (typeof body.assigneeId === 'string') {
        assignee = await prisma.staffMember.findFirst({ where: { id: body.assigneeId, guildId }, select: { id: true } });
        if (!assignee) {
          json(res, 400, { error: 'Cette personne ne fait pas partie du staff.' });
          return true;
        }
      }

      await prisma.$transaction(async (tx) => {
        if (Object.keys(data).length > 0) await tx.doingListItem.update({ where: { id: itemId }, data });
        if (body.columnId !== undefined || index !== null) {
          await placeItem(tx, itemId, targetColumnId, index ?? Number.MAX_SAFE_INTEGER);
        }
      });

      const item = await prisma.doingListItem.findUniqueOrThrow({ where: { id: itemId } });
      let staffTaskId = item.staffTaskId;
      const priority = item.priority ?? 'MEDIUM';

      // L'attribution passe par une tâche du planning : la retirer supprime la
      // tâche, attribuer une carte qui n'en a pas en crée une.
      if (assignee === null && staffTaskId) {
        await prisma.staffTask.delete({ where: { id: staffTaskId } });
        staffTaskId = null;
        await audit('Attribution retirée', `« ${item.title} » dans « ${list.name} ».`);
      } else if (assignee && staffTaskId) {
        await prisma.staffTask.update({ where: { id: staffTaskId }, data: { assigneeId: assignee.id } });
        await audit('Carte réattribuée', `« ${item.title} » dans « ${list.name} ».`);
      } else if (assignee) {
        const task = await createTask(guildId, user.userId, item.title, item.description, priority as 'LOW' | 'MEDIUM' | 'HIGH', item.dueDate, assignee.id, assignee.id);
        await prisma.doingListItem.update({ where: { id: itemId }, data: { staffTaskId: task.id } });
        staffTaskId = task.id;
        await audit('Carte attribuée', `« ${item.title} » dans « ${list.name} ».`);
      }

      // La tâche suit la carte : titre, détails, avancement.
      if (staffTaskId) {
        await prisma.staffTask.update({
          where: { id: staffTaskId },
          data: {
            title: item.title,
            description: item.description,
            priority: priority as 'LOW' | 'MEDIUM' | 'HIGH',
            dueDate: item.dueDate,
            status: taskStatusForColumn(columns, item.columnId),
          },
        });
      }

      json(res, 200, { item: await prisma.doingListItem.findUniqueOrThrow({ where: { id: itemId }, include: ITEM_INCLUDE }) });
      return true;
    }

    // DELETE /doing-lists/:id/items/:itemId : retire la carte, pas sa source ;
    // une tâche attribuée reste dans le planning.
    if (method === 'DELETE') {
      await prisma.doingListItem.delete({ where: { id: itemId } });
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  } catch (err) {
    logger.error(LOG, 'Erreur listes de suivi :', err);
    jsonFailure(res, err, 'Erreur sur les listes de suivi', LOG);
    return true;
  }
}
