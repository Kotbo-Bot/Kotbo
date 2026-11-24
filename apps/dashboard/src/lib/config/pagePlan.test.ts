import { describe, expect, test } from 'bun:test';
import { pagePlan, staffItems } from './pages';

describe('pagePlan', () => {
  test('module hors offre gratuite : couronne Plus', () => {
    expect(pagePlan({ name: '', href: '/seasons', featureKey: 'seasons' })).toBe('plus');
  });

  test('module gratuit ou page du cœur : pas de couronne', () => {
    expect(pagePlan({ name: '', href: '/logs', featureKey: 'logs' })).toBeNull();
    expect(pagePlan({ name: '', href: '/billing', featureKey: 'settings' })).toBeNull();
  });

  test('le marquage explicite l’emporte sur le module', () => {
    expect(pagePlan({ name: '', href: '/custom-bot', featureKey: 'settings', plan: 'plus' })).toBe('plus');
    expect(pagePlan({ name: '', href: '/analytics', featureKey: 'analytics', plan: 'freemium' })).toBe('freemium');
  });

  test('la cellule bien-être porte la couronne Plus dans le menu', () => {
    const page = staffItems.find((item) => item.href === '/wellbeing');
    expect(page && pagePlan(page)).toBe('plus');
  });
});
