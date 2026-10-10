/**
 * Recherche plein texte dans les pages publiées d'un site.
 *
 * `searchText` est stocké sans accents et en minuscules : la requête est
 * repliée de la même façon, chaque mot devient un préfixe (`regl` trouve
 * « règlement »), et l'index GIN de la migration sert la requête. L'extrait
 * affiché est pris dans le texte d'origine (accents compris), en retrouvant la
 * position du terme grâce à une table de correspondance des indices.
 */

import { extractSiteDocumentText, foldSearchText, normalizeSiteDocument, type SiteDocument } from '@kotbo/shared';
import type { SitePageKind, SiteVisibility } from '@prisma/client';
import prisma from '../../utils/db.js';
import { esc } from './siteHtml.js';

export interface SearchHit {
  id: string;
  kind: SitePageKind;
  slug: string;
  title: string;
  visibility: SiteVisibility;
  visibleRoleIds: string[];
  snippetHtml: string;
}

/** Mots de la requête, repliés et réduits à des caractères sûrs pour `to_tsquery`. */
export function searchTerms(query: string): string[] {
  return [...new Set(foldSearchText(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 2))].slice(0, 8);
}

/** Texte replié, avec pour chaque caractère replié l'indice du caractère d'origine. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = text[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (let k = 0; k < piece.length; k++) {
      folded += piece[k];
      map.push(i);
    }
  }
  return { folded, map };
}

/** Extrait d'environ 220 caractères autour du premier terme trouvé, termes surlignés. */
export function buildSnippet(text: string, terms: string[], radius = 110): string {
  if (!text) return '';
  const { folded, map } = foldWithMap(text);
  let first = -1;
  for (const term of terms) {
    const at = folded.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  const centre = first === -1 ? 0 : map[first];
  const start = Math.max(0, centre - radius);
  const end = Math.min(text.length, centre + radius);
  const slice = text.slice(start, end);

  const { folded: sliceFolded, map: sliceMap } = foldWithMap(slice);
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = sliceFolded.indexOf(term, from);
      if (at === -1) break;
      ranges.push([sliceMap[at], sliceMap[at + term.length - 1] + 1]);
      from = at + term.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let html = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s < cursor) continue;
    html += `${esc(slice.slice(cursor, s))}<mark>${esc(slice.slice(s, e))}</mark>`;
    cursor = e;
  }
  html += esc(slice.slice(cursor));
  return `${start > 0 ? '…' : ''}${html}${end < text.length ? '…' : ''}`;
}

export async function searchSite(siteId: string, query: string, limit = 30): Promise<SearchHit[]> {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const tsquery = terms.map((t) => `${t}:*`).join(' & ');

  const rows = await prisma.$queryRaw<Array<{ id: string; kind: SitePageKind; slug: string; publishedTitle: string | null; visibility: SiteVisibility; visibleRoleIds: string[]; rank: number }>>`
    SELECT "id", "kind", "slug", "publishedTitle", "visibility", "visibleRoleIds",
           ts_rank(to_tsvector('simple', "searchText"), to_tsquery('simple', ${tsquery})) AS "rank"
    FROM "site_pages"
    WHERE "siteId" = ${siteId}
      AND "publishedAt" IS NOT NULL
      AND "archivedAt" IS NULL
      AND to_tsvector('simple', "searchText") @@ to_tsquery('simple', ${tsquery})
    ORDER BY "rank" DESC
    LIMIT ${Math.min(50, Math.max(1, limit))}
  `;
  if (rows.length === 0) return [];

  // Le texte d'origine (accents compris) n'est lu que pour les résultats.
  const contents = await prisma.sitePage.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, publishedContent: true } });
  const textById = new Map(contents.map((c) => [c.id, extractSiteDocumentText(normalizeSiteDocument(c.publishedContent) as SiteDocument, 20_000)]));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    title: row.publishedTitle ?? row.slug,
    visibility: row.visibility,
    visibleRoleIds: row.visibleRoleIds,
    snippetHtml: buildSnippet(textById.get(row.id) ?? '', terms),
  }));
}
