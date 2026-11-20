import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${extension}`), () => ({ default: {}, prisma: {}, prismaRead: {} }));
}

const { findArticle } = await import('../../commands/community/regle.js');

const art = (id: string, title: string, description = '') => ({
  id, title, description, emoji: null, sortOrder: 0, enabled: true, createdAt: new Date(), updatedAt: new Date(),
});
const articles = [art('a', 'Respect'), art('b', 'Publicité', 'Pas de pub en MP'), art('c', 'Langage')];

describe('/regle findArticle', () => {
  test('par id d’autocomplétion', () => expect(findArticle(articles, 'id:c')?.index).toBe(2));
  test('par numéro', () => expect(findArticle(articles, ' 2 ')?.article.id).toBe('b'));
  test('numéro hors limites', () => expect(findArticle(articles, '9')).toBeNull());
  test('par titre sans accents ni casse', () => expect(findArticle(articles, 'publicite')?.article.id).toBe('b'));
  test('par description en dernier recours', () => expect(findArticle(articles, 'en mp')?.article.id).toBe('b'));
  test('introuvable', () => expect(findArticle(articles, 'spoiler')).toBeNull());
});
