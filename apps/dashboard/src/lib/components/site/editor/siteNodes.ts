/**
 * Nœuds et marques propres aux pages du site, pour Tiptap.
 *
 * Les noms et les attributs suivent exactement la liste blanche du serveur
 * (`normalizeSiteDocument` dans @kotbo/shared) : l'éditeur ne produit rien que
 * le serveur jetterait. Les nœuds « atomiques » (bloc de module, bouton, vidéo,
 * sommaire) se configurent dans un panneau : leur vue délègue le clic à
 * `editor.storage.siteNodes.onConfigure`, que la page branche sur sa modale.
 */
import { Extension, Mark, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { SITE_CALLOUT_VARIANTS, SITE_HIGHLIGHT_COLORS, SITE_IMAGE_WIDTHS, sanitizeSiteHref } from '@kotbo/shared';

export interface ConfigureRequest {
  type: string;
  pos: number;
  attrs: Record<string, unknown>;
}

export interface SiteNodesStorage {
  onConfigure: ((request: ConfigureRequest) => void) | null;
  describeModule: ((key: string, config: Record<string, unknown>) => { label: string; summary: string; icon: string; available: boolean }) | null;
  labels: Record<string, string>;
}

declare module '@tiptap/core' {
  interface Storage {
    siteNodes: SiteNodesStorage;
  }
}

/** Point d'ancrage des rappels de la page : configuration, libellés. */
export const SiteNodesBridge = Extension.create<Record<string, never>, SiteNodesStorage>({
  name: 'siteNodes',
  addStorage() {
    return { onConfigure: null, describeModule: null, labels: {} };
  },
});

function label(editor: Editor, key: string, fallback: string): string {
  return editor.storage.siteNodes?.labels[key] ?? fallback;
}

function configure(editor: Editor, type: string, getPos: () => number | undefined, attrs: Record<string, unknown>) {
  const pos = getPos();
  if (typeof pos === 'number') editor.storage.siteNodes?.onConfigure?.({ type, pos, attrs });
}

/** Carte d'un nœud atomique : icône, titre, résumé, bouton « Configurer ». */
function atomCard(editor: Editor, opts: { icon: string; title: string; summary: string; warning?: string; onConfigure: () => void }): HTMLElement {
  const card = document.createElement('div');
  card.className = 'site-atom';
  card.contentEditable = 'false';
  const icon = document.createElement('span');
  icon.className = 'site-atom-icon';
  icon.textContent = opts.icon;
  const body = document.createElement('div');
  body.className = 'site-atom-body';
  const title = document.createElement('p');
  title.className = 'site-atom-title';
  title.textContent = opts.title;
  const summary = document.createElement('p');
  summary.className = 'site-atom-summary';
  summary.textContent = opts.summary;
  body.append(title, summary);
  if (opts.warning) {
    const warning = document.createElement('p');
    warning.className = 'site-atom-warning';
    warning.textContent = opts.warning;
    body.append(warning);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'site-atom-button';
  button.textContent = label(editor, 'configure', 'Configurer');
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    opts.onConfigure();
  });
  card.append(icon, body, button);
  return card;
}

// ─── Bloc de module ─────────────────────────────────────────────────────────

export const ModuleNode = Node.create({
  name: 'module',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      module: { default: 'staff' },
      config: { default: {} },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-site-module]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-site-module': HTMLAttributes.module })];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const render = (attrs: Record<string, unknown>) => {
        const description = editor.storage.siteNodes?.describeModule?.(String(attrs.module), (attrs.config ?? {}) as Record<string, unknown>) ?? {
          label: String(attrs.module),
          summary: '',
          icon: '🧩',
          available: true,
        };
        return atomCard(editor, {
          icon: description.icon,
          title: description.label,
          summary: description.summary,
          warning: description.available ? undefined : label(editor, 'moduleOff', 'Module éteint : ce bloc ne s’affiche pas sur le site.'),
          onConfigure: () => configure(editor, 'module', getPos, attrs),
        });
      };
      let dom = render(node.attrs);
      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'module') return false;
          const next = render(updated.attrs);
          dom.replaceWith(next);
          dom = next;
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

