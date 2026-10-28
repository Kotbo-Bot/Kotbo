/**
 * Listes de suivi : un élément ne s'épingle que depuis un module relié à la
 * liste et seulement s'il appartient au serveur, une étape pleine refuse une
 * carte de plus, attribuer une carte la pose dans le planning, et l'écriture
 * suit le droit de la section, pas le seul droit de configuration.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import type { Client } from 'discord.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims, type DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';

type Column = { id: string; name: string; position: number; wipLimit: number | null; isDone: boolean };

let listRow: { id: string; guildId: string; name: string; modules: string[] } | null = null;
let ticketRow: { reason: string; username: string } | null = null;
let columnRows: Column[] = [];
let itemCount = 0;
let itemRow: Record<string, unknown> | null = null;
// Autres cartes du serveur, par identifiant (cible d'un lien, parente).
let otherRows: Record<string, Record<string, unknown>> = {};
let existingLink: { id: string } | null = null;
let featureRights: Record<string, { canView: boolean; canModerate: boolean; canConfigure: boolean; canDelete: boolean }> = {};

const createItem = mock(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'item-1', ...data }));
const updateItem = mock(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'item-1', ...data }));
const updateTask = mock(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'task-1', ...data }));
const createTask = mock(async () => ({ id: 'task-1' }));
const createLink = mock(async ({ data }: { data: Record<string, unknown> }) => ({
  id: 'link-1',
  type: data.type,
  from: refRow(data.fromId as string),
  to: refRow(data.toId as string),
}));
const findRow = (id?: string) => (id === 'item-1' ? itemRow : id ? otherRows[id] ?? null : null);
function refRow(id: string) {
  return { id, listId: 'list-1', number: 1, title: id, type: 'TASK', list: { key: 'BOUT' }, column: { isDone: false } };
}
const mockDb: Record<string, unknown> = {
  doingList: { findFirst: mock(async () => listRow), update: mock(async () => ({ nextNumber: 8 })) },
  doingListColumn: { findMany: mock(async () => columnRows) },
  doingListItem: {
    count: mock(async () => itemCount),
    findFirst: mock(async ({ where }: { where: { id?: string } }) => findRow(where.id)),
    findUnique: mock(async ({ where }: { where: { id?: string } }) => findRow(where.id)),
    findMany: mock(async () => []),
    findUniqueOrThrow: mock(async () => itemRow),
    create: createItem,
    update: updateItem,
  },
  doingListEvent: { create: mock(async () => ({})) },
  doingListItemLink: { findFirst: mock(async () => existingLink), count: mock(async () => 0), create: createLink },
  staffMember: { findFirst: mock(async ({ where }: { where: { id: string } }) => (where.id === 'staff-2' ? { id: 'staff-2' } : null)) },
  staffTask: { update: updateTask, delete: mock(async () => ({})) },
  ticket: { findFirst: mock(async () => ticketRow) },
  suggestion: { findFirst: mock(async () => null) },
  dashboardAuditLog: { create: mock(async () => ({})) },
};
mockDb.$transaction = mock(async (run: (tx: unknown) => unknown) => run(mockDb));

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
}

const featureGatePath = path.resolve(__dirname, '../../api/routes/dashboard/featureGate.ts');
for (const suffix of ['../../api/routes/dashboard/featureGate.ts', '../../api/routes/dashboard/featureGate.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(featureGatePath, {
    getCachedFeatureAccess: mock(async () => featureRights),
  }));
}

const leadershipPath = path.resolve(__dirname, '../../services/staff/staffLeadershipService.ts');
for (const suffix of ['../../services/staff/staffLeadershipService.ts', '../../services/staff/staffLeadershipService.js']) {
  mock.module(path.resolve(__dirname, suffix), () => completeModuleMock(leadershipPath, { createTask }));
}

const { handleDoingListRoutes } = await import('../../api/routes/dashboard/doingLists.js');
const { columnForTaskStatus, taskStatusForColumn } = await import('../../services/staff/doingListTaskSync.js');

function request(method: string, body: Record<string, unknown>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

function response(): ServerResponse & { body: string } {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as ServerResponse & { body: string };
  res.setHeader = () => res;
  res.writeHead = (code: number) => { res.statusCode = code; return res; };
  res.end = (chunk?: unknown) => { res.body = chunk ? String(chunk) : ''; return res; };
  return res;
}

const client = { guilds: { cache: new Map() } } as unknown as Client;
const user: AuthClaims = { userId: 'user-1', username: 'Staff' };
const moderatorAccess = { ...DASHBOARD_ACCESS_ADMIN, canManageSettings: false } as DashboardAccess;
const itemsPath = ['api', 'dashboard', 'guilds', 'guild-1', 'doing-lists', 'list-1', 'items'];
const pin = { sourceModule: 'tickets', sourceId: 'ticket-1' };
const BOARD: Column[] = [
  { id: 'col-todo', name: 'À faire', position: 0, wipLimit: null, isDone: false },
  { id: 'col-doing', name: 'En cours', position: 1, wipLimit: null, isDone: false },
  { id: 'col-done', name: 'Terminé', position: 2, wipLimit: null, isDone: true },
];

async function call(access: DashboardAccess, body: Record<string, unknown>, method = 'POST', route = itemsPath) {
  const res = response();
  await handleDoingListRoutes(request(method, body), res, route, new URL('http://x'), client, user, 'guild-1', access);
  return res;
}

beforeEach(() => {
  listRow = { id: 'list-1', guildId: 'guild-1', name: 'Projet', modules: ['tickets'] };
  ticketRow = { reason: 'Bug boutique', username: 'alice' };
  columnRows = BOARD.map((column) => ({ ...column }));
  itemCount = 0;
  itemRow = null;
  otherRows = {};
  existingLink = null;
  featureRights = {};
  for (const fn of [createItem, updateItem, updateTask, createTask, createLink]) fn.mockClear();
});

describe('épingler un élément', () => {
  test("reprend le titre de la source et l'épingle dans la première étape", async () => {
    const res = await call(DASHBOARD_ACCESS_ADMIN, pin);
    expect(res.statusCode).toBe(201);
    // Numéro réservé sur la liste : nextNumber passait de 7 à 8.
    expect(createItem.mock.calls[0][0].data).toMatchObject({ title: 'Bug boutique (alice)', sourceModule: 'tickets', sourceId: 'ticket-1', columnId: 'col-todo', number: 7 });
  });

  test("refuse un module que la liste ne relie pas", async () => {
    listRow = { ...listRow!, modules: ['suggestions'] };
    expect((await call(DASHBOARD_ACCESS_ADMIN, pin)).statusCode).toBe(400);
    expect(createItem).not.toHaveBeenCalled();
  });

  test("refuse un ticket d'un autre serveur", async () => {
    ticketRow = null;
    expect((await call(DASHBOARD_ACCESS_ADMIN, pin)).statusCode).toBe(404);
    expect(createItem).not.toHaveBeenCalled();
  });

  test('refuse une carte de plus dans une étape pleine', async () => {
    columnRows[0].wipLimit = 2;
    itemCount = 2;
    const res = await call(DASHBOARD_ACCESS_ADMIN, { title: 'Nouvelle' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('pleine');
    expect(createItem).not.toHaveBeenCalled();
  });
});

describe('attribution', () => {
  const itemPath = [...itemsPath, 'item-1'];

  test('attribuer une carte crée sa tâche dans le planning de la personne', async () => {
    itemRow = { id: 'item-1', listId: 'list-1', guildId: 'guild-1', columnId: 'col-doing', title: 'Refaire la boutique', description: null, priority: null, dueDate: null, sourceModule: null, staffTaskId: null };
    const res = await call(DASHBOARD_ACCESS_ADMIN, { assigneeId: 'staff-2' }, 'PATCH', itemPath);
    expect(res.statusCode).toBe(200);
    expect(createTask.mock.calls[0]).toMatchObject(['guild-1', 'user-1', 'Refaire la boutique', null, 'MEDIUM', null, 'staff-2', 'staff-2']);
    expect(updateItem.mock.calls.some(([arg]) => arg.data.staffTaskId === 'task-1')).toBe(true);
    // La carte est en cours : sa tâche aussi.
    expect(updateTask.mock.calls.at(-1)?.[0].data).toMatchObject({ status: 'IN_PROGRESS' });
  });

  test("refuse d'attribuer à quelqu'un hors du staff", async () => {
    itemRow = { id: 'item-1', columnId: 'col-todo', title: 'X', sourceModule: null, staffTaskId: null };
    expect((await call(DASHBOARD_ACCESS_ADMIN, { assigneeId: 'inconnu' }, 'PATCH', itemPath)).statusCode).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('liens et sous-tâches', () => {
  const itemPath = [...itemsPath, 'item-1'];
  const base = { id: 'item-1', listId: 'list-1', guildId: 'guild-1', columnId: 'col-todo', title: 'A', sourceModule: null, staffTaskId: null, parentId: null };

  test("« est bloquée par » enregistre le lien depuis la carte qui bloque", async () => {
    itemRow = { ...base };
    otherRows = { 'item-2': refRow('item-2') };
    const res = await call(DASHBOARD_ACCESS_ADMIN, { type: 'BLOCKS', targetId: 'item-2', inward: true }, 'POST', [...itemPath, 'links']);
    expect(res.statusCode).toBe(201);
    expect(createLink.mock.calls[0][0].data).toMatchObject({ fromId: 'item-2', toId: 'item-1', type: 'BLOCKS' });
  });

  test("refuse un lien vers soi-même et un lien qui existe déjà", async () => {
    itemRow = { ...base };
    otherRows = { 'item-1': refRow('item-1'), 'item-2': refRow('item-2') };
    expect((await call(DASHBOARD_ACCESS_ADMIN, { type: 'RELATES', targetId: 'item-1' }, 'POST', [...itemPath, 'links'])).statusCode).toBe(400);
    existingLink = { id: 'link-0' };
    expect((await call(DASHBOARD_ACCESS_ADMIN, { type: 'RELATES', targetId: 'item-2' }, 'POST', [...itemPath, 'links'])).statusCode).toBe(409);
    expect(createLink).not.toHaveBeenCalled();
  });

  test("refuse de faire d'une carte la sous-tâche de sa propre sous-tâche", async () => {
    itemRow = { ...base };
    // item-3 est la sous-tâche de item-1 : item-1 ne peut pas passer sous item-3.
    otherRows = { 'item-3': { id: 'item-3', parentId: 'item-1' } };
    const res = await call(DASHBOARD_ACCESS_ADMIN, { parentId: 'item-3' }, 'PATCH', itemPath);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('sous-tâche');
  });
});

describe('étapes et avancement des tâches', () => {
  test("l'étape donne le statut de la tâche", () => {
    expect(taskStatusForColumn(BOARD, 'col-todo')).toBe('PENDING');
    expect(taskStatusForColumn(BOARD, 'col-doing')).toBe('IN_PROGRESS');
    expect(taskStatusForColumn(BOARD, 'col-done')).toBe('COMPLETED');
  });

  test('le statut de la tâche ramène la carte dans la bonne étape', () => {
    expect(columnForTaskStatus(BOARD, 'PENDING')).toBe('col-todo');
    expect(columnForTaskStatus(BOARD, 'IN_PROGRESS')).toBe('col-doing');
    expect(columnForTaskStatus(BOARD, 'COMPLETED')).toBe('col-done');
    expect(columnForTaskStatus(BOARD.filter((column) => !column.isDone), 'COMPLETED')).toBeNull();
  });
});

describe('droits', () => {
  test('un modérateur de la section peut épingler sans droit de configuration', async () => {
    featureRights = { doing_lists: { canView: true, canModerate: true, canConfigure: false, canDelete: false } };
    expect((await call(moderatorAccess, pin)).statusCode).toBe(201);
  });

  test('un simple lecteur ne peut pas', async () => {
    featureRights = { doing_lists: { canView: true, canModerate: false, canConfigure: false, canDelete: false } };
    expect((await call(moderatorAccess, pin)).statusCode).toBe(403);
    expect(createItem).not.toHaveBeenCalled();
  });
});
