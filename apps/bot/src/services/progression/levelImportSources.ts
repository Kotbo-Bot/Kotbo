/**
 * Lecture des classements publics des autres bots de niveaux, pour reprendre
 * l'XP des membres sans export manuel.
 *
 * Sources lisibles :
 * - MEE6 : `mee6.xyz/api/plugins/levels/leaderboard/<id>`, à condition que le
 *   serveur ait coché « rendre le classement public » (401 sinon) ;
 * - DraftBot : `api.draftbot.fr/activities/levels/<id>`, la route qu'appelle
 *   sa page publique `draftbot.gg/levels/<id>` ;
 * - Lurkr : `api.lurkr.gg/v2/levels/<id>`, API publique documentée, si le
 *   classement web du serveur est public ;
 * - Tatsu : `api.tatsu.gg/v1/guilds/<id>/rankings/all`, avec une clef d'API
 *   personnelle. Tatsu ne donne qu'un score, repris comme XP brute.
 *
 * Arcane et Amari refusent explicitement les lectures hors de leur site :
 * on ne les contourne pas.
 *
 * MEE6 et DraftBot ne sont pas documentés : un changement de format doit
 * donner un message clair, pas un import silencieusement vide.
 *
 * Quand la source donne un niveau, on reprend le niveau et l'avancement dans
 * le palier, pas l'XP brute : les courbes diffèrent, et c'est le niveau que
 * les membres connaissent et que les rôles de récompense suivent.
 */
import { UserFacingError } from '../../utils/userFacingError.js';

export const LEVEL_IMPORT_SOURCES = ['mee6', 'draftbot', 'lurkr', 'tatsu'] as const;
export type LevelImportSource = (typeof LEVEL_IMPORT_SOURCES)[number];

/** Sources qui exigent une clef d'API fournie par le serveur. */
export const LEVEL_IMPORT_SOURCES_WITH_KEY: readonly LevelImportSource[] = ['tatsu'];

export type ExternalLevel =
  /** `progress` : avancement dans le palier en cours, entre 0 et 1. */
  | { userId: string; level: number; progress: number; xp?: undefined }
  /** Source sans niveau : l'XP est recalculée en niveau sur la courbe Kotbo. */
  | { userId: string; xp: number; level?: undefined; progress?: undefined };

const SNOWFLAKE = /^\d{17,20}$/;
const REQUEST_TIMEOUT_MS = 15_000;
// Garde-fou : 200 pages couvrent 200 000 membres chez MEE6, bien au-delà d'un
// serveur réel, et bornent une boucle que la source ferait tourner à vide.
const MAX_PAGES = 200;
const PAGE_PAUSE_MS = 250;

