import { describe, expect, test } from 'bun:test';
import { parseDurationToMs } from '../../utils/sanctionDuration';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('parseDurationToMs', () => {
  test('lit les unités courtes déjà connues', () => {
    expect(parseDurationToMs('30m')).toBe(30 * 60 * 1000);
    expect(parseDurationToMs('3j')).toBe(3 * DAY_MS);
    expect(parseDurationToMs('1 semaine')).toBe(7 * DAY_MS);
  });

  test('accepte les mois, comptés 30 jours', () => {
    expect(parseDurationToMs('6 mois')).toBe(180 * DAY_MS);
    expect(parseDurationToMs('6mo')).toBe(180 * DAY_MS);
    expect(parseDurationToMs('2 months')).toBe(60 * DAY_MS);
  });

  test('accepte les années, comptées 365 jours', () => {
    expect(parseDurationToMs('1 an')).toBe(365 * DAY_MS);
    expect(parseDurationToMs('2 ans')).toBe(730 * DAY_MS);
    expect(parseDurationToMs('1y')).toBe(365 * DAY_MS);
  });

  test('« m » reste des minutes, pas des mois', () => {
    expect(parseDurationToMs('6m')).toBe(6 * 60 * 1000);
  });

  test('combine plusieurs unités', () => {
    expect(parseDurationToMs('1 an 2 mois')).toBe(425 * DAY_MS);
  });

  test('refuse une unité inconnue ou une saisie vide', () => {
    expect(parseDurationToMs('3 siècles')).toBeNull();
    expect(parseDurationToMs('')).toBeNull();
  });
});
