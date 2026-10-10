/**
 * Markdown ↔ document du site, pour les agents (MCP).
 *
 * Les personnes éditent en WYSIWYG et rien n'est stocké en Markdown : ce
 * module ne sert qu'à laisser un agent lire et écrire une page sans manier le
 * JSON ProseMirror. Le Markdown entrant est converti puis normalisé par la
 * même liste blanche que tout le reste ; il ne peut donc rien produire que
 * l'éditeur ne produirait pas.
 *
 * Sous-ensemble pris en charge : titres `#`…`####`, paragraphes, listes à
 * puces, numérotées et de tâches, citations, blocs de code, séparateurs,
 * images `![alt](url)`, gras, italique, barré, code, liens. Les blocs propres
 * au site (modules, grilles, FAQ…) s'écrivent en JSON.
 */

import { normalizeSiteDocument, type SiteDocument, type SiteMark, type SiteNode } from './document.js';

type Inline = SiteNode;

const INLINE_PATTERN = /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|_([^_]+)_)/;

function withMark(nodes: Inline[], mark: SiteMark): Inline[] {
  return nodes.map((node) => (node.type === 'text' ? { ...node, marks: [...(node.marks ?? []), mark] } : node));
}

/** Texte en ligne → nœuds texte marqués. */
export function parseInlineMarkdown(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      out.push({ type: 'text', text: rest });
      break;
    }
    if (match.index > 0) out.push({ type: 'text', text: rest.slice(0, match.index) });
    const [whole, , bold1, bold2, strike, code, linkText, linkHref, italic1, italic2] = match;
    if (bold1 ?? bold2) out.push(...withMark(parseInlineMarkdown(bold1 ?? bold2), { type: 'bold' }));
    else if (strike) out.push(...withMark(parseInlineMarkdown(strike), { type: 'strike' }));
    else if (code) out.push({ type: 'text', text: code, marks: [{ type: 'code' }] });
    else if (linkText && linkHref) out.push(...withMark(parseInlineMarkdown(linkText), { type: 'link', attrs: { href: linkHref } }));
    else if (italic1 ?? italic2) out.push(...withMark(parseInlineMarkdown(italic1 ?? italic2), { type: 'italic' }));
    rest = rest.slice(match.index + whole.length);
  }
  return out.filter((node) => node.type !== 'text' || node.text);
}

function paragraph(lines: string[]): SiteNode {
  const content: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...parseInlineMarkdown(line));
  });
  return { type: 'paragraph', content };
}

export function markdownToSiteDocument(markdown: string): SiteDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: SiteNode[] = [];
  let i = 0;

  const listItem = (text: string): SiteNode => ({ type: 'listItem', content: [paragraph([text])] });

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const fence = /^```([\w+#-]*)\s*$/.exec(trimmed);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) code.push(lines[i++]);
      i += 1;
      blocks.push({ type: 'codeBlock', attrs: fence[1] ? { language: fence[1] } : undefined, content: code.length ? [{ type: 'text', text: code.join('\n') }] : undefined });
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({ type: 'heading', attrs: { level: heading[1].length }, content: parseInlineMarkdown(heading[2]) });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'horizontalRule' });
      i += 1;
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed);
    if (image) {
      blocks.push({ type: 'image', attrs: { src: image[2], alt: image[1], caption: '', width: 'wide' } });
      i += 1;
      continue;
    }

    if (/^[-*]\s+\[( |x|X)\]\s+/.test(trimmed)) {
      const items: SiteNode[] = [];
      while (i < lines.length && /^[-*]\s+\[( |x|X)\]\s+/.test(lines[i].trim())) {
        const m = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(lines[i].trim())!;
        items.push({ type: 'taskItem', attrs: { checked: m[1].toLowerCase() === 'x' }, content: [paragraph([m[2]])] });
        i += 1;
      }
      blocks.push({ type: 'taskList', content: items });
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items: SiteNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) items.push(listItem(lines[i++].trim().replace(/^[-*+]\s+/, '')));
      blocks.push({ type: 'bulletList', content: items });
      continue;
    }

    const ordered = /^(\d{1,6})[.)]\s+/.exec(trimmed);
    if (ordered) {
      const items: SiteNode[] = [];
      while (i < lines.length && /^\d{1,6}[.)]\s+/.test(lines[i].trim())) items.push(listItem(lines[i++].trim().replace(/^\d{1,6}[.)]\s+/, '')));
      blocks.push({ type: 'orderedList', attrs: { start: Number(ordered[1]) }, content: items });
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) quoted.push(lines[i++].trim().replace(/^>\s?/, ''));
      blocks.push({ type: 'blockquote', content: markdownToSiteDocument(quoted.join('\n')).content });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|[-*+]\s|\d{1,6}[.)]\s|>|!\[|(-{3,}|\*{3,}|_{3,})$)/.test(lines[i].trim())
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) {
      // Ligne qu'aucune règle ne prend : texte brut, pour ne jamais boucler.
      para.push(lines[i++].trim());
    }
    blocks.push(paragraph(para));
  }

  return normalizeSiteDocument({ type: 'doc', content: blocks });
}

// ─── Document → Markdown (lecture) ──────────────────────────────────────────

function inlineToMarkdown(nodes: SiteNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') return '  \n';
      let text = node.text ?? '';
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') text = `**${text}**`;
        else if (mark.type === 'italic') text = `*${text}*`;
        else if (mark.type === 'strike') text = `~~${text}~~`;
        else if (mark.type === 'code') text = `\`${text}\``;
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') text = `[${text}](${mark.attrs.href})`;
      }
      return text;
    })
    .join('');
}

