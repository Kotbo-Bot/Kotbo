/**
 * CSS libre du site communautaire.
 *
 * Le site est servi sous le domaine du dashboard : son CSS ne doit ni charger
 * de ressource externe (pistage, exfiltration par sélecteurs d'attributs), ni
 * sortir de la balise `<style>`, ni atteindre ce que Kotbo affiche autour du
 * contenu (mention « Propulsé par Kotbo », bouton de signalement, invites de
 * connexion). Deux passes :
 *
 * 1. `sanitizeSiteCss` décode les échappements CSS (sans quoi `@\69mport`
 *    passerait pour un autre mot), retire commentaires, chevrons, at-rules
 *    dangereuses, `position: fixed|sticky`, et toute URL qui n'est pas une
 *    image du site ou une image en `data:` ;
 * 2. `scopeSiteCss` préfixe chaque sélecteur par la racine du contenu
 *    (`.site-root`). `html`, `body` et `:root` y sont ramenés. Les blocs
 *    `@media`, `@supports`, `@container` et `@layer` sont parcourus ; les
 *    `@keyframes` et `@font-face` sont gardés tels quels ; toute autre at-rule
 *    est retirée.
 *
 * La racine porte en plus un style en ligne `isolation: isolate !important` :
 * aucun `z-index` du contenu ne peut alors passer au-dessus de l'habillage
 * Kotbo, qui vit hors de la racine.
 */

export const SITE_CSS_MAX_LENGTH = 30_000;
export const SITE_CSS_SCOPE = '.site-root';

const DANGEROUS_PATTERNS: RegExp[] = [
  /@\s*(import|charset|namespace|document|page)\b[^;{]*;?/gi,
  /expression\s*\(/gi,
  /-moz-binding\s*[^;}]*(;|(?=\}))/gi,
  /behavior\s*:[^;}]*(;|(?=\}))/gi,
  /(javascript|vbscript)\s*:/gi,
  // Superpositions plein écran : base de toute imitation d'un écran de connexion.
  /position\s*:\s*(fixed|sticky)[^;}]*(;|(?=\}))/gi,
  // Fonctions qui chargent une ressource sans passer par url().
  /(-webkit-)?image-set\s*\(/gi,
  /(-moz-)?element\s*\(/gi,
  /\bsrc\s*\(/gi,
];

/** Décode `\XXXXXX ` et `\c` : ce que le navigateur lira réellement. */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n0-9a-fA-F])/g, (_m, hex: string | undefined, ch: string | undefined) => {
    if (hex) {
      const code = parseInt(hex, 16);
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return ch ?? '';
  });
}

function isAllowedCssUrl(target: string, assetPrefix: string): boolean {
  const value = target.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value)) return true;
  return value.startsWith(assetPrefix) && /^[\w\-./]+$/.test(value) && !value.includes('..');
}

/**
 * @param assetPrefix chemin des images du site, ex. `/s/mon-serveur/_/a/`
 */
