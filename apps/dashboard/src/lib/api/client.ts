/**
 * Socle HTTP du dashboard : resolution de la guilde courante, appel
 * authentifie, delai borne, rejeu des pannes passageres et gestion uniforme
 * des erreurs.
 *
 * Les modules de domaine de ce dossier s appuient tous sur dashboardRequest
 * (reponse JSON, leve en cas d echec) ou dashboardMutation (booleen, ne leve
 * pas). L API publique est reexportee par ./index.ts.
 *
 * Qui annonce quoi
 * ----------------
 * dashboardRequest **n'affiche aucun toast**. Il leve une DashboardApiError et
 * rend la main : l'appelant qui attrape l'erreur en dit ce qu'il veut, dans les
 * mots de sa page. Celui qui ne l'attrape pas laisse la rejection remonter, et
 * le filet global d'App.svelte affiche le message de categorie.
 *
 * Avant, le socle toastait *et* levait : les quelque trois cents blocs `catch`
 * de l'application ajoutaient leur propre message, et l'utilisateur voyait deux
 * bulles pour un seul echec. Le succes souffrait du meme defaut, « Operation
 * reussie » se superposant au message metier de la page.
 *
 * dashboardMutation, lui, avale l'erreur et rend un booleen : comme rien ne
 * remonte, c'est lui qui annonce l'echec.
 */
import { authStore } from '../stores/auth.svelte';
import { backendHealth } from '../stores/backendHealth.svelte';
import { toast } from '../stores/toast.svelte';
import { captureApiFailure } from '../sentry';
import { trackApiResult } from '../telemetry/telemetry';
import { m } from '../i18n';
import {
  DashboardApiError,
  isDashboardApiError,
  kindFromNetworkError,
  kindFromStatus,
  parseRetryAfter,
} from './errors';

export {
  DashboardApiError,
  isDashboardApiError,
  type ApiErrorKind,
} from './errors';

const envApiUrl = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/$/, '');

function getBrowserOrigin() {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return '';
}

export const API_BASE_URL = envApiUrl;
const wsBaseUrl = API_BASE_URL
  ? API_BASE_URL.replace(/^http/i, 'ws')
  : getBrowserOrigin().replace(/^http/i, 'ws');
export const DASHBOARD_WS_URL = `${wsBaseUrl}/api/dashboard/ws`;
export const BASE_URL = `${API_BASE_URL}/api/dashboard`;
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Delai au bout duquel on cesse d'attendre une reponse.
 *
 * Sans borne, un backend qui accepte la connexion mais ne repond plus (base
 * saturee, worker bloque) laissait un ecran en chargement indefiniment : rien
 * n'echouait jamais, donc rien ne s'affichait ni ne pouvait etre retente.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Certaines routes agregent et calculent : elles ont droit a plus de temps. */
const SLOW_ROUTE_TIMEOUT_MS = 45_000;
const SLOW_ROUTE_HINTS = ['/analytics', '/stats', '/export', '/backfill', '/audit'];

/** Methodes rejouables sans risque : les repeter ne change rien au serveur. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Tentatives supplementaires accordees a une requete rejouable. */
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 4_000;

function timeoutForPath(path: string, override?: number): number {
  if (override !== undefined) return override;
  return SLOW_ROUTE_HINTS.some((hint) => path.includes(hint))
    ? SLOW_ROUTE_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
}

/**
 * Attente avant un nouvel essai : exponentielle, plafonnee, et bruitee.
 *
 * Le bruit n'est pas cosmetique. Quand le backend repart, toutes les pages
 * ouvertes ont echoue au meme instant ; sans decalage aleatoire elles
 * retenteraient ensemble et le remettraient a genoux.
 */
