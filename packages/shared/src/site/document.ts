/**
 * Document d'une page du site communautaire.
 *
 * Le format est celui de ProseMirror (JSON), avec les noms de nœuds de Tiptap :
 * l'éditeur du dashboard le produit tel quel, l'API le normalise avant toute
 * écriture et le rendu serveur le transforme en HTML. Aucun HTML n'est jamais
 * accepté ni stocké.
 *
 * `normalizeSiteDocument` est la seule porte d'entrée : tout ce qui n'est pas
 * dans la liste blanche ci-dessous disparaît (nœud inconnu, marque inconnue,
 * attribut inattendu, URL `javascript:`), et le document est borné en taille.
 * Le rendu peut donc faire confiance à la forme de ce qu'il reçoit ; il échappe
 * malgré tout chaque valeur.
 */

import { normalizeModuleConfig, isSiteModuleKey, type SiteModuleKey } from './modules.js';

export type SiteMarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link' | 'highlight' | 'subscript' | 'superscript';

export interface SiteMark {
  type: SiteMarkType;
  attrs?: Record<string, unknown>;
}

export interface SiteNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: SiteNode[];
  marks?: SiteMark[];
  text?: string;
}

export interface SiteDocument {
  type: 'doc';
  content: SiteNode[];
}

export const EMPTY_SITE_DOCUMENT: SiteDocument = { type: 'doc', content: [] };

/** Bornes d'un document : au-delà, le surplus est tronqué, jamais refusé en bloc. */
export const SITE_DOCUMENT_LIMITS = {
  maxNodes: 6000,
  maxDepth: 14,
  maxTextLength: 20_000,
  maxAttrLength: 2000,
  maxTableColumns: 12,
} as const;

export const SITE_TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export const SITE_CALLOUT_VARIANTS = ['info', 'success', 'warning', 'danger', 'note'] as const;
export const SITE_BUTTON_VARIANTS = ['primary', 'secondary', 'ghost'] as const;
export const SITE_HIGHLIGHT_COLORS = ['accent', 'yellow', 'green', 'blue', 'pink', 'red'] as const;
export const SITE_VIDEO_PROVIDERS = ['youtube', 'twitch', 'vimeo'] as const;
export const SITE_IMAGE_WIDTHS = ['small', 'medium', 'wide', 'full'] as const;
export const SITE_BANNER_TONES = ['surface', 'accent', 'dark'] as const;
export const SITE_GALLERY_LAYOUTS = ['grid', 'carousel'] as const;
/** Plafonds des sections : au-delà, le surplus est ignoré. */
export const SITE_SECTION_LIMITS = { galleryImages: 24 } as const;

/**
 * Contenu permis de chaque nœud bloc : `block` (tout bloc), `inline` (texte),
 * ou une liste de nœuds précis. Les nœuds absents de la table sont refusés.
 */
type ContentRule = 'block' | 'inline' | 'none' | readonly string[];

const BLOCK_CONTENT: Record<string, ContentRule> = {
  paragraph: 'inline',
  heading: 'inline',
  blockquote: 'block',
  codeBlock: 'inline',
  bulletList: ['listItem'],
  orderedList: ['listItem'],
  listItem: 'block',
  taskList: ['taskItem'],
  taskItem: 'block',
  horizontalRule: 'none',
  image: 'none',
  table: ['tableRow'],
  tableRow: ['tableHeader', 'tableCell'],
  tableHeader: 'block',
  tableCell: 'block',
  callout: 'block',
  grid: ['gridCell'],
  gridCell: 'block',
  button: 'none',
  faq: ['faqItem'],
  faqItem: 'block',
  video: 'none',
  toc: 'none',
  module: 'none',
  banner: 'block',
  gallery: 'none',
  testimonials: ['testimonial'],
  testimonial: 'block',
};

/** Nœuds permis directement sous `doc` (et partout où `block` est attendu). */
const TOP_BLOCKS = new Set(
  Object.keys(BLOCK_CONTENT).filter(
    (type) => !['listItem', 'taskItem', 'tableRow', 'tableHeader', 'tableCell', 'gridCell', 'faqItem', 'testimonial'].includes(type),
  ),
);

