import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildCommitsAlert,
  buildIssueAlert,
  githubGet,
  itemsSince,
  normalizeGithubBranch,
  normalizeGithubRepo,
  resetGithubStateForTests,
  resolveGithubRepo,
  type FetchLike,
  type GithubCommit,
} from '../../services/integrations/githubService';

function commit(sha: string, message = `Commit ${sha}`): GithubCommit {
  return {
    sha,
    html_url: `https://github.com/kotbo/bot/commit/${sha}`,
    commit: { message, author: { name: 'Elouan' } },
    author: { login: 'klaynight' },
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

afterEach(() => resetGithubStateForTests());

describe('normalizeGithubRepo', () => {
  test('accepte owner/repo et les URL du dépôt', () => {
    expect(normalizeGithubRepo('Kotbo-Bot/Kotbo')).toBe('kotbo-bot/kotbo');
    expect(normalizeGithubRepo('https://github.com/Kotbo-Bot/Kotbo')).toBe('kotbo-bot/kotbo');
    expect(normalizeGithubRepo('https://github.com/kotbo-bot/kotbo/tree/main/apps')).toBe('kotbo-bot/kotbo');
    expect(normalizeGithubRepo('git@github.com:kotbo-bot/kotbo.git')).toBe('kotbo-bot/kotbo');
  });

  test('refuse ce qui ne désigne pas un dépôt', () => {
    expect(normalizeGithubRepo('')).toBeNull();
    expect(normalizeGithubRepo('kotbo')).toBeNull();
    expect(normalizeGithubRepo('a/b/c')).toBeNull();
    expect(normalizeGithubRepo('-bad/repo')).toBeNull();
    expect(normalizeGithubRepo('owner/..')).toBeNull();
  });
});

describe('normalizeGithubBranch', () => {
  test('vide = branche par défaut, noms invalides refusés', () => {
    expect(normalizeGithubBranch('  ')).toBeNull();
    expect(normalizeGithubBranch('feat/ui-v2')).toBe('feat/ui-v2');
    expect(normalizeGithubBranch('a..b')).toBeNull();
    expect(normalizeGithubBranch('with space')).toBeNull();
  });
});

describe('itemsSince', () => {
  test('rend les éléments plus récents que le dernier vu', () => {
    const list = [commit('c3'), commit('c2'), commit('c1')];
    expect(itemsSince(list, (c) => c.sha === 'c2').map((c) => c.sha)).toEqual(['c3']);
    expect(itemsSince(list, (c) => c.sha === 'c3')).toEqual([]);
  });

  test('dernier vu absent de la page : toute la page est nouvelle', () => {
    const list = [commit('c3'), commit('c2')];
    expect(itemsSince(list, (c) => c.sha === 'old')).toHaveLength(2);
  });
});

describe('alertes', () => {
  test('plusieurs commits : un seul message qui les liste', () => {
    const alert = buildCommitsAlert({ repo: 'kotbo/bot', commitMessage: null }, 'main', [commit('aaaaaaa1', 'fix: a\n\ndetail'), commit('bbbbbbb2')]);
    expect(alert.content).toContain('2 nouveaux commits');
    const description = alert.embeds[0]!.data.description!;
    expect(description).toContain('`aaaaaaa`');
    expect(description).toContain('fix: a');
    expect(description).not.toContain('detail');
  });

  test('message personnalisé avec variables', () => {
    const alert = buildCommitsAlert({ repo: 'kotbo/bot', commitMessage: '[author] a poussé [title]' }, 'main', [commit('c1', 'feat: x')]);
    expect(alert.content).toBe('klaynight a poussé feat: x');
  });

  test('issue et pull request ont leur propre libellé', () => {
    const item = { number: 7, title: 'Bug', html_url: 'https://github.com/kotbo/bot/issues/7' };
    const follow = { repo: 'kotbo/bot', pullRequestMessage: null, issueMessage: null };
    expect(buildIssueAlert(follow, item, 'issue').content).toContain('Nouvelle issue');
    expect(buildIssueAlert(follow, item, 'pull').content).toContain('Nouvelle pull request');
    expect(buildIssueAlert(follow, item, 'issue').embeds[0]!.data.title).toBe('#7 Bug');
  });
});

describe('githubGet', () => {
  test('un 304 rend la réponse mise en cache par ETag', async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push(headers);
      return headers['If-None-Match'] ? response(304, null) : response(200, [{ id: 1 }], { etag: '"v1"' });
    };

    expect(await githubGet('/repos/kotbo/bot/releases', fetchImpl)).toEqual({ ok: true, data: [{ id: 1 }] });
    expect(await githubGet('/repos/kotbo/bot/releases', fetchImpl)).toEqual({ ok: true, data: [{ id: 1 }] });
    expect(calls[1]!['If-None-Match']).toBe('"v1"');
  });

  test('un quota épuisé suspend les appels suivants', async () => {
    let count = 0;
    const fetchImpl: FetchLike = async () => {
      count++;
      return response(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
    };

    expect((await githubGet('/repos/a/b', fetchImpl)).ok).toBeFalse();
    expect((await githubGet('/repos/a/c', fetchImpl)).ok).toBeFalse();
    expect(count).toBe(1);
  });
});

describe('resolveGithubRepo', () => {
  test('dépôt public : nom canonique en minuscules', async () => {
    const fetchImpl: FetchLike = async () => response(200, { full_name: 'Kotbo-Bot/Kotbo', default_branch: 'main', private: false });
    expect(await resolveGithubRepo('kotbo-bot/kotbo', fetchImpl)).toEqual({ ok: true, repo: 'kotbo-bot/kotbo', defaultBranch: 'main' });
  });

  test('la cause de l\'échec est conservée', async () => {
    const reasonFor = async (status: number, headers: Record<string, string> = {}) => {
      resetGithubStateForTests();
      const result = await resolveGithubRepo('a/b', async () => response(status, {}, headers));
      return result.ok ? null : result.reason;
    };
    expect(await reasonFor(404)).toBe('not_found');
    expect(await reasonFor(401)).toBe('unauthorized');
    expect(await reasonFor(403, { 'x-ratelimit-remaining': '0' })).toBe('rate_limited');
    expect(await reasonFor(403, { 'retry-after': '30' })).toBe('rate_limited');
    expect(await reasonFor(429)).toBe('rate_limited');
    expect(await reasonFor(502)).toBe('unavailable');
  });

  test('un 403 hors quota est un refus d\'accès, pas un quota', async () => {
    const result = await resolveGithubRepo('a/b', async () => response(403, { message: 'Resource protected by organization SAML enforcement.' }));
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    // Aucune pause posée : le dépôt suivant doit encore être interrogé.
    let called = false;
    await githubGet('/repos/a/c', async () => { called = true; return response(200, {}); });
    expect(called).toBeTrue();
  });

  test('un dépôt privé est traité comme introuvable', async () => {
    const fetchImpl: FetchLike = async () => response(200, { full_name: 'a/b', default_branch: 'main', private: true });
    expect(await resolveGithubRepo('a/b', fetchImpl)).toEqual({ ok: false, reason: 'not_found' });
  });
});