export function isLevelImportSource(value: unknown): value is LevelImportSource {
  return typeof value === 'string' && (LEVEL_IMPORT_SOURCES as readonly string[]).includes(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
}

function ratio(current: unknown, needed: unknown): number {
  const cur = toNumber(current);
  const need = toNumber(needed);
  if (!Number.isFinite(cur) || !Number.isFinite(need) || need <= 0) return 0;
  return Math.min(1, Math.max(0, cur / need));
}

/** Ligne validée, ou `null` : la réponse vient de l'extérieur. */
function entry(id: unknown, level: unknown, progress: number): ExternalLevel | null {
  const lvl = toNumber(level);
  if (typeof id !== 'string' || !SNOWFLAKE.test(id)) return null;
  if (!Number.isInteger(lvl) || lvl < 0 || lvl > 10_000) return null;
  return { userId: id, level: lvl, progress };
}

/** `players[].detailed_xp` vaut `[xp dans le palier, xp du palier, xp totale]`. */
export function parseMee6Page(body: unknown): ExternalLevel[] {
  const players = (body as { players?: unknown })?.players;
  if (!Array.isArray(players)) throw new UserFacingError('Le classement MEE6 a renvoyé un format inattendu.');
  return players
    .map((p) => {
      const detailed = Array.isArray(p?.detailed_xp) ? p.detailed_xp : [];
      return entry(p?.id, p?.level, ratio(detailed[0], detailed[1]));
    })
    .filter((e): e is ExternalLevel => e !== null);
}

/**
 * `users[]` porte `currentLevelXp` et `levelXp` en chaînes. `total` est le
 * nombre de pages (leur page publique charge tant que `page < total - 1`), et
 * il n'est renvoyé qu'avec la première.
 */
export function parseDraftbotPage(body: unknown): { entries: ExternalLevel[]; pages: number | null } {
  const users = (body as { users?: unknown })?.users;
  if (!Array.isArray(users)) throw new UserFacingError('Le classement DraftBot a renvoyé un format inattendu.');
  const pages = toNumber((body as { total?: unknown }).total);
  return {
    entries: users
      .map((u) => entry(u?.id, u?.level, ratio(u?.currentLevelXp, u?.levelXp)))
      .filter((e): e is ExternalLevel => e !== null),
    pages: Number.isFinite(pages) ? pages : null,
  };
}

/**
 * `levels[].progress` est un pourcentage. Les membres qui ont caché leur rang
 * arrivent en `userId: "anonymous:N"` : ils sont écartés, faute d'identifiant.
 */
export function parseLurkrPage(body: unknown): ExternalLevel[] {
  const levels = (body as { levels?: unknown })?.levels;
  if (!Array.isArray(levels)) throw new UserFacingError('Le classement Lurkr a renvoyé un format inattendu.');
  return levels
    .map((l) => entry(l?.userId, l?.level, ratio(l?.progress, 100)))
    .filter((e): e is ExternalLevel => e !== null);
}

/** `rankings[]` ne porte qu'un score cumulé, sans niveau. */
export function parseTatsuPage(body: unknown): ExternalLevel[] {
  const rankings = (body as { rankings?: unknown })?.rankings;
  if (!Array.isArray(rankings)) throw new UserFacingError('Le classement Tatsu a renvoyé un format inattendu.');
  return rankings
    .map((r): ExternalLevel | null => {
      const score = toNumber(r?.score);
      if (typeof r?.user_id !== 'string' || !SNOWFLAKE.test(r.user_id)) return null;
      if (!Number.isFinite(score) || score < 0) return null;
      return { userId: r.user_id, xp: Math.floor(score) };
    })
    .filter((e): e is ExternalLevel => e !== null);
}

/** Forme d'une clef Tatsu : elle part dans un en-tête, rien d'autre ne passe. */
const API_KEY = /^[A-Za-z0-9._-]{8,200}$/;

export function isValidImportApiKey(value: unknown): value is string {
  return typeof value === 'string' && API_KEY.test(value);
}

const SOURCE_LABEL: Record<LevelImportSource, string> = { mee6: 'MEE6', draftbot: 'DraftBot', lurkr: 'Lurkr', tatsu: 'Tatsu' };

const PRIVATE_MESSAGE: Record<LevelImportSource, string> = {
  mee6: 'Le classement MEE6 de ce serveur est privé. Active « Rendre le classement public » dans les réglages Levels de MEE6, puis réessaie.',
  draftbot: 'Le classement DraftBot de ce serveur est privé.',
  lurkr: 'Le classement Lurkr de ce serveur est privé. Passe la visibilité du classement web sur « Public » dans le dashboard Lurkr, puis réessaie.',
  tatsu: 'Tatsu a refusé la clef d’API. Vérifie-la (commande t!apikey) puis réessaie.',
};

async function getJson(source: LevelImportSource, url: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Kotbo level import', ...extraHeaders },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    if (!res) throw new UserFacingError(`${SOURCE_LABEL[source]} ne répond pas. Réessaie dans quelques minutes.`);

    if (res.status === 429) {
      const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new UserFacingError(PRIVATE_MESSAGE[source]);
    }
    if (res.status === 404) {
      throw new UserFacingError(`${SOURCE_LABEL[source]} n'a pas de classement pour ce serveur.`);
    }
    if (!res.ok) throw new UserFacingError(`${SOURCE_LABEL[source]} a refusé la lecture du classement (code ${res.status}).`);
    return res.json().catch(() => {
      throw new UserFacingError(`${SOURCE_LABEL[source]} a renvoyé une réponse illisible.`);
    });
  }
  throw new UserFacingError(`${SOURCE_LABEL[source]} limite les lectures pour l'instant. Réessaie dans quelques minutes.`);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, PAGE_PAUSE_MS));

type FetchJob = { entries: ExternalLevel[] | null; error: unknown; fetched: number; startedAt: number };
const jobs = new Map<string, FetchJob>();
// Assez pour analyser, relire le rapport puis lancer l'import sans relire la source.
const JOB_TTL_MS = 15 * 60_000;