function blockToMarkdown(node: SiteNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  const children = (n: SiteNode) => (n.content ?? []).map((c) => blockToMarkdown(c, depth)).join('\n\n');
  switch (node.type) {
    case 'paragraph':
      return inlineToMarkdown(node.content);
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level) || 2)} ${inlineToMarkdown(node.content)}`;
    case 'blockquote':
      return children(node)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language ?? ''}\n${(node.content ?? []).map((c) => c.text ?? '').join('')}\n\`\`\``;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (node.content ?? [])
        .map((item, i) => {
          const marker =
            node.type === 'orderedList' ? `${(Number(node.attrs?.start) || 1) + i}.` : node.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}]` : '-';
          const [first, ...rest] = item.content ?? [];
          const head = first ? blockToMarkdown(first, depth + 1) : '';
          const tail = rest.map((c) => blockToMarkdown(c, depth + 1).replace(/^/gm, `${indent}  `)).join('\n');
          return `${indent}${marker} ${head}${tail ? `\n${tail}` : ''}`;
        })
        .join('\n');
    case 'horizontalRule':
      return '---';
    case 'image':
      return `![${node.attrs?.alt ?? ''}](${node.attrs?.src ?? ''})`;
    case 'table':
      return (node.content ?? [])
        .map((row, i) => {
          const cells = (row.content ?? []).map((cell) => children(cell).replace(/\n+/g, ' '));
          const line = `| ${cells.join(' | ')} |`;
          return i === 0 ? `${line}\n|${cells.map(() => ' --- ').join('|')}|` : line;
        })
        .join('\n');
    case 'callout':
      return `> **${String(node.attrs?.variant || 'info')}** ${children(node).replace(/\n/g, '\n> ')}`;
    case 'faq':
      return (node.content ?? []).map((item) => `**${item.attrs?.question ?? ''}**\n\n${children(item)}`).join('\n\n');
    case 'grid':
      return (node.content ?? []).map((cell) => children(cell)).join('\n\n');
    case 'button':
      return `[${node.attrs?.label ?? ''}](${node.attrs?.href ?? ''})`;
    case 'video':
      return `[vidéo ${node.attrs?.provider}:${node.attrs?.videoId}]`;
    case 'toc':
      return '[sommaire]';
    case 'module':
      return `[bloc ${String(node.attrs?.module)} ${JSON.stringify(node.attrs?.config ?? {})}]`;
    case 'banner':
      return `[bannière ${String(node.attrs?.tone ?? 'surface')}]\n\n${children(node)}`;
    case 'gallery':
      return `[galerie ${Array.isArray(node.attrs?.images) ? node.attrs.images.length : 0} image(s)]`;
    case 'testimonials':
      return (node.content ?? [])
        .map((item) => `> ${children(item).replace(/\n/g, '\n> ')}\n> — ${[item.attrs?.name, item.attrs?.role].filter(Boolean).join(', ')}`)
        .join('\n\n');
    default:
      return children(node);
  }
}

export function siteDocumentToMarkdown(doc: SiteDocument): string {
  return doc.content.map((node) => blockToMarkdown(node)).join('\n\n');
}
