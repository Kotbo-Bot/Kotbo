import { describe, expect, it } from 'bun:test';
import { matchesQuery } from './workflowSearch';

describe('matchesQuery', () => {
  it('garde tout quand la recherche est vide', () => {
    expect(matchesQuery('  ', ['Envoyer un message'])).toBe(true);
  });

  it('ignore la casse et les accents', () => {
    expect(matchesQuery('REACTION', ['Quand quelqu un ajoute une réaction'])).toBe(true);
    expect(matchesQuery('rôle', ['Donner un role'])).toBe(true);
  });

  it('cherche dans chacun des textes', () => {
    expect(matchesQuery('bienvenue', ['Quand un membre arrive', 'Souhaiter la bienvenue'])).toBe(true);
  });

  it('demande que chaque mot se retrouve quelque part', () => {
    expect(matchesQuery('membre bienvenue', ['Quand un membre arrive', 'Souhaiter la bienvenue'])).toBe(true);
    expect(matchesQuery('membre ticket', ['Quand un membre arrive', 'Souhaiter la bienvenue'])).toBe(false);
  });
});
