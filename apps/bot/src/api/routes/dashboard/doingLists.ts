import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import {
  DOING_LIST_MODULES,
  isDoingListItemType,
  isDoingListLinkType,
  isDoingListModule,
  isDoingListPriority,
  isDoingListSource,
  parseDoingListRef,
  type DoingListChecklistEntry,
  type DoingListModule,
  type DoingListSource,
} from '@kotbo/contracts';
import type { DoingList, DoingListItem, Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { pushAudit, getGuildName } from '../../shared.js';
import { auditUserOf, fail, guildRoute, readBody, send } from '../../hono/dashboard/kit.js';
import { getCachedFeatureAccess } from './featureGate.js';
import { createTask } from '../../../services/staff/staffLeadershipService.js';
import { columnForTaskStatus, pushListProgressToTasks, taskStatusForColumn } from '../../../services/staff/doingListTaskSync.js';
import {
  deriveListKey,
  freeListKey,
  fullColumnMessage,
  logDoingListEvent,
  nextItemNumber,
  type DoingListEventKind,
} from '../../../services/staff/doingListBoard.js';

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
  _count: { select: { events: { where: { kind: 'comment' } } } },
} satisfies Prisma.DoingListItemInclude;

// Ce qu'on montre d'une carte citée ailleurs (lien, résultat de recherche).
const REF_SELECT = {
  id: true,
  listId: true,
  number: true,
  title: true,
  type: true,
  list: { select: { key: true } },
  column: { select: { isDone: true } },
} satisfies Prisma.DoingListItemSelect;

type RefRow = Prisma.DoingListItemGetPayload<{ select: typeof REF_SELECT }>;

function toRef(row: RefRow) {
  return { id: row.id, listId: row.listId, key: `${row.list.key}-${row.number}`, title: row.title, type: row.type, done: row.column.isDone };
}

type ColumnRow = { id: string; name: string; position: number; wipLimit: number | null; isDone: boolean };

const MAX_LINKS_PER_ITEM = 50;
const COMMENT_MAX = 4000;

