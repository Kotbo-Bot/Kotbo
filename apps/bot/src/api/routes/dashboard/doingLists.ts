import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { DOING_LIST_MODULES, isDoingListModule, isDoingListStatus, type DoingListModule } from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, pushAudit, getGuildName, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { jsonFailure } from '../../shared/failure.js';
import { getCachedFeatureAccess } from './featureGate.js';

const SEGMENT = 'doing-lists';
const LOG = 'DoingListsAPI';
const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const TITLE_MAX = 200;
const MAX_LISTS_PER_GUILD = 50;
const MAX_ITEMS_PER_LIST = 500;

function readText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().slice(0, max);
  return text || null;
}

function readModules(raw: unknown): DoingListModule[] {
  return Array.isArray(raw) ? [...new Set(raw.filter(isDoingListModule))] : [];
}

/**
 * Titre d'un élément de module, lu à l'épinglage. Ne renvoie rien si l'élément
 * n'appartient pas au serveur : c'est aussi la vérification d'appartenance.
 */
async function readSourceTitle(guildId: string, module: DoingListModule, sourceId: string): Promise<string | null> {
  if (module === 'suggestions') {
    const suggestion = await prisma.suggestion.findFirst({ where: { id: sourceId, guildId }, select: { content: true } });
    return suggestion ? suggestion.content.replace(/\s+/g, ' ').slice(0, TITLE_MAX) : null;
  }
  const ticket = await prisma.ticket.findFirst({ where: { id: sourceId, guildId }, select: { reason: true, username: true } });
  return ticket ? `${ticket.reason} (${ticket.username})`.slice(0, TITLE_MAX) : null;
}

/**
 * Listes de suivi : plusieurs listes par serveur, chacune reliée à des modules
 * dont on y épingle les éléments un par un, plus des tâches libres.
 *
 * Lecture ouverte à qui voit la section (garde du répartiteur). Déplacer,
 * ajouter ou retirer un élément relève de la modération de la section : c'est
 * l'outil de travail du staff, pas un réglage. Supprimer une liste demande le
 * droit de suppression.
 */
