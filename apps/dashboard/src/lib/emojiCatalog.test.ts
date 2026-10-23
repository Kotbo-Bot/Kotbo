import { describe, expect, it } from 'bun:test';
import data from 'emojibase-data/fr/compact.json';
import messages from 'emojibase-data/fr/messages.json';
import { buildCatalog, searchCatalog, matchesEmojiTerm, normalizeEmojiTerm } from './emojiCatalog';

const catalog = buildCatalog(data as never, messages as never);

describe('emojiCatalog', () => {
  it('écarte les composants et garde les neuf groupes affichables', () => {
    expect(catalog.map((g) => g.key)).toEqual([
      'smileys-emotion', 'people-body', 'animals-nature', 'food-drink',
      'travel-places', 'activities', 'objects', 'symbols', 'flags',
    ]);
  });

  it('trouve un emoji par son nom français, accents ou pas', () => {
    expect(searchCatalog(catalog, 'coeur rouge')[0]?.unicode).toBe('❤️');
    expect(searchCatalog(catalog, 'feu').some((e) => e.unicode === '🔥')).toBe(true);
    expect(searchCatalog(catalog, 'drapeau france').some((e) => e.unicode === '🇫🇷')).toBe(true);
  });

  it('demande que chaque mot tapé corresponde', () => {
    expect(matchesEmojiTerm(normalizeEmojiTerm('Cœur rouge amour'), 'rouge cœur')).toBe(true);
    expect(matchesEmojiTerm(normalizeEmojiTerm('Cœur rouge'), 'cœur bleu')).toBe(false);
    expect(searchCatalog(catalog, '   ')).toEqual([]);
  });
});
