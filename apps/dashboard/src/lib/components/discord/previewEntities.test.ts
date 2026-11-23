import { describe, expect, test } from 'bun:test';
import { mergeEntities, toPreviewMarkdown } from './previewEntities.svelte';

describe('toPreviewMarkdown', () => {
  test('les @pseudo en clair deviennent des mentions nommées, stables', () => {
    const first = toPreviewMarkdown('Bienvenue @Lina sur **Kotbo** !');
    const id = Object.keys(first.entities.users ?? {})[0];
    expect(first.markdown).toBe(`Bienvenue <@${id}> sur **Kotbo** !`);
    expect(first.entities.users).toEqual({ [id]: { name: 'Lina' } });
    expect(toPreviewMarkdown('Salut @Lina').entities.users).toEqual({ [id]: { name: 'Lina' } });
    // Forme d'un identifiant Discord : le parseur Markdown n'en accepte pas d'autre.
    expect(id).toMatch(/^\d{17,20}$/);
  });

  test('titre ou nom de champ : pas de mention, seulement les émojis', () => {
    const { markdown, entities } = toPreviewMarkdown('Ticket de @Lina <:coin:123456789012345678>', { mentions: false });
    expect(markdown).toBe('Ticket de @Lina <:coin:123456789012345678>');
    expect(entities.users).toBeUndefined();
    expect(entities.emojis?.['123456789012345678']).toMatchObject({ name: 'coin' });
  });

  test('@everyone et @here restent tels quels', () => {
    expect(toPreviewMarkdown('@everyone et @here')).toEqual({ markdown: '@everyone et @here', entities: {} });
  });

  test('émojis du serveur : texte conservé, image en entité', () => {
    const { markdown, entities } = toPreviewMarkdown('Prix <:coin:123456789012345678> et <a:party:223456789012345678>');
    expect(markdown).toBe('Prix <:coin:123456789012345678> et <a:party:223456789012345678>');
    expect(entities.emojis?.['123456789012345678']).toMatchObject({ name: 'coin' });
    expect(entities.emojis?.['223456789012345678']?.image).toContain('.gif');
  });
});

describe('mergeEntities', () => {
  test('fusionne les noms de plusieurs textes', () => {
    expect(mergeEntities([
      { users: { 1: { name: 'A' } } },
      { users: { 2: { name: 'B' } }, emojis: { 3: { name: 'c', image: 'https://cdn/c.png' } } },
    ])).toEqual({ users: { 1: { name: 'A' }, 2: { name: 'B' } }, emojis: { 3: { name: 'c', image: 'https://cdn/c.png' } } });
  });
});
