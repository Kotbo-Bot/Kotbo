import { describe, test, expect } from 'bun:test';
import { formatDuration, presetsWithin } from './durationFormat';

/**
 * Les durées des drops se règlent en minutes : « 1440 » ne se lit pas d'un coup d'oeil.
 * Chaque champ affiche son équivalent, et propose des crans dans ses bornes.
 */
// Intl sépare nombre et unité d'une espace insécable, fine ou non selon la version
// d'ICU : le test compare le texte, pas la variante d'espace.
const lisible = (minutes: number) => formatDuration(minutes, 'fr-FR').replace(/[\u00a0\u202f]/g, ' ');

describe('durées lisibles', () => {
  test('minutes, heures et jours, dans la langue de l\'interface', () => {
    expect(lisible(45)).toBe('45 min');
    expect(lisible(360)).toBe('6 h');
    expect(lisible(90)).toBe('1 h 30 min');
    expect(lisible(1440)).toBe('1 j');
    expect(lisible(10_080)).toBe('7 j');
  });

  test('une valeur absente ou nulle ne s\'affiche pas', () => {
    expect(formatDuration(Number.NaN, 'fr-FR')).toBe('');
    expect(formatDuration(0, 'fr-FR')).toBe('');
  });

  test('seuls les crans dans les bornes du champ sont proposés', () => {
    expect(presetsWithin([1, 5, 60, 2000], { min: 5, max: 1440 })).toEqual([5, 60]);
  });
});
