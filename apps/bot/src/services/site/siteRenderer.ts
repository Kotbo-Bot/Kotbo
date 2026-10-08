/**
 * Document d'une page → HTML.
 *
 * Le document a déjà été normalisé (`normalizeSiteDocument`) : seuls des nœuds
 * et attributs connus arrivent ici. Le rendu échappe malgré tout chaque valeur,
 * pour qu'une évolution de la normalisation ne puisse jamais ouvrir une faille
 * à elle seule.
 *
 * Les blocs de modules sont asynchrones (requêtes, cache) : la page les résout
 * d'abord, dans l'ordre du document, puis passe leur HTML à ce rendu, qui reste
 * synchrone et pur.
 */

import { collectSiteHeadings, type SiteDocument, type SiteMark, type SiteNode } from '@kotbo/shared';
import { attrs, cls, esc } from './siteHtml.js';

export interface SiteRenderEnv {
  /** Racine du site, sans barre finale : `/s/mon-serveur`. */
  basePath: string;
  /** Hôte qui affiche la page, exigé par le lecteur Twitch (`parent=`). */
  host: string;
  /** HTML de chaque nœud `module`, dans l'ordre du document. */
  moduleHtml: string[];
  labels: { toc: string; video: string };
}

const HIGHLIGHT_CLASSES: Record<string, string> = {
  accent: 'hl-accent',
  yellow: 'hl-yellow',
  green: 'hl-green',
  blue: 'hl-blue',
  pink: 'hl-pink',
  red: 'hl-red',
};

/**
 * Lien interne au site, saisi `/~/wiki/regles` dans l'éditeur : il suit le
 * site si son slug change.
 */
export function resolveSiteHref(href: string, basePath: string): string {
  if (href.startsWith('/~/')) return `${basePath}/${href.slice(3)}`;
  if (href === '/~') return basePath;
  return href;
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith('mailto:');
}

function renderLink(href: string, inner: string, basePath: string): string {
  const resolved = resolveSiteHref(href, basePath);
  if (isExternal(resolved)) {
    return `<a${attrs({ href: resolved, rel: 'noopener noreferrer ugc', target: resolved.startsWith('mailto:') ? null : '_blank' })}>${inner}</a>`;
  }
  return `<a${attrs({ href: resolved })}>${inner}</a>`;
}

