import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Garde-fou i18n des toasts : un toast ecrit en dur reste en francais pour un
 * utilisateur en anglais. Tout texte affiche passe par `m.<cle>()`. Comme
 * uxGuard.test.ts, c'est un cliquet : baisser le plafond apres un nettoyage ;
 * il ne remonte jamais.
 *
 * Est compte tout appel `toast.error|success|warning|info(...)` dont le premier
 * argument est une chaine litterale ('...', "..." ou `...`) contenant une
 * lettre hors des interpolations `${...}`.
 */
const SRC = join(import.meta.dir, '..');

const CEILING = 0;

const TOAST_LITERAL = /\btoast\.(?:error|success|warning|info)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'paraglide' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Retire les `${...}` (une imbrication d'accolades suffit ici) puis cherche une lettre. */
function hasStaticText(literal: string): boolean {
  return /\p{L}/u.test(literal.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ''));
}

describe('garde-fou i18n des toasts', () => {
  test(`toasts recevant une chaîne écrite en dur : pas plus de ${CEILING}`, () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(TOAST_LITERAL)) {
        const literal = match[1] ?? match[2] ?? match[3];
        if (!hasStaticText(literal)) continue;
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(SRC, file)}:${line}`);
      }
    }
    if (offenders.length > CEILING) {
      throw new Error(
        `${offenders.length} toasts écrits en dur (plafond ${CEILING}). `
        + `Mets le texte dans messages/en.json et fr.json et appelle m.<cle>() :\n  ${offenders.join('\n  ')}`,
      );
    }
    expect(offenders.length).toBeLessThanOrEqual(CEILING);
  });
});
