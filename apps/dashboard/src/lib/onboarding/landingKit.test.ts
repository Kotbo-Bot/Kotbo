import { describe, test, expect } from 'bun:test';
import { parseLandingKit } from './landingKit';

/**
 * Le `kit` arrive d'une URL publique, écrit par un dépôt séparé (la landing).
 * Ce qu'on vérifie ici : une chaîne bien formée donne les réponses attendues,
 * et tout le reste est écarté sans jamais faire échouer l'installation.
 */
describe('parseLandingKit', () => {
  test('lit vocation, modération et pistes, structure comprise', () => {
    expect(parseLandingKit('1.gaming.strict.greeting-tickets-levels')).toEqual({
      theme: 'gaming',
      moderation: 'strict',
      tracks: ['structure', 'greeting', 'tickets', 'levels'],
    });
  });

  test('range les pistes dans l ordre du parcours, pas dans celui de l URL', () => {
    expect(parseLandingKit('1.entraide.light.staff-greeting')?.tracks).toEqual(['structure', 'greeting', 'staff']);
  });

  test('ecarte une piste inconnue sans rejeter le reste', () => {
    expect(parseLandingKit('1.communaute.standard.greeting-teleportation')?.tracks).toEqual(['structure', 'greeting']);
  });

  test('accepte un serveur sans piste cochee', () => {
    expect(parseLandingKit('1.creation.light.none')?.tracks).toEqual(['structure']);
  });

  test('refuse une version, une vocation ou un niveau inconnus', () => {
    expect(parseLandingKit('2.gaming.strict.greeting')).toBeNull();
    expect(parseLandingKit('1.casino.strict.greeting')).toBeNull();
    expect(parseLandingKit('1.gaming.extreme.greeting')).toBeNull();
  });

  test('refuse tout caractere hors du jeu attendu', () => {
    expect(parseLandingKit('1.gaming.strict.greeting<script>')).toBeNull();
    expect(parseLandingKit('1.Gaming.strict.greeting')).toBeNull();
    expect(parseLandingKit('')).toBeNull();
    expect(parseLandingKit(null)).toBeNull();
    expect(parseLandingKit('1.gaming.strict.' + 'a'.repeat(200))).toBeNull();
  });
});
