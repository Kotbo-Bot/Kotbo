/**
 * Une collection de démo : liste, création, modification et suppression sur la
 * mémoire locale, en une déclaration.
 *
 * Sert aux modules dont l'API suit le schéma REST habituel du bot
 * (`GET /x`, `POST /x`, `PATCH|PUT /x/:id`, `DELETE /x/:id`). Une création faite
 * dans la démo revient donc à la lecture suivante, au lieu de disparaître.
 */
import { route, type DemoRequest } from './backend';
import { demoDb, demoId } from './db';

/** Préfixe commun des routes d'un serveur. */
export const G = '/api/dashboard/guilds/:guildId';

type Item = { id: string } & Record<string, any>;

export type CollectionOptions<T extends Item> = {
  /** Chemin sous le serveur, par exemple `/backups`. */
  path: string;
  /** Clé de la mémoire locale. */
  key: string;
  seed: () => T[];
  /** Clé de la liste dans la réponse (`{ backups: [...] }`). `null` rend le tableau nu. */
  listKey: string | null;
  /** Clé de l'élément dans les réponses d'écriture (`{ backup: {...} }`). `null` rend l'élément nu. */
  itemKey?: string | null;
  /** Complète un élément créé : valeurs par défaut que l'API aurait posées. */
  create?: (body: any, req: DemoRequest) => Omit<T, 'id'> & Partial<Pick<T, 'id'>>;
  /** Champs ajoutés à la réponse de liste (`total`, `stats`…). */
  extra?: (items: T[], req: DemoRequest) => Record<string, unknown>;
  /** Méthode de modification déclarée : PATCH, PUT ou les deux. */
  update?: Array<'PATCH' | 'PUT'>;
  /** Ne déclare pas la lecture d'un élément seul (`GET /x/:id`). */
  noGetOne?: boolean;
};

export type DemoCollection<T extends Item> = {
  all: () => T[];
  find: (id: string) => T | undefined;
  save: (items: T[]) => T[];
  patch: (id: string, change: Partial<T> | ((item: T) => T)) => T | undefined;
};

export function collection<T extends Item>(options: CollectionOptions<T>): DemoCollection<T> {
  const { path, key, seed, listKey } = options;
  const itemKey = options.itemKey === undefined ? null : options.itemKey;
  const all = () => demoDb.get<T[]>(key, seed);
  const save = (items: T[]) => demoDb.set(key, items);
  const wrap = (item: T | undefined) => (itemKey ? { success: true, [itemKey]: item } : { success: true, ...item });
  const find = (id: string) => all().find((item) => item.id === id);
  const patch = (id: string, change: Partial<T> | ((item: T) => T)) => {
    let next: T | undefined;
    save(
      all().map((item) => {
        if (item.id !== id) return item;
        next = typeof change === 'function' ? change(item) : { ...item, ...change, updatedAt: new Date().toISOString() };
        return next;
      }),
    );
    return next;
  };

  route('GET', `${G}${path}`, (req) => {
    const items = all();
    const extra = options.extra?.(items, req) ?? {};
    return listKey ? { [listKey]: items, ...extra } : items;
  });

  if (!options.noGetOne) {
    route('GET', `${G}${path}/:itemId`, ({ params }) => {
      const item = find(params.itemId);
      if (!item) return new Response(JSON.stringify({ error: 'Introuvable dans la démo.' }), { status: 404 });
      return itemKey ? { [itemKey]: item } : item;
    });
  }

  route('POST', `${G}${path}`, (req) => {
    const now = new Date().toISOString();
    const base = options.create ? options.create(req.body ?? {}, req) : { ...(req.body ?? {}) };
    const item = { createdAt: now, updatedAt: now, ...base, id: (base as Item).id ?? demoId() } as unknown as T;
    save([item, ...all()]);
    return wrap(item);
  });

  for (const method of options.update ?? ['PATCH', 'PUT']) {
    route(method, `${G}${path}/:itemId`, ({ params, body }) => wrap(patch(params.itemId, body ?? {})));
  }

  route('DELETE', `${G}${path}/:itemId`, ({ params }) => {
    save(all().filter((item) => item.id !== params.itemId));
    return { success: true };
  });

  return { all, find, save, patch };
}

/** Document unique (config d'un module) : `GET` le rend, `PATCH|PUT` le fusionne. */
export function singleton<T extends Record<string, any>>(options: {
  path: string;
  key: string;
  seed: () => T;
  /** Clé de l'objet dans la réponse (`{ config: {...} }`). `null` rend l'objet nu. */
  wrapKey: string | null;
  /** Champs ajoutés à la réponse de lecture. */
  extra?: () => Record<string, unknown>;
  methods?: Array<'PATCH' | 'PUT' | 'POST'>;
}) {
  const get = () => demoDb.get<T>(options.key, options.seed);
  const respond = (value: T) => (options.wrapKey ? { [options.wrapKey]: value, ...(options.extra?.() ?? {}) } : { ...value, ...(options.extra?.() ?? {}) });
  route('GET', `${G}${options.path}`, () => respond(get()));
  for (const method of options.methods ?? ['PATCH', 'PUT']) {
    route(method, `${G}${options.path}`, ({ body }) => {
      const patch = options.wrapKey && body?.[options.wrapKey] && typeof body[options.wrapKey] === 'object' ? body[options.wrapKey] : body;
      const next = demoDb.update(options.key, options.seed, (current) => ({ ...current, ...(patch ?? {}) }));
      return { success: true, ...respond(next) };
    });
  }
  return { get, set: (value: T) => demoDb.set(options.key, value) };
}
