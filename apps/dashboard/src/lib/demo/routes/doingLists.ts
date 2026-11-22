/**
 * Listes de suivi façon Trello : deux tableaux, leurs étapes et leurs cartes,
 * attribuées à l'équipe de la démo. Formes de `routes/dashboard/doingLists.ts`.
 */
import { DOING_LIST_MODULES } from '@kotbo/contracts';
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { G } from '../crud';
import { DAY, ME, ago } from '../fixtures';
import { staffMembers } from './home';

type Column = { id: string; listId: string; name: string; position: number; wipLimit: number | null; isDone: boolean };
type Item = Record<string, any> & { id: string; listId: string; columnId: string; number: number; title: string; position: number };
type Board = { lists: Array<{ id: string; name: string; key: string; description: string | null; modules: string[]; createdAt: string }>; columns: Column[]; items: Item[]; events: Record<string, any[]> };

const assignee = (username: string) => {
  const m = staffMembers().find((s) => s.username === username) ?? staffMembers()[0];
  return { id: m.id, userId: m.userId, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl };
};

function seed(): Board {
  const col = (id: string, listId: string, name: string, position: number, extra: Partial<Column> = {}): Column => ({ id, listId, name, position, wipLimit: null, isDone: false, ...extra });
  let n = 0;
  const item = (listId: string, columnId: string, title: string, extra: Record<string, unknown> = {}): Item => {
    n += 1;
    return {
      id: `dli-${n}`, listId, columnId, title, position: n, number: n, type: 'TASK', estimate: null, parentId: null, description: null,
      priority: null, dueDate: null, labels: [], checklist: [], sourceModule: null, sourceId: null, staffTaskId: null, staffTask: null,
      _count: { events: 0 }, createdAt: ago((20 - n) * DAY), ...extra,
    };
  };
  const task = (username: string, status = 'IN_PROGRESS') => ({ staffTaskId: `st-${username}`, staffTask: { id: `st-${username}`, status, assignee: assignee(username) } });
  return {
    lists: [
      { id: 'dl-1', name: 'Projets du serveur', key: 'NOVA', description: 'Ce que le staff prépare pour la communauté.', modules: ['suggestions'], createdAt: ago(40 * DAY) },
      { id: 'dl-2', name: 'Support', key: 'SUP', description: 'Tickets qui demandent un suivi.', modules: ['tickets'], createdAt: ago(20 * DAY) },
    ],
    columns: [
      col('c-1', 'dl-1', 'Idées', 0),
      col('c-2', 'dl-1', 'À faire', 1),
      col('c-3', 'dl-1', 'En cours', 2, { wipLimit: 3 }),
      col('c-4', 'dl-1', 'Terminé', 3, { isDone: true }),
      col('c-5', 'dl-2', 'Nouveau', 0),
      col('c-6', 'dl-2', 'En attente du membre', 1),
      col('c-7', 'dl-2', 'Résolu', 2, { isDone: true }),
    ],
    items: [
      item('dl-1', 'c-1', 'Salon pour partager nos clips', { type: 'STORY', labels: ['communauté'], sourceModule: 'suggestions', sourceId: 'sugg-2' }),
      item('dl-1', 'c-1', 'Soirée karaoké mensuelle', { labels: ['événement'] }),
      item('dl-1', 'c-2', 'Préparer le bracket du tournoi d’automne', { priority: 'HIGH', dueDate: ago(-5 * DAY), labels: ['événement'], ...task('zenox', 'TODO'),
        checklist: [{ id: 'ck1', text: 'Fermer les inscriptions', done: false }, { id: 'ck2', text: 'Tirer les poules', done: false }] }),
      item('dl-1', 'c-3', 'Refaire la page d’accueil du site', { priority: 'MEDIUM', type: 'EPIC', ...task('lena') }),
      item('dl-1', 'c-3', 'Nouveaux emojis du serveur', { ...task('lina'), _count: { events: 3 } }),
      item('dl-1', 'c-4', 'Ouvrir la boutique', { labels: ['économie'], ...task('arka', 'DONE') }),
      item('dl-2', 'c-5', 'Remboursement d’un achat en boutique', { priority: 'HIGH', sourceModule: 'tickets', sourceId: 'ticket-3', ...task('kylian') }),
      item('dl-2', 'c-6', 'Bug : rôle Habitué non attribué', { type: 'BUG', sourceModule: 'tickets', sourceId: 'ticket-5', ...task('aiden') }),
      item('dl-2', 'c-7', 'Changement de pseudo refusé', { sourceModule: 'tickets', sourceId: 'ticket-8' }),
    ],
    events: {
      'dli-5': [
        { id: 'ev-1', actorId: ME.id, actorName: 'Toi', kind: 'created', body: null, data: null, createdAt: ago(9 * DAY), updatedAt: ago(9 * DAY) },
        { id: 'ev-2', actorId: assignee('lina').userId, actorName: 'Lina', kind: 'comment', body: 'J’ai fait 6 propositions, je les poste ce soir 🎨', data: null, createdAt: ago(2 * DAY), updatedAt: ago(2 * DAY) },
        { id: 'ev-3', actorId: ME.id, actorName: 'Toi', kind: 'moved', body: null, data: { from: 'À faire', to: 'En cours' }, createdAt: ago(DAY), updatedAt: ago(DAY) },
      ],
    },
  };
}