function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, RETRY_MAX_DELAY_MS);
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jitter = exponential * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function authorizedFetch(
  url: string,
  options: RequestInit & { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs, ...init } = options;
  const token = authStore.token;
  if (!token) {
    throw new DashboardApiError({
      kind: 'unauthorized',
      serverMessage: 'Session absente, reconnexion necessaire',
      path: url,
      method: init.method ?? 'GET',
    });
  }

  const headers = {
    ...init.headers,
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json'
  };

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: 'include',
      // Le signal de l'appelant s'ajoute au delai borne au lieu de le
      // remplacer : une recherche annulable ne doit pas, au passage, perdre
      // sa protection contre un serveur qui ne repond plus.
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS)])
        : AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DashboardApiError({
      kind: kindFromNetworkError(err),
      path: url,
      method: init.method ?? 'GET',
      cause: err,
    });
  }

  if (response.status === 401) {
    authStore.logout();
    throw new DashboardApiError({
      kind: 'unauthorized',
      status: 401,
      path: url,
      method: init.method ?? 'GET',
    });
  }

  return response;
}

export function getGuildId(guildId?: string) {
  if (guildId) {
    return guildId;
  }

  const requestedGuildId = authStore.selectedGuildId;
  if (!requestedGuildId) return null;

  if (authStore.guilds.length === 0) {
    return requestedGuildId;
  }

  const accessibleGuild = authStore.guilds.find((guild) => guild.id === requestedGuildId);
  if (accessibleGuild) {
    return requestedGuildId;
  }

  return authStore.guilds[0]?.id ?? null;
}

/**
 * Refus attendus, que l'ecran raconte deja mieux qu'un toast.
 *
 * Un module eteint n'est pas une panne : l'API ferme ses routes avec un 403
 * `module_disabled`, y compris en lecture, et ModuleDisabledNotice l'explique.
 * Les remonter en toast faisait apparaitre « Le module X est desactive sur ce
 * serveur » sur toutes les pages, parce qu'un appel de fond (la progression
 * d'apprenti du store global) part a chaque chargement.
 *
 * `feature_denied` suit la meme regle : une section fermee au role rend un 403
 * sur chaque lecture, et une page qui en lance dix aurait empile dix toasts
 * identiques par-dessus l'ecran qui dit deja que l'acces est refuse.
 *
 * L'erreur continue d'etre levee : l'appelant garde la main.
 */
const SILENT_REFUSAL_CODES = new Set(['module_disabled', 'feature_denied']);

/** Un refus attendu ne merite ni toast, ni ecran d'erreur, ni alerte Sentry. */
export function isExpectedRefusal(error: unknown): boolean {
  if (!isDashboardApiError(error)) return false;
  return error.status === 403 && !!error.code && SILENT_REFUSAL_CODES.has(error.code);
}

/** Corps de reponse d'echec, lu au mieux : un proxy peut rendre du HTML. */
async function readErrorBody(response: Response): Promise<{ body: unknown; message?: string; code?: string }> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    return { body: null };
  }

  if (!body || typeof body !== 'object') return { body };

  const record = body as Record<string, unknown>;
  const rawMessage =
    (typeof record.error === 'string' && record.error.trim()) ||
    (typeof record.message === 'string' && record.message.trim()) ||
    undefined;
  const code = typeof record.code === 'string' ? record.code : undefined;

  return { body, message: rawMessage || undefined, code };
}

/**
 * Consigne l'echec : journal local, sante du backend, et Sentry.
 *
 * Les refus attendus en sont exclus : ils sont le fonctionnement normal d'un
 * module eteint, et les remonter noierait les vraies pannes.
 */
function recordFailure(error: DashboardApiError, context: string) {
  backendHealth.reportFailure(error.kind, error.infraFailure);

  if (isExpectedRefusal(error)) return;

  console.error(context, {
    kind: error.kind,
    status: error.status,
    code: error.code,
    method: error.method,
    path: error.path,
    message: error.message,
  });

  captureApiFailure(error, { context });
}

