import { describe, expect, test } from 'bun:test';
import { HATE_SYMBOLS, findHateSymbol } from '@kotbo/shared';

describe('findHateSymbol', () => {
  test('repère une croix gammée au milieu du texte', () => {
    expect(findHateSymbol('salut 卐 tout le monde', [])?.id).toBe('swastika');
  });

  test('repère les runes SS, même séparées par une espace ou un caractère invisible', () => {
    expect(findHateSymbol('ᛋ ᛋ', [])?.id).toBe('ss_runes');
    expect(findHateSymbol('ᛋ​ᛋ', [])?.id).toBe('ss_runes');
  });

  test('une rune isolée ne suffit pas', () => {
    expect(findHateSymbol('ᛋ', [])).toBe(null);
  });

  test('un symbole autorisé par le serveur passe', () => {
    expect(findHateSymbol('卍', ['manji'])).toBe(null);
    expect(findHateSymbol('卍', [])?.id).toBe('manji');
  });

  test('un texte ordinaire passe', () => {
    expect(findHateSymbol('Bonjour, ça va ?', [])).toBe(null);
  });

  test('chaque symbole a un identifiant unique', () => {
    const ids = HATE_SYMBOLS.map((symbol) => symbol.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
