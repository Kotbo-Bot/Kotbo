import { describe, expect, test } from 'bun:test';
import { buildRichLinkContainer, findRichLink, parseRichLink } from '../../services/integrations/richLinkService.js';

describe('parseRichLink', () => {
  test.each([
    ['https://github.com/oven-sh/bun', 'github_repo', ['oven-sh', 'bun']],
    ['https://www.github.com/kurodaki-dev/', 'github_user', ['kurodaki-dev']],
    ['https://github.com/oven-sh/bun/issues/12', 'github_issue', ['oven-sh', 'bun', '12']],
    ['https://github.com/oven-sh/bun/pull/7', 'github_issue', ['oven-sh', 'bun', '7']],
    ['https://twitter.com/jack/status/20?s=46', 'tweet', ['20']],
    ['https://x.com/jack/status/20', 'tweet', ['20']],
    ['https://bsky.app/profile/bsky.app/post/3mzhhvhjfwk22', 'bluesky', ['bsky.app', '3mzhhvhjfwk22']],
    ['https://www.tiktok.com/@tiktok/video/7106594312292453675?lang=fr', 'tiktok', ['https://www.tiktok.com/@tiktok/video/7106594312292453675']],
    ['https://vm.tiktok.com/ZMabc123/', 'tiktok', ['https://vm.tiktok.com/ZMabc123/']],
    ['https://www.instagram.com/reels/CuE2WNQs6vH/', 'instagram', ['reel', 'CuE2WNQs6vH']],
    ['https://www.instagram.com/google/p/CuE2WNQs6vH/', 'instagram', ['p', 'CuE2WNQs6vH']],
    ['https://www.youtube.com/@StevenTed', 'youtube_channel', ['@StevenTed']],
    ['https://store.steampowered.com/app/620/Portal_2/', 'steam', ['620']],
    ['https://www.npmjs.com/package/@sveltejs/kit', 'npm', ['@sveltejs/kit']],
    ['https://www.npmjs.com/package/svelte/v/5.0.0', 'npm', ['svelte']],
    ['https://pypi.org/project/requests/', 'pypi', ['requests']],
    ['https://crates.io/crates/serde', 'crate', ['serde']],
    ['https://huggingface.co/openai-community/gpt2', 'huggingface', ['openai-community', 'gpt2']],
    ['https://stackoverflow.com/questions/11227809/why-is', 'stackoverflow', ['11227809']],
  ])('%s', (url, kind, args) => {
    expect(parseRichLink(url)).toEqual({ kind, args });
  });

  test.each([
    'https://github.com/pricing',
    'https://github.com/oven-sh/bun/blob/main/README.md',
    'https://github.com.evil.example/oven-sh/bun',
    'https://x.com/jack',
    'https://x.com/jack/status/abc',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://huggingface.co/datasets/squad',
    'https://www.npmjs.com/package/..%2f..%2fetc',
    'https://www.tiktok.com/@tiktok',
    'pas une url',
  ])('laisse passer %s', (url) => {
    expect(parseRichLink(url)).toBeNull();
  });
});

describe('findRichLink', () => {
  test('prend le premier lien géré, sans la ponctuation collée', () => {
    expect(findRichLink('regarde https://example.com puis (https://github.com/oven-sh/bun).')).toEqual({
      kind: 'github_repo', args: ['oven-sh', 'bun'],
    });
  });

  test('ignore un lien masqué entre chevrons', () => {
    expect(findRichLink('<https://github.com/oven-sh/bun>')).toBeNull();
  });
});

test('la carte se sérialise avec vignette, avec images et sans chiffres', () => {
  const base = { title: 'a/b', url: 'https://github.com/a/b', openLabel: 'Ouvrir GitHub' };
  expect(() => buildRichLinkContainer({ ...base, stats: '⭐ 1', thumbnail: 'https://avatars.githubusercontent.com/u/1' }).toJSON()).not.toThrow();
  expect(() => buildRichLinkContainer({ ...base, images: ['attachment://apercu-0.jpg'] }).toJSON()).not.toThrow();
});