type RequestOptions = {
  method?: string;
  payload?: unknown;
  guildId?: string;
  errorContext?: string;
  silent?: boolean;
  /**
   * Corps deja serialise, pour les appels qui ne passent pas par `payload`.
   *
   * dashboardFetch reprend des appels ecrits a la main : ils apportent leur
   * `body` et leurs en-tetes tels quels, et les reecrire en `payload` aurait
   * touche a la charge utile de pres de cent ecrans.
   */
  body?: BodyInit | null;
  /** En-tetes supplementaires. L'autorisation reste posee par le socle. */
  headers?: Record<string, string>;
  /**
   * Annulation par l'appelant.
   *
   * S'ajoute au delai borne, sans le remplacer : une recherche que
   * l'utilisateur relance a chaque frappe s'annule elle-meme, tout en restant
   * protegee d'un serveur qui ne repond plus.
   */
  signal?: AbortSignal;
  /** Borne d'attente propre a l'appel, sinon deduite de la route. */
  timeoutMs?: number;
  /**
   * Force le rejeu d'une methode non idempotente.
   *
   * Par defaut, seules GET/HEAD/OPTIONS sont rejouees : repeter un POST qui a
   * peut-etre abouti cote serveur creerait un doublon. A n'activer que sur une
   * route dont on sait qu'elle supporte d'etre appelee deux fois.
   */
  retryUnsafe?: boolean;
  /**
   * Rend la reponse d'echec a l'appelant au lieu de lever.
   *
   * Reserve a dashboardFetch, dont les appelants testent `res.ok` eux-memes.
   * Les pannes reseau restent levees : il n'y a alors aucune reponse a rendre.
   */
  allowErrorResponse?: boolean;
  /**
   * Message a annoncer quand l'ecriture aboutit.
   *
   * Le socle disait « Operation reussie » a chaque ecriture, quelle qu'elle
   * soit, et se superposait au message de la page quand celle-ci en avait un.
   * Le message vit desormais dans le module de domaine, qui sait ce qui vient
   * d'etre fait ; une page qui annonce deja le resultat n'en passe pas.
   */
  successMessage?: string;
};

/**
 * Appel authentifie, avec delai borne et rejeu des pannes passageres.
 *
 * Rend la reponse brute ; la lecture du corps reste a l'appelant, parce que
 * seul lui sait si la route rend du JSON ou un fichier.
 */
async function performRequest(
  url: string,
  path: string,
  options: RequestOptions,
): Promise<Response> {
  // Issue finale de l'appel, rejeux compris, pour la telemetrie produit :
  // latence des lectures, enregistrements, erreurs et refus par page. Un
  // appel annule par l'appelant (recherche relancee) n'est pas un echec.
  const method = (options.method ?? 'GET').toUpperCase();
  const startedAt = performance.now();
  try {
    const response = await performRequestAttempts(url, path, options);
    trackApiResult({
      method,
      ok: response.ok,
      durationMs: performance.now() - startedAt,
      errorKind: response.ok ? undefined : kindFromStatus(response.status),
    });
    return response;
  } catch (error) {
    if (isDashboardApiError(error) && !options.signal?.aborted) {
      trackApiResult({
        method,
        ok: false,
        durationMs: performance.now() - startedAt,
        errorKind: error.kind,
        refusalCode: isExpectedRefusal(error) ? error.code : undefined,
      });
    }
    throw error;
  }
}

