/**
 * Lecture des classements publics des autres bots de niveaux, pour reprendre
 * l'XP des membres sans export manuel.
 *
 * Deux sources exposent un classement par serveur sans clef d'API :
 * - MEE6 : `mee6.xyz/api/plugins/levels/leaderboard/<id>`, à condition que le
 *   serveur ait coché « rendre le classement public » (401 sinon) ;
 * - DraftBot : `api.draftbot.fr/activities/levels/<id>`, la route qu'appelle
 *   sa page publique `draftbot.gg/levels/<id>`.
 *
 * Aucune des deux n'est documentée : un changement de format doit donner un
 * message clair, pas un import silencieusement vide.
 *
 * On reprend le niveau et l'avancement dans le palier, pas l'XP brute : les
 * courbes diffèrent, et c'est le niveau que les membres connaissent et que les
 * rôles de récompense suivent.
 */
import { UserFacingError } from '../../utils/userFacingError.js';

export const LEVEL_IMPORT_SOURCES = ['mee6', 'draftbot'] as const;
export type LevelImportSource = (typeof LEVEL_IMPORT_SOURCES)[number];

export type ExternalLevel = {
  userId: string;
  level: number;
  /** Avancement dans le palier en cours, entre 0 et 1. */
  progress: number;
};

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

const SOURCE_LABEL: Record<LevelImportSource, string> = { mee6: 'MEE6', draftbot: 'DraftBot' };

async function getJson(source: LevelImportSource, url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Kotbo level import' },
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
      throw new UserFacingError(
        source === 'mee6'
          ? 'Le classement MEE6 de ce serveur est privé. Active « Rendre le classement public » dans les réglages Levels de MEE6, puis réessaie.'
          : 'Le classement DraftBot de ce serveur est privé.',
      );
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
export function externalLevelsJob(source: LevelImportSource, guildId: string): FetchJob {
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
  fetchExternalLevels(source, guildId, (n) => { job.fetched = n; })
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
): Promise<ExternalLevel[]> {
  if (!SNOWFLAKE.test(guildId)) throw new UserFacingError('Identifiant de serveur invalide.');
  const byUser = new Map<string, ExternalLevel>();
  let lastPage = MAX_PAGES;

  for (let page = 0; page < lastPage; page++) {
    if (page > 0) await pause();

    if (source === 'mee6') {
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