function readEstimate(raw: unknown): number | null | undefined {
  if (raw === null || raw === '') return null;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 999 ? raw : undefined;
}

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
export function createDoingListsRouter(client: Client) {
  const router = new Hono();
  const base = '/api/dashboard/guilds/:guildId';
  // Écrire demande le droit de modérer ou de configurer la section ; supprimer
  // une liste entière, celui de supprimer.
  const doingAccess = createMiddleware(async (c, next) => {
    const method = c.req.method;
    const access = c.var.effectiveAccess;
    if (method !== 'GET' && !access.canManageSettings) {
      const rights = (await getCachedFeatureAccess(client, c.req.param('guildId')!, access, c.var.dashboardUser.userId)).doing_lists;
      const deletesList = method === 'DELETE' && /\/doing-lists\/[^/]+$/.test(c.req.path);
      if (!(deletesList ? rights?.canDelete : rights?.canModerate || rights?.canConfigure)) {
        return send(c, { error: 'Action sur les listes de suivi non autorisée.' }, 403);
      }
    }
    await next();
  });
  // Pas de purge du cache derrière : l'ancien routeur n'en faisait pas.
  const gate = [...guildRoute(client, { invalidateCache: false }), doingAccess] as const;

  const helpers = (c: Context) => {
    const guildId = c.req.param('guildId')!;
    const listId = c.req.param('listId')!;
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    return {
      audit: (action: string, details: string) => pushAudit(guildId, {
        user: auditUser,
        action,
        context: getGuildName(client, guildId),
        module: 'Listes de suivi',
        eventType: 'Settings',
        details,
        channelId: null,
      }).catch((err) => logger.warn(LOG, 'Journal non écrit :', err)),
      findList: () => prisma.doingList.findFirst({ where: { id: listId, guildId } }),
      findColumns: (): Promise<ColumnRow[]> => prisma.doingListColumn.findMany({
        where: { listId },
        orderBy: { position: 'asc' },
        select: { id: true, name: true, position: true, wipLimit: true, isDone: true },
      }),
      fullColumnError: fullColumnMessage,
      logEvent: (itemId: string, kind: DoingListEventKind, data?: Prisma.InputJsonValue, body?: string | null) =>
        logDoingListEvent({ guildId, itemId, actorId: user.userId, actorName: auditUser, kind, data, body }),
    };
  };

  /** La liste visée, limitée au serveur. */
  const loadList = createMiddleware<{ Variables: { list: DoingList } }>(async (c, next) => {
    const list = await prisma.doingList.findFirst({ where: { id: c.req.param('listId'), guildId: c.req.param('guildId') } });
    if (!list) return send(c, { error: 'Liste introuvable.' }, 404);
    c.set('list', list);
    await next();
  });
  const listGate = [...gate, loadList] as const;

  /** L'étape visée et toutes celles de la liste. */
  const loadColumn = createMiddleware<{ Variables: { columns: ColumnRow[]; column: ColumnRow } }>(async (c, next) => {
    const columns = await helpers(c).findColumns();
    const column = columns.find((entry) => entry.id === c.req.param('columnId'));
    if (!column) return send(c, { error: 'Étape introuvable.' }, 404);
    c.set('columns', columns);
    c.set('column', column);
    await next();
  });
  const columnGate = [...listGate, loadColumn] as const;

  /** La carte visée, dans la liste et le serveur. */
  const loadItem = createMiddleware<{ Variables: { existingItem: DoingListItem } }>(async (c, next) => {
    const existingItem = await prisma.doingListItem.findFirst({
      where: { id: c.req.param('itemId'), listId: c.req.param('listId'), guildId: c.req.param('guildId') },
    });
    if (!existingItem) return send(c, { error: 'Élément introuvable.' }, 404);
    c.set('existingItem', existingItem);
    await next();
  });
  const itemGate = [...listGate, loadItem] as const;

  router.onError((err, c) => {
    logger.error(LOG, 'Erreur listes de suivi :', err);
    return fail(c, err, 'Erreur sur les listes de suivi', LOG);
  });

  // PATCH / DELETE /doing-lists/:listId/items/:itemId/comments/:eventId :
  // son auteur seulement, ou un admin pour la suppression.
  router.on(['PATCH', 'DELETE'], `${base}/doing-lists/:listId/items/:itemId/comments/:eventId`, ...itemGate, async (c) => {
    const eventId = c.req.param('eventId');
    const comment = await prisma.doingListEvent.findFirst({ where: { id: eventId, itemId: c.req.param('itemId'), kind: 'comment' } });
    if (!comment) return send(c, { error: 'Commentaire introuvable.' }, 404);
    const isAuthor = comment.actorId === c.var.dashboardUser.userId;
    if (c.req.method === 'PATCH') {
      if (!isAuthor) return send(c, { error: 'Seul son auteur peut modifier ce commentaire.' }, 403);
      const body = (await readBody<{ body?: unknown }>(c)) ?? {};
      const text = readText(body.body, COMMENT_MAX);
      if (!text) return send(c, { error: 'Le commentaire est vide.' }, 400);
      return send(c, { event: await prisma.doingListEvent.update({ where: { id: eventId }, data: { body: text } }) });
    }
    if (!isAuthor && !c.var.effectiveAccess.canManageSettings) {
      return send(c, { error: 'Seul son auteur peut supprimer ce commentaire.' }, 403);
    }
    await prisma.doingListEvent.delete({ where: { id: eventId } });
    return send(c, { ok: true });
  });

  // DELETE /doing-lists/:listId/items/:itemId/links/:linkId
  router.delete(`${base}/doing-lists/:listId/items/:itemId/links/:linkId`, ...itemGate, async (c) => {
    const itemId = c.req.param('itemId');
    const linkId = c.req.param('linkId');
    const { logEvent } = helpers(c);
    const link = await prisma.doingListItemLink.findFirst({
      where: { id: linkId, OR: [{ fromId: itemId }, { toId: itemId }] },
      select: { id: true, type: true, from: { select: REF_SELECT }, to: { select: REF_SELECT } },
    });
    if (!link) return send(c, { error: 'Lien introuvable.' }, 404);
    await prisma.doingListItemLink.delete({ where: { id: linkId } });
    const ref = { type: link.type, from: toRef(link.from).key, to: toRef(link.to).key };
    await Promise.all([logEvent(link.from.id, 'unlinked', ref), logEvent(link.to.id, 'unlinked', ref)]);
    return send(c, { ok: true });
  });



  router.get(`${base}/doing-lists`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
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
    return send(c, {
      lists: lists.map((list) => ({ ...list, counts: counts.get(list.id) ?? { total: 0, done: 0 } })),
      modules: DOING_LIST_MODULES,
    });
  });

  router.post(`${base}/doing-lists`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const { audit } = helpers(c);
    const body = (await readBody<{ name?: unknown; description?: unknown; modules?: unknown; columns?: unknown; key?: unknown }>(c)) ?? {};
    const name = readText(body.name, NAME_MAX);
    if (!name) {
      return send(c, { error: 'Donne un nom à la liste.' }, 400);
    }
    if (await prisma.doingList.count({ where: { guildId } }) >= MAX_LISTS_PER_GUILD) {
      return send(c, { error: `${MAX_LISTS_PER_GUILD} listes au plus par serveur.` }, 400);
    }
    // Une clé demandée déjà prise est suffixée plutôt que refusée.
    const key = await freeListKey(guildId, readText(body.key, 10) ?? deriveListKey(name));
    if (!key) {
      return send(c, { error: 'La clé fait 2 à 10 lettres ou chiffres et commence par une lettre (ex. BOUT).' }, 400);
    }
    const names = Array.isArray(body.columns)
      ? body.columns.map((column) => readText(column, NAME_MAX)).filter((column): column is string => !!column).slice(0, MAX_COLUMNS_PER_LIST)
      : [];
    const columnNames = names.length > 0 ? names : DEFAULT_COLUMNS;
    const list = await prisma.doingList.create({
      data: {
        guildId,
        name,
        key,
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
    return send(c, { list: { ...list, counts: { total: 0, done: 0 } } }, 201);
  });

  router.get(`${base}/doing-lists/assignees`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const members = await prisma.staffMember.findMany({
      where: { guildId },
      select: { id: true, userId: true, username: true, displayName: true, avatarUrl: true },
      orderBy: { username: 'asc' },
    });
    return send(c, { members });
  });

  // par titre, pour lier une carte à une autre.
  router.get(`${base}/doing-lists/search`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const query = (c.req.query('q') ?? '').trim().slice(0, 100);
    if (!query) {
      return send(c, { items: [] });
    }
    const ref = parseDoingListRef(query);
    const rows = await prisma.doingListItem.findMany({
      where: {
        guildId,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          ...(ref ? [{ number: ref.number, list: { key: ref.key } }] : []),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: REF_SELECT,
    });
    return send(c, { items: rows.map(toRef) });
  });

  // cette source, et celles qui l'ont déjà, pour le bouton des pages du module.
  router.get(`${base}/doing-lists/for/:source`, ...gate, async (c) => {
    const guildId = c.req.param('guildId');
    const source = c.req.param('source');
    if (!isDoingListSource(source)) {
      return send(c, { error: 'Module non reliable.' }, 400);
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
    return send(c, { lists, items });
  });

  router.get(`${base}/doing-lists/:listId`, ...listGate, async (c) => {
    const guildId = c.req.param('guildId');
    const listId = c.req.param('listId');
    const { findList, findColumns } = helpers(c);
    const list = await findList();
    if (!list) {
      return send(c, { error: 'Liste introuvable.' }, 404);
    }
    const [columns, items, links] = await Promise.all([
      findColumns(),
      prisma.doingListItem.findMany({
        where: { listId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        include: ITEM_INCLUDE,
      }),
      // Liens touchant une carte de la liste, l'autre bout pouvant être ailleurs.
      prisma.doingListItemLink.findMany({
        where: { guildId, OR: [{ from: { listId } }, { to: { listId } }] },
        select: { id: true, type: true, from: { select: REF_SELECT }, to: { select: REF_SELECT } },
      }),
    ]);
    return send(c, {
      list,
      columns,
      items,
      links: links.map((link) => ({ id: link.id, type: link.type, from: toRef(link.from), to: toRef(link.to) })),
    });
  });

  router.patch(`${base}/doing-lists/:listId`, ...listGate, async (c) => {
    const guildId = c.req.param('guildId');
    const listId = c.req.param('listId');
    const { audit, findList } = helpers(c);
    const existing = await findList();
    if (!existing) {
      return send(c, { error: 'Liste introuvable.' }, 404);
    }
    const body = (await readBody<{ name?: unknown; description?: unknown; modules?: unknown; key?: unknown }>(c)) ?? {};
    const data: { name?: string; description?: string | null; modules?: DoingListModule[]; key?: string } = {};
    // Changer la clé renomme toutes les références (BOUT-12 → SHOP-12) : les
    // liens tiennent par identifiant, rien ne casse.
    if (body.key !== undefined) {
      const wanted = readText(body.key, 10)?.toUpperCase() ?? '';
      const key = await freeListKey(guildId, wanted, listId);
      if (!key) {
        return send(c, { error: 'La clé fait 2 à 10 lettres ou chiffres et commence par une lettre (ex. BOUT).' }, 400);
      }
      if (key !== wanted) {
        return send(c, { error: `La clé ${wanted} est déjà prise sur ce serveur.` }, 409);
      }
      data.key = key;
    }
    if (body.name !== undefined) {
      const name = readText(body.name, NAME_MAX);
      if (!name) {
        return send(c, { error: 'Donne un nom à la liste.' }, 400);
      }
      data.name = name;
    }
    if (body.description !== undefined) data.description = readText(body.description, DESCRIPTION_MAX);
    // Délier un module garde ses éléments déjà épinglés : on ne perd pas le
    // suivi en cours, on cesse seulement d'en ajouter.
    if (body.modules !== undefined) data.modules = readModules(body.modules);
    const list = await prisma.doingList.update({ where: { id: listId }, data });
    await audit('Modification liste de suivi', `« ${list.name} » : ${Object.keys(data).join(', ') || 'aucun changement'}.`);
    return send(c, { list });
  });

  router.delete(`${base}/doing-lists/:listId`, ...listGate, async (c) => {
    const listId = c.req.param('listId');
    const { audit, findList } = helpers(c);
    const existing = await findList();
    if (!existing) {
      return send(c, { error: 'Liste introuvable.' }, 404);
    }
    await prisma.doingList.delete({ where: { id: listId } });
    await audit('Suppression liste de suivi', `« ${existing.name} ».`);
    return send(c, { ok: true });
  });

  router.put(`${base}/doing-lists/:listId/columns/order`, ...listGate, async (c) => {
    const listId = c.req.param('listId');
    const { findColumns } = helpers(c);
    const body = (await readBody<{ ids?: unknown }>(c)) ?? {};
    const columns = await findColumns();
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
    if (ids.length !== columns.length || new Set(ids).size !== ids.length || !columns.every((column) => ids.includes(column.id))) {
      return send(c, { error: 'Ordre des étapes invalide.' }, 400);
    }
    await prisma.$transaction(ids.map((id, position) => prisma.doingListColumn.update({ where: { id }, data: { position } })));
    await pushListProgressToTasks(listId);
    return send(c, { columns: await findColumns() });
  });

  router.post(`${base}/doing-lists/:listId/columns`, ...listGate, async (c) => {
    const list = c.var.list;
    const guildId = c.req.param('guildId');
    const listId = c.req.param('listId');
    const { audit, findColumns } = helpers(c);
    const body = (await readBody<{ name?: unknown; wipLimit?: unknown; isDone?: unknown }>(c)) ?? {};
    const name = readText(body.name, NAME_MAX);
    if (!name) {
      return send(c, { error: "Donne un nom à l'étape." }, 400);
    }
    const columns = await findColumns();
    if (columns.length >= MAX_COLUMNS_PER_LIST) {
      return send(c, { error: `${MAX_COLUMNS_PER_LIST} étapes au plus par liste.` }, 400);
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
    return send(c, { column }, 201);
  });

  router.patch(`${base}/doing-lists/:listId/columns/:columnId`, ...columnGate, async (c) => {
    const columnId = c.req.param('columnId');
    const column = c.var.column;
    const listId = c.req.param('listId');
    const body = (await readBody<{ name?: unknown; wipLimit?: unknown; isDone?: unknown }>(c)) ?? {};
    const data: { name?: string; wipLimit?: number | null; isDone?: boolean } = {};
    if (body.name !== undefined) {
      const name = readText(body.name, NAME_MAX);
      if (!name) {
        return send(c, { error: "Donne un nom à l'étape." }, 400);
      }
      data.name = name;
    }
    if (body.wipLimit !== undefined) {
      const wipLimit = readWipLimit(body.wipLimit);
      if (wipLimit === undefined) {
        return send(c, { error: 'La limite est un nombre entier entre 1 et 999.' }, 400);
      }
      data.wipLimit = wipLimit;
    }
    if (typeof body.isDone === 'boolean') data.isDone = body.isDone;
    const updated = await prisma.doingListColumn.update({ where: { id: columnId }, data });
    if (data.isDone !== undefined && data.isDone !== column.isDone) await pushListProgressToTasks(listId);
    return send(c, { column: updated });
  });

  // dans une autre étape, la première par défaut.
  router.delete(`${base}/doing-lists/:listId/columns/:columnId`, ...columnGate, async (c) => {
    const columnId = c.req.param('columnId');
    const column = c.var.column;
    const columns = c.var.columns;
    const list = c.var.list;
    const listId = c.req.param('listId');
    const { audit } = helpers(c);
    const others = columns.filter((entry) => entry.id !== columnId);
    const target = others.find((entry) => entry.id === (c.req.query('moveTo') ?? null)) ?? others[0];
    if (!target) {
      return send(c, { error: 'Une liste garde au moins une étape.' }, 400);
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
    return send(c, { ok: true });
  });

  // relié ou tâche du planning ({ sourceModule, sourceId }).
  router.post(`${base}/doing-lists/:listId/items`, ...listGate, async (c) => {
    const columns = await helpers(c).findColumns();
    const list = c.var.list;
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const listId = c.req.param('listId');
    const { fullColumnError, logEvent } = helpers(c);
    if (await prisma.doingListItem.count({ where: { listId } }) >= MAX_ITEMS_PER_LIST) {
      return send(c, { error: `${MAX_ITEMS_PER_LIST} éléments au plus par liste.` }, 400);
    }
    const body = (await readBody<{ title?: unknown; sourceModule?: unknown; sourceId?: unknown; columnId?: unknown; type?: unknown; parentId?: unknown }>(c)) ?? {};
    let title = readText(body.title, TITLE_MAX);
    const type = isDoingListItemType(body.type) ? body.type : 'TASK';
    // Sous-tâche créée depuis la fiche de sa parente : même liste seulement.
    let parentId: string | null = null;
    if (typeof body.parentId === 'string') {
      const parent = await prisma.doingListItem.findFirst({ where: { id: body.parentId, listId }, select: { id: true } });
      if (!parent) {
        return send(c, { error: 'Carte parente introuvable dans cette liste.' }, 400);
      }
      parentId = parent.id;
    }
    let source: SourceRead | null = null;
    let sourceModule: DoingListSource | null = null;
    let sourceId: string | null = null;

    if (body.sourceModule !== undefined || body.sourceId !== undefined) {
      const linked = body.sourceModule === 'tasks' || (isDoingListModule(body.sourceModule) && list.modules.includes(body.sourceModule));
      if (!isDoingListSource(body.sourceModule) || !linked) {
        return send(c, { error: "Ce module n'est pas relié à la liste." }, 400);
      }
      sourceId = readText(body.sourceId, 64);
      source = sourceId ? await readSource(guildId, body.sourceModule, sourceId) : null;
      if (!source) {
        return send(c, { error: 'Élément introuvable sur ce serveur.' }, 404);
      }
      sourceModule = body.sourceModule;
      title = title ?? source.title;
      const duplicate = sourceModule === 'tasks'
        ? await prisma.doingListItem.findUnique({ where: { staffTaskId: sourceId as string }, select: { list: { select: { name: true } } } })
        : await prisma.doingListItem.findFirst({ where: { listId, sourceModule, sourceId }, select: { list: { select: { name: true } } } });
      if (duplicate) {
        return send(c, { error: `Cet élément est déjà dans la liste « ${duplicate.list.name} ».` }, 409);
      }
    }
    if (!title) {
      return send(c, { error: "Donne un titre à l'élément." }, 400);
    }

    // Une tâche du planning arrive dans l'étape qui correspond à son avancement.
    const preferredId = typeof body.columnId === 'string'
      ? body.columnId
      : source?.status ? columnForTaskStatus(columns, source.status) : null;
    const column = columns.find((entry) => entry.id === preferredId) ?? columns[0];
    if (!column) {
      return send(c, { error: "La liste n'a aucune étape." }, 400);
    }
    const full = await fullColumnError(column);
    if (full) {
      return send(c, { error: full }, 409);
    }

    const last = await prisma.doingListItem.findFirst({ where: { columnId: column.id }, orderBy: { position: 'desc' }, select: { position: true } });
    const staffTaskId = sourceModule === 'tasks' ? sourceId : null;
    const item = await prisma.$transaction(async (tx) => tx.doingListItem.create({
      data: {
        listId,
        guildId,
        columnId: column.id,
        number: await nextItemNumber(listId, tx),
        type,
        parentId,
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
    }));
    await logEvent(item.id, 'created', sourceModule ? { source: sourceModule } : undefined);
    if (staffTaskId && item.staffTask && item.staffTask.status !== taskStatusForColumn(columns, column.id)) {
      await prisma.staffTask.update({ where: { id: staffTaskId }, data: { status: taskStatusForColumn(columns, column.id) } });
    }
    return send(c, { item }, 201);
  });

  router.get(`${base}/doing-lists/:listId/items/:itemId/events`, ...itemGate, async (c) => {
    const itemId = c.req.param('itemId');
    const events = await prisma.doingListEvent.findMany({ where: { itemId }, orderBy: { createdAt: 'asc' }, take: 500 });
    return send(c, { events });
  });

  router.post(`${base}/doing-lists/:listId/items/:itemId/comments`, ...itemGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const auditUser = auditUserOf(c);
    const itemId = c.req.param('itemId');
    const body = (await readBody<{ body?: unknown }>(c)) ?? {};
    const text = readText(body.body, COMMENT_MAX);
    if (!text) {
      return send(c, { error: 'Le commentaire est vide.' }, 400);
    }
    const event = await prisma.doingListEvent.create({
      data: { guildId, itemId, actorId: user.userId, actorName: auditUser, kind: 'comment', body: text },
    });
    return send(c, { event }, 201);
  });

  // inward = la carte est la cible (« est bloquée par », « est dupliquée par »).
  router.post(`${base}/doing-lists/:listId/items/:itemId/links`, ...itemGate, async (c) => {
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const itemId = c.req.param('itemId');
    const { logEvent } = helpers(c);
    const body = (await readBody<{ type?: unknown; targetId?: unknown; inward?: unknown }>(c)) ?? {};
    if (!isDoingListLinkType(body.type)) {
      return send(c, { error: 'Type de lien inconnu.' }, 400);
    }
    const target = typeof body.targetId === 'string'
      ? await prisma.doingListItem.findFirst({ where: { id: body.targetId, guildId }, select: REF_SELECT })
      : null;
    if (!target) {
      return send(c, { error: 'Carte à lier introuvable sur ce serveur.' }, 404);
    }
    if (target.id === itemId) {
      return send(c, { error: 'Une carte ne se lie pas à elle-même.' }, 400);
    }
    const [fromId, toId] = body.inward === true ? [target.id, itemId] : [itemId, target.id];
    const existing = await prisma.doingListItemLink.findFirst({
      where: {
        type: body.type,
        // « Liée à » n'a pas de sens : A–B et B–A sont le même lien.
        OR: body.type === 'RELATES' ? [{ fromId, toId }, { fromId: toId, toId: fromId }] : [{ fromId, toId }],
      },
      select: { id: true },
    });
    if (existing) {
      return send(c, { error: 'Ce lien existe déjà.' }, 409);
    }
    if (await prisma.doingListItemLink.count({ where: { OR: [{ fromId: itemId }, { toId: itemId }] } }) >= MAX_LINKS_PER_ITEM) {
      return send(c, { error: `${MAX_LINKS_PER_ITEM} liens au plus par carte.` }, 400);
    }
    const link = await prisma.doingListItemLink.create({
      data: { guildId, fromId, toId, type: body.type, createdById: user.userId },
      select: { id: true, type: true, from: { select: REF_SELECT }, to: { select: REF_SELECT } },
    });
    const ref = { type: body.type, from: toRef(link.from).key, to: toRef(link.to).key };
    await Promise.all([logEvent(itemId, 'linked', ref), logEvent(target.id, 'linked', ref)]);
    return send(c, { link: { id: link.id, type: link.type, from: toRef(link.from), to: toRef(link.to) } }, 201);
  });

  // ({ columnId, index }), attribution ({ assigneeId } : membre du staff ou null).
  router.patch(`${base}/doing-lists/:listId/items/:itemId`, ...itemGate, async (c) => {
    const existingItem = c.var.existingItem;
    const columns = await helpers(c).findColumns();
    const list = c.var.list;
    const guildId = c.req.param('guildId');
    const user = c.var.dashboardUser;
    const listId = c.req.param('listId');
    const itemId = c.req.param('itemId');
    const { audit, fullColumnError, logEvent } = helpers(c);
    const body = (await readBody<{
      title?: unknown;
      description?: unknown;
      priority?: unknown;
      dueDate?: unknown;
      labels?: unknown;
      checklist?: unknown;
      columnId?: unknown;
      index?: unknown;
      assigneeId?: unknown;
      type?: unknown;
      estimate?: unknown;
      parentId?: unknown;
    }>(c)) ?? {};

    const data: Prisma.DoingListItemUncheckedUpdateInput = {};
    if (body.title !== undefined) {
      const title = readText(body.title, TITLE_MAX);
      if (!title) {
        return send(c, { error: "Donne un titre à l'élément." }, 400);
      }
      data.title = title;
    }
    if (body.description !== undefined) data.description = readText(body.description, ITEM_DESCRIPTION_MAX);
    if (body.priority !== undefined) {
      if (body.priority !== null && !isDoingListPriority(body.priority)) {
        return send(c, { error: 'Priorité inconnue.' }, 400);
      }
      data.priority = body.priority;
    }
    if (body.dueDate !== undefined) {
      const dueDate = readDueDate(body.dueDate);
      if (dueDate === undefined) {
        return send(c, { error: 'Échéance illisible.' }, 400);
      }
      data.dueDate = dueDate;
    }
    if (body.labels !== undefined) data.labels = readLabels(body.labels);
    if (body.checklist !== undefined) data.checklist = readChecklist(body.checklist);
    if (body.type !== undefined) {
      if (!isDoingListItemType(body.type)) {
        return send(c, { error: 'Type de carte inconnu.' }, 400);
      }
      data.type = body.type;
    }
    if (body.estimate !== undefined) {
      const estimate = readEstimate(body.estimate);
      if (estimate === undefined) {
        return send(c, { error: "L'estimation est un nombre entier entre 0 et 999." }, 400);
      }
      data.estimate = estimate;
    }
    if (body.parentId !== undefined) {
      if (body.parentId === null) data.parentId = null;
      else {
        const parent = typeof body.parentId === 'string'
          ? await prisma.doingListItem.findFirst({ where: { id: body.parentId, listId }, select: { id: true } })
          : null;
        if (!parent) {
          return send(c, { error: 'Carte parente introuvable dans cette liste.' }, 400);
        }
        // Remonte la lignée de la future parente : y trouver la carte ferait une boucle.
        let cursor: string | null = parent.id;
        for (let depth = 0; cursor && depth < 50; depth += 1) {
          if (cursor === itemId) {
            return send(c, { error: 'Une carte ne peut pas devenir la sous-tâche de sa propre sous-tâche.' }, 400);
          }
          cursor = (await prisma.doingListItem.findUnique({ where: { id: cursor }, select: { parentId: true } }))?.parentId ?? null;
        }
        data.parentId = parent.id;
      }
    }

    let targetColumnId = existingItem.columnId;
    if (body.columnId !== undefined) {
      const column = columns.find((entry) => entry.id === body.columnId);
      if (!column) {
        return send(c, { error: 'Étape introuvable.' }, 400);
      }
      if (column.id !== existingItem.columnId) {
        const full = await fullColumnError(column, itemId);
        if (full) {
          return send(c, { error: full }, 409);
        }
      }
      targetColumnId = column.id;
    }
    const index = typeof body.index === 'number' && Number.isInteger(body.index) ? body.index : null;
    let assignee: { id: string; username: string | null; displayName: string | null } | null | undefined;
    if (body.assigneeId === null) {
      if (existingItem.sourceModule === 'tasks') {
        return send(c, { error: 'Une tâche du planning garde toujours une personne attitrée.' }, 400);
      }
      assignee = null;
    } else if (typeof body.assigneeId === 'string') {
      assignee = await prisma.staffMember.findFirst({ where: { id: body.assigneeId, guildId }, select: { id: true, username: true, displayName: true } });
      if (!assignee) {
        return send(c, { error: 'Cette personne ne fait pas partie du staff.' }, 400);
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

    // Fil de la carte : ce qui a bougé, sans le simple réordonnancement.
    if (item.columnId !== existingItem.columnId) {
      const name = (id: string) => columns.find((column) => column.id === id)?.name ?? '?';
      await logEvent(itemId, 'moved', { from: name(existingItem.columnId), to: name(item.columnId) });
    }
    if (assignee) await logEvent(itemId, 'assigned', { name: assignee.displayName || assignee.username || '' });
    else if (assignee === null && existingItem.staffTaskId) await logEvent(itemId, 'unassigned');
    const changed = Object.keys(data);
    if (changed.length > 0) await logEvent(itemId, 'updated', { fields: changed });

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

    return send(c, { item: await prisma.doingListItem.findUniqueOrThrow({ where: { id: itemId }, include: ITEM_INCLUDE }) });
  });

  // une tâche attribuée reste dans le planning.
  router.delete(`${base}/doing-lists/:listId/items/:itemId`, ...itemGate, async (c) => {
    const itemId = c.req.param('itemId');
    await prisma.doingListItem.delete({ where: { id: itemId } });
    return send(c, { ok: true });
  });

  return router;
}

