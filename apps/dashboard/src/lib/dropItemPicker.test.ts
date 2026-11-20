import { describe, test, expect } from 'bun:test';
import { matchesItemQuery, sortItemsByRarity } from './dropItemPicker';

/**
 * Le choix des objets d'un drop doit rester praticable sur un gros catalogue : tri par
 * rareté pour trouver les pièces précieuses, recherche qui ignore accents et casse.
 */
const item = (name: string, rarity: string) => ({ id: name, name, emoji: '', rarity });

describe('liste des objets d\'un drop', () => {
  test('tri par rareté, puis par nom ; une rareté inconnue est rangée avec les communes', () => {
    const sorted = sortItemsByRarity([
      item('Lame', 'LEGENDARY'),
      item('Potion', 'COMMON'),
      item('Arc', 'COMMON'),
      item('Relique', 'MYSTERE'),
      item('Bouclier', 'RARE'),
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['Arc', 'Potion', 'Relique', 'Bouclier', 'Lame']);
  });

  test('la recherche ignore accents et majuscules', () => {
    const epee = item('Épée du Crépuscule', 'EPIC');
    expect(matchesItemQuery(epee, 'epee')).toBe(true);
    expect(matchesItemQuery(epee, 'CREPUS')).toBe(true);
    expect(matchesItemQuery(epee, 'arc')).toBe(false);
    expect(matchesItemQuery(epee, '  ')).toBe(true);
  });
});
