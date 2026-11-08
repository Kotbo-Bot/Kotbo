/**
 * Modèle de site « Dev & tech » : adresses valides, menu, blocs coupés avec leur module.
 */
import { describe, expect, test } from 'bun:test';
import { validatePageSlug } from '@kotbo/shared';
import { buildSiteBlueprint } from '../../services/site/siteTemplates.js';

const modulesIn = (doc: unknown): string[] => JSON.stringify(doc).match(/"module":"[a-zA-Z]+"/g)?.map((m) => m.slice(10, -1)) ?? [];

describe('modèle dev', () => {
  for (const lang of ['fr', 'en'] as const) {
    test(`toutes les pages, adresses valides (${lang})`, () => {
      const bp = buildSiteBlueprint('dev', lang, {});
      expect(bp.pages.map((p) => p.key)).toEqual(['home', 'news', 'stats', 'recruit', 'contact', 'market']);
      for (const page of bp.pages) expect(validatePageSlug(page.slug)).toBeNull();
      expect(new Set(bp.pages.map((p) => p.slug)).size).toBe(bp.pages.length);
      expect(bp.navigation.map((n) => n.section ?? n.pageKey)).toEqual(['home', 'forum', 'news', 'stats', 'recruit', 'contact', 'market', 'me']);
    });
  }

  test('un module éteint retire sa page et ses blocs', () => {
    const bp = buildSiteBlueprint('dev', 'fr', { news: false, leveling: false, tickets: false, recruitment: false, custom_forms: false, marketplace: false });
    expect(bp.pages.map((p) => p.key)).toEqual(['home', 'stats', 'contact']);
    const used = bp.pages.flatMap((p) => modulesIn(p.content));
    for (const off of ['news', 'leaderboard', 'ticket', 'recruitment', 'marketplace']) expect(used).not.toContain(off);
  });
});
