/**
 * JSON Discord du sticky : ce que la saisie du dashboard peut faire publier.
 *
 * Le JSON part tel quel vers Discord à chaque renvoi : un champ inattendu qui
 * passerait ici échouerait en silence à chaque seuil franchi.
 */
import { describe, expect, test } from 'bun:test';
import { parseStickyJsonPayload } from '../../services/features/stickyMessageService.js';

describe('parseStickyJsonPayload', () => {
  test('garde le texte, les embeds et les composants', () => {
    const result = parseStickyJsonPayload(JSON.stringify({
      content: 'Règles',
      embeds: [{ title: 'Bienvenue', description: 'Lis le salon' }],
      components: [],
      username: 'ignoré',
    }));
    expect(result).toEqual({
      ok: true,
      payload: { content: 'Règles', embeds: [{ title: 'Bienvenue', description: 'Lis le salon' }], components: [] },
    });
  });

  test('refuse un JSON vide, mal formé ou trop chargé', () => {
    expect(parseStickyJsonPayload('{}').ok).toBe(false);
    expect(parseStickyJsonPayload('{"content": ').ok).toBe(false);
    expect(parseStickyJsonPayload('[1]').ok).toBe(false);
    expect(parseStickyJsonPayload(JSON.stringify({ embeds: Array.from({ length: 11 }, () => ({})) })).ok).toBe(false);
    expect(parseStickyJsonPayload(JSON.stringify({ content: 'x'.repeat(2001) })).ok).toBe(false);
  });

  test('seul le drapeau des composants v2 passe', () => {
    expect(parseStickyJsonPayload(JSON.stringify({ flags: 32768, components: [{ type: 10, content: 'x' }] })).ok).toBe(true);
    expect(parseStickyJsonPayload(JSON.stringify({ content: 'x', flags: 4 })).ok).toBe(false);
  });
});
