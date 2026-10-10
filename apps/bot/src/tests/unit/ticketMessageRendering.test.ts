import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

for (const file of ['db.ts', 'db.js']) {
  mock.module(path.resolve(import.meta.dir, '../../utils', file), () => ({ default: {}, prisma: {}, prismaRead: {}, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { msgComponentsV2Map, msgReactionsMap } = await import('../../api/routes/dashboard/modules/_shared.js');
const { parseDiscordMarkdown } = await import('../../api/shared/markdown.js');

const raw = (value: unknown) => ({ toJSON: () => value });

describe('messages en Components V2 lus comme des embeds', () => {
  test('un conteneur devient une carte : texte, couleur, vignette, images, boutons', () => {
    const { cards, text, buttons } = msgComponentsV2Map([
      raw({
        type: 17,
        accent_color: 0x5865f2,
        components: [
          { type: 9, components: [{ type: 10, content: '### 🎫 Ticket' }], accessory: { type: 11, media: { url: 'https://cdn/avatar.png' } } },
          { type: 14 },
          { type: 10, content: 'Bonjour **alice**' },
          { type: 12, items: [{ media: { url: 'https://cdn/a.png' } }, { media: { url: 'https://cdn/b.png' } }] },
        ],
      }),
      raw({ type: 1, components: [{ type: 2, label: 'Fermer', style: 4, emoji: { name: '🔒' } }] }),
    ], null);

    expect(text).toBe('');
    expect(buttons).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      description: '### 🎫 Ticket\n\nBonjour **alice**',
      color: '#5865f2',
      thumbnail: { url: 'https://cdn/avatar.png' },
      image: { url: 'https://cdn/a.png' },
      images: ['https://cdn/b.png'],
      buttons: [{ label: 'Fermer', emoji: '🔒', url: null, style: 4, disabled: false }],
    });
    expect(cards[0].htmlDescription).toContain('font-bold');
  });

  test('le texte hors conteneur reste du contenu', () => {
    const { cards, text } = msgComponentsV2Map([raw({ type: 10, content: 'Salut' })], null);
    expect(cards).toEqual([]);
    expect(text).toBe('Salut');
  });

  test('réactions : émoji texte ou image personnalisée, avec le nombre', () => {
    expect(msgReactionsMap([
      { emoji: { id: null, name: '👍' }, count: 3 },
      { emoji: { id: '42', name: 'kotbo', animated: true }, count: 1 },
    ])).toEqual([
      { emoji: '👍', imageUrl: null, name: '👍', count: 3 },
      { emoji: null, imageUrl: 'https://cdn.discordapp.com/emojis/42.gif?size=32', name: 'kotbo', count: 1 },
    ]);
  });
});

describe('markdown Discord', () => {
  test('titres, sous-texte et citations', () => {
    expect(parseDiscordMarkdown('### Titre')).toContain('dc-heading dc-h3');
    expect(parseDiscordMarkdown('### Titre')).toContain('>Titre</span>');
    // Classe stable pour le CSS du dashboard, qui ne génère pas les classes Tailwind du bot.
    expect(parseDiscordMarkdown('<:kotbo:42>')).toContain('class="dc-emoji');
    expect(parseDiscordMarkdown('-# pied')).toContain('text-white/50">pied</span>');
    expect(parseDiscordMarkdown('> cité')).toContain('border-l-4');
  });

  test('liens masqués en http(s) seulement, échappés', () => {
    expect(parseDiscordMarkdown('[Kotbo](https://kotbo.fr/a?b=1&c=2)')).toContain('<a href="https://kotbo.fr/a?b=1&amp;c=2"');
    expect(parseDiscordMarkdown('[piège](javascript:alert(1))')).not.toContain('<a ');
    expect(parseDiscordMarkdown('[x](https://e.fr/"onmouseover=1)')).not.toContain('"onmouseover');
  });
});
