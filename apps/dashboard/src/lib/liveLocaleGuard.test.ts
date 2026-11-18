import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Garde-fou du changement de langue sans rechargement (issue 671).
 *
 * La langue active est un etat Svelte (liveLocale.svelte.ts) : chaque
 * `m.cle()` lu dans un template, un `$derived` ou une fonction se retraduit
 * seul. Un appel evalue une seule fois, au chargement du module ou au montage
 * du composant, garde en revanche l'ancienne langue :
 *
 *   const LABEL = m.cle();                 // fige
 *   const ITEMS = [{ label: m.cle() }];    // fige
 *
 * Correction : un accesseur (`{ get label() { return m.cle(); } }`), un
 * `$derived(...)` ou une fonction. Un appel en langue explicite
 * (`m.bot_x({}, bot())`) suit la langue du bot et n'est pas concerne.
 */
const SRC = join(import.meta.dir, '..');
const IMPORT_M = /import\s*\{[^}]*\bm\b[^}]*\}\s*from\s*['"][^'"]*i18n['"]/;
const KEY = /^m\.[a-z][a-z0-9_]*\(/i;
const REACTIVE = new Set(['$derived', '$derived.by', '$state', '$state.raw']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'paraglide' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Le code JS/TS du fichier : les blocs <script> d'un composant, tout un module sinon. */
function scripts(path: string, code: string): { text: string; offset: number }[] {
  if (!path.endsWith('.svelte')) return [{ text: code, offset: 0 }];
  return [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => ({
    text: match[1],
    offset: match.index + match[0].indexOf('>') + 1,
  }));
}

/** Vrai si l'appel ouvert en `open` passe une langue explicite. */
function explicitLocale(code: string, open: number): boolean {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')' && --depth === 0) return /\bbot\(\)|\blocale\s*:/.test(code.slice(open, k));
  }
  return false;
}

interface Frame {
  c: string;
  /** Corps de fonction ou argument d'une rune : evalue a la demande. */
  lazy: boolean;
  /** Corps d'une fonction flechee sans accolades, jusqu'a la virgule suivante. */
  arrow: boolean;
}

/**
 * Positions des appels `m.cle()` evalues une seule fois. Lecture lexicale :
 * chaines et commentaires sautes, corps de fonction (`=>`, `function`,
 * methode) et arguments de `$derived`/`$state` consideres comme paresseux.
 */
export function frozenCalls(code: string): number[] {
  const hits: number[] = [];
  const stack: Frame[] = [{ c: '', lazy: false, arrow: false }];
  let arrowBody = false;
  let functionDepth = -1;
  let i = 0;
  const prevSig = (k: number) => {
    let j = k - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    return j;
  };
  while (i < code.length) {
    const ch = code[i];
    const top = stack[stack.length - 1];
    if (top.c === '`') {
      if (ch === '\\') i += 2;
      else if (ch === '`') { stack.pop(); i++; }
      else if (ch === '$' && code[i + 1] === '{') { stack.push({ c: '${', lazy: false, arrow: false }); i += 2; }
      else i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < code.length && code[i] !== ch) i += code[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '`') { stack.push({ c: '`', lazy: false, arrow: false }); i++; continue; }
    if (ch === '=' && code[i + 1] === '>') {
      let j = i + 2;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] === '{') arrowBody = true;
      else top.arrow = true;
      i += 2;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch) && (i === 0 || !/[\w$.]/.test(code[i - 1]))) {
      const word = /^[\w$]+(?:\.[\w$]+)*/.exec(code.slice(i, i + 80))![0];
      if (word === 'function') functionDepth = stack.length;
      if (
        word.startsWith('m.') &&
        KEY.test(code.slice(i, i + 80)) &&
        stack.every((frame) => !frame.lazy && !frame.arrow) &&
        !explicitLocale(code, i + word.length)
      ) {
        hits.push(i);
      }
      if (REACTIVE.has(word)) {
        const open = /^\s*(?:<[^()]*>)?\s*\(/.exec(code.slice(i + word.length, i + word.length + 200));
        if (open) {
          stack.push({ c: '(', lazy: true, arrow: false });
          i += word.length + open[0].length;
          continue;
        }
      }
      i += word.length;
      continue;
    }
    if (ch === '(' || ch === '[') { stack.push({ c: ch, lazy: false, arrow: false }); i++; continue; }
    if (ch === '{') {
      const p = prevSig(i);
      const before = code.slice(Math.max(0, p - 120), p + 1);
      const declared = functionDepth === stack.length && !/[<:|&,]/.test(code[p]);
      if (declared) functionDepth = -1;
      const body =
        declared ||
        arrowBody ||
        code[p] === ')' ||
        /\)\s*:\s*[\w$<>[\]|&., ]+$/.test(before) ||
        /\b(?:else|try|finally|do)$/.test(before);
      arrowBody = false;
      stack.push({ c: '{', lazy: body, arrow: false });
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (ch === ',' || ch === ';') top.arrow = false;
    i++;
  }
  return hits;
}

function frozenSites(): string[] {
  const sites: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const code = readFileSync(path, 'utf-8');
    if (!IMPORT_M.test(code)) continue;
    for (const { text, offset } of scripts(path, code)) {
      for (const hit of frozenCalls(text)) {
        const line = code.slice(0, offset + hit).split('\n').length;
        sites.push(`${relative(SRC, path)}:${line}`);
      }
    }
  }
  return sites;
}

describe('changement de langue sans rechargement', () => {
  test('le detecteur repere un libelle fige et ignore un libelle paresseux', () => {
    const code = [
      'const A = m.fige();',
      'const B = [{ label: m.fige() }];',
      'const C = { get label() { return m.ok(); } };',
      'const D = $derived(m.ok());',
      'const E = () => m.ok();',
      'function f() { return m.ok(); }',
      'const F = { text: m.bot_x({}, bot()) };',
      '// m.commentaire()',
    ].join('\n');
    expect(frozenCalls(code).map((pos) => code.slice(pos, code.indexOf('(', pos)))).toEqual(['m.fige', 'm.fige']);
  });

  test('aucun libelle de l\'interface n\'est fige dans la langue du chargement', () => {
    expect(frozenSites()).toEqual([]);
  });

  test('i18n.ts reste importable par les tests Bun, qui ne compilent pas les runes', () => {
    const code = readFileSync(join(SRC, 'lib', 'i18n.ts'), 'utf-8');
    expect(/from\s*['"][^'"]*\.svelte(?:\.[jt]s)?['"]/.test(code)).toBe(false);
  });

  test('la langue change sans recharger la page', () => {
    const calls = sourceFiles(SRC).flatMap((path) => {
      const code = readFileSync(path, 'utf-8');
      return [...code.matchAll(/\bsetLocale\(([^)]*)\)/g)].map((match) => ({ path: relative(SRC, path), args: match[1] }));
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.path).toBe('lib/liveLocale.svelte.ts');
      expect(call.args).toContain('reload: false');
    }
  });
});
