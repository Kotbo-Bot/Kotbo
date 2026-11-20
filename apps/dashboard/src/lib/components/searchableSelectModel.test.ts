import { describe, expect, test } from 'bun:test';
import { displayedText, filterOptions } from './searchableSelectModel';

const options = [
  { id: '1', name: '🔊 ➕│Créer un vocal' },
  { id: '2', name: '🔊 ➕│Overwatch' },
  { id: '3', name: '🔊 ➕│Fortnite' },
];

describe('filterOptions', () => {
  test('le nom du choix courant ne filtre pas la liste', () => {
    expect(filterOptions(options, '🔊 ➕│Créer un vocal', '🔊 ➕│Créer un vocal')).toHaveLength(3);
  });

  test('une saisie differente du choix courant filtre', () => {
    expect(filterOptions(options, 'over', '🔊 ➕│Créer un vocal').map((o) => o.id)).toEqual(['2']);
  });

  test('sans choix courant, le texte filtre normalement', () => {
    expect(filterOptions(options, 'creer', null).map((o) => o.id)).toEqual(['1']);
  });

  test('recherche par identifiant', () => {
    expect(filterOptions(options, '3', null).map((o) => o.id)).toEqual(['3']);
  });

  test('les doublons sont retires', () => {
    expect(filterOptions([...options, options[0]], '', null)).toHaveLength(3);
  });
});

describe('displayedText', () => {
  test('nom du choix courant', () => {
    expect(displayedText('2', options)).toBe('🔊 ➕│Overwatch');
  });

  test('vide sans choix', () => {
    expect(displayedText(null, options)).toBe('');
  });

  test('null tant que le choix manque des options', () => {
    expect(displayedText('9', options)).toBeNull();
  });
});