/**
 * Lecture détachée de la requête : un gros classement prend une à deux minutes,
 * bien au-delà de ce qu'attend le dashboard. Chaque appel renvoie l'état ; le
 * premier lance la lecture, un échec ou un résultat périmé la relance.
 */
export function externalLevelsJob(source: LevelImportSource, guildId: string, apiKey?: string): FetchJob {
  const now = Date.now();
  for (const [k, j] of jobs) if (now - j.startedAt > JOB_TTL_MS) jobs.delete(k);

  const key = `${source}:${guildId}`;
  const existing = jobs.get(key);
  if (existing) {
    // L'erreur n'est rendue qu'une fois : l'appel suivant relance la lecture.
    if (existing.error) jobs.delete(key);
    return existing;
  }

  const job: FetchJob = { entries: null, error: null, fetched: 0, startedAt: Date.now() };
  jobs.set(key, job);
  // La clef ne vit que dans cette lecture : ni journalisée, ni conservée.
  fetchExternalLevels(source, guildId, (n) => { job.fetched = n; }, apiKey)
    .then((entries) => { job.entries = entries; })
    .catch((err) => { job.error = err; });
  return job;
}

/** Après un import réel : le classement servi ne doit pas resservir. */
export function forgetExternalLevels(source: LevelImportSource, guildId: string): void {
  jobs.delete(`${source}:${guildId}`);
}

/** Tout le classement du serveur chez la source, dédoublonné par membre. */
export async function fetchExternalLevels(
  source: LevelImportSource,
  guildId: string,
  onProgress?: (fetched: number) => void,
  apiKey?: string,
): Promise<ExternalLevel[]> {
  if (!SNOWFLAKE.test(guildId)) throw new UserFacingError('Identifiant de serveur invalide.');
  if (LEVEL_IMPORT_SOURCES_WITH_KEY.includes(source) && !isValidImportApiKey(apiKey)) {
    throw new UserFacingError(`Il faut une clef d'API ${SOURCE_LABEL[source]} valide pour lire ce classement.`);
  }
  const byUser = new Map<string, ExternalLevel>();
  let lastPage = MAX_PAGES;
  let offset = 0;

  for (let page = 0; page < lastPage; page++) {
    if (page > 0) await pause();

    if (source === 'lurkr') {
      // Pages numérotées à partir de 1 ; la fin est la première page vide.
      const entries = parseLurkrPage(await getJson(source, `https://api.lurkr.gg/v2/levels/${guildId}?page=${page + 1}`));
      for (const e of entries) if (!byUser.has(e.userId)) byUser.set(e.userId, e);
      onProgress?.(byUser.size);
      if (entries.length === 0) break;
    } else if (source === 'tatsu') {
      const body = await getJson(source, `https://api.tatsu.gg/v1/guilds/${guildId}/rankings/all?offset=${offset}`, {
        Authorization: apiKey as string,
      });
      const rows = (body as { rankings?: unknown[] })?.rankings?.length ?? 0;
      const entries = parseTatsuPage(body);
      for (const e of entries) if (!byUser.has(e.userId)) byUser.set(e.userId, e);
      onProgress?.(byUser.size);
      if (rows === 0) break;
      offset += rows;
      // L'API Tatsu limite à 60 requêtes par minute.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else if (source === 'mee6') {
      const body = await getJson(source, `https://mee6.xyz/api/plugins/levels/leaderboard/${guildId}?limit=1000&page=${page}`);
      const entries = parseMee6Page(body);
      for (const e of entries) if (!byUser.has(e.userId)) byUser.set(e.userId, e);
      onProgress?.(byUser.size);
      if (entries.length < 1000) break;
    } else {
      const body = await getJson(source, `https://api.draftbot.fr/activities/levels/${guildId}?page=${page}`);
      const { entries, pages } = parseDraftbotPage(body);
      if (page === 0 && pages !== null) lastPage = Math.min(MAX_PAGES, pages);
      for (const e of entries) if (!byUser.has(e.userId)) byUser.set(e.userId, e);
      onProgress?.(byUser.size);
      // Les pages ne sont pas pleines (anciens membres filtrés) : seule une
      // page vide dit qu'on est au bout quand le nombre de pages manque.
      if (entries.length === 0 && pages === null) break;
    }
  }

  return Array.from(byUser.values());
}
