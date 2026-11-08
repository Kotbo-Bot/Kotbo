/**
 * Modes d'un menu de rôles, partagés entre le bot et le dashboard : « un seul
 * rôle » est un mode du menu, à part de la bascule et de l'attribution
 * définitive, et ses boutons n'ont pas de mode propre.
 */

import { describe, expect, it } from 'bun:test';
import { normalizeMenuMode, resolveButtonMode } from '@kotbo/contracts';

describe('normalizeMenuMode', () => {
  it('accepte les trois modes du menu', () => {
    expect(normalizeMenuMode('toggle')).toBe('toggle');
    expect(normalizeMenuMode('add_only')).toBe('add_only');
    expect(normalizeMenuMode('exclusive')).toBe('exclusive');
  });

  it('retombe sur la bascule pour une valeur inconnue', () => {
    expect(normalizeMenuMode('autre')).toBe('toggle');
    expect(normalizeMenuMode(undefined)).toBe('toggle');
  });
});

describe('resolveButtonMode', () => {
  it('un bouton sans mode suit celui du menu', () => {
    expect(resolveButtonMode(undefined, 'add_only')).toBe('add_only');
    expect(resolveButtonMode(null, 'toggle')).toBe('toggle');
  });

  it('le mode du bouton l’emporte dans un menu bascule ou définitif', () => {
    expect(resolveButtonMode('add_only', 'toggle')).toBe('add_only');
    expect(resolveButtonMode('toggle', 'add_only')).toBe('toggle');
  });

  it('dans un menu « un seul rôle », chaque bouton bascule, quel que soit son ancien mode', () => {
    expect(resolveButtonMode('add_only', 'exclusive')).toBe('toggle');
    expect(resolveButtonMode(undefined, 'exclusive')).toBe('toggle');
  });
});