async function performRequestAttempts(
  url: string,
  path: string,
  options: RequestOptions,
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const hasPayload = options.payload !== undefined;
  const hasRawBody = options.body !== undefined && options.body !== null;
  // Un corps deja serialise en texte est du JSON dans tous les appels repris ;
  // un FormData, lui, doit laisser le navigateur poser sa propre frontiere
  // multipart, faute de quoi la requete part illisible.
  const wantsJsonHeader = hasPayload || (hasRawBody && typeof options.body === 'string');
  const canRetry = options.retryUnsafe || IDEMPOTENT_METHODS.has(method);
  const attempts = canRetry ? MAX_RETRIES + 1 : 1;
  const timeoutMs = timeoutForPath(path, options.timeoutMs);

  let lastError: DashboardApiError | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(backoffDelay(attempt - 1, lastError?.retryAfterMs));
    }

    let response: Response;
    try {
      response = await authorizedFetch(url, {
        method,
        headers: {
          ...(wantsJsonHeader ? JSON_HEADERS : undefined),
          ...options.headers,
        },
        body: hasPayload ? JSON.stringify(options.payload) : options.body ?? undefined,
        signal: options.signal,
        timeoutMs,
      });
    } catch (err) {
      // authorizedFetch ne leve que des DashboardApiError ; le garde couvre
      // une erreur de programmation plutot qu'un cas reel.
      const error = isDashboardApiError(err)
        ? err
        : new DashboardApiError({ kind: 'offline', path, method, cause: err });

      if (error.retryable && attempt < attempts - 1) {
        lastError = error;
        continue;
      }
      throw error;
    }

    if (response.ok) {
      backendHealth.reportSuccess();
      return response;
    }

    const kind = kindFromStatus(response.status);

    // Une reponse d'echec compte comme une preuve que le serveur repond : le
    // mode degrade ne vise que les pannes d'infrastructure.
    if (options.allowErrorResponse && kind !== 'unavailable') {
      backendHealth.reportFailure(kind, false);
      return response;
    }

    const { body, message, code } = await readErrorBody(response);
    const error = new DashboardApiError({
      kind,
      status: response.status,
      code,
      data: body,
      serverMessage: message,
      path,
      method,
      retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
    });

    if (error.retryable && attempt < attempts - 1) {
      lastError = error;
      continue;
    }

    throw error;
  }

  // Inatteignable : la derniere tentative sort par return ou par throw.
  throw lastError ?? new DashboardApiError({ kind: 'server', path, method });
}

/**
 * Appel a une route de guilde qui rend la `Response` brute.
 *
 * Une centaine d'ecrans appelaient `fetch` a la main sur
 * `${API_BASE_URL}/api/dashboard/guilds/${guildId}...`, en recollant a chaque
 * fois l'URL et l'en-tete d'autorisation. Outre la repetition, ces appels
 * passaient a cote de tout ce que le socle apporte : deconnexion sur 401,
 * delai borne, rejeu des pannes passageres, suivi de la sante du backend et
 * remontee Sentry. Une coupure reseau y restait invisible.
 *
 * `dashboardRequest` ne leur convenait pas : ils lisent `res.ok`, des en-tetes
 * de pagination ou un corps non-JSON. D'ou cette variante, qui rend la reponse
 * telle quelle et laisse l'appelant la lire comme il le faisait.
 *
 * Une reponse d'echec n'est pas levee ici, `res.ok` reste a la charge de
 * l'appelant ; seules les pannes reseau le sont, sous forme de
 * DashboardApiError.
 */
export async function dashboardFetch(
  path: string,
  options: {
    method?: string;
    payload?: unknown;
    guildId?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    /** Annulation par l'appelant, pour une saisie qui se poursuit (autocompletion). */
    signal?: AbortSignal;
    timeoutMs?: number;
    retryUnsafe?: boolean;
  } = {},
): Promise<Response> {
  const selectedGuildId = getGuildId(options.guildId);
  if (!selectedGuildId) {
    throw new DashboardApiError({
      kind: 'client',
      serverMessage: 'Aucun serveur selectionne',
      path,
      method: options.method ?? 'GET',
    });
  }

  const method = (options.method ?? 'GET').toUpperCase();
  if (!isReadMethod(method) && !backendHealth.canWrite) {
    throw new DashboardApiError({
      kind: 'unavailable',
      serverMessage: offlineWriteMessage(),
      path,
      method,
    });
  }

  return performRequest(
    `${BASE_URL}/guilds/${selectedGuildId}${path}`,
    path,
    { ...options, method, allowErrorResponse: true },
  );
}

/**
 * Ecriture qui ne leve pas : rend `true` si l'operation a abouti.
 *
 * Comme rien ne remonte a l'appelant, c'est ici qu'on annonce l'echec ; les
 * pages qui testent le booleen n'ont pas a le refaire.
 */
