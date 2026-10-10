/**
 * Adresses du site communautaire : slug du site, slugs des pages, menu.
 *
 * Un site vit sous `/s/<slug>`. Sous lui, quelques segments sont réservés aux
 * pages générées (wiki, blog, recherche, espace membre, fichiers techniques) :
 * une page libre ne peut pas les prendre.
 */

import { foldSearchText } from './document.js';

export const SITE_SLUG_MIN = 3;
export const SITE_SLUG_MAX = 40;

/** Segments que le routeur du site sert lui-même. */
export const SITE_RESERVED_PAGE_SLUGS = new Set([
  '_', 'wiki', 'blog', 'search', 'me', 'profile', 'embed', 'login', 'logout',
  'rss.xml', 'sitemap.xml', 'robots.txt', 'feed', 'api',
  // Routes du site : profils, votes, formulaires, aperçus, boutique, forum.
  'u', 'votes', 'form', 'preview', 'shop', 'boutique', 'forum',
]);

/** Slugs de site refusés : ils prêteraient à confusion avec Kotbo lui-même. */
export const SITE_RESERVED_SITE_SLUGS = new Set([
  'kotbo', 'admin', 'api', 'www', 'dashboard', 'support', 'help', 'aide', 'login',
  'sitemap.xml', 'robots.txt', 'static', 'assets', 'discord', 'staff-kotbo',
]);

/** Transforme un texte libre en slug : minuscules, sans accents, tirets. */
export function slugify(value: string, max = SITE_SLUG_MAX): string {
  return foldSearchText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

export type SiteSlugError = 'too_short' | 'too_long' | 'invalid' | 'reserved';

export function validateSiteSlug(value: string): SiteSlugError | null {
  if (value.length < SITE_SLUG_MIN) return 'too_short';
  if (value.length > SITE_SLUG_MAX) return 'too_long';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return 'invalid';
  // Un slug fait uniquement de chiffres serait pris pour un identifiant Discord.
  if (/^\d+$/.test(value)) return 'invalid';
  if (SITE_RESERVED_SITE_SLUGS.has(value)) return 'reserved';
  return null;
}

export function validatePageSlug(value: string): SiteSlugError | null {
  if (value.length < 1) return 'too_short';
  if (value.length > 80) return 'too_long';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return 'invalid';
  if (SITE_RESERVED_PAGE_SLUGS.has(value)) return 'reserved';
  return null;
}

// ─── Menu ────────────────────────────────────────────────────────────────────

export const SITE_NAV_SECTIONS = ['home', 'wiki', 'blog', 'search', 'me', 'votes'] as const;
export type SiteNavSection = (typeof SITE_NAV_SECTIONS)[number];

export type SiteNavTarget =
  | { type: 'page'; pageId: string }
  | { type: 'section'; section: SiteNavSection }
  | { type: 'url'; href: string };

export interface SiteNavItem {
  id: string;
  label: string;
  target: SiteNavTarget | null;
  children: SiteNavItem[];
}

export const SITE_NAV_LIMITS = { topLevel: 12, children: 12, label: 40 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTarget(raw: unknown): SiteNavTarget | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'page' && typeof raw.pageId === 'string' && /^[a-z0-9]{20,32}$/i.test(raw.pageId)) {
    return { type: 'page', pageId: raw.pageId };
  }
  if (raw.type === 'section' && typeof raw.section === 'string' && (SITE_NAV_SECTIONS as readonly string[]).includes(raw.section)) {
    return { type: 'section', section: raw.section as SiteNavSection };
  }
  if (raw.type === 'url' && typeof raw.href === 'string') {
    try {
      const url = new URL(raw.href.trim());
      if (url.protocol === 'https:' || url.protocol === 'http:') return { type: 'url', href: url.toString() };
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeItem(raw: unknown, index: number, depth: number): SiteNavItem | null {
  if (!isRecord(raw)) return null;
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, SITE_NAV_LIMITS.label) : '';
  if (!label) return null;
  const id = typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : `nav-${depth}-${index}`;
  const children =
    depth === 0 && Array.isArray(raw.children)
      ? raw.children
          .slice(0, SITE_NAV_LIMITS.children)
          .map((child, i) => normalizeItem(child, i, 1))
          .filter((child): child is SiteNavItem => child !== null)
      : [];
  const target = normalizeTarget(raw.target);
  // Un élément sans cible n'a de sens que comme titre de sous-menu.
  if (!target && children.length === 0) return null;
  return { id, label, target, children };
}

/** Menu ramené à deux niveaux au plus, cibles vérifiées. */
export function normalizeSiteNavigation(input: unknown): SiteNavItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, SITE_NAV_LIMITS.topLevel)
    .map((item, i) => normalizeItem(item, i, 0))
    .filter((item): item is SiteNavItem => item !== null);
}

/** Pages référencées par le menu, pour vérifier qu'elles appartiennent au site. */
export function collectNavPageIds(items: SiteNavItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.target?.type === 'page') ids.push(item.target.pageId);
    for (const child of item.children) if (child.target?.type === 'page') ids.push(child.target.pageId);
  }
  return ids;
}
