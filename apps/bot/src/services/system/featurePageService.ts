/**
 * Pages fonctionnalités du site vitrine (kotbo.fr), sur le modèle des pages
 * par plugin de MEE6 : une page par fonctionnalité, en français
 * (`/fonctionnalites/<slugFr>`) et en anglais (`/en/features/<slugEn>`).
 *
 * Elles se rédigent dans la console admin du dashboard (`/admin/feature-pages`)
 * et le site les lit à son build (`GET /api/public/feature-pages`). Le site
 * reste statique : chaque page sort prérendue, donc indexable. Publier,
 * modifier ou retirer une page publiée relance le build du site
 * (`requestLandingRebuild`), quand le jeton de déploiement est configuré.
 *
 * Un brouillon peut être incomplet. Une page publiée a ses deux langues
 * complètes : une page à moitié vide ferait plus de mal au référencement que
 * pas de page du tout.
 */
import { isModulePaused } from '@kotbo/contracts';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { featurePageSeedModules } from './featurePageSeeds.js';
import { RICH_FEATURE_PAGE_SEEDS } from './featurePageRichSeeds.js';

export type FeaturePageLocale = 'fr' | 'en';

export interface FeaturePageSection {
  h2: string;
  body: string;
  points?: string[];
}

export interface FeaturePageText {
  /** Nom court, pour les liens et le pied de page. */
  name: string;
  /** Balise <title> : la requête visée en tête, moins de 60 signes. */
  title: string;
  /** Meta description, moins de 160 signes. */
  description: string;
  h1: string;
  lead: string;
  sections: FeaturePageSection[];
  faq: { q: string; a: string }[];
}

export type FeaturePageContent = Record<FeaturePageLocale, FeaturePageText>;

export interface FeaturePageSeed {
  key: string;
  slug: Record<FeaturePageLocale, string>;
  modules: string[];
  position: number;
  content: FeaturePageContent;
}

export interface FeaturePageRecord {
  id: string;
  key: string;
  slug: Record<FeaturePageLocale, string>;
  modules: string[];
  content: FeaturePageContent;
  published: boolean;
  position: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** La forme que lit le site vitrine (`Feature` dans `src/lib/data/features.ts`). */
export interface PublicFeaturePage {
  key: string;
  slug: Record<FeaturePageLocale, string>;
  modules: string[];
  text: FeaturePageContent;
}

export class FeaturePageError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const LOCALES: FeaturePageLocale[] = ['fr', 'en'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[a-z0-9_]+$/;

/** Bornes de longueur : au-delà, le texte est coupé, pas refusé. */
const LIMITS = {
  name: 60,
  title: 90,
  description: 220,
  h1: 140,
  lead: 800,
  h2: 140,
  body: 3000,
  point: 400,
  q: 240,
  a: 2000,
  sections: 12,
  points: 15,
  faq: 15,
  modules: 10,
  module: 60,
} as const;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function list<T>(value: unknown, max: number, map: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(map).filter((item): item is T => item !== null);
}

function normalizeText(raw: unknown): FeaturePageText {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    name: text(source.name, LIMITS.name),
    title: text(source.title, LIMITS.title),
    description: text(source.description, LIMITS.description),
    h1: text(source.h1, LIMITS.h1),
    lead: text(source.lead, LIMITS.lead),
    sections: list(source.sections, LIMITS.sections, (item) => {
      const section = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const h2 = text(section.h2, LIMITS.h2);
      const body = text(section.body, LIMITS.body);
      const points = list(section.points, LIMITS.points, (point) => text(point, LIMITS.point) || null);
      if (!h2 && !body && points.length === 0) return null;
      return points.length > 0 ? { h2, body, points } : { h2, body };
    }),
    faq: list(source.faq, LIMITS.faq, (item) => {
      const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const q = text(entry.q, LIMITS.q);
      const a = text(entry.a, LIMITS.a);
      return q || a ? { q, a } : null;
    }),
  };
}

export function normalizeContent(raw: unknown): FeaturePageContent {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { fr: normalizeText(source.fr), en: normalizeText(source.en) };
}

/**
 * Ce qui manque pour publier, en phrases lisibles par l'admin. Vide : la page
 * peut être publiée.
 */
export function missingForPublication(content: FeaturePageContent): string[] {
  const missing: string[] = [];
  const LABEL = { fr: 'français', en: 'anglais' } as const;
  for (const locale of LOCALES) {
    const t = content[locale];
    const fields: [keyof FeaturePageText, string][] = [
      ['name', 'le nom'],
      ['title', 'le titre de la page'],
      ['description', 'la meta description'],
      ['h1', 'le titre principal'],
      ['lead', "l'introduction"],
    ];
    for (const [field, label] of fields) {
      if (!t[field]) missing.push(`${label} (${LABEL[locale]})`);
    }
    if (!t.sections.some((section) => section.h2 && section.body)) {
      missing.push(`au moins une section avec titre et texte (${LABEL[locale]})`);
    }
    if (t.sections.some((section) => !section.h2 || !section.body)) {
      missing.push(`une section sans titre ou sans texte (${LABEL[locale]})`);
    }
    if (t.faq.some((entry) => !entry.q || !entry.a)) {
      missing.push(`une question de FAQ sans question ou sans réponse (${LABEL[locale]})`);
    }
  }
  return missing;
}

function normalizeSlug(value: unknown, locale: FeaturePageLocale): string {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SLUG.test(slug) || slug.length > 80) {
    throw new FeaturePageError(
      400,
      `Adresse ${locale === 'fr' ? 'française' : 'anglaise'} invalide : minuscules, chiffres et tirets seulement.`,
    );
  }
  return slug;
}