const KEY = 'doing-lists';
const board = () => demoDb.get(KEY, seed);
const save = (next: Board) => demoDb.set(KEY, next);

const counts = (b: Board, listId: string) => {
  const done = new Set(b.columns.filter((c) => c.isDone).map((c) => c.id));
  const items = b.items.filter((i) => i.listId === listId);
  return { total: items.length, done: items.filter((i) => done.has(i.columnId)).length };
};
const ref = (b: Board, i: Item) => {
  const list = b.lists.find((l) => l.id === i.listId);
  return { id: i.id, listId: i.listId, key: `${list?.key ?? 'X'}-${i.number}`, title: i.title, type: i.type, done: !!b.columns.find((c) => c.id === i.columnId)?.isDone };
};
const columnsOf = (b: Board, listId: string) => b.columns.filter((c) => c.listId === listId).sort((a, z) => a.position - z.position).map(({ listId: _l, ...c }) => c);

export function registerDoingListRoutes(): void {
  const base = `${G}/doing-lists`;
  route('GET', base, () => {
    const b = board();
    return { lists: b.lists.map((l) => ({ ...l, counts: counts(b, l.id) })), modules: DOING_LIST_MODULES };
  });
  route('GET', `${base}/assignees`, () => ({ members: staffMembers().map((m) => assignee(m.username)) }));
  route('GET', `${base}/search`, ({ query }) => {
    const q = (query.get('q') ?? '').toLowerCase();
    const b = board();
    return { items: b.items.filter((i) => i.title.toLowerCase().includes(q)).slice(0, 10).map((i) => ref(b, i)) };
  });
  route('GET', `${base}/for/:source`, ({ params }) => {
    const b = board();
    return { lists: b.lists.filter((l) => l.modules.includes(params.source)).map((l) => ({ id: l.id, name: l.name })), items: b.items.filter((i) => i.sourceModule === params.source).map((i) => ({ id: i.id, listId: i.listId, sourceId: i.sourceId })) };
  });
  route('POST', base, ({ body }) => {
    const b = board();
    const id = demoId();
    const list = { id, name: body?.name ?? 'Nouvelle liste', key: (body?.key ?? 'NEW').toUpperCase(), description: body?.description ?? null, modules: body?.modules ?? [], createdAt: new Date().toISOString() };
    const names: string[] = body?.columns?.length ? body.columns : ['À faire', 'En cours', 'Terminé'];
    save({ ...b, lists: [...b.lists, list], columns: [...b.columns, ...names.map((name, i) => ({ id: demoId() + i, listId: id, name, position: i, wipLimit: null, isDone: i === names.length - 1 }))] });
    return { list: { ...list, counts: { total: 0, done: 0 } } };
  });
  route('GET', `${base}/:listId`, ({ params }) => {
    const b = board();
    const list = b.lists.find((l) => l.id === params.listId);
    if (!list) return new Response(JSON.stringify({ error: 'Liste introuvable.' }), { status: 404 });
    return { list, columns: columnsOf(b, list.id), items: b.items.filter((i) => i.listId === list.id).sort((a, z) => a.position - z.position), links: [] };
  });
  route('PATCH', `${base}/:listId`, ({ params, body }) => {
    const b = board();
    let list: unknown;
    save({ ...b, lists: b.lists.map((l) => (l.id === params.listId ? (list = { ...l, ...(body ?? {}) }) as typeof l : l)) });
    return { list };
  });
  route('DELETE', `${base}/:listId`, ({ params }) => {
    const b = board();
    save({ ...b, lists: b.lists.filter((l) => l.id !== params.listId), items: b.items.filter((i) => i.listId !== params.listId) });
    return { ok: true };
  });

  route('PUT', `${base}/:listId/columns/order`, ({ params, body }) => {
    const b = board();
    const ids: string[] = body?.ids ?? body?.order ?? [];
    const next = { ...b, columns: b.columns.map((c) => (c.listId === params.listId && ids.includes(c.id) ? { ...c, position: ids.indexOf(c.id) } : c)) };
    save(next);
    return { columns: columnsOf(next, params.listId) };
  });
  route('POST', `${base}/:listId/columns`, ({ params, body }) => {
    const b = board();
    const column: Column = { id: demoId(), listId: params.listId, name: body?.name ?? 'Nouvelle étape', position: columnsOf(b, params.listId).length, wipLimit: body?.wipLimit ?? null, isDone: !!body?.isDone };
    save({ ...b, columns: [...b.columns, column] });
    const { listId: _l, ...rest } = column;
    return { column: rest };
  });
  route('PATCH', `${base}/:listId/columns/:columnId`, ({ params, body }) => {
    const b = board();
    let column: unknown;
    save({ ...b, columns: b.columns.map((c) => (c.id === params.columnId ? (column = { ...c, ...(body ?? {}) }) as Column : c)) });
    return { column };
  });
  route('DELETE', `${base}/:listId/columns/:columnId`, ({ params, query }) => {
    const b = board();
    const moveTo = query.get('moveTo');
    save({ ...b, columns: b.columns.filter((c) => c.id !== params.columnId), items: b.items.map((i) => (i.columnId === params.columnId && moveTo ? { ...i, columnId: moveTo } : i)).filter((i) => i.columnId !== params.columnId) });
    return { ok: true };
  });

  route('POST', `${base}/:listId/items`, ({ params, body }) => {
    const b = board();
    const number = Math.max(0, ...b.items.map((i) => i.number)) + 1;
    const firstColumn = columnsOf(b, params.listId)[0]?.id;
    const item: Item = {
      ...seed().items[1], id: demoId(), listId: params.listId, columnId: body?.columnId ?? firstColumn, number, position: number, title: body?.title ?? 'Nouvelle carte',
      labels: [], checklist: [], staffTask: null, staffTaskId: null, sourceModule: body?.sourceModule ?? null, sourceId: body?.sourceId ?? null, _count: { events: 0 }, createdAt: new Date().toISOString(), ...(body ?? {}),
    };
    save({ ...b, items: [...b.items, item] });
    return { item };
  });
  route('PATCH', `${base}/:listId/items/:itemId`, ({ params, body }) => {
    const b = board();
    let item: Item | undefined;
    const patch = { ...(body ?? {}) };
    if ('assigneeId' in patch) {
      const who = staffMembers().find((m) => m.id === patch.assigneeId);
      patch.staffTask = who ? { id: `st-${who.username}`, status: 'TODO', assignee: assignee(who.username) } : null;
      delete patch.assigneeId;
    }
    save({ ...b, items: b.items.map((i) => (i.id === params.itemId ? (item = { ...i, ...patch }) : i)) });
    return { item };
  });
  route('DELETE', `${base}/:listId/items/:itemId`, ({ params }) => {
    const b = board();
    save({ ...b, items: b.items.filter((i) => i.id !== params.itemId) });
    return { ok: true };
  });
  route('GET', `${base}/:listId/items/:itemId/events`, ({ params }) => ({ events: board().events[params.itemId] ?? [], links: [] }));
  route('POST', `${base}/:listId/items/:itemId/comments`, ({ params, body }) => {
    const b = board();
    const now = new Date().toISOString();
    const event = { id: demoId(), actorId: ME.id, actorName: 'Toi', kind: 'comment', body: body?.body ?? body?.text ?? '', data: null, createdAt: now, updatedAt: now };
    save({ ...b, events: { ...b.events, [params.itemId]: [...(b.events[params.itemId] ?? []), event] } });
    return { event };
  });
  route('PATCH', `${base}/:listId/items/:itemId/comments/:eventId`, ({ params, body }) => {
    const b = board();
    let event: unknown;
    save({ ...b, events: { ...b.events, [params.itemId]: (b.events[params.itemId] ?? []).map((e) => (e.id === params.eventId ? (event = { ...e, body: body?.body ?? body?.text ?? e.body }) : e)) } });
    return { event };
  });
  route('DELETE', `${base}/:listId/items/:itemId/comments/:eventId`, ({ params }) => {
    const b = board();
    save({ ...b, events: { ...b.events, [params.itemId]: (b.events[params.itemId] ?? []).filter((e) => e.id !== params.eventId) } });
    return { ok: true };
  });
  route('POST', `${base}/:listId/items/:itemId/links`, ({ params, body }) => {
    const b = board();
    const from = b.items.find((i) => i.id === params.itemId);
    const to = b.items.find((i) => i.id === body?.toId);
    return { link: from && to ? { id: demoId(), type: body?.type ?? 'RELATES', from: ref(b, from), to: ref(b, to) } : null };
  });
  route('DELETE', `${base}/:listId/items/:itemId/links/:linkId`, () => ({ ok: true }));
}
