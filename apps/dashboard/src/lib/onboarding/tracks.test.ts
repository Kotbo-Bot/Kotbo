import { describe, expect, test } from 'bun:test';
import { stepsFor, stepsOfTrack } from './steps';
import { TRACKS, defaultTracks } from './tracks';

describe('ce qui est coché d’office', () => {
  // Chaque écran ajouté d'office est une occasion de partir avant la fin.
  test('serveur neuf : l’essentiel et le règlement', () => {
    expect(defaultTracks('new')).toEqual(['structure', 'moderation', 'greeting', 'rules']);
  });

  test('serveur habité : pas de second règlement', () => {
    expect(defaultTracks('existing')).toEqual(['structure', 'moderation', 'greeting']);
  });

  test('aucune offre payante n’est supposée', () => {
    const picked = [...defaultTracks('new'), ...defaultTracks('existing')];
    for (const paid of ['economy', 'animation', 'staff', 'mcp'] as const) expect(picked).not.toContain(paid);
  });

  // Plafond à baisser quand on raccourcit le parcours, jamais à relever sans y penser.
  test('le parcours par défaut d’un serveur neuf ne dépasse pas onze écrans', () => {
    expect(stepsFor(defaultTracks('new'), 'new').length).toBeLessThanOrEqual(11);
  });
});

describe('nombre d’écrans annoncé', () => {
  test('« La structure » : un écran sur un serveur vide, le mappage en plus sur un serveur habité', () => {
    expect(stepsOfTrack('structure', 'new')).toEqual(['structure']);
    expect(stepsOfTrack('structure', 'new', { structured: true })).toHaveLength(9);
  });

  test('le total annoncé correspond au parcours réellement traversé', () => {
    for (const structured of [false, true]) {
      const all = TRACKS.map((track) => track.key);
      const announced = all.reduce((sum, key) => sum + stepsOfTrack(key, 'new', { structured }).length, 0);
      const common = stepsFor([], 'new', { structured }).length;
      expect(common + announced).toBe(stepsFor(all, 'new', { structured }).length);
    }
  });
});
