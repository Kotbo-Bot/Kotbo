/**
 * Le faux back-end de la démo : un `fetch` qui répond à la place de l'API.
 *
 * Les routes sont déclarées par domaine dans `demo/routes/`, avec le même
 * chemin que côté bot. Une route de lecture rend les données de démo, une
 * route d'écriture modifie la mémoire locale (`demo/db.ts`) puis rend ce que
 * l'API aurait rendu.
 *
 * Toute route non déclarée reçoit un fallback sandbox :
 *   - GET  → structure vide reconnue par les pages (liste, objet, null).
 *   - Mutations → succès 200 silencieux pour que les boutons ne restent pas bloqués.
 * La liste des routes manquantes est enregistrée dans `window.__kotboDemoMisses`
 * pour faciliter la complétion future de la démo.
 */
import { DEMO_BASE } from './mode';

export type DemoRequest = {
  method: string;
  /** Chemin à partir de `/api`, sans la requête : `/api/dashboard/guilds/…`. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
};

export type DemoHandler = (req: DemoRequest) => unknown;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: DemoHandler };

const routes: Route[] = [];

/** Message rendu par une route absente de la démo (conservé pour compatibilité). */
export const DEMO_UNAVAILABLE =
  "Cette partie du dashboard n'est pas incluse dans la démo. Elle fonctionne une fois Kotbo ajouté à ton serveur.";

/**
 * Déclare une route. `path` suit la syntaxe des routes du bot : `:nom` pour un
 * segment variable, `*` en fin pour « tout ce qui suit ».
 */
export function route(method: string, path: string, handler: DemoHandler): void {
  const keys: string[] = [];
  const source = path
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*$/, '(?:/.*)?')
    .replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
  routes.push({ method: method.toUpperCase(), pattern: new RegExp(`^${source}/?$`), keys, handler });
  // Les routes à segments fixes passent avant les routes à paramètre, quel que soit
  // l'ordre de déclaration : `/tickets/macros` ne doit pas tomber sur `/tickets/:ticketId`.
  routes.sort((a, b) => a.keys.length - b.keys.length);
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Routes demandées sans réponse : la liste sert à compléter la démo, elle n'est jamais envoyée. */
const misses = new Set<string>();

function remember(method: string, path: string): void {
  const key = `${method} ${path.replace(/\d{17,19}/g, ':id')}`;
  if (misses.has(key)) return;
  misses.add(key);
  (window as unknown as { __kotboDemoMisses?: string[] }).__kotboDemoMisses = [...misses];
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<any> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // FormData, Blob : la démo ne lit pas les fichiers envoyés.
  return null;
}

/**
 * Réponse GET de repli : retourne une structure vide que les pages savent gérer.
 * On devine la forme attendue à partir du dernier segment du chemin.
 */
function fallbackGet(path: string): unknown {
  const seg = path.split('/').filter(Boolean).pop() ?? '';
  // Suffixes pluriels ou clés de liste → { <seg>: [] } ou { items: [] }
  if (
    /^(members|items|events|players|logs|templates|presets|results|submissions|channels|roles|servers|guilds|bots|runs|history|list|tickets|sanctions|backups|campaigns|clans|drops|giveaways|invitations|meetings|calls|workflows|executions|quests|anomalies|alerts|reviews|evaluations|absences|links|networks|problems|weeks)$/.test(
      seg,
    )
  ) {
    return { [seg]: [] };
  }
  // Endpoints de statistiques courantes
  if (/^(analytics|stats|metrics|overview|summary)$/.test(seg)) {
    return { hasData: false };
  }
  // Statuts booléens
  if (/^(status|enabled|active)$/.test(seg)) return { enabled: false };
  // config, settings, widget, etc. → objet vide
  return {};
}

async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const apiIndex = url.pathname.indexOf('/api/');
  const path = url.pathname.slice(apiIndex);

  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    candidate.keys.forEach((key, index) => (params[key] = decodeURIComponent(match[index + 1])));
    try {
      const result = await candidate.handler({
        method,
        path,
        params,
        query: url.searchParams,
        body: await readBody(input, init),
      });
      if (result instanceof Response) return result;
      return json(result === undefined ? 204 : 200, result);
    } catch (err) {
      console.error('[démo] la route a échoué', method, path, err);
      return json(500, { error: "La démo n'a pas pu traiter cette action." });
    }
  }

  remember(method, path);

  // Fallback sandbox : aucun 503 bloquant.
  if (method === 'GET') return json(200, fallbackGet(path));
  return json(200, {});
}

/** L'appel vise-t-il l'API ? Tout le reste (images, polices, modules) part au réseau. */
function isApiCall(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : String(input);
  return raw.includes('/api/');
}

/**
 * Remplace `fetch`. Appelé avant tout autre module : la session est lue dès
 * l'import du store d'authentification, avant même le montage de l'App.
 */
export function installDemoBackend(): void {
  const network = window.fetch.bind(window);
  // Cast : sous bun-types (tests), `typeof fetch` réclame `preconnect`, propre à Bun.
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    isApiCall(input) ? handle(input, init) : network(input, init)) as typeof fetch;
}
