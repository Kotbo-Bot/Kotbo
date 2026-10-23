/**
 * Tests unitaires de la censure de messages : seuls les passages interdits
 * sont masqués, le reste du message est conservé.
 */

import { describe, it, expect } from 'bun:test';
import {
  censorContent,
  classifyLink,
  findKeywordRanges,
  findLiteralRanges,
  INVITE_KEYWORDS,
  keywordToRegex,
  LINK_KEYWORDS,
  mergeRanges,
} from '../../services/moderation/censorship.js';

const MASK = /`[^`]+`/;

describe('keywordToRegex - sémantique AutoMod Discord', () => {
  it('sans astérisque, le mot doit être entier', () => {
    const regex = keywordToRegex('con')!;
    expect('un con ici'.match(regex)?.[0]).toBe('con');
    expect('une conférence'.match(regex)).toBeNull();
  });

  it('un astérisque étend la correspondance au reste du mot', () => {
    expect('connard'.match(keywordToRegex('con*')!)?.[0]).toBe('connard');
    expect('gros-mot'.match(keywordToRegex('*mot')!)?.[0]).toBe('gros-mot');
  });

  it('un lien est capté en entier, jusqu’à l’espace', () => {
    const regex = keywordToRegex('*https://*')!;
    expect('va sur https://exemple.com/a?b=1 stp'.match(regex)?.[0]).toBe('https://exemple.com/a?b=1');
  });

  it('ignore un mot-clé vide', () => {
    expect(keywordToRegex('**')).toBeNull();
    expect(keywordToRegex('  ')).toBeNull();
  });
});

describe('findKeywordRanges', () => {
  it('trouve chaque occurrence, pas seulement la première', () => {
    const ranges = findKeywordRanges('nul et nul', ['nul'], [], 'word');
    expect(ranges).toHaveLength(2);
  });

  it('respecte la liste d’exceptions', () => {
    const content = 'https://github.com/kotbo et https://arnaque.xyz';
    const ranges = findKeywordRanges(content, LINK_KEYWORDS, ['*github.com*'], 'link');
    expect(ranges).toHaveLength(1);
    expect(content.slice(ranges[0].start, ranges[0].end)).toBe('https://arnaque.xyz');
  });

  it('autorise l’invitation d’un serveur listé', () => {
    const content = 'discord.gg/ami et discord.gg/pub';
    const ranges = findKeywordRanges(content, INVITE_KEYWORDS, ['*discord.gg/ami*'], 'invite');
    expect(ranges).toHaveLength(1);
    expect(content.slice(ranges[0].start, ranges[0].end)).toBe('discord.gg/pub');
  });
});

describe('findLiteralRanges', () => {
  it('ignore la casse', () => {
    expect(findLiteralRanges('Truc TRUC truc', 'truc', 'word')).toHaveLength(3);
  });
});

describe('mergeRanges', () => {
  it('fusionne les chevauchements et garde le type le plus parlant', () => {
    const merged = mergeRanges([
      { start: 0, end: 10, kind: 'link' },
      { start: 5, end: 20, kind: 'invite' },
      { start: 30, end: 35, kind: 'word' },
    ]);
    expect(merged).toEqual([
      { start: 0, end: 20, kind: 'invite' },
      { start: 30, end: 35, kind: 'word' },
    ]);
  });
});

describe('censorContent', () => {
  it('garde le reste du message autour d’un lien', () => {
    const content = 'Alors que https://exemple.com existe :superdazedface:';
    const ranges = findKeywordRanges(content, LINK_KEYWORDS, [], 'link');
    const out = censorContent(content, ranges);

    expect(out.startsWith('Alors que `')).toBe(true);
    expect(out.endsWith('` *(lien censuré)* existe :superdazedface:')).toBe(true);
    expect(out).not.toContain('exemple.com');
  });

  it('masque un mot sans mention supplémentaire', () => {
    const out = censorContent('quel nul celui-là', findLiteralRanges('quel nul celui-là', 'nul', 'word'));
    expect(out).toMatch(/^quel `[^`]+` celui-là$/);
  });

  it('ne laisse aucun accent grave dans le masque', () => {
    const out = censorContent('abcdefghijklmnopqrstuvwxyz', [{ start: 0, end: 26, kind: 'word' }]);
    expect(out).toMatch(MASK);
    expect(out.slice(1, -1)).not.toContain('`');
    expect(out.length).toBe(18);
  });

  it('reste sous la limite Discord', () => {
    const content = 'a '.repeat(999) + 'b';
    const ranges = findLiteralRanges(content, 'a', 'word');
    expect(censorContent(content, ranges).length).toBeLessThanOrEqual(2000);
  });
});

describe('classifyLink', () => {
  it('distingue une invitation d’un lien ordinaire', () => {
    expect(classifyLink('https://discord.gg/abc')).toBe('invite');
    expect(classifyLink('discord.com/invite/abc')).toBe('invite');
    expect(classifyLink('https://discord.com/channels/1/2')).toBe('link');
  });
});
