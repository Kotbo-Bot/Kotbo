import { describe, expect, test } from 'bun:test';
import { fuzzyScore, moduleKeywords, normalize, score } from './paletteSearch';

const sanctions = { label: 'Sanctions', group: 'Sécurité', keywords: moduleKeywords('/security/sanctions') };
const croissance = { label: 'Statistiques › Croissance', group: 'Général' };
const bestiaire = { label: 'Économie › Bestiaire', group: 'Économie' };

describe('paletteSearch', () => {
  test('un sujet trouve la page par la description de son module', () => {
    expect(sanctions.keywords).toContain('bans');
    expect(score(sanctions, normalize('ban'))).toBeGreaterThan(0);
  });

  test('le nom passe avant les mots-cles', () => {
    expect(score(sanctions, 'sanc')).toBeGreaterThan(score(croissance, 'sanc'));
  });

  test('plusieurs mots, dans n importe quel ordre', () => {
    expect(score(bestiaire, normalize('bestiaire eco'))).toBeGreaterThan(0);
    expect(score(bestiaire, normalize('bestiaire xyz'))).toBe(0);
  });

  test('une faute de frappe reste toleree', () => {
    expect(fuzzyScore(sanctions, 'sactions')).toBeGreaterThan(0);
  });
});
