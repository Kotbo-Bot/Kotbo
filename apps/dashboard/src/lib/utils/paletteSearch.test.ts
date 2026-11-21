import { describe, expect, test } from 'bun:test';
import { contentScore, fuzzyScore, moduleKeywords, normalize, pageWords, score } from './paletteSearch';

const sanctions = { label: 'Sanctions', group: 'Sécurité', keywords: moduleKeywords('/security/sanctions') };
const croissance = { label: 'Statistiques › Croissance', group: 'Général' };
const bestiaire = { label: 'Économie › Bestiaire', group: 'Économie' };

describe('paletteSearch', () => {
  test('un sujet trouve la page par la description de son module', () => {
    expect(sanctions.keywords).toContain('bans');
    expect(score(sanctions, normalize('ban'))).toBeGreaterThan(0);
  });

  test('un terme associe trouve une page hors registre des modules', () => {
    const mcp = { label: 'Connecter une IA', group: 'Intégrations', keywords: moduleKeywords('/mcp-settings') };
    expect(score(mcp, 'mcp')).toBeGreaterThan(0);
    const billing = { label: 'Facturation', group: 'Compte', keywords: moduleKeywords('/billing') };
    expect(score(billing, normalize('abonnement'))).toBeGreaterThan(0);
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

describe('recherche dans le texte des pages', () => {
  const index = {
    '/backups': { fr: 'copie restaure sauvegarde salons', en: 'copy restore backup' },
    '/backups/export': { fr: 'fichier exporter', en: 'file export' },
    '/economy': { fr: 'boutique pieces bestiaire', en: 'shop coins' },
  };

  test('prend la route la plus précise', () => {
    expect(pageWords(index, '/backups/export', 'fr')?.has('exporter')).toBe(true);
    expect(pageWords(index, '/backups/autre', 'fr')?.has('sauvegarde')).toBe(true);
    expect(pageWords(index, '/inconnu', 'fr')).toBeUndefined();
  });

  test('tous les mots doivent figurer dans la page, dans n’importe quel ordre', () => {
    const words = pageWords(index, '/economy', 'fr');
    expect(contentScore(words, 'bestiaire boutique')).toBeGreaterThan(0);
    expect(contentScore(words, 'bestiaire inconnu')).toBe(0);
  });

  test('accepte un début de mot et passe un mot entier devant', () => {
    const words = pageWords(index, '/economy', 'fr');
    expect(contentScore(words, 'best')).toBeGreaterThan(0);
    expect(contentScore(words, 'bestiaire')).toBeGreaterThan(contentScore(words, 'best'));
  });

  test('ne cherche pas en dessous de trois lettres', () => {
    expect(contentScore(pageWords(index, '/economy', 'fr'), 'bo')).toBe(0);
  });
});
