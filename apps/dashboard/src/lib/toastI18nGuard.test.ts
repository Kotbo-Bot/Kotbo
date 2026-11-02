import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Garde-fou i18n des toasts : un toast ecrit en dur reste en francais pour un
 * utilisateur en anglais. Tout texte affiche passe par `m.<cle>()`. Comme
 * uxGuard.test.ts, c'est un cliquet : baisser le plafond apres un nettoyage ;
 * il ne remonte jamais.
 *
 * Est comptee toute chaine litterale ('...', "..." ou `...`) contenant une
 * lettre hors des interpolations `${...}`, n'importe ou dans les arguments
 * d'un appel `toast.error|success|warning|info(...)` : texte de secours
 * (`errorMessage(err) || '...'`), branche d'une condition, libelle d'action.
 */
const SRC = join(import.meta.dir, '..');

const CEILING = 0;

/** Chaines qui ne s'affichent pas : locale passee a `toLocale*String`. */
const NOT_DISPLAYED = new Set(['fr-FR', 'en-GB', 'en-US']);

/**
 * Une chaine comparee (`direction === 'up'`) ou affectee (`href = '/billing'`)
 * est une valeur de code, pas un texte affiche.
 */
const COMPARED_BEFORE = /(?:[=!]==?|[^=!<>]=)\s*$/;
const COMPARED_AFTER = /^\s*[=!]==?/;

const TOAST_CALL = /\btoast\.(?:error|success|warning|info)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'paraglide' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

interface Literal { index: number; end: number; text: string }

/**
 * Parcourt le code depuis `start` jusqu'a la fermeture qui equilibre
 * l'ouverture deja consommee (`)` d'un appel, `}` d'une interpolation).
 * Renvoie la position atteinte et le texte statique de chaque chaine vue,
 * interpolations imbriquees comprises.
 */
function scan(code: string, start: number, literals: Literal[]): number {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) return code.length; continue; }
    if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i) + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      literals.push({ index: i, end: j + 1, text: code.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const begin = i;
      let text = '';
      let j = i + 1;
      while (j < code.length && code[j] !== '`') {
        if (code[j] === '\\') { text += code.slice(j, j + 2); j += 2; continue; }
        if (code[j] === '$' && code[j + 1] === '{') { j = scan(code, j + 2, literals); continue; }
        text += code[j++];
      }
      literals.push({ index: begin, end: j + 1, text });
      i = j + 1;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) return i + 1;
      depth--;
    }
    i++;
  }
  return i;
}

function displayedLiterals(code: string): number[] {
  const found: number[] = [];
  for (const call of code.matchAll(TOAST_CALL)) {
    const literals: Literal[] = [];
    scan(code, call.index + call[0].length, literals);
    for (const { index, end, text } of literals) {
      if (!/\p{L}/u.test(text) || NOT_DISPLAYED.has(text)) continue;
      if (COMPARED_BEFORE.test(code.slice(Math.max(0, index - 4), index)) || COMPARED_AFTER.test(code.slice(end, end + 4))) continue;
      found.push(index);
    }
  }
  return found;
}

describe('garde-fou i18n des toasts', () => {
  test('le parcours trouve les textes de secours, les conditions et les gabarits', () => {
    const sample = [
      "toast.error(errorMessage(err) || 'Enregistrement impossible');",
      "toast.success(on ? 'Activé' : m.off());",
      'toast.info(\n  `Code : ${code.toLocaleString(\'fr-FR\')}`,\n  { label: m.ok() },\n);',
      "toast.success(m.saved({ n: list.join(', ') }));",
      "toast.success(mode === 'create' ? m.added() : m.updated(), 0, { onClick: () => { location.href = '/billing'; } });",
    ].join('\n');
    expect(displayedLiterals(sample)).toHaveLength(3);
  });

  test(`toasts affichant une chaîne écrite en dur : pas plus de ${CEILING}`, () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const code = readFileSync(file, 'utf-8');
      for (const index of displayedLiterals(code)) {
        offenders.push(`${relative(SRC, file)}:${code.slice(0, index).split('\n').length}`);
      }
    }
    if (offenders.length > CEILING) {
      throw new Error(
        `${offenders.length} textes de toast écrits en dur (plafond ${CEILING}). `
        + `Mets le texte dans messages/en.json et fr.json et appelle m.<cle>() :\n  ${offenders.join('\n  ')}`,
      );
    }
    expect(offenders.length).toBeLessThanOrEqual(CEILING);
  });
});
