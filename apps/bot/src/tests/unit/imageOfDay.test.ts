import { describe, expect, test } from 'bun:test';
import { hasImage } from '../../services/features/imageOfDayService.js';

const message = (over: { content?: string; contentTypes?: Array<string | null>; embedTypes?: string[] } = {}) => ({
  content: over.content ?? '',
  attachments: { some: (fn: (a: { contentType: string | null }) => boolean) => (over.contentTypes ?? []).some((contentType) => fn({ contentType })) },
  embeds: (over.embedTypes ?? []).map((type) => ({ data: { type } })),
});

describe('image du jour : présence d’une image', () => {
  test('pièce jointe image, lien direct ou embed image/GIF', () => {
    expect(hasImage(message({ contentTypes: ['image/png'] }))).toBe(true);
    expect(hasImage(message({ content: 'regardez https://exemple.fr/chat.JPG?x=1' }))).toBe(true);
    expect(hasImage(message({ embedTypes: ['gifv'] }))).toBe(true);
  });

  test('texte seul, vidéo ou lien de page : pas une image', () => {
    expect(hasImage(message({ content: 'trop belle cette photo' }))).toBe(false);
    expect(hasImage(message({ contentTypes: ['video/mp4', null] }))).toBe(false);
    expect(hasImage(message({ content: 'https://exemple.fr/page.html', embedTypes: ['link'] }))).toBe(false);
  });
});