function normalizeModules(value: unknown): string[] {
  return [...new Set(list(value, LIMITS.modules, (item) => text(item, LIMITS.module) || null))];
}

function toRecord(row: {
  id: string;
  key: string;
  slugFr: string;
  slugEn: string;
  modules: string[];
  content: Prisma.JsonValue;
  published: boolean;
  position: number;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): FeaturePageRecord {
  return {
    id: row.id,
    key: row.key,
    slug: { fr: row.slugFr, en: row.slugEn },
    modules: row.modules,
    content: normalizeContent(row.content),
    published: row.published,
    position: row.position,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function slugConflict(err: unknown): FeaturePageError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = String((err.meta?.target as string[] | string | undefined) ?? '');
    if (target.includes('key')) return new FeaturePageError(409, 'Une page porte déjà cette clé.');
    return new FeaturePageError(409, 'Une autre page utilise déjà cette adresse.');
  }
  return null;
}

// ── Lecture ────────────────────────────────────────────────────────────────

export async function listFeaturePages(): Promise<FeaturePageRecord[]> {
  const rows = await prisma.featurePage.findMany({ orderBy: [{ position: 'asc' }, { key: 'asc' }] });
  return rows.map(toRecord);
}

let publicCache: { pages: PublicFeaturePage[]; at: number } | null = null;
const PUBLIC_CACHE_MS = 5 * 60 * 1000;

/** Les pages publiées, telles que le site vitrine les lit à son build. */
export async function listPublishedFeaturePages(): Promise<PublicFeaturePage[]> {
  if (publicCache && Date.now() - publicCache.at < PUBLIC_CACHE_MS) return publicCache.pages;
  const rows = await prisma.featurePage.findMany({
    where: { published: true },
    orderBy: [{ position: 'asc' }, { key: 'asc' }],
  });
  const pages = rows
    .map(toRecord)
    // Une page publiée avant une règle plus stricte ne doit pas casser le site.
    .filter((page) => missingForPublication(page.content).length === 0)
    // La page d'un module en pause ne présente plus une fonctionnalité offerte.
    .filter((page) => !isModulePaused(page.key))
    .map((page) => ({ key: page.key, slug: page.slug, modules: page.modules, text: page.content }));
  publicCache = { pages, at: Date.now() };
  return pages;
}

// ── Écriture ───────────────────────────────────────────────────────────────

export interface FeaturePageInput {
  key?: unknown;
  slug?: { fr?: unknown; en?: unknown };
  modules?: unknown;
  content?: unknown;
  published?: unknown;
  position?: unknown;
}

function assertPublishable(content: FeaturePageContent, published: boolean): void {
  if (!published) return;
  const missing = missingForPublication(content);
  if (missing.length > 0) {
    throw new FeaturePageError(400, `Impossible de publier, il manque : ${missing.join(', ')}.`);
  }
}

export async function createFeaturePage(input: FeaturePageInput, actorId: string): Promise<FeaturePageRecord> {
  const key = typeof input.key === 'string' ? input.key.trim().toLowerCase() : '';
  if (!KEY.test(key) || key.length > 60) {
    throw new FeaturePageError(400, 'Clé invalide : minuscules, chiffres et tirets bas seulement.');
  }
  const content = normalizeContent(input.content);
  const published = input.published === true;
  assertPublishable(content, published);

  try {
    const row = await prisma.featurePage.create({
      data: {
        key,
        slugFr: normalizeSlug(input.slug?.fr, 'fr'),
        slugEn: normalizeSlug(input.slug?.en, 'en'),
        modules: normalizeModules(input.modules),
        content: content as unknown as Prisma.InputJsonValue,
        published,
        position: Number.isInteger(input.position) ? (input.position as number) : 0,
        updatedBy: actorId,
      },
    });
    afterWrite(published);
    return toRecord(row);
  } catch (err) {
    throw slugConflict(err) ?? err;
  }
}

export async function updateFeaturePage(id: string, input: FeaturePageInput, actorId: string): Promise<FeaturePageRecord> {
  const current = await prisma.featurePage.findUnique({ where: { id } });
  if (!current) throw new FeaturePageError(404, 'Page introuvable.');

  const content = input.content === undefined ? normalizeContent(current.content) : normalizeContent(input.content);
  const published = input.published === undefined ? current.published : input.published === true;
  assertPublishable(content, published);

  try {
    const row = await prisma.featurePage.update({
      where: { id },
      data: {
        slugFr: input.slug?.fr === undefined ? current.slugFr : normalizeSlug(input.slug.fr, 'fr'),
        slugEn: input.slug?.en === undefined ? current.slugEn : normalizeSlug(input.slug.en, 'en'),
        modules: input.modules === undefined ? current.modules : normalizeModules(input.modules),
        content: content as unknown as Prisma.InputJsonValue,
        published,
        position: Number.isInteger(input.position) ? (input.position as number) : current.position,
        updatedBy: actorId,
      },
    });
    // Un brouillon modifié ne change rien au site ; une page publiée, ou qui
    // vient d'être retirée, si.
    afterWrite(published || current.published);
    return toRecord(row);
  } catch (err) {
    throw slugConflict(err) ?? err;
  }
}

export async function deleteFeaturePage(id: string): Promise<FeaturePageRecord> {
  const current = await prisma.featurePage.findUnique({ where: { id } });
  if (!current) throw new FeaturePageError(404, 'Page introuvable.');
  await prisma.featurePage.delete({ where: { id } });
  afterWrite(current.published);
  return toRecord(current);
}

/**
 * Crée les pages qui manquent : celles déjà rédigées pour le site (publiées),
 * puis une par module du registre (en brouillon). Ne touche jamais une page
 * existante, repérée par sa clé ou son adresse.
 */
export async function importFeaturePages(actorId: string): Promise<{ created: number; published: number; skipped: number }> {
  const existing = await prisma.featurePage.findMany({ select: { key: true, slugFr: true, slugEn: true, position: true } });
  const keys = new Set(existing.map((row) => row.key));
  const slugs = new Set(existing.flatMap((row) => [`fr:${row.slugFr}`, `en:${row.slugEn}`]));
  let position = existing.reduce((max, row) => Math.max(max, row.position), RICH_FEATURE_PAGE_SEEDS.length);

  const seeds: (FeaturePageSeed & { published: boolean })[] = [
    ...RICH_FEATURE_PAGE_SEEDS.map((seed) => ({ ...seed, published: true })),
    ...featurePageSeedModules().map((module) => ({
      key: module.key,
      slug: module.slug,
      modules: [module.name.fr, module.name.en],
      position: ++position,
      published: false,
      content: {
        fr: draftText(module.name.fr, module.description.fr, 'fr'),
        en: draftText(module.name.en, module.description.en, 'en'),
      },
    })),
  ];

  let created = 0;
  let published = 0;
  let skipped = 0;
  for (const seed of seeds) {
    if (keys.has(seed.key) || slugs.has(`fr:${seed.slug.fr}`) || slugs.has(`en:${seed.slug.en}`)) {
      skipped += 1;
      continue;
    }
    await prisma.featurePage.create({
      data: {
        key: seed.key,
        slugFr: seed.slug.fr,
        slugEn: seed.slug.en,
        modules: seed.modules,
        content: seed.content as unknown as Prisma.InputJsonValue,
        published: seed.published,
        position: seed.position,
        updatedBy: actorId,
      },
    });
    keys.add(seed.key);
    slugs.add(`fr:${seed.slug.fr}`);
    slugs.add(`en:${seed.slug.en}`);
    created += 1;
    if (seed.published) published += 1;
  }

  if (created > 0) afterWrite(published > 0);
  return { created, published, skipped };
}

/** Le squelette d'un brouillon : ce que le registre sait du module. */
function draftText(name: string, description: string, locale: FeaturePageLocale): FeaturePageText {
  return locale === 'fr'
    ? {
        name,
        title: `${name} : bot Discord · Kotbo`,
        description,
        h1: name,
        lead: description,
        sections: [{ h2: 'Ce que fait le module', body: description }],
        faq: [],
      }
    : {
        name,
        title: `${name}: Discord bot · Kotbo`,
        description,
        h1: name,
        lead: description,
        sections: [{ h2: 'What the module does', body: description }],
        faq: [],
      };
}

// ── Reconstruction du site ─────────────────────────────────────────────────

const LANDING_REPO = process.env.LANDING_REPO ?? 'Kotbo-Bot/Landing-Page';
const REBUILD_DELAY_MS = 60_000;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

/** Le site peut-il être reconstruit automatiquement ? Affiché dans la console. */
export function isLandingRebuildConfigured(): boolean {
  return Boolean(process.env.LANDING_DEPLOY_TOKEN);
}

function afterWrite(affectsSite: boolean): void {
  publicCache = null;
  if (affectsSite) requestLandingRebuild();
}

/**
 * Relance le workflow de déploiement du site (`repository_dispatch`). Regroupé
 * sur une minute : corriger trois pages d'affilée ne lance qu'un build.
 */
export function requestLandingRebuild(): void {
  const token = process.env.LANDING_DEPLOY_TOKEN;
  if (!token) return;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void fetch(`https://api.github.com/repos/${LANDING_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'kotbo-feature-pages',
      },
      body: JSON.stringify({ event_type: 'feature-pages' }),
    })
      .then((response) => {
        if (!response.ok) logger.warn('FeaturePages', `Reconstruction du site refusée par GitHub (${response.status}).`);
      })
      .catch((err) => logger.error('FeaturePages', 'Reconstruction du site impossible', err));
  }, REBUILD_DELAY_MS);
  rebuildTimer.unref?.();
}
