import { describe, expect, test } from 'bun:test';
import { resyncDraft } from './draftSync';

describe('resyncDraft', () => {
  test('un rafraîchissement du store n\'écrase pas une saisie en cours', () => {
    expect(resyncDraft(['salon-a', 'salon-b'], ['salon-a'], ['salon-a'])).toEqual(['salon-a', 'salon-b']);
  });

  test('un brouillon intact suit le serveur', () => {
    expect(resyncDraft({ email: '' }, { email: '' }, { email: 'staff@exemple.fr' })).toEqual({ email: 'staff@exemple.fr' });
  });
});
