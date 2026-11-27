import { describe, expect, test } from 'bun:test';
import { resumeStep, stepsFor, stepsOfTrack } from './steps';
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

  // Plafonds à baisser quand on raccourcit le parcours, jamais à relever sans y penser.
  test('le parcours par défaut d’un serveur neuf ne dépasse pas sept écrans', () => {
    expect(stepsFor(defaultTracks('new'), 'new').length).toBeLessThanOrEqual(7);
  });

  test('un serveur déjà organisé ne dépasse pas neuf écrans', () => {
    expect(stepsFor(defaultTracks('existing'), 'existing', { structured: true }).length).toBeLessThanOrEqual(9);
  });
});

describe('installation express', () => {
  const express = ['structure', 'moderation', 'greeting'] as const;

  test('serveur neuf : démarrage, structure, mise en service', () => {
    expect(stepsFor(express, 'new', { express: true })).toEqual(['tracks', 'structure', 'checkout']);
  });

  test('serveur habité : la reprise et le rattachement restent imposés', () => {
    expect(stepsFor(express, 'existing', { structured: true, express: true })).toEqual([
      'tracks', 'migration-bots', 'migration-findings', 'map-access', 'structure', 'checkout',
    ]);
  });
});

describe('reprise d’un parcours enregistré avant la fusion des écrans', () => {
  test('un écran disparu renvoie à celui qui l’a absorbé', () => {
    expect(['welcome', 'kind', 'identity', 'map-voice', 'recap', 'inconnu', null].map(resumeStep))
      .toEqual(['tracks', 'tracks', 'theme', 'map-access', 'checkout', 'tracks', 'tracks']);
    expect(resumeStep('rules')).toBe('rules');
  });
});

describe('nombre d’écrans annoncé', () => {
  test('« La structure » : un écran sur un serveur vide, le rattachement en plus sur un serveur habité', () => {
    expect(stepsOfTrack('structure', 'new')).toEqual(['structure']);
    expect(stepsOfTrack('structure', 'new', { structured: true })).toEqual(['map-access', 'structure']);
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