export async function handleDoingListRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  _url: URL,
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

  try {
    // GET /doing-lists : les listes et leurs compteurs par statut.
    if (parts.length === 5 && method === 'GET') {
      const [lists, grouped] = await Promise.all([
        prisma.doingList.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } }),
        prisma.doingListItem.groupBy({ by: ['listId', 'status'], where: { guildId }, _count: { _all: true } }),
      ]);
      const counts = new Map<string, Record<string, number>>();
      for (const row of grouped) {
        const entry = counts.get(row.listId) ?? { TODO: 0, DOING: 0, DONE: 0 };
        entry[row.status] = row._count._all;
        counts.set(row.listId, entry);
      }
      json(res, 200, {
        lists: lists.map((list) => ({ ...list, counts: counts.get(list.id) ?? { TODO: 0, DOING: 0, DONE: 0 } })),
        modules: DOING_LIST_MODULES,
      });
      return true;
    }

    // POST /doing-lists : création.
    if (parts.length === 5 && method === 'POST') {
      const body = (await readJsonBody<{ name?: unknown; description?: unknown; modules?: unknown }>(req)) ?? {};
      const name = readText(body.name, NAME_MAX);
      if (!name) {
        json(res, 400, { error: 'Donne un nom à la liste.' });
        return true;
      }
      if (await prisma.doingList.count({ where: { guildId } }) >= MAX_LISTS_PER_GUILD) {
        json(res, 400, { error: `${MAX_LISTS_PER_GUILD} listes au plus par serveur.` });
        return true;
      }
      const list = await prisma.doingList.create({
        data: {
          guildId,
          name,
          description: readText(body.description, DESCRIPTION_MAX),
          modules: readModules(body.modules),
          createdById: user.userId,
        },
      });
      await audit('Création liste de suivi', `« ${list.name} ».`);
      json(res, 201, { list: { ...list, counts: { TODO: 0, DOING: 0, DONE: 0 } } });
      return true;
    }

    // GET /doing-lists/for/:module : listes reliées au module et éléments déjà
    // épinglés, pour le bouton « Ajouter à une liste » des pages du module.
    if (parts.length === 7 && parts[5] === 'for' && method === 'GET') {
      const module = parts[6];
      if (!isDoingListModule(module)) {
        json(res, 400, { error: 'Module non reliable.' });
        return true;
      }
      const lists = await prisma.doingList.findMany({
        where: { guildId, modules: { has: module } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });
      const items = lists.length > 0
        ? await prisma.doingListItem.findMany({
          where: { guildId, sourceModule: module, listId: { in: lists.map((list) => list.id) } },
          select: { id: true, listId: true, sourceId: true, status: true },
        })
        : [];
      json(res, 200, { lists, items });
      return true;
    }

    if (!listId) return false;

    // GET /doing-lists/:id : la liste et ses éléments.
    if (parts.length === 6 && method === 'GET') {
      const list = await findList();
      if (!list) {
        json(res, 404, { error: 'Liste introuvable.' });
        return true;
      }
      const items = await prisma.doingListItem.findMany({
        where: { listId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      });
      json(res, 200, { list, items });
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

    // DELETE /doing-lists/:id
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

    if (parts[6] !== 'items') return false;

    // POST /doing-lists/:id/items : tâche libre ({ title }) ou élément d'un
    // module relié ({ sourceModule, sourceId }).
    if (parts.length === 7 && method === 'POST') {
      const list = await findList();
      if (!list) {
        json(res, 404, { error: 'Liste introuvable.' });
        return true;
      }
      if (await prisma.doingListItem.count({ where: { listId } }) >= MAX_ITEMS_PER_LIST) {
        json(res, 400, { error: `${MAX_ITEMS_PER_LIST} éléments au plus par liste.` });
        return true;
      }
      const body = (await readJsonBody<{ title?: unknown; sourceModule?: unknown; sourceId?: unknown; status?: unknown }>(req)) ?? {};
      const status = isDoingListStatus(body.status) ? body.status : 'TODO';
      let title = readText(body.title, TITLE_MAX);
      let sourceModule: DoingListModule | null = null;
      let sourceId: string | null = null;

      if (body.sourceModule !== undefined || body.sourceId !== undefined) {
        if (!isDoingListModule(body.sourceModule) || !list.modules.includes(body.sourceModule)) {
          json(res, 400, { error: "Ce module n'est pas relié à la liste." });
          return true;
        }
        sourceId = readText(body.sourceId, 64);
        const sourceTitle = sourceId ? await readSourceTitle(guildId, body.sourceModule, sourceId) : null;
        if (!sourceTitle) {
          json(res, 404, { error: 'Élément introuvable sur ce serveur.' });
          return true;
        }
        sourceModule = body.sourceModule;
        title = title ?? sourceTitle;
        const duplicate = await prisma.doingListItem.findFirst({ where: { listId, sourceModule, sourceId }, select: { id: true } });
        if (duplicate) {
          json(res, 409, { error: 'Cet élément est déjà dans la liste.' });
          return true;
        }
      }
      if (!title) {
        json(res, 400, { error: "Donne un titre à l'élément." });
        return true;
      }

      const last = await prisma.doingListItem.findFirst({ where: { listId, status }, orderBy: { position: 'desc' }, select: { position: true } });
      const item = await prisma.doingListItem.create({
        data: { listId, guildId, title, status, position: (last?.position ?? -1) + 1, sourceModule, sourceId, createdById: user.userId },
      });
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

    // PATCH /doing-lists/:id/items/:itemId : titre, statut, position.
    if (method === 'PATCH') {
      const body = (await readJsonBody<{ title?: unknown; status?: unknown; position?: unknown }>(req)) ?? {};
      const data: { title?: string; status?: string; position?: number } = {};
      if (body.title !== undefined) {
        const title = readText(body.title, TITLE_MAX);
        if (!title) {
          json(res, 400, { error: "Donne un titre à l'élément." });
          return true;
        }
        data.title = title;
      }
      if (body.status !== undefined) {
        if (!isDoingListStatus(body.status)) {
          json(res, 400, { error: 'Statut inconnu.' });
          return true;
        }
        data.status = body.status;
      }
      if (typeof body.position === 'number' && Number.isInteger(body.position) && body.position >= 0) {
        data.position = body.position;
      }
      const item = await prisma.doingListItem.update({ where: { id: itemId }, data });
      json(res, 200, { item });
      return true;
    }

    // DELETE /doing-lists/:id/items/:itemId : retire l'élément, pas sa source.
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
