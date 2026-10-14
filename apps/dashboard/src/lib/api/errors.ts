/**
 * Taxonomie des echecs d'appel au backend.
 *
 * Avant, tout ce qui ratait remontait « Erreur reseau ou serveur » : une
 * coupure de connexion, une base injoignable, un jeton expire et une requete
 * trop longue donnaient le meme texte, et personne ne pouvait dire lequel des
 * quatre venait de se produire. On distingue desormais la nature de la panne,
 * parce que la conduite a tenir n'est pas la meme : reessayer, se reconnecter,
 * attendre, ou prevenir un administrateur.
 *
 * `kind` est la nature de la panne, stable et testable. `userMessage` est ce
 * qu'on montre : le message du serveur quand il en donne un d'utile, le texte
 * de la categorie sinon.
 */
import { m } from '../i18n';

export type ApiErrorKind =
  /** Aucune connexion : hors ligne, DNS, ou serveur qui n'accepte pas la connexion. */
  | 'offline'
  /** Le serveur n'a pas repondu dans le delai imparti. */
  | 'timeout'
  /** 401 : jeton absent, expire ou invalide. */
  | 'unauthorized'
  /** 403 : authentifie mais pas autorise. */
  | 'forbidden'
  /** 404 : la ressource n'existe pas (ou plus). */
  | 'not_found'
  /** 409 : conflit avec l'etat courant (doublon, version concurrente). */
  | 'conflict'
  /** 429 : trop d'appels, il faut attendre. */
  | 'rate_limited'
  /** 502/503/504 : backend, base de donnees ou Redis injoignable. */
  | 'unavailable'
  /** Autre 5xx : le serveur a plante en traitant la demande. */
  | 'server'
  /** Autre 4xx : la demande est refusee telle quelle. */
  | 'client'
  /** Reponse recue mais illisible (JSON casse, HTML d'un proxy...). */
  | 'parse';

/**
 * Categories qui valent la peine d'etre retentees : la demande est peut-etre
 * bonne, c'est le chemin qui est momentanement coupe. Un 4xx, lui, ne
 * deviendra pas correct en le repetant.
 */
const RETRYABLE: ReadonlySet<ApiErrorKind> = new Set<ApiErrorKind>([
  'offline',
  'timeout',
  'unavailable',
  'rate_limited',
]);

/**
 * Categories qui signalent que le backend lui-meme est en cause, par
 * opposition a une demande refusee. C'est ce qui declenche le mode degrade.
 */
const INFRA_FAILURE: ReadonlySet<ApiErrorKind> = new Set<ApiErrorKind>([
  'offline',
  'timeout',
  'unavailable',
]);

/** Texte par defaut d'une categorie, quand le serveur n'en fournit pas. */
function defaultMessage(kind: ApiErrorKind): string {
  switch (kind) {
    case 'offline':
      return m.api_err_offline();
    case 'timeout':
      return m.api_err_timeout();
    case 'unauthorized':
      return m.api_err_unauthorized();
    case 'forbidden':
      return m.api_err_forbidden();
    case 'not_found':
      return m.api_err_not_found();
    case 'conflict':
      return m.api_err_conflict();
    case 'rate_limited':
      return m.api_err_rate_limited();
    case 'unavailable':
      return m.api_err_unavailable();
    case 'server':
      return m.api_err_server();
    case 'client':
      return m.api_err_client();
    case 'parse':
      return m.api_err_parse();
  }
}

type CodeParams = Record<string, string | number>;

/**
 * Codes applicatifs de la route vocale (`channels-management`, préfixe `tv_`)
 * et leur message traduit (`api_err_tv_*`). Consultée AVANT le message du
 * serveur : le texte français que la route renvoie ne sert que de repli quand
 * le code est inconnu de cette version du dashboard. Une `Map` plutôt qu'un
 * objet, pour qu'un code `constructor` ne retombe pas sur le prototype.
 */
