import { describe, expect, test } from 'bun:test';
import { chunkText, excerptOf, prepareText, textFingerprint } from '../../services/moderation/aegis/aegisText';

describe('prepareText', () => {
  test('retire mentions, emojis maison, liens et horodatages', () => {
    expect(prepareText('<@123456789012345678> regarde <:pepe:123456789012345678> https://x.y/z <t:1700000000:R> ici'))
      .toBe('regarde ici');
  });

  test("ne garde rien quand il n'y a pas de lettre", () => {
    expect(prepareText('😂😂😂')).toBeNull();
    expect(prepareText('<@123456789012345678>')).toBeNull();
    expect(prepareText('!!! 123')).toBeNull();
    expect(prepareText('')).toBeNull();
    expect(prepareText('a')).toBeNull();
  });

  test('garde un message court mais lisible', () => {
    expect(prepareText('fdp')).toBe('fdp');
    expect(prepareText('  ça   va  ')).toBe('ça va');
  });
});

describe('chunkText', () => {
  test('ne touche pas un message court', () => {
    expect(chunkText('bonjour')).toEqual(['bonjour']);
  });

  test('coupe aux espaces et borne le nombre de morceaux', () => {
    const text = 'mot '.repeat(500).trim();
    const chunks = chunkText(text, 100, 3);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.startsWith(' ') || chunk.endsWith(' ')).toBe(false);
    }
  });

  test('coupe net un mot démesuré', () => {
    expect(chunkText('a'.repeat(250), 100, 4)).toEqual(['a'.repeat(100), 'a'.repeat(100), 'a'.repeat(50)]);
  });
});

describe('textFingerprint', () => {
  test('ignore la casse', () => {
    expect(textFingerprint('Connard')).toBe(textFingerprint('connard'));
    expect(textFingerprint('a')).not.toBe(textFingerprint('b'));
  });
});

describe('excerptOf', () => {
  test('aplatit et tronque', () => {
    expect(excerptOf('a\n\nb')).toBe('a b');
    expect(excerptOf('x'.repeat(600), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
