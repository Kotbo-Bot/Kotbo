import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(import.meta.dir, '..', '..');

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    files.push(fullPath);
  }

  return files;
}

export function listSourceFiles(segment: string): string[] {
  return walk(path.join(SRC_ROOT, segment)).sort();
}

export function toProjectPath(absolutePath: string): string {
  return absolutePath.replace(/\\/g, '/').split('/src/')[1] ?? absolutePath;
}

export function readModuleSource(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8');
}

/**
 * Recupere le nom d'une commande slash a partir de sa source.
 *
 * Deux formes coexistent depuis la migration i18n :
 *  - `.setName('ping')`                 -> nom litteral
 *  - `.setName(meta.name)` alimente par `getCommandMetadata('ping')`
 *    -> le nom est porte par la cle de metadonnees, la seule chose lisible
 *       statiquement.
 */
export function extractSlashCommandName(source: string): string | null {
  // Les metadonnees sont prioritaires : quand la commande est construite via
  // `.setName(meta.name)`, le premier `.setName('...')` litteral du fichier est
  // celui d'une *sous-commande* (`list`, `claim`, ...) et non celui de la commande.
  const fromMetadata = source.match(/getCommandMetadata\((['"])(?<name>[^'"]+)\1\)/);
  if (fromMetadata?.groups?.name) return fromMetadata.groups.name;

  // `localized(new SlashCommandBuilder(), 'lnk')` : le nom est la clé anglaise `lnk_name`
  // (cf. getCommandMetadata), lue dans le fichier de traduction.
  const prefix = source.match(/localized\(\s*new\s+SlashCommandBuilder\(\)\s*,\s*(['"])(?<prefix>[^'"]+)\1/)?.groups?.prefix;
  if (prefix) {
    const en = JSON.parse(readFileSync(path.resolve(SRC_ROOT, '..', 'messages', 'en.json'), 'utf8')) as Record<string, string>;
    return en[`${prefix}_name`] ?? prefix;
  }

  const literal = source.match(/\.setName\((['"])(?<name>[^'"]+)\1\)/);
  return literal?.groups?.name ?? null;
}
