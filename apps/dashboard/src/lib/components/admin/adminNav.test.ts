import { describe, expect, test } from 'bun:test';
import { ADMIN_SPACES, spaceForPath } from './adminNav';

describe('plan de la console admin', () => {
  test('chaque page admin appartient a un seul espace', () => {
    const paths = ADMIN_SPACES.flatMap((space) => space.tabs.map((tab) => tab.path));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBe(17);
  });

  test('l’accueil ne capte pas les autres pages', () => {
    expect(spaceForPath('/admin').id).toBe('home');
    expect(spaceForPath('/admin/servers').id).toBe('servers');
    expect(spaceForPath('/admin/feature-pages').id).toBe('comms');
    expect(spaceForPath('/admin/config').id).toBe('system');
  });

  test('une adresse inconnue retombe sur l’accueil', () => {
    expect(spaceForPath('/admin/nope').id).toBe('home');
  });
});