const INLINE_NODES = new Set(['text', 'hardBreak']);
const MARK_TYPES = new Set<SiteMarkType>(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight', 'subscript', 'superscript']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number = SITE_DOCUMENT_LIMITS.maxAttrLength): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * URL d'un lien. Absolue en http(s) ou mailto, ou relative au site (`/s/…`),
 * ou ancre (`#titre`). Tout autre schéma (`javascript:`, `data:`) est refusé.
 */
export function sanitizeSiteHref(value: unknown): string | null {
  const raw = str(value).trim();
  if (!raw) return null;
  if (raw.startsWith('#')) return /^#[\w-]{1,120}$/.test(raw) ? raw : null;
  if (raw.startsWith('/')) {
    // `//hote` serait une URL absolue déguisée.
    if (raw.startsWith('//') || raw.includes('\\')) return null;
    return /^\/[\w\-./~%?=&#+:@]*$/.test(raw) ? raw : null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return url.toString();
  } catch {
    return null;
  }
  return null;
}

/**
 * Chemin des images téléversées. Indépendant du slug : renommer un site ne
 * casse ni ses pages ni son CSS.
 */
export const SITE_ASSET_PATH_PREFIX = '/s/_/a/';

/** Source d'image : https, ou image téléversée (`/s/_/a/<id>.<ext>`). */
export function sanitizeSiteImageSrc(value: unknown): string | null {
  const raw = str(value).trim();
  if (!raw) return null;
  if (raw.startsWith('/')) return /^\/s\/_\/a\/[a-z0-9]{20,32}\.(png|jpe?g|gif|webp|avif)$/.test(raw) ? raw : null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Identifiant de vidéo propre à chaque hébergeur, extrait d'une URL ou saisi tel quel. */
export function parseSiteVideo(input: unknown): { provider: (typeof SITE_VIDEO_PROVIDERS)[number]; videoId: string } | null {
  const raw = str(input).trim();
  if (!raw) return null;
  const youtube = raw.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (youtube) return { provider: 'youtube', videoId: youtube[1] };
  const twitchVideo = raw.match(/twitch\.tv\/videos\/(\d{5,15})/);
  if (twitchVideo) return { provider: 'twitch', videoId: `v${twitchVideo[1]}` };
  const twitchChannel = raw.match(/twitch\.tv\/([A-Za-z0-9_]{3,25})\/?$/);
  if (twitchChannel) return { provider: 'twitch', videoId: twitchChannel[1].toLowerCase() };
  const vimeo = raw.match(/vimeo\.com\/(\d{5,12})/);
  if (vimeo) return { provider: 'vimeo', videoId: vimeo[1] };
  return null;
}

function isValidVideoId(provider: string, id: string): boolean {
  if (provider === 'youtube') return /^[\w-]{11}$/.test(id);
  if (provider === 'twitch') return /^(v\d{5,15}|[a-z0-9_]{3,25})$/.test(id);
  if (provider === 'vimeo') return /^\d{5,12}$/.test(id);
  return false;
}

function normalizeMarks(marks: unknown): SiteMark[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out: SiteMark[] = [];
  const seen = new Set<string>();
  for (const mark of marks) {
    if (!isRecord(mark) || typeof mark.type !== 'string') continue;
    const type = mark.type as SiteMarkType;
    if (!MARK_TYPES.has(type) || seen.has(type)) continue;
    const attrs = isRecord(mark.attrs) ? mark.attrs : {};
    if (type === 'link') {
      const href = sanitizeSiteHref(attrs.href);
      if (!href) continue;
      out.push({ type, attrs: { href } });
    } else if (type === 'highlight') {
      out.push({ type, attrs: { color: oneOf(attrs.color, SITE_HIGHLIGHT_COLORS, 'accent') } });
    } else {
      out.push({ type });
    }
    seen.add(type);
  }
  return out.length > 0 ? out : undefined;
}

/** Attributs propres à chaque nœud, réduits à ce que le rendu sait lire. */
function normalizeAttrs(type: string, attrs: Record<string, unknown>): Record<string, unknown> | undefined | null {
  switch (type) {
    case 'paragraph':
      return attrs.textAlign && attrs.textAlign !== 'left' ? { textAlign: oneOf(attrs.textAlign, SITE_TEXT_ALIGNS, 'left') } : undefined;
    case 'heading':
      return {
        level: int(attrs.level, 1, 4, 2),
        ...(attrs.textAlign && attrs.textAlign !== 'left' ? { textAlign: oneOf(attrs.textAlign, SITE_TEXT_ALIGNS, 'left') } : {}),
      };
    case 'orderedList':
      return { start: int(attrs.start, 1, 100_000, 1) };
    case 'taskItem':
      return { checked: attrs.checked === true };
    case 'codeBlock': {
      const language = str(attrs.language, 30).toLowerCase();
      return /^[a-z0-9+#-]{1,30}$/.test(language) ? { language } : undefined;
    }
    case 'tableHeader':
    case 'tableCell':
      return { colspan: int(attrs.colspan, 1, SITE_DOCUMENT_LIMITS.maxTableColumns, 1), rowspan: int(attrs.rowspan, 1, 50, 1) };
    case 'image': {
      const src = sanitizeSiteImageSrc(attrs.src);
      if (!src) return null;
      return {
        src,
        alt: str(attrs.alt, 300),
        caption: str(attrs.caption, 300),
        width: oneOf(attrs.width, SITE_IMAGE_WIDTHS, 'wide'),
      };
    }
    case 'callout':
      return { variant: oneOf(attrs.variant, SITE_CALLOUT_VARIANTS, 'info'), icon: str(attrs.icon, 16) };
    case 'grid':
      return { columns: int(attrs.columns, 1, 4, 2) };
    case 'gridCell':
      return { span: int(attrs.span, 1, 4, 1), rowSpan: int(attrs.rowSpan, 1, 3, 1), surface: attrs.surface === false ? false : true };
    case 'button': {
      const href = sanitizeSiteHref(attrs.href);
      const label = str(attrs.label, 80).trim();
      if (!href || !label) return null;
      return { label, href, variant: oneOf(attrs.variant, SITE_BUTTON_VARIANTS, 'primary'), align: oneOf(attrs.align, SITE_TEXT_ALIGNS, 'left') };
    }
    case 'faqItem': {
      const question = str(attrs.question, 300).trim();
      return { question: question || '…', open: attrs.open === true };
    }
    case 'video': {
      const provider = oneOf(attrs.provider, SITE_VIDEO_PROVIDERS, 'youtube');
      const videoId = str(attrs.videoId, 40);
      if (!isValidVideoId(provider, videoId)) return null;
      return { provider, videoId, caption: str(attrs.caption, 300) };
    }
    case 'toc':
      return { maxLevel: int(attrs.maxLevel, 2, 4, 3) };
    case 'banner':
      return {
        image: sanitizeSiteImageSrc(attrs.image) ?? '',
        tone: oneOf(attrs.tone, SITE_BANNER_TONES, 'surface'),
        align: oneOf(attrs.align, ['left', 'center'] as const, 'center'),
        tall: attrs.tall === true,
      };
    case 'gallery': {
      const images = (Array.isArray(attrs.images) ? attrs.images : [])
        .filter(isRecord)
        .map((image) => ({ src: sanitizeSiteImageSrc(image.src) ?? '', alt: str(image.alt, 300), caption: str(image.caption, 300) }))
        .filter((image) => image.src)
        .slice(0, SITE_SECTION_LIMITS.galleryImages);
      return { images, layout: oneOf(attrs.layout, SITE_GALLERY_LAYOUTS, 'grid'), columns: int(attrs.columns, 2, 4, 3) };
    }
    case 'testimonials':
      return { columns: int(attrs.columns, 1, 3, 3) };
    case 'testimonial':
      return { name: str(attrs.name, 80).trim(), role: str(attrs.role, 80).trim(), avatar: sanitizeSiteImageSrc(attrs.avatar) ?? '' };
    case 'module': {
      if (!isSiteModuleKey(attrs.module)) return null;
      const moduleKey: SiteModuleKey = attrs.module;
      return { module: moduleKey, config: normalizeModuleConfig(moduleKey, attrs.config) };
    }
    default:
      return undefined;
  }
}

interface WalkState {
  nodes: number;
}

function normalizeInline(raw: unknown[], state: WalkState): SiteNode[] {
  const out: SiteNode[] = [];
  for (const child of raw) {
    if (state.nodes >= SITE_DOCUMENT_LIMITS.maxNodes) break;
    if (!isRecord(child) || typeof child.type !== 'string' || !INLINE_NODES.has(child.type)) continue;
    state.nodes += 1;
    if (child.type === 'hardBreak') {
      out.push({ type: 'hardBreak' });
      continue;
    }
    const text = str(child.text, SITE_DOCUMENT_LIMITS.maxTextLength);
    if (!text) continue;
    const marks = normalizeMarks(child.marks);
    const previous = out[out.length - 1];
    // Fusionne deux textes voisins de mêmes marques : l'éditeur en produit en
    // rafale, et chaque fragment coûte un nœud sur le plafond.
    if (previous?.type === 'text' && JSON.stringify(previous.marks ?? null) === JSON.stringify(marks ?? null)) {
      previous.text = `${previous.text ?? ''}${text}`.slice(0, SITE_DOCUMENT_LIMITS.maxTextLength);
      continue;
    }
    out.push(marks ? { type: 'text', text, marks } : { type: 'text', text });
  }
  return out;
}

function normalizeBlock(raw: unknown, allowed: ContentRule, depth: number, state: WalkState): SiteNode | null {
  if (state.nodes >= SITE_DOCUMENT_LIMITS.maxNodes || depth > SITE_DOCUMENT_LIMITS.maxDepth) return null;
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  const type = raw.type;
  const rule = BLOCK_CONTENT[type];
  if (!rule) return null;
  if (allowed === 'block' ? !TOP_BLOCKS.has(type) : Array.isArray(allowed) ? !allowed.includes(type) : true) return null;

  const attrs = normalizeAttrs(type, isRecord(raw.attrs) ? raw.attrs : {});
  if (attrs === null) return null;
  state.nodes += 1;

  const node: SiteNode = { type };
  if (attrs) node.attrs = attrs;

  const children = Array.isArray(raw.content) ? raw.content : [];
  if (rule === 'inline') {
    let inline = normalizeInline(children, state);
    // Un bloc de code ne garde ni marques ni sauts : du texte brut.
    if (type === 'codeBlock') inline = inline.filter((n) => n.type === 'text').map((n) => ({ type: 'text', text: n.text }));
    if (inline.length > 0) node.content = inline;
  } else if (rule !== 'none') {
    const content: SiteNode[] = [];
    for (const child of children) {
      const normalized = normalizeBlock(child, rule, depth + 1, state);
      if (normalized) content.push(normalized);
    }
    // Conteneurs qui n'ont de sens qu'avec un contenu : vides, ils sautent.
    if (content.length === 0) {
      if (['bulletList', 'orderedList', 'taskList', 'table', 'tableRow', 'grid', 'faq', 'testimonials'].includes(type)) return null;
      // Une cellule, un élément de liste ou un encadré vide garde un paragraphe
      // vide : ProseMirror refuse un nœud bloc sans contenu.
      content.push({ type: 'paragraph' });
    }
    node.content = content;
  }

  if (type === 'table') {
    // Une ligne trop large est rognée plutôt que de casser la mise en page.
    for (const row of node.content ?? []) {
      if (row.content && row.content.length > SITE_DOCUMENT_LIMITS.maxTableColumns) {
        row.content = row.content.slice(0, SITE_DOCUMENT_LIMITS.maxTableColumns);
      }
    }
  }

  return node;
}

/** Ramène n'importe quelle entrée à un document valide, éventuellement vide. */
export function normalizeSiteDocument(input: unknown): SiteDocument {
  const raw = typeof input === 'string' ? safeParse(input) : input;
  if (!isRecord(raw) || raw.type !== 'doc' || !Array.isArray(raw.content)) return { type: 'doc', content: [] };
  const state: WalkState = { nodes: 0 };
  const content: SiteNode[] = [];
  for (const child of raw.content) {
    const node = normalizeBlock(child, 'block', 1, state);
    if (node) content.push(node);
  }
  return { type: 'doc', content };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Retire accents et casse : la recherche se fait sur ce texte-là. */
export function foldSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Texte brut d'un document, blocs séparés par des espaces. Sert à la
 * recherche, aux résumés automatiques et au temps de lecture.
 */
export function extractSiteDocumentText(doc: SiteDocument, maxLength = 200_000): string {
  const parts: string[] = [];
  let length = 0;
  const visit = (node: SiteNode) => {
    if (length >= maxLength) return;
    if (node.type === 'text' && node.text) {
      parts.push(node.text);
      length += node.text.length;
      return;
    }
    if (node.type === 'faqItem' && typeof node.attrs?.question === 'string') {
      parts.push(` ${node.attrs.question} `);
    }
    if (node.type === 'image' && typeof node.attrs?.caption === 'string' && node.attrs.caption) {
      parts.push(` ${node.attrs.caption} `);
    }
    for (const child of node.content ?? []) visit(child);
    if (node.type !== 'text' && node.type !== 'hardBreak') parts.push(' ');
  };
  for (const node of doc.content) visit(node);
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** Les titres du document, pour le sommaire et les ancres. */
export interface SiteHeading {
  level: number;
  text: string;
  id: string;
}

/** Identifiant d'ancre stable à partir d'un texte de titre. */
export function headingAnchor(text: string): string {
  const base = foldSearchText(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'section';
}

export function collectSiteHeadings(doc: SiteDocument): SiteHeading[] {
  const headings: SiteHeading[] = [];
  const used = new Map<string, number>();
  const visit = (node: SiteNode) => {
    if (node.type === 'heading') {
      const text = (node.content ?? []).map((n) => n.text ?? '').join('').trim();
      if (text) {
        const base = headingAnchor(text);
        const count = used.get(base) ?? 0;
        used.set(base, count + 1);
        headings.push({ level: Number(node.attrs?.level ?? 2), text, id: count === 0 ? base : `${base}-${count + 1}` });
      }
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of doc.content) visit(node);
  return headings;
}

/** Modules utilisés par un document : le rendu ne charge que leurs données. */
export function collectSiteModules(doc: SiteDocument): SiteModuleKey[] {
  const found = new Set<SiteModuleKey>();
  const visit = (node: SiteNode) => {
    if (node.type === 'module' && isSiteModuleKey(node.attrs?.module)) found.add(node.attrs.module);
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of doc.content) visit(node);
  return [...found];
}

/** Temps de lecture estimé, en minutes, à 220 mots par minute. */
export function estimateReadingMinutes(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
