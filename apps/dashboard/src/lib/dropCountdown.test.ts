import { describe, test, expect } from 'bun:test';
import { dropCountdown } from './dropCountdown';

/**
 * Le panneau d'état dit quand tombe le prochain drop en temps relatif : « dans 12 minutes »
 * se lit d'un coup d'oeil, une date complète oblige à regarder l'heure.
 */
const now = new Date('2026-11-13T12:00:00Z');
const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60 * 1000);

describe('compte à rebours du prochain drop', () => {
  test('moins d\'une heure : en minutes, arrondies au-dessus', () => {
    expect(dropCountdown(inMinutes(12), now, 'fr')).toBe('dans 12 minutes');
    expect(dropCountdown(new Date(now.getTime() + 30 * 1000), now, 'fr')).toBe('dans 1 minute');
  });

  test('une heure ou plus : en heures', () => {
    expect(dropCountdown(inMinutes(60), now, 'fr')).toBe('dans 1 heure');
    expect(dropCountdown(inMinutes(150), now, 'fr')).toBe('dans 3 heures');
  });

  test('suit la langue de l\'interface', () => {
    expect(dropCountdown(inMinutes(12), now, 'en')).toBe('in 12 minutes');
  });
});