export async function dashboardMutation(path: string, options: RequestOptions = {}): Promise<boolean> {
  const selectedGuildId = getGuildId(options.guildId);
  if (!selectedGuildId) return false;

  const method = (options.method ?? 'PUT').toUpperCase();
  const errorContext = options.errorContext || 'API Error';

  if (!isReadMethod(method) && !backendHealth.canWrite) {
    toast.error(offlineWriteMessage());
    return false;
  }

  try {
    await performRequest(
      `${BASE_URL}/guilds/${selectedGuildId}${path}`,
      path,
      { ...options, method },
    );
    if (options.successMessage && !options.silent) {
      toast.success(options.successMessage);
    }
    return true;
  } catch (err) {
    const error = asApiError(err, path, method);
    recordFailure(error, errorContext);
    if (!options.silent && !isExpectedRefusal(error)) {
      toast.error(error.userMessage);
    }
    return false;
  }
}

/**
 * Appel qui rend le JSON de la reponse et leve une DashboardApiError en cas
 * d'echec.
 *
 * N'affiche rien : voir l'en-tete du fichier pour le partage des roles entre
 * le socle, l'appelant et le filet global.
 *
 * `T` decrit la reponse attendue. Le defaut reste `any` : le typer en
 * `unknown` obligerait a annoter les cinq cents fonctions de domaine d'un
 * coup. Chacune le precise a son rythme, et ce qu'elle rend cesse alors d'etre
 * opaque pour les ecrans qui l'appellent.
 *
 * Le `null` du retour n'est pas un echec : c'est l'absence de serveur
 * selectionne, seul cas ou aucun appel n'est emis.
 */
export async function dashboardRequest<T = any>(
  path: string,
  options: RequestOptions = {},
): Promise<T | null> {
  const selectedGuildId = getGuildId(options.guildId);
  // Aucun serveur selectionne : il n'y a pas de route a appeler. Le `null` est
  // dans la signature, et non avale en silence, faute de quoi l'appelant croit
  // tenir ses donnees et echoue plus bas sur un `.map`.
  if (!selectedGuildId) return null;

  const method = (options.method ?? 'GET').toUpperCase();
  const errorContext = options.errorContext || 'API Error';

  if (!isReadMethod(method) && !backendHealth.canWrite) {
    throw new DashboardApiError({
      kind: 'unavailable',
      serverMessage: offlineWriteMessage(),
      path,
      method,
    });
  }

  let response: Response;
  try {
    response = await performRequest(
      `${BASE_URL}/guilds/${selectedGuildId}${path}`,
      path,
      { ...options, method },
    );
  } catch (err) {
    const error = asApiError(err, path, method);
    recordFailure(error, errorContext);
    throw error;
  }

  if (options.successMessage && !options.silent) {
    toast.success(options.successMessage);
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    const error = new DashboardApiError({ kind: 'parse', status: response.status, path, method, cause: err });
    recordFailure(error, errorContext);
    throw error;
  }
}

/**
 * Comme dashboardRequest, pour une route de l'API qui ne vit pas sous
 * `/api/dashboard/guilds/<id>` (sites communautaires, par exemple) : `path`
 * part de la racine de l'API. Même délai, mêmes rejeux, mêmes erreurs.
 */
export async function apiRequest<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const errorContext = options.errorContext || 'API Error';

  if (!isReadMethod(method) && !backendHealth.canWrite) {
    throw new DashboardApiError({ kind: 'unavailable', serverMessage: offlineWriteMessage(), path, method });
  }

  let response: Response;
  try {
    response = await performRequest(`${API_BASE_URL}${path}`, path, { ...options, method });
  } catch (err) {
    const error = asApiError(err, path, method);
    recordFailure(error, errorContext);
    throw error;
  }

  if (options.successMessage && !options.silent) {
    toast.success(options.successMessage);
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    const error = new DashboardApiError({ kind: 'parse', status: response.status, path, method, cause: err });
    recordFailure(error, errorContext);
    throw error;
  }
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function offlineWriteMessage(): string {
  return m.api_err_write_blocked();
}

function asApiError(err: unknown, path: string, method: string): DashboardApiError {
  if (isDashboardApiError(err)) return err;
  return new DashboardApiError({
    kind: 'server',
    serverMessage: err instanceof Error ? err.message : undefined,
    path,
    method,
    cause: err,
  });
}
