/**
 * Cartes partageables : texte ramené à la largeur, images limitées à des
 * sources sûres, cache qui ne dessine qu'une fois.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cachedCard, fitText, loadCardImage, renderServerCard } from '../../services/site/siteCards.js';

const tenPxPerChar = { measureText: (text: string) => ({ width: text.length * 10 }) } as unknown as Parameters<typeof fitText>[0];

describe('texte des cartes', () => {
  test('inchangé s’il tient, coupé avec « … » sinon', () => {
    expect(fitText(tenPxPerChar, 'Ana', 100)).toBe('Ana');
    const cut = fitText(tenPxPerChar, 'Les Chroniques d’Aldor', 100);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length * 10).toBeLessThanOrEqual(100);
  });
});

describe('images des cartes', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('aucune requête vers une adresse hors du CDN de Discord', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;
    expect(await loadCardImage('https://exemple.fr/banniere.png')).toBeNull();
    expect(await loadCardImage('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(await loadCardImage('https://cdn.discordapp.com.evil.fr/x.png')).toBeNull();
    expect(called).toBe(0);
    expect(await loadCardImage('https://cdn.discordapp.com/embed/avatars/1.png')).toBeNull();
    expect(called).toBe(1);
  });
});

describe('carte du serveur', () => {
  test('PNG de 1200 × 630, dessiné une seule fois pour une même clé', async () => {
    let draws = 0;
    const draw = () => {
      draws += 1;
      return renderServerCard({
        name: 'Serveur test',
        tagline: null,
        iconUrl: null,
        bannerUrl: null,
        accent: '#2f7de1',
        onAccent: '#ffffff',
        membersLabel: '10 membres',
        onlineLabel: null,
        url: 'dash.kotbo.fr/s/test',
        cta: 'Rejoindre',
      });
    };
    const [a, b] = await Promise.all([cachedCard('test:server', draw), cachedCard('test:server', draw)]);
    expect(draws).toBe(1);
    expect(a).toBe(b);
    // En-tête PNG, puis largeur et hauteur dans le bloc IHDR.
    expect(a.subarray(1, 4).toString()).toBe('PNG');
    expect(a.readUInt32BE(16)).toBe(1200);
    expect(a.readUInt32BE(20)).toBe(630);
  });
});
