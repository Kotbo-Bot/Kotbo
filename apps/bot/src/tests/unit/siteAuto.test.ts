/**
 * Site automatique : réglages relus, titre tiré d'une annonce, semaine ISO.
 */
import { describe, expect, test } from 'bun:test';
import { isoWeekKey, normalizeSiteAuto, splitAnnouncement } from '@kotbo/shared';

describe('réglages du site automatique', () => {
  test('valeurs par défaut et bornes', () => {
    const auto = normalizeSiteAuto({ announcements: { enabled: true, channelIds: ['123456789012345678', 'nope', '123456789012345678'], tag: ' Infos Serveur ', minLength: -4 }, weeklySummary: { enabled: true, weekday: 9, hour: '25' } });
    expect(auto.announcements).toEqual({ enabled: true, channelIds: ['123456789012345678'], tag: 'infos-serveur', minLength: 0 });
    expect(auto.weeklySummary).toEqual({ enabled: true, weekday: 6, hour: 23 });
    expect(normalizeSiteAuto(null).modulePages.enabled).toBe(false);
  });
});

describe('annonce → article', () => {
  test('titre Markdown, gras ou première ligne courte', () => {
    expect(splitAnnouncement('# Mise à jour 2.0\nVoici les nouveautés.', 'x')).toEqual({ title: 'Mise à jour 2.0', body: 'Voici les nouveautés.' });
    expect(splitAnnouncement('**Tournoi samedi**\nInscriptions ouvertes.', 'x').title).toBe('Tournoi samedi');
    expect(splitAnnouncement('Soirée jeux ce soir\nRendez-vous à 21 h.', 'x').title).toBe('Soirée jeux ce soir');
  });

  test('un long paragraphe garde le titre de repli et tout son texte', () => {
    const text = 'Bonjour à tous, '.repeat(10).trim();
    expect(splitAnnouncement(text, 'Annonce du 10 octobre')).toEqual({ title: 'Annonce du 10 octobre', body: text });
  });
});

describe('semaine ISO', () => {
  test('lundi et dimanche de la même semaine, passage d’année', () => {
    expect(isoWeekKey(new Date('2026-10-05T10:00:00Z'))).toBe(isoWeekKey(new Date('2026-10-11T10:00:00Z')));
    expect(isoWeekKey(new Date('2026-10-12T10:00:00Z'))).not.toBe(isoWeekKey(new Date('2026-10-11T10:00:00Z')));
    expect(isoWeekKey(new Date('2027-01-01T10:00:00Z'))).toBe('2026-W53');
  });
});
