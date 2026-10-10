/**
 * Galerie de thèmes : une page modèle perd ce qui ne vaut que sur son serveur.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('../../utils/db.js', () => ({ default: {}, prisma: {}, prismaRead: {} }));

const { portableDocument } = await import('../../services/site/siteGalleryService.js');

describe('pages modèles portables', () => {
  test('salon, formulaire et hiérarchies retirés, le reste gardé', () => {
    const doc = portableDocument({
      type: 'doc',
      content: [
        { type: 'module', attrs: { module: 'channelFeed', config: { channelId: '123456789012345678', limit: 5 } } },
        { type: 'module', attrs: { module: 'staff', config: { layout: 'org', hierarchyIds: ['clxyz0123456789abcdefgh'] } } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Bienvenue' }] },
      ],
    } as never);
    const [feed, staff, text] = doc.content as Array<{ type: string; attrs?: { config?: Record<string, unknown> } }>;
    expect(feed.attrs?.config?.channelId ?? '').toBe('');
    expect(feed.attrs?.config?.limit).toBe(5);
    expect(staff.attrs?.config?.hierarchyIds ?? []).toEqual([]);
    expect(staff.attrs?.config?.layout).toBe('org');
    expect(text.type).toBe('paragraph');
  });
});