// ─── Image légendée ─────────────────────────────────────────────────────────

export const SiteImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: '' },
      caption: { default: '' },
      width: { default: 'wide' },
    };
  },
  parseHTML() {
    return [{ tag: 'figure[data-site-image]' }, { tag: 'img[src]', getAttrs: (el) => ({ src: (el as HTMLImageElement).getAttribute('src'), alt: (el as HTMLImageElement).getAttribute('alt') ?? '' }) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', { 'data-site-image': '', class: `img img-${HTMLAttributes.width}` }, ['img', { src: HTMLAttributes.src, alt: HTMLAttributes.alt }]];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const figure = document.createElement('figure');
      figure.className = `img img-${node.attrs.width} site-image`;
      figure.contentEditable = 'false';
      const img = document.createElement('img');
      img.src = node.attrs.src ?? '';
      img.alt = node.attrs.alt ?? '';
      const caption = document.createElement('input');
      caption.className = 'site-image-caption';
      caption.placeholder = label(editor, 'caption', 'Légende (facultatif)');
      caption.value = node.attrs.caption ?? '';
      caption.addEventListener('change', () => {
        const pos = getPos();
        if (typeof pos === 'number') editor.chain().command(({ tr }) => {
          tr.setNodeAttribute(pos, 'caption', caption.value.slice(0, 300));
          return true;
        }).run();
      });
      caption.addEventListener('keydown', (event) => event.stopPropagation());
      const toolbar = document.createElement('div');
      toolbar.className = 'site-image-toolbar';
      for (const width of SITE_IMAGE_WIDTHS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label(editor, `width_${width}`, width);
        b.className = node.attrs.width === width ? 'is-active' : '';
        b.addEventListener('mousedown', (event) => event.preventDefault());
        b.addEventListener('click', () => {
          const pos = getPos();
          if (typeof pos === 'number') editor.chain().command(({ tr }) => {
            tr.setNodeAttribute(pos, 'width', width);
            return true;
          }).run();
        });
        toolbar.append(b);
      }
      const alt = document.createElement('button');
      alt.type = 'button';
      alt.textContent = label(editor, 'altText', 'Texte alternatif');
      alt.addEventListener('mousedown', (event) => event.preventDefault());
      alt.addEventListener('click', () => configure(editor, 'image', getPos, node.attrs));
      toolbar.append(alt);
      figure.append(toolbar, img, caption);
      return {
        dom: figure,
        update(updated) {
          if (updated.type.name !== 'image') return false;
          figure.className = `img img-${updated.attrs.width} site-image`;
          img.src = updated.attrs.src ?? '';
          img.alt = updated.attrs.alt ?? '';
          if (document.activeElement !== caption) caption.value = updated.attrs.caption ?? '';
          toolbar.querySelectorAll('button').forEach((b, i) => {
            if (i < SITE_IMAGE_WIDTHS.length) b.className = SITE_IMAGE_WIDTHS[i] === updated.attrs.width ? 'is-active' : '';
          });
          return true;
        },
        stopEvent: (event) => event.target === caption,
        ignoreMutation: () => true,
      };
    };
  },
});

// ─── Encadré ────────────────────────────────────────────────────────────────

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { variant: { default: 'info' }, icon: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['aside', { 'data-callout': '', class: `callout callout-${HTMLAttributes.variant}` }, 0];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('aside');
      dom.className = `callout callout-${node.attrs.variant}`;
      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'callout-icon site-callout-switch';
      icon.contentEditable = 'false';
      icon.textContent = node.attrs.icon || 'ℹ️';
      icon.title = label(editor, 'calloutStyle', 'Style de l’encadré');
      icon.addEventListener('mousedown', (event) => event.preventDefault());
      icon.addEventListener('click', () => {
        // Clic : variante suivante, comme un sélecteur rapide.
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const current = SITE_CALLOUT_VARIANTS.indexOf(node.attrs.variant);
        const next = SITE_CALLOUT_VARIANTS[(current + 1) % SITE_CALLOUT_VARIANTS.length];
        const icons: Record<string, string> = { info: 'ℹ️', success: '✅', warning: '⚠️', danger: '⛔', note: '📝' };
        editor.chain().command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, variant: next, icon: icons[next] });
          return true;
        }).run();
      });
      const content = document.createElement('div');
      content.className = 'callout-body';
      dom.append(icon, content);
      return { dom, contentDOM: content };
    };
  },
});