const CODE_MESSAGES = new Map<string, (p: CodeParams) => string>([
  ['tv_guild_not_found', () => m.api_err_tv_guild_not_found()],
  ['tv_feature_unknown', () => m.api_err_tv_feature_unknown()],
  ['tv_channel_not_found', () => m.api_err_tv_channel_not_found()],
  ['tv_channel_not_editable', () => m.api_err_tv_channel_not_editable()],
  ['tv_channel_name_invalid', () => m.api_err_tv_channel_name_invalid()],
  ['tv_channel_not_deletable', () => m.api_err_tv_channel_not_deletable()],
  ['tv_sticky_channel_missing', () => m.api_err_tv_sticky_channel_missing()],
  ['tv_sticky_channel_invalid', () => m.api_err_tv_sticky_channel_invalid()],
  ['tv_sticky_json_invalid', (p) => m.api_err_tv_sticky_json_invalid({ detail: String(p.detail ?? '') })],
  ['tv_sticky_empty', () => m.api_err_tv_sticky_empty()],
  ['tv_sticky_webhook_name', () => m.api_err_tv_sticky_webhook_name()],
  ['tv_sticky_avatar_invalid', () => m.api_err_tv_sticky_avatar_invalid()],
  ['tv_sticky_not_found', () => m.api_err_tv_sticky_not_found()],
  ['tv_sticky_not_found_or_off', () => m.api_err_tv_sticky_not_found_or_off()],
  ['tv_sticky_repost_failed', () => m.api_err_tv_sticky_repost_failed()],
  ['tv_temp_channel_unregistered', () => m.api_err_tv_temp_channel_unregistered()],
  ['tv_discord_delete_refused', () => m.api_err_tv_discord_delete_refused()],
  ['tv_discord_rename_refused', () => m.api_err_tv_discord_rename_refused()],
  ['tv_reservation_role_invalid', () => m.api_err_tv_reservation_role_invalid()],
  ['tv_reservation_category_refused', () => m.api_err_tv_reservation_category_refused()],
  ['tv_payload_invalid', () => m.api_err_tv_payload_invalid()],
  ['tv_honeypot_sanction_invalid', () => m.api_err_tv_honeypot_sanction_invalid()],
  ['tv_name_template_invalid', () => m.api_err_tv_name_template_invalid()],
  ['tv_object_expected', (p) => m.api_err_tv_object_expected({ field: String(p.field ?? '') })],
  [
    'tv_setting_invalid_choice',
    (p) => m.api_err_tv_setting_invalid_choice({ field: String(p.field ?? ''), value: String(p.value ?? ''), expected: String(p.expected ?? '') }),
  ],
  [
    'tv_setting_invalid_range',
    (p) => m.api_err_tv_setting_invalid_range({ field: String(p.field ?? ''), value: String(p.value ?? ''), min: String(p.min ?? ''), max: String(p.max ?? '') }),
  ],
  ['tv_snowflake_invalid', (p) => m.api_err_tv_snowflake_invalid({ field: String(p.field ?? ''), value: String(p.value ?? '') })],
]);

/** Codes que ce dashboard sait traduire (pour les tests et la détection d'oubli). */
export const TRANSLATED_API_CODES: readonly string[] = [...CODE_MESSAGES.keys()];

/**
 * Message traduit d'un code applicatif, ou `undefined` si le code est absent
 * ou inconnu (le message du serveur prend alors le relais). `data` est le corps
 * de la réponse d'échec : ses `params` alimentent les messages à variables.
 */
export function messageForApiCode(code: string | undefined, data?: unknown): string | undefined {
  const build = code ? CODE_MESSAGES.get(code) : undefined;
  if (!build) return undefined;
  const params = (data as { params?: unknown } | null | undefined)?.params;
  return build(params && typeof params === 'object' ? (params as CodeParams) : {});
}

/**
 * Avis d'un enregistrement réussi (`notices` de la route vocale) : même
 * mécanisme que les erreurs, un `code` et des `params` traduits ici, le texte
 * français du serveur ne servant que de repli pour un code inconnu.
 */
const NOTICE_MESSAGES = new Map<string, (p: CodeParams) => string>([
  ['notice_tv_generator_cap', (p) => m.api_notice_tv_generator_cap({ n: Number(p.n ?? 0), max: Number(p.max ?? 0) })],
  ['notice_tv_generator_no_channel', (p) => m.api_notice_tv_generator_no_channel({ n: Number(p.n ?? 0) })],
  ['notice_tv_generator_duplicate', (p) => m.api_notice_tv_generator_duplicate({ n: Number(p.n ?? 0), name: String(p.name ?? ''), first: Number(p.first ?? 0) })],
  ['notice_tv_generator_is_main', (p) => m.api_notice_tv_generator_is_main({ n: Number(p.n ?? 0), name: String(p.name ?? '') })],
  ['notice_tv_generator_not_kept', (p) => m.api_notice_tv_generator_not_kept({ n: Number(p.n ?? 0), name: String(p.name ?? '') })],
  ['notice_tv_state_colors_inert', (p) => m.api_notice_tv_state_colors_inert({ colors: String(p.colors ?? '') })],
]);

