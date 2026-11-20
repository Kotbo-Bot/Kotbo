import { describe, expect, test } from 'bun:test';
import {
  BroadcastValidationError,
  DEFAULT_BROADCAST_FOOTER_EN,
  DEFAULT_BROADCAST_TITLE_EN,
  normalizeBroadcastContent,
  pickBroadcastLocale,
  pickBroadcastText,
} from '../../services/system/broadcastService.js';

const base = { title: 'Titre', message: 'Bonjour', footerText: 'Pied' };
const en = { en: { title: 'Title', message: 'Hello', footerText: 'Foot' } };

describe('pickBroadcastLocale', () => {
  test('le choix explicite du serveur prime sur la langue Discord', () => {
    expect(pickBroadcastLocale('fr', 'en-US')).toBe('fr');
    expect(pickBroadcastLocale('en', 'fr')).toBe('en');
  });

  test('sans choix explicite, suit la langue Discord puis retombe sur l’anglais', () => {
    expect(pickBroadcastLocale(null, 'fr')).toBe('fr');
    expect(pickBroadcastLocale(null, 'es-ES')).toBe('en');
    expect(pickBroadcastLocale(undefined, undefined)).toBe('en');
  });
});

describe('pickBroadcastText', () => {
  test('envoie la variante anglaise aux serveurs anglophones', () => {
    expect(pickBroadcastText(base, en, 'en')).toEqual({ title: 'Title', message: 'Hello', footerText: 'Foot' });
  });

  test('garde le français pour les serveurs francophones', () => {
    expect(pickBroadcastText(base, en, 'fr')).toBe(base);
  });

  test('sans variante anglaise, tout le monde reçoit le texte de base', () => {
    expect(pickBroadcastText(base, null, 'en')).toBe(base);
    expect(pickBroadcastText(base, { en: { title: 'Title' } }, 'en')).toBe(base);
  });
});

describe('normalizeBroadcastContent : traductions', () => {
  test('sans traduction, renvoie null', () => {
    expect(normalizeBroadcastContent({ message: 'Salut' }).translations).toBeNull();
  });

  test('titre et pied anglais vides retombent sur les défauts anglais', () => {
    const { translations } = normalizeBroadcastContent({ message: 'Salut', translations: { en: { message: 'Hi' } } });
    expect(translations?.en?.title).toBe(DEFAULT_BROADCAST_TITLE_EN);
    expect(translations?.en?.footerText).toBe(DEFAULT_BROADCAST_FOOTER_EN);
  });

  test('titre personnalisé conservé quand le titre anglais est vide', () => {
    const { translations } = normalizeBroadcastContent({ title: 'Maintenance', message: 'Salut', translations: { en: { message: 'Hi' } } });
    expect(translations?.en?.title).toBe('Maintenance');
  });

  test('refuse un titre anglais sans message anglais', () => {
    expect(() => normalizeBroadcastContent({ message: 'Salut', translations: { en: { title: 'Only title' } } }))
      .toThrow(BroadcastValidationError);
  });
});
