/**
 * Suivi de dépôts GitHub : nouveaux commits d'une branche, releases, pull
 * requests et issues, annoncés dans un salon.
 *
 * Polling de l'API REST toutes les 5 minutes. Sans `GITHUB_TOKEN`, GitHub
 * n'accorde que 60 requêtes par heure et par IP : de quoi suivre un seul dépôt.
 * Avec un jeton, 5 000. Les requêtes conditionnelles (ETag) répondues par 304
 * ne sont pas décomptées : un dépôt calme ne coûte presque rien.
 *
 * Un même dépôt suivi par plusieurs serveurs n'est interrogé qu'une fois.
 */
import { type Client } from 'discord.js';
import type { GithubRepoFollow } from '@prisma/client';
import prisma from '../../utils/db.js';
import { baseEmbed, truncate } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { sendFollowAlert } from './socialDelivery.js';
import { resolveFollowMessage, templateHasVariable } from './socialTemplates.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_COLOR = 0x24292f;
/** Au-delà, une alerte « +N autres » remplace le détail : un push massif ne doit pas noyer le salon. */
const MAX_COMMITS_LISTED = 5;
const MAX_ITEMS_PER_TYPE = 3;

type GithubUser = { login: string; avatar_url?: string; html_url?: string };

export type GithubCommit = {
  sha: string;
  html_url: string;
  commit: { message: string; author?: { name?: string; date?: string } | null };
  author?: GithubUser | null;
};

export type GithubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  author?: GithubUser | null;
};

export type GithubIssue = {
  number: number;
  title: string;
  html_url: string;
  user?: GithubUser | null;
  body?: string | null;
  /** Présent quand l'élément de `/issues` est en réalité une pull request. */
  pull_request?: unknown;
};

// ==================== HELPERS PURS ====================

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO_RE = /^[a-z0-9._-]{1,100}$/;

/**
 * Ramène une saisie à `owner/repo` en minuscules : `owner/repo`, URL
 * `github.com/owner/repo(.git)` ou URL d'une page du dépôt. `null` sinon.
 */