/** Codes d'avis que ce dashboard sait traduire. */
export const TRANSLATED_NOTICE_CODES: readonly string[] = [...NOTICE_MESSAGES.keys()];

/** Texte d'un avis dans la langue du dashboard ; une chaîne seule (ancien serveur) passe telle quelle. */
export function messageForNotice(notice: unknown): string {
  if (typeof notice === 'string') return notice;
  const { code, params, message } = (notice ?? {}) as { code?: unknown; params?: unknown; message?: unknown };
  const build = typeof code === 'string' ? NOTICE_MESSAGES.get(code) : undefined;
  if (build) return build(params && typeof params === 'object' ? (params as CodeParams) : {});
  return typeof message === 'string' ? message : String(notice);
}

export type DashboardApiErrorInit = {
  kind: ApiErrorKind;
  /** Statut HTTP, absent quand la requete n'a jamais abouti. */
  status?: number;
  /** Code applicatif rendu par l'API (`module_disabled`, `feature_denied`...). */
  code?: string;
  /** Corps de la reponse d'echec : une operation interrompue y decrit ce qu'elle a fait. */
  data?: unknown;
  /** Message du serveur, prefere au texte de categorie quand il est utile. */
  serverMessage?: string;
  /** Route appelee, pour les journaux et Sentry. */
  path?: string;
  method?: string;
  /** Delai reclame par un 429, en millisecondes. */
  retryAfterMs?: number;
  cause?: unknown;
};

/**
 * Echec d'un appel au backend du dashboard.
 *
 * Toutes les fonctions de `lib/api` levent ce type et lui seul : un bloc
 * `catch` peut donc se fier a `kind` plutot que de relire une chaine.
 */
export class DashboardApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly data?: unknown;
  readonly path?: string;
  readonly method?: string;
  readonly retryAfterMs?: number;

  constructor(init: DashboardApiErrorInit) {
    const serverMessage = init.serverMessage?.trim();
    super(messageForApiCode(init.code, init.data) ?? (serverMessage || defaultMessage(init.kind)));
    this.name = 'DashboardApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.data = init.data;
    this.path = init.path;
    this.method = init.method;
    this.retryAfterMs = init.retryAfterMs;
    if (init.cause !== undefined) this.cause = init.cause;
  }

  /**
   * Ce qu'on montre a l'utilisateur.
   *
   * Recalcule a la lecture : la langue peut changer entre le moment ou
   * l'erreur est levee et celui ou un ecran l'affiche.
   */
  get userMessage(): string {
    return messageForApiCode(this.code, this.data) ?? this.message;
  }

  /** Vaut-il la peine de rejouer la requete telle quelle ? */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /** La panne vient-elle du backend plutot que de la demande ? */
  get infraFailure(): boolean {
    return INFRA_FAILURE.has(this.kind);
  }
}

export function isDashboardApiError(value: unknown): value is DashboardApiError {
  return value instanceof DashboardApiError;
}

/** Categorie deduite d'un statut HTTP. */
export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status >= 500) return 'server';
  return 'client';
}

/**
 * Categorie deduite d'une exception de `fetch`.
 *
 * `fetch` ne distingue pas les causes : il leve un `TypeError` opaque aussi
 * bien pour un DNS muet que pour un serveur qui refuse la connexion. Seule
 * l'interruption volontaire (`AbortError`) est reconnaissable, et le hors
 * ligne se lit sur le navigateur.
 */
export function kindFromNetworkError(err: unknown): ApiErrorKind {
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'timeout';
  if (err instanceof DOMException && err.name === 'AbortError') return 'timeout';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  return 'offline';
}

/**
 * Delai reclame par le serveur, en millisecondes.
 *
 * `Retry-After` s'exprime en secondes ou en date HTTP ; les deux formes
 * circulent, Discord et les proxys n'utilisant pas la meme.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}
