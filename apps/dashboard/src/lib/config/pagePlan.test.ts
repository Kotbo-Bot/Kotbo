import { describe, expect, mock, test } from 'bun:test';
// pages.ts appelle les traductions au chargement : un m.* vide suffit ici.
mock.module('../i18n', () => ({ m: new Proxy({}, { get: () => () => '' }) }));
const { pagePlan } = await import('./pages');

describe('pagePlan', () => {
  test('module hors offre gratuite : couronne Plus', () => {
    expect(pagePlan({ name: '', href: '/forms', featureKey: 'custom_forms' })).toBe('plus');
  });

  test('module gratuit ou page du cœur : pas de couronne', () => {
    expect(pagePlan({ name: '', href: '/logs', featureKey: 'logs' })).toBeNull();
    expect(pagePlan({ name: '', href: '/billing', featureKey: 'settings' })).toBeNull();
  });

  test('le marquage explicite l’emporte sur le module', () => {
    expect(pagePlan({ name: '', href: '/custom-bot', featureKey: 'settings', plan: 'plus' })).toBe('plus');
    expect(pagePlan({ name: '', href: '/analytics', featureKey: 'analytics', plan: 'freemium' })).toBe('freemium');
  });
});