function renderText(node: SiteNode, env: SiteRenderEnv): string {
  let html = esc(node.text ?? '');
  const marks: SiteMark[] = node.marks ?? [];
  // Le lien enveloppe le reste : un lien en gras reste un seul lien.
  const ordered = [...marks].sort((a, b) => (a.type === 'link' ? 1 : 0) - (b.type === 'link' ? 1 : 0));
  for (const mark of ordered) {
    switch (mark.type) {
      case 'bold':
        html = `<strong>${html}</strong>`;
        break;
      case 'italic':
        html = `<em>${html}</em>`;
        break;
      case 'underline':
        html = `<u>${html}</u>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'subscript':
        html = `<sub>${html}</sub>`;
        break;
      case 'superscript':
        html = `<sup>${html}</sup>`;
        break;
      case 'highlight':
        html = `<mark class="${HIGHLIGHT_CLASSES[String(mark.attrs?.color)] ?? 'hl-accent'}">${html}</mark>`;
        break;
      case 'link':
        if (typeof mark.attrs?.href === 'string') html = renderLink(mark.attrs.href, html, env.basePath);
        break;
    }
  }
  return html;
}

function align(node: SiteNode): string | null {
  const value = node.attrs?.textAlign;
  return typeof value === 'string' && value !== 'left' ? `ta-${value}` : null;
}

function videoSrc(provider: string, id: string, host: string): string | null {
  switch (provider) {
    case 'youtube':
      return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0`;
    case 'twitch':
      return id.startsWith('v')
        ? `https://player.twitch.tv/?video=${encodeURIComponent(id)}&parent=${encodeURIComponent(host)}&autoplay=false`
        : `https://player.twitch.tv/?channel=${encodeURIComponent(id)}&parent=${encodeURIComponent(host)}&autoplay=false`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${encodeURIComponent(id)}?dnt=1`;
    default:
      return null;
  }
}

class Renderer {
  private moduleIndex = 0;
  private headingIndex = 0;
  private readonly headingIds: string[];
  private readonly headings: ReturnType<typeof collectSiteHeadings>;

  constructor(
    doc: SiteDocument,
    private readonly env: SiteRenderEnv,
  ) {
    this.headings = collectSiteHeadings(doc);
    this.headingIds = this.headings.map((h) => h.id);
  }

  children(node: SiteNode): string {
    return (node.content ?? []).map((child) => this.node(child)).join('');
  }

  inline(node: SiteNode): string {
    return (node.content ?? [])
      .map((child) => (child.type === 'hardBreak' ? '<br>' : child.type === 'text' ? renderText(child, this.env) : ''))
      .join('');
  }

  node(node: SiteNode): string {
    const a = node.attrs ?? {};
    switch (node.type) {
      case 'paragraph': {
        const inner = this.inline(node);
        return `<p${attrs({ class: align(node) })}>${inner || '<br>'}</p>`;
      }
      case 'heading': {
        const level = Math.min(4, Math.max(1, Number(a.level) || 2));
        const inner = this.inline(node);
        // Le titre de la page est le seul h1 : un titre de niveau 1 du document devient h2.
        const tag = `h${level + 1}`;
        // Même règle que collectSiteHeadings : seul un titre qui a du texte compte.
        const hasText = (node.content ?? []).some((n) => (n.text ?? '').trim());
        const id = hasText ? this.headingIds[this.headingIndex++] : undefined;
        const anchor = id ? `<a class="anchor" href="#${esc(id)}" aria-hidden="true" tabindex="-1">#</a>` : '';
        return `<${tag}${attrs({ id, class: cls(`doc-h${level}`, align(node)) })}>${inner}${anchor}</${tag}>`;
      }
      case 'blockquote':
        return `<blockquote>${this.children(node)}</blockquote>`;
      case 'codeBlock': {
        const code = (node.content ?? []).map((n) => esc(n.text ?? '')).join('');
        const language = typeof a.language === 'string' ? a.language : '';
        return `<pre${attrs({ 'data-lang': language })}><code${attrs({ class: language ? `language-${language}` : null })}>${code}</code></pre>`;
      }
      case 'bulletList':
        return `<ul>${this.children(node)}</ul>`;
      case 'orderedList':
        return `<ol${attrs({ start: Number(a.start) > 1 ? Number(a.start) : null })}>${this.children(node)}</ol>`;
      case 'listItem':
        return `<li>${this.children(node)}</li>`;
      case 'taskList':
        return `<ul class="tasks">${this.children(node)}</ul>`;
      case 'taskItem':
        return `<li class="${a.checked ? 'task done' : 'task'}"><span class="task-box" aria-hidden="true"></span><div>${this.children(node)}</div></li>`;
      case 'horizontalRule':
        return '<hr>';
      case 'image': {
        const caption = typeof a.caption === 'string' && a.caption ? `<figcaption>${esc(a.caption)}</figcaption>` : '';
        return `<figure class="img img-${esc(a.width ?? 'wide')}"><img${attrs({ src: String(a.src), alt: String(a.alt ?? ''), loading: 'lazy', decoding: 'async' })}>${caption}</figure>`;
      }
      case 'table':
        return `<div class="table-wrap"><table>${this.children(node)}</table></div>`;
      case 'tableRow':
        return `<tr>${this.children(node)}</tr>`;
      case 'tableHeader':
      case 'tableCell': {
        const tag = node.type === 'tableHeader' ? 'th' : 'td';
        return `<${tag}${attrs({ colspan: Number(a.colspan) > 1 ? Number(a.colspan) : null, rowspan: Number(a.rowspan) > 1 ? Number(a.rowspan) : null })}>${this.children(node)}</${tag}>`;
      }
      case 'callout': {
        const icon = typeof a.icon === 'string' && a.icon ? `<span class="callout-icon" aria-hidden="true">${esc(a.icon)}</span>` : '';
        return `<aside class="callout callout-${esc(a.variant ?? 'info')}">${icon}<div class="callout-body">${this.children(node)}</div></aside>`;
      }
      case 'grid':
        return `<div class="bento cols-${esc(a.columns ?? 2)}">${this.children(node)}</div>`;
      case 'gridCell':
        return `<div class="${cls('cell', `span-${Number(a.span) || 1}`, Number(a.rowSpan) > 1 && `rows-${Number(a.rowSpan)}`, a.surface !== false && 'surface')}">${this.children(node)}</div>`;
      case 'button':
        return `<p class="${cls('btn-row', typeof a.align === 'string' && a.align !== 'left' && `ta-${a.align}`)}">${renderButton(String(a.href), String(a.label), String(a.variant ?? 'primary'), this.env.basePath)}</p>`;
      case 'faq':
        return `<div class="faq">${this.children(node)}</div>`;
      case 'faqItem':
        return `<details class="faq-item"${a.open ? ' open' : ''}><summary>${esc(a.question)}</summary><div class="faq-answer">${this.children(node)}</div></details>`;
      case 'video': {
        const src = videoSrc(String(a.provider), String(a.videoId), this.env.host);
        if (!src) return '';
        const caption = typeof a.caption === 'string' && a.caption ? `<figcaption>${esc(a.caption)}</figcaption>` : '';
        return `<figure class="video"><div class="video-frame"><iframe${attrs({
          src,
          title: (typeof a.caption === 'string' && a.caption) || this.env.labels.video,
          loading: 'lazy',
          allow: 'encrypted-media; picture-in-picture; fullscreen',
          allowfullscreen: true,
          referrerpolicy: 'strict-origin-when-cross-origin',
        })}></iframe></div>${caption}</figure>`;
      }
      case 'toc':
        return this.toc(Number(a.maxLevel) || 3);
      case 'module':
        return this.env.moduleHtml[this.moduleIndex++] ?? '';
      default:
        return '';
    }
  }

  toc(maxLevel: number): string {
    const items = this.headings.filter((h) => h.level <= maxLevel);
    if (items.length === 0) return '';
    const list = items.map((h) => `<li class="toc-l${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('');
    return `<nav class="toc" aria-label="${esc(this.env.labels.toc)}"><p class="toc-title">${esc(this.env.labels.toc)}</p><ol>${list}</ol></nav>`;
  }
}

export function renderButton(href: string, label: string, variant: string, basePath: string): string {
  const resolved = resolveSiteHref(href, basePath);
  const external = isExternal(resolved);
  return `<a${attrs({
    class: `btn btn-${['primary', 'secondary', 'ghost'].includes(variant) ? variant : 'primary'}`,
    href: resolved,
    rel: external ? 'noopener noreferrer' : null,
    target: external && !resolved.startsWith('mailto:') ? '_blank' : null,
  })}>${esc(label)}</a>`;
}

export function renderSiteDocument(doc: SiteDocument, env: SiteRenderEnv): string {
  const renderer = new Renderer(doc, env);
  return doc.content.map((node) => renderer.node(node)).join('\n');
}