export function normalizeGithubRepo(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;

  const fromUrl = value.match(/github\.com[/:]([^/\s]+)\/([^/\s?#]+)/);
  if (fromUrl) value = `${fromUrl[1]}/${fromUrl[2]}`;
  value = value.replace(/\.git$/, '');

  const [owner, repo, ...rest] = value.split('/');
  if (rest.length > 0 || !owner || !repo) return null;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`;
}

/** Nom de branche acceptable (sous-ensemble prudent des règles de git). */
export function normalizeGithubBranch(input: string | null | undefined): string | null {
  const value = (input ?? '').trim();
  if (!value) return null;
  if (value.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.startsWith('/')) {
    return null;
  }
  return value;
}

/**
 * Éléments plus récents que le dernier vu, dans l'ordre de la liste (du plus
 * récent au plus ancien). Si le dernier vu n'apparaît pas dans la page (push
 * massif, historique réécrit), toute la page est considérée comme nouvelle.
 */
export function itemsSince<T>(items: readonly T[], isLastSeen: (item: T) => boolean): T[] {
  const index = items.findIndex(isLastSeen);
  return index === -1 ? [...items] : items.slice(0, index);
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]!.trim();
}

// ==================== HTTP ====================

const etagCache = new Map<string, { etag: string; data: unknown }>();
/** Horodatage (ms) jusqu'auquel GitHub a fermé le quota : on n'interroge plus. */
let rateLimitedUntil = 0;

export function resetGithubStateForTests(): void {
  etagCache.clear();
  rateLimitedUntil = 0;
}

type GithubResult<T> = { ok: true; data: T } | { ok: false; status: number; rateLimited: boolean };

/**
 * GET JSON sur l'API GitHub, avec ETag. Un 304 rend la dernière réponse
 * connue. Un quota épuisé suspend toutes les requêtes jusqu'à sa remise à zéro.
 */
export async function githubGet<T>(path: string, fetchImpl: FetchLike = fetch): Promise<GithubResult<T>> {
  if (Date.now() < rateLimitedUntil) return { ok: false, status: 429, rateLimited: true };

  const url = `${API}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Kotbo',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const cached = etagCache.get(url);
  if (cached) headers['If-None-Match'] = cached.etag;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (error) {
    logger.warn('GithubService', `Appel ${path} en échec : ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, status: 0, rateLimited: false };
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 304 && cached) return { ok: true, data: cached.data as T };

  if (res.status === 403 || res.status === 429) {
    // Quota horaire (remaining à 0) ou limite secondaire (Retry-After) : deux
    // pauses différentes. Tout autre 403 est un refus d'accès, pas un quota.
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      rateLimitedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 15 * 60_000;
      // Une limite de 60 trahit un appel anonyme : jeton absent ou ignoré.
      const limit = res.headers.get('x-ratelimit-limit') ?? '?';
      logger.warn('GithubService', `Quota GitHub épuisé (${limit} requêtes/h, ${token ? 'avec' : 'sans'} GITHUB_TOKEN) jusqu'à ${new Date(rateLimitedUntil).toISOString()}.`);
      return { ok: false, status: res.status, rateLimited: true };
    }
    if (res.status === 429 || Number.isFinite(retryAfter) && retryAfter > 0) {
      rateLimitedUntil = Date.now() + (retryAfter > 0 ? retryAfter : 60) * 1000;
      logger.warn('GithubService', `Limite secondaire GitHub atteinte, pause jusqu'à ${new Date(rateLimitedUntil).toISOString()}.`);
      return { ok: false, status: res.status, rateLimited: true };
    }
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => null) as { message?: string } | null;
      logger.warn('GithubService', `Accès refusé par GitHub (${res.status}, ${token ? 'avec' : 'sans'} GITHUB_TOKEN) sur ${path} : ${body?.message ?? 'sans détail'}`);
    }
    return { ok: false, status: res.status, rateLimited: false };
  }

  const data = await res.json().catch(() => null) as T | null;
  if (data === null) return { ok: false, status: res.status, rateLimited: false };
  const etag = res.headers.get('etag');
  if (etag) etagCache.set(url, { etag, data });
  return { ok: true, data };
}

export type GithubRepoFailure = 'not_found' | 'rate_limited' | 'unauthorized' | 'forbidden' | 'unavailable';

export type ResolvedGithubRepo =
  | { ok: true; repo: string; defaultBranch: string }
  | { ok: false; reason: GithubRepoFailure };

/**
 * Dépôt existant et public : nom canonique et branche par défaut. En cas
 * d'échec, la cause est gardée : un quota épuisé ou un jeton refusé ne doit
 * pas se faire passer pour un dépôt inexistant.
 */
export async function resolveGithubRepo(repo: string, fetchImpl: FetchLike = fetch): Promise<ResolvedGithubRepo> {
  const res = await githubGet<{ full_name: string; default_branch: string; private?: boolean }>(`/repos/${repo}`, fetchImpl);
  if (res.ok) {
    if (res.data.private) return { ok: false, reason: 'not_found' };
    return { ok: true, repo: res.data.full_name.toLowerCase(), defaultBranch: res.data.default_branch };
  }
  if (res.rateLimited) return { ok: false, reason: 'rate_limited' };
  switch (res.status) {
    case 404:
    case 451:
      return { ok: false, reason: 'not_found' };
    case 401:
      return { ok: false, reason: 'unauthorized' };
    case 403:
      return { ok: false, reason: 'forbidden' };
    default:
      return { ok: false, reason: 'unavailable' };
  }
}

// ==================== MESSAGES ====================

export function buildCommitsAlert(
  follow: Pick<GithubRepoFollow, 'repo' | 'commitMessage'>,
  branch: string,
  commits: readonly GithubCommit[],
) {
  const latest = commits[0]!;
  const author = latest.author?.login ?? latest.commit.author?.name ?? null;
  const vars = { title: firstLine(latest.commit.message), channel: follow.repo, url: latest.html_url, author };
  const fallback = commits.length === 1
    ? `📝 Nouveau commit sur **${follow.repo}** (\`${branch}\`)`
    : `📝 ${commits.length} nouveaux commits sur **${follow.repo}** (\`${branch}\`)`;

  const lines = commits.slice(0, MAX_COMMITS_LISTED).map((c) => {
    const who = c.author?.login ?? c.commit.author?.name ?? '?';
    return `[\`${c.sha.slice(0, 7)}\`](${c.html_url}) ${truncate(firstLine(c.commit.message), 80)} - ${who}`;
  });
  if (commits.length > MAX_COMMITS_LISTED) lines.push(`… et ${commits.length - MAX_COMMITS_LISTED} autres`);

  const embed = baseEmbed(GITHUB_COLOR)
    .setAuthor({ name: follow.repo, url: `https://github.com/${follow.repo}`, iconURL: latest.author?.avatar_url })
    .setTitle(truncate(`[${follow.repo}:${branch}] ${commits.length} commit${commits.length > 1 ? 's' : ''}`, 256))
    .setURL(commits.length === 1 ? latest.html_url : `https://github.com/${follow.repo}/commits/${encodeURIComponent(branch)}`)
    .setDescription(truncate(lines.join('\n'), 4000));

  return { content: resolveFollowMessage(follow.commitMessage, fallback, vars), embeds: [embed] };
}

export function buildReleaseAlert(follow: Pick<GithubRepoFollow, 'repo' | 'releaseMessage'>, release: GithubRelease) {
  const title = release.name?.trim() || release.tag_name;
  const vars = { title, channel: follow.repo, url: release.html_url, author: release.author?.login ?? null };
  const label = release.prerelease ? 'Pré-version' : 'Nouvelle version';
  const embed = baseEmbed(GITHUB_COLOR)
    .setAuthor({ name: follow.repo, url: `https://github.com/${follow.repo}`, iconURL: release.author?.avatar_url })
    .setTitle(truncate(templateHasVariable(follow.releaseMessage, 'title') ? title : `${label} : ${title}`, 256))
    .setURL(release.html_url)
    .setDescription(truncate(release.body?.trim() || `Tag \`${release.tag_name}\``, 1500));
  return {
    content: resolveFollowMessage(follow.releaseMessage, `🚀 ${label} de **${follow.repo}** : ${title}`, vars),
    embeds: [embed],
  };
}

export function buildIssueAlert(
  follow: Pick<GithubRepoFollow, 'repo' | 'pullRequestMessage' | 'issueMessage'>,
  item: GithubIssue,
  kind: 'pull' | 'issue',
) {
  const template = kind === 'pull' ? follow.pullRequestMessage : follow.issueMessage;
  const vars = { title: item.title, channel: follow.repo, url: item.html_url, author: item.user?.login ?? null };
  const fallback = kind === 'pull'
    ? `🔀 Nouvelle pull request sur **${follow.repo}** : ${item.title}`
    : `🐛 Nouvelle issue sur **${follow.repo}** : ${item.title}`;
  const embed = baseEmbed(GITHUB_COLOR)
    .setAuthor({ name: item.user?.login ?? follow.repo, iconURL: item.user?.avatar_url, url: item.user?.html_url })
    .setTitle(truncate(`#${item.number} ${item.title}`, 256))
    .setURL(item.html_url);
  const body = item.body?.trim();
  if (body) embed.setDescription(truncate(body, 1000));
  return { content: resolveFollowMessage(template, fallback, vars), embeds: [embed] };
}

// ==================== BOUCLE PRINCIPALE ====================

type FollowWithGuild = GithubRepoFollow & { guild: { publicChannelId: string | null } };

/** Une réponse par chemin et par passage : plusieurs serveurs suivent souvent le même dépôt. */
function memoizedGet(fetchImpl: FetchLike) {
  const memo = new Map<string, Promise<GithubResult<unknown>>>();
  return <T>(path: string): Promise<GithubResult<T>> => {
    let pending = memo.get(path);
    if (!pending) {
      pending = githubGet<unknown>(path, fetchImpl);
      memo.set(path, pending);
    }
    return pending as Promise<GithubResult<T>>;
  };
}

export async function checkGithubFollows(client: Client, fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    const follows = await prisma.githubRepoFollow.findMany({
      include: { guild: { select: { publicChannelId: true } } },
    }) as FollowWithGuild[];
    if (follows.length === 0) return;

    const get = memoizedGet(fetchImpl);
    const branches = new Map<string, Promise<string | null>>();
    const defaultBranch = (repo: string) => {
      let pending = branches.get(repo);
      if (!pending) {
        pending = get<{ default_branch: string }>(`/repos/${repo}`).then((r) => (r.ok ? r.data.default_branch : null));
        branches.set(repo, pending);
      }
      return pending;
    };

    for (const follow of follows) {
      if (Date.now() < rateLimitedUntil) return;
      if (!(await isModuleEnabled(follow.guildId, 'social_networks'))) continue;
      await processFollow(client, follow, get, defaultBranch).catch((error) =>
        logger.error('GithubService', `Suivi ${follow.repo} (guilde ${follow.guildId}) en échec :`, error));
    }
  } catch (error) {
    logger.error('GithubService', 'Erreur pendant la vérification des dépôts GitHub :', error);
  }
}

