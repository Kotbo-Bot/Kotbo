/**
 * Menu « un seul rôle » : prendre un rôle du menu retire ceux du même menu que
 * le membre avait déjà, et rien d'autre.
 */

import { describe, it, expect } from 'bun:test';
import { rolesToSwapOut } from '../../services/features/reactionRoleExclusive.js';

describe('rolesToSwapOut', () => {
  const MENU = ['rouge', 'bleu', 'vert'];

  it('retire les autres rôles du menu que le membre possède', () => {
    expect(rolesToSwapOut(MENU, ['rouge', 'vert'], 'bleu')).toEqual(['rouge', 'vert']);
  });

  it('ne touche pas aux rôles hors du menu', () => {
    expect(rolesToSwapOut(MENU, ['rouge', 'moderateur'], 'bleu')).toEqual(['rouge']);
  });

  it('ne retire jamais le rôle cliqué', () => {
    expect(rolesToSwapOut(MENU, ['bleu'], 'bleu')).toEqual([]);
  });

  it('ne rend rien quand le membre n\'a aucun rôle du menu', () => {
    expect(rolesToSwapOut(MENU, [], 'bleu')).toEqual([]);
  });

  it('dédoublonne un rôle porté par deux boutons', () => {
    expect(rolesToSwapOut(['rouge', 'rouge', 'bleu'], ['rouge'], 'bleu')).toEqual(['rouge']);
  });
});
