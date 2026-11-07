import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import type { EmbedBuilder } from 'discord.js';

const prismaMock = {
  guild: { findUnique: mock(async () => null), update: mock(async () => ({})) },
  guildRegulationArticle: {
    findMany: mock(async (): Promise<{ id: string }[]> => []),
    update: mock((args: { where: { id: string }; data: { sortOrder: number } }) => args),
  },
  $transaction: mock(async (ops: unknown[]) => ops),
  dashboardFeatureConfig: { findUnique: mock(async () => null) },
  staffMember: { findMany: mock(async () => []) },
};

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({
    default: prismaMock,
    prisma: prismaMock,
    prismaRead: prismaMock,
  }));
}

const { buildRegulationEmbeds, renumberRegulationArticles } = await import('../../services/staff/regulationService.js');

/** Limite Discord : texte affichable cumulé d'un message. */
const DISCORD_TEXT_LIMIT = 4000;

function makeArticle(overrides: Partial<{
  id: string;
  title: string;
  description: string;
  emoji: string | null;
  sortOrder: number;
  enabled: boolean;
}> = {}) {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: overrides.id ?? 'article-1',
    title: overrides.title ?? 'Respect',
    description: overrides.description ?? 'Restez courtois avec tout le monde.',
    emoji: overrides.emoji ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    enabled: overrides.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

function displayableTextLength(embed: EmbedBuilder): number {
  const data = embed.toJSON();
  const fieldsLength = (data.fields ?? []).reduce(
    (total, field) => total + field.name.length + field.value.length,
    0,
  );
  return (
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text.length ?? 0) +
    fieldsLength
  );
}

function build(articles: ReturnType<typeof makeArticle>[]) {
  return buildRegulationEmbeds({
    guildName: 'Les nerds',
    guildId: 'guild-1',
    articles,
    publishedAt: new Date('2026-01-02T00:00:00Z'),
    locale: 'fr',
  });
}

describe('buildRegulationEmbeds', () => {
  test('tient dans un seul embed pour un règlement court', () => {
    const embeds = build([makeArticle(), makeArticle({ id: 'article-2', title: 'Spam' })]);

    expect(embeds).toHaveLength(1);
    const data = embeds[0]!.toJSON();
    expect(data.title).toBe('📜 Règlement du serveur');
    expect(data.description).toContain('Les nerds');
    expect(data.footer?.text).toBeTruthy();
    // Résumé + 2 articles
    expect(data.fields).toHaveLength(3);
  });

  test('découpe en plusieurs messages sous la limite Discord', () => {
    const articles = Array.from({ length: 40 }, (_, index) =>
      makeArticle({
        id: `article-${index}`,
        title: `Article ${index}`,
        description: 'Lorem ipsum dolor sit amet. '.repeat(20),
        sortOrder: index,
      }),
    );

    const embeds = build(articles);

    expect(embeds.length).toBeGreaterThan(1);
    for (const embed of embeds) {
      expect(displayableTextLength(embed)).toBeLessThanOrEqual(DISCORD_TEXT_LIMIT);
      expect(embed.toJSON().fields?.length ?? 0).toBeLessThanOrEqual(25);
    }

    // En-tête sur la première page, pied de page sur la dernière uniquement.
    expect(embeds[0]!.toJSON().description).toBeTruthy();
    expect(embeds[1]!.toJSON().description).toBeUndefined();
    expect(embeds[0]!.toJSON().footer).toBeUndefined();
    expect(embeds.at(-1)!.toJSON().footer?.text).toBeTruthy();
    expect(embeds[0]!.toJSON().title).toContain('Partie 1/');
  });

  test('scinde une description plus longue que la limite dun champ', () => {
    const embeds = build([makeArticle({ description: 'a'.repeat(2500) })]);
    const fields = embeds.flatMap((embed) => embed.toJSON().fields ?? []);
    const articleFields = fields.filter((field) => field.name.includes('Article 1'));

    expect(articleFields.length).toBeGreaterThan(1);
    for (const field of articleFields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
      expect(field.name.length).toBeLessThanOrEqual(256);
    }
    expect(articleFields.at(-1)!.name).toContain('(suite)');
  });

  test('ignore les articles désactivés mais les compte dans le total', () => {
    const embeds = build([
      makeArticle({ id: 'a', title: 'Actif' }),
      makeArticle({ id: 'b', title: 'Inactif', enabled: false }),
    ]);

    const fields = embeds[0]!.toJSON().fields ?? [];
    expect(fields.some((field) => field.name.includes('Inactif'))).toBeFalse();
    expect(fields[0]!.value).toContain('Articles actifs: **1**');
    expect(fields[0]!.value).toContain('Articles totaux: **2**');
  });

  test('limite le nombre de messages et signale les articles restants', () => {
    const articles = Array.from({ length: 400 }, (_, index) =>
      makeArticle({
        id: `article-${index}`,
        title: `Article ${index}`,
        description: 'x'.repeat(900),
        sortOrder: index,
      }),
    );

    const embeds = build(articles);

    expect(embeds).toHaveLength(10);
    for (const embed of embeds) {
      expect(displayableTextLength(embed)).toBeLessThanOrEqual(DISCORD_TEXT_LIMIT);
      expect(embed.toJSON().fields?.length ?? 0).toBeLessThanOrEqual(25);
    }
    expect(embeds.at(-1)!.toJSON().fields?.at(-1)?.name).toContain('et plus');
  });

  test('garde de la place pour le bloc « et plus » quand les champs saturent', () => {
    // Descriptions courtes : c'est la limite de 25 champs qui borne chaque page.
    const articles = Array.from({ length: 400 }, (_, index) =>
      makeArticle({ id: `article-${index}`, title: `Article ${index}`, description: 'Court.', sortOrder: index }),
    );

    const embeds = build(articles);
    const lastFields = embeds.at(-1)!.toJSON().fields ?? [];

    expect(embeds).toHaveLength(10);
    expect(lastFields.length).toBeLessThanOrEqual(25);
    expect(lastFields.at(-1)?.name).toContain('et plus');
  });
});

describe('renumberRegulationArticles', () => {
  test("place les ids demandés d'abord, ignore inconnus et doublons, garde le reste dans l'ordre", async () => {
    prismaMock.guildRegulationArticle.findMany.mockImplementationOnce(async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    prismaMock.guildRegulationArticle.update.mockClear();

    const order = await renumberRegulationArticles('g', ['c', 'zz', 'a', 'c']);

    expect(order).toEqual(['c', 'a', 'b', 'd']);
    expect(prismaMock.guildRegulationArticle.update.mock.calls.map(([args]) => [args.where.id, args.data.sortOrder])).toEqual([
      ['c', 0], ['a', 1], ['b', 2], ['d', 3],
    ]);
  });
});