async function processFollow(
  client: Client,
  follow: FollowWithGuild,
  get: ReturnType<typeof memoizedGet>,
  defaultBranch: (repo: string) => Promise<string | null>,
): Promise<void> {
  const update: Partial<GithubRepoFollow> = {};
  const send = (message: { content: string; embeds: ReturnType<typeof baseEmbed>[] }) =>
    sendFollowAlert(client, follow, follow.guild.publicChannelId, message, 'GithubService');
  const repoPath = `/repos/${follow.repo}`;

  // Un type désactivé oublie sa référence : réactivé plus tard, il repartira du
  // présent au lieu d'annoncer tout ce qui s'est passé entre-temps.
  if (follow.notifyCommits) {
    const branch = follow.branch ?? (await defaultBranch(follow.repo));
    const res = branch ? await get<GithubCommit[]>(`${repoPath}/commits?sha=${encodeURIComponent(branch)}&per_page=20`) : null;
    if (branch && res?.ok && res.data.length > 0) {
      const latest = res.data[0]!.sha;
      if (follow.lastCommitSha && follow.lastCommitSha !== latest) {
        const fresh = itemsSince(res.data, (c) => c.sha === follow.lastCommitSha);
        if (fresh.length > 0) await send(buildCommitsAlert(follow, branch, fresh));
      }
      if (follow.lastCommitSha !== latest) update.lastCommitSha = latest;
    }
  } else if (follow.lastCommitSha) {
    update.lastCommitSha = null;
  }

  if (follow.notifyReleases) {
    const res = await get<GithubRelease[]>(`${repoPath}/releases?per_page=10`);
    if (res.ok) {
      const published = res.data.filter((r) => !r.draft);
      const latest = published[0] ? String(published[0].id) : null;
      if (follow.lastReleaseId && latest && latest !== follow.lastReleaseId) {
        const fresh = itemsSince(published, (r) => String(r.id) === follow.lastReleaseId).slice(0, MAX_ITEMS_PER_TYPE);
        for (const release of fresh.reverse()) await send(buildReleaseAlert(follow, release));
      }
      // Dépôt sans release : la référence « aucune » est posée pour que la
      // première release publiée soit annoncée.
      const reference = latest ?? 'none';
      if (follow.lastReleaseId !== reference) update.lastReleaseId = reference;
    }
  } else if (follow.lastReleaseId) {
    update.lastReleaseId = null;
  }

  if (follow.notifyPullRequests) {
    const res = await get<GithubIssue[]>(`${repoPath}/pulls?state=all&sort=created&direction=desc&per_page=10`);
    if (res.ok) {
      const max = res.data.reduce((acc, p) => Math.max(acc, p.number), 0);
      if (follow.lastPullNumber !== null) {
        const fresh = res.data.filter((p) => p.number > follow.lastPullNumber!).slice(0, MAX_ITEMS_PER_TYPE);
        for (const pull of fresh.reverse()) await send(buildIssueAlert(follow, pull, 'pull'));
      }
      if (follow.lastPullNumber === null || max > follow.lastPullNumber) update.lastPullNumber = max;
    }
  } else if (follow.lastPullNumber !== null) {
    update.lastPullNumber = null;
  }

  if (follow.notifyIssues) {
    const res = await get<GithubIssue[]>(`${repoPath}/issues?state=all&sort=created&direction=desc&per_page=20`);
    if (res.ok) {
      const issues = res.data.filter((i) => !i.pull_request);
      const max = issues.reduce((acc, i) => Math.max(acc, i.number), 0);
      if (follow.lastIssueNumber !== null) {
        const fresh = issues.filter((i) => i.number > follow.lastIssueNumber!).slice(0, MAX_ITEMS_PER_TYPE);
        for (const issue of fresh.reverse()) await send(buildIssueAlert(follow, issue, 'issue'));
      }
      if (follow.lastIssueNumber === null || max > follow.lastIssueNumber) update.lastIssueNumber = max;
    }
  } else if (follow.lastIssueNumber !== null) {
    update.lastIssueNumber = null;
  }

  if (Object.keys(update).length > 0) {
    await prisma.githubRepoFollow.update({ where: { id: follow.id }, data: update });
  }
}