export function sanitizeSiteCss(input: unknown, assetPrefix: string): string {
  if (typeof input !== 'string') return '';
  let css = decodeCssEscapes(input.slice(0, SITE_CSS_MAX_LENGTH));
  css = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\*[\s\S]*$/, ' ');
  css = css.replace(/[<>\\]/g, '');

  for (let i = 0; i < 10; i++) {
    const before = css;
    for (const pattern of DANGEROUS_PATTERNS) css = css.replace(pattern, ' ');
    css = css.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (_m, _q, target: string) =>
      isAllowedCssUrl(target, assetPrefix) ? `url("${target.trim()}")` : 'none',
    );
    // Un `url(` resté ouvert (guillemet non fermé…) ne doit rien charger.
    css = css.replace(/url\s*\((?!")/gi, 'none(');
    if (css === before) break;
  }
  return css.trim();
}

// ─── Portée ─────────────────────────────────────────────────────────────────

const RECURSE_AT_RULES = new Set(['media', 'supports', 'container', 'layer']);
const VERBATIM_AT_RULES = new Set(['keyframes', '-webkit-keyframes', 'font-face', 'property', 'counter-style']);

interface Cursor {
  css: string;
  i: number;
}

/** Avance jusqu'au caractère d'arrêt de premier niveau, chaînes et parenthèses comprises. */
function readUntil(cur: Cursor, stops: string): string {
  const start = cur.i;
  let depth = 0;
  while (cur.i < cur.css.length) {
    const ch = cur.css[cur.i];
    if (ch === '"' || ch === "'") {
      const end = cur.css.indexOf(ch, cur.i + 1);
      cur.i = end === -1 ? cur.css.length : end + 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && stops.includes(ch)) break;
    cur.i += 1;
  }
  return cur.css.slice(start, cur.i);
}

/** Lit un bloc `{ … }` équilibré ; le curseur doit être sur `{`. Rend l'intérieur. */
function readBlock(cur: Cursor): string {
  cur.i += 1;
  const start = cur.i;
  let depth = 1;
  while (cur.i < cur.css.length) {
    const ch = cur.css[cur.i];
    if (ch === '"' || ch === "'") {
      const end = cur.css.indexOf(ch, cur.i + 1);
      cur.i = end === -1 ? cur.css.length : end + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const inner = cur.css.slice(start, cur.i);
        cur.i += 1;
        return inner;
      }
    }
    cur.i += 1;
  }
  return cur.css.slice(start);
}

/** Découpe une liste de sélecteurs sur les virgules de premier niveau. */
function splitSelectors(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function scopeSelector(selector: string, scope: string): string {
  if (selector === scope || selector.startsWith(`${scope} `) || selector.startsWith(`${scope}:`) || selector.startsWith(`${scope}.`)) {
    return selector;
  }
  // `html`, `body`, `:root` (et leurs combinaisons en tête) désignent la racine du contenu.
  const rootMatch = selector.match(/^((?:html|body|:root)(?![\w-])\s*)+/i);
  if (rootMatch) {
    const rest = selector.slice(rootMatch[0].length);
    if (!rest) return scope;
    // `body.dark` → `.site-root.dark` ; `body > main` → `.site-root > main`.
    return /^[.:#[]/.test(rest) ? `${scope}${rest}` : `${scope} ${rest.trim()}`;
  }
  return `${scope} ${selector}`;
}

function scopeRules(css: string, scope: string, depth: number): string {
  const cur: Cursor = { css, i: 0 };
  const out: string[] = [];
  while (cur.i < css.length) {
    while (cur.i < css.length && /[\s;]/.test(css[cur.i])) cur.i += 1;
    if (cur.i >= css.length) break;

    if (css[cur.i] === '@') {
      const prelude = readUntil(cur, '{;');
      const name = (prelude.match(/^@([\w-]+)/)?.[1] ?? '').toLowerCase();
      if (css[cur.i] === ';') {
        cur.i += 1;
        continue;
      }
      if (cur.i >= css.length) break;
      const inner = readBlock(cur);
      if (RECURSE_AT_RULES.has(name) && depth < 3) {
        out.push(`${prelude.trim()}{${scopeRules(inner, scope, depth + 1)}}`);
      } else if (VERBATIM_AT_RULES.has(name)) {
        out.push(`${prelude.trim()}{${inner}}`);
      }
      continue;
    }

    const prelude = readUntil(cur, '{}');
    if (cur.i >= css.length) break;
    if (css[cur.i] === '}') {
      cur.i += 1;
      continue;
    }
    const block = readBlock(cur);
    const selectors = splitSelectors(prelude).map((s) => scopeSelector(s, scope));
    if (selectors.length > 0) out.push(`${selectors.join(',')}{${block}}`);
  }
  return out.join('\n');
}

export function scopeSiteCss(css: string, scope: string = SITE_CSS_SCOPE): string {
  return scopeRules(css, scope, 0);
}

/** Les deux passes, dans l'ordre : ce qui est stocké et servi. */
export function prepareSiteCss(input: unknown, assetPrefix: string, scope: string = SITE_CSS_SCOPE): string {
  const sanitized = sanitizeSiteCss(input, assetPrefix);
  return sanitized ? scopeSiteCss(sanitized, scope) : '';
}