// ─── Grille bento ───────────────────────────────────────────────────────────

export const Grid = Node.create({
  name: 'grid',
  group: 'block',
  content: 'gridCell+',
  isolating: true,
  addAttributes() {
    return { columns: { default: 2 } };
  },
  parseHTML() {
    return [{ tag: 'div[data-grid]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-grid': '', class: `bento cols-${HTMLAttributes.columns}` }, 0];
  },
});

export const GridCell = Node.create({
  name: 'gridCell',
  content: 'block+',
  isolating: true,
  addAttributes() {
    return { span: { default: 1 }, rowSpan: { default: 1 }, surface: { default: true } };
  },
  parseHTML() {
    return [{ tag: 'div[data-grid-cell]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const classes = ['cell', `span-${HTMLAttributes.span}`];
    if (Number(HTMLAttributes.rowSpan) > 1) classes.push(`rows-${HTMLAttributes.rowSpan}`);
    if (HTMLAttributes.surface !== false) classes.push('surface');
    return ['div', { 'data-grid-cell': '', class: classes.join(' ') }, 0];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      const apply = (attrs: Record<string, unknown>) => {
        dom.className = ['cell', `span-${attrs.span}`, Number(attrs.rowSpan) > 1 ? `rows-${attrs.rowSpan}` : '', attrs.surface !== false ? 'surface' : '', 'site-cell'].filter(Boolean).join(' ');
      };
      apply(node.attrs);
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'site-cell-handle';
      handle.contentEditable = 'false';
      handle.textContent = '⋯';
      handle.title = label(editor, 'cellSettings', 'Réglages de la case');
      handle.addEventListener('mousedown', (event) => event.preventDefault());
      handle.addEventListener('click', () => configure(editor, 'gridCell', getPos, node.attrs));
      const content = document.createElement('div');
      content.className = 'site-cell-content';
      dom.append(handle, content);
      return {
        dom,
        contentDOM: content,
        update(updated) {
          if (updated.type.name !== 'gridCell') return false;
          apply(updated.attrs);
          node = updated;
          return true;
        },
      };
    };
  },
});

// ─── Bouton ─────────────────────────────────────────────────────────────────

export const SiteButton = Node.create({
  name: 'button',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { label: { default: '' }, href: { default: '' }, variant: { default: 'primary' }, align: { default: 'left' } };
  },
  parseHTML() {
    return [{ tag: 'p[data-site-button]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['p', { 'data-site-button': '', class: `btn-row ta-${HTMLAttributes.align}` }, ['a', { class: `btn btn-${HTMLAttributes.variant}`, href: HTMLAttributes.href }, HTMLAttributes.label]];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('p');
      const render = (attrs: Record<string, unknown>) => {
        dom.className = `btn-row ta-${attrs.align} site-button`;
        dom.contentEditable = 'false';
        dom.textContent = '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-${attrs.variant}`;
        button.textContent = String(attrs.label || label(editor, 'buttonEmpty', 'Bouton sans texte'));
        button.title = String(attrs.href || '');
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => configure(editor, 'button', getPos, attrs));
        dom.append(button);
      };
      render(node.attrs);
      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'button') return false;
          render(updated.attrs);
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

// ─── FAQ ────────────────────────────────────────────────────────────────────

export const Faq = Node.create({
  name: 'faq',
  group: 'block',
  content: 'faqItem+',
  parseHTML() {
    return [{ tag: 'div[data-faq]' }];
  },
  renderHTML() {
    return ['div', { 'data-faq': '', class: 'faq' }, 0];
  },
});

export const FaqItem = Node.create({
  name: 'faqItem',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { question: { default: '' }, open: { default: false } };
  },
  parseHTML() {
    return [{ tag: 'details[data-faq-item]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['details', { 'data-faq-item': '', class: 'faq-item', open: 'open' }, ['summary', {}, HTMLAttributes.question], ['div', { class: 'faq-answer' }, 0]];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'faq-item site-faq-item';
      const question = document.createElement('input');
      question.className = 'site-faq-question';
      question.placeholder = label(editor, 'faqQuestion', 'Question');
      question.value = node.attrs.question ?? '';
      question.addEventListener('change', () => {
        const pos = getPos();
        if (typeof pos === 'number') editor.chain().command(({ tr }) => {
          tr.setNodeAttribute(pos, 'question', question.value.slice(0, 300));
          return true;
        }).run();
      });
      question.addEventListener('keydown', (event) => event.stopPropagation());
      const content = document.createElement('div');
      content.className = 'faq-answer';
      dom.append(question, content);
      return {
        dom,
        contentDOM: content,
        update(updated) {
          if (updated.type.name !== 'faqItem') return false;
          if (document.activeElement !== question) question.value = updated.attrs.question ?? '';
          return true;
        },
        stopEvent: (event) => event.target === question,
        ignoreMutation: (mutation) => !content.contains(mutation.target as globalThis.Node),
      };
    };
  },
});

// ─── Vidéo ──────────────────────────────────────────────────────────────────

export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { provider: { default: 'youtube' }, videoId: { default: '' }, caption: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'figure[data-site-video]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', { 'data-site-video': '', class: 'video' }, `${HTMLAttributes.provider}:${HTMLAttributes.videoId}`];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const render = (attrs: Record<string, unknown>) =>
        atomCard(editor, {
          icon: attrs.provider === 'twitch' ? '🟣' : attrs.provider === 'vimeo' ? '🎞️' : '▶️',
          title: label(editor, 'video', 'Vidéo'),
          summary: `${attrs.provider} · ${attrs.videoId}`,
          onConfigure: () => configure(editor, 'video', getPos, attrs),
        });
      let dom = render(node.attrs);
      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'video') return false;
          const next = render(updated.attrs);
          dom.replaceWith(next);
          dom = next;
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

// ─── Sommaire ───────────────────────────────────────────────────────────────

export const Toc = Node.create({
  name: 'toc',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { maxLevel: { default: 3 } };
  },
  parseHTML() {
    return [{ tag: 'nav[data-site-toc]' }];
  },
  renderHTML() {
    return ['nav', { 'data-site-toc': '', class: 'toc' }];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => ({
      dom: atomCard(editor, {
        icon: '🧭',
        title: label(editor, 'toc', 'Sommaire'),
        summary: label(editor, 'tocSummary', 'Construit à partir des titres de la page.'),
        onConfigure: () => configure(editor, 'toc', getPos, node.attrs),
      }),
      ignoreMutation: () => true,
    });
  },
});

// ─── Surlignage aux couleurs du thème ───────────────────────────────────────

export const SiteHighlight = Mark.create({
  name: 'highlight',
  addAttributes() {
    return { color: { default: 'accent' } };
  },
  parseHTML() {
    return [{ tag: 'mark', getAttrs: (el) => ({ color: (el as HTMLElement).dataset.color ?? 'accent' }) }];
  },
  renderHTML({ HTMLAttributes }) {
    const color = (SITE_HIGHLIGHT_COLORS as readonly string[]).includes(String(HTMLAttributes.color)) ? HTMLAttributes.color : 'accent';
    return ['mark', { 'data-color': color, class: `hl-${color}` }, 0];
  },
});

/** Lien accepté par l'éditeur : les mêmes règles que le serveur. */
export function isAllowedSiteUri(url: string): boolean {
  return sanitizeSiteHref(url) !== null;
}
