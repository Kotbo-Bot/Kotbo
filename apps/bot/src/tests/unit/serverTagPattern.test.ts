import { describe, expect, test } from 'bun:test';
import { MAX_SERVER_TAG_LENGTH, normalizeTagList, tagPatternMaxLength } from '@kotbo/shared';

describe('tagPatternMaxLength', () => {
  test('un tag de serveur Discord fait 4 caractères au plus', () => {
    expect(MAX_SERVER_TAG_LENGTH).toBe(4);
  });

  test('les modes exact et contient sont bornés à la longueur d\'un tag', () => {
    expect(tagPatternMaxLength('EXACT')).toBe(MAX_SERVER_TAG_LENGTH);
    expect(tagPatternMaxLength('CONTAINS')).toBe(MAX_SERVER_TAG_LENGTH);
  });

  test('une expression régulière garde la place de décrire plusieurs tags', () => {
    expect(tagPatternMaxLength('REGEX')).toBe(100);
  });
});

describe('normalizeTagList', () => {
  test('met en capitales, écarte les vides, les doublons et les tags trop longs', () => {
    expect(normalizeTagList([' ss', 'SS', '', 'toolong', 14, '14'])).toEqual(['SS', '14']);
  });
});
