/**
 * Génère `src/lib/demo/generated/prismaDefaults.ts` depuis le schéma Prisma.
 *
 * Beaucoup de routes du bot rendent une ligne de configuration telle que
 * Prisma la crée (`getOrCreate…Config`). La démo part des mêmes valeurs par
 * défaut, lues dans le schéma plutôt que recopiées : quand un champ est ajouté
 * côté base, relancer ce script suffit à le faire apparaître dans la démo.
 *
 *   bun scripts/demo-prisma-defaults.mjs
 *
 * Règles : `@default(x)` donne x ; un champ optionnel vaut `null` ; sinon zéro,
 * faux, chaîne ou liste vide. Les relations sont ignorées. Les dates
 * `now()` / `@updatedAt` valent `"__NOW__"`, remplacé à la lecture.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, '../../../packages/database/prisma');
const outFile = resolve(here, '../src/lib/demo/generated/prismaDefaults.ts');

const sources = readdirSync(schemaDir)
  .filter((f) => f.endsWith('.prisma'))
  .map((f) => readFileSync(join(schemaDir, f), 'utf8'))
  .join('\n');

const enums = new Map();
for (const match of sources.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
  const values = match[2]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l && !l.startsWith('@'));
  enums.set(match[1], values);
}

const models = new Map();
for (const match of sources.matchAll(/^model\s+(\w+)\s*\{([^}]*)\}/gm)) models.set(match[1], match[2]);

const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);

function parseDefault(raw, type, isList) {
  const value = raw.trim();
  if (value === 'now()') return '__NOW__';
  if (/^(cuid|uuid|nanoid|autoincrement|dbgenerated)\(/.test(value)) return type === 'Int' || type === 'BigInt' ? 0 : '';
  if (isList) {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (type === 'Boolean') return value === 'true';
  if (['Int', 'BigInt', 'Float', 'Decimal'].includes(type)) return Number(value);
  if (type === 'Json') {
    try {
      return JSON.parse(value.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
    } catch {
      return {};
    }
  }
  if (value.startsWith('"')) return JSON.parse(value);
  return value; // valeur d'enum
}

function emptyValue(type, isList, optional) {
  if (isList) return [];
  if (optional) return null;
  if (type === 'Boolean') return false;
  if (['Int', 'BigInt', 'Float', 'Decimal'].includes(type)) return 0;
  if (type === 'DateTime') return '__NOW__';
  if (type === 'Json') return {};
  if (enums.has(type)) return enums.get(type)[0];
  return '';
}

const output = {};
for (const [name, body] of models) {
  const fields = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line || line.startsWith('@@')) continue;
    const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, field, type, list, optional, attrs] = m;
    if (!SCALARS.has(type) && !enums.has(type)) continue; // relation
    if (attrs.includes('@relation')) continue;
    const def = /@default\(((?:[^()]|\([^()]*\))*)\)/.exec(attrs);
    if (def) fields[field] = parseDefault(def[1], type, !!list);
    else if (attrs.includes('@updatedAt')) fields[field] = '__NOW__';
    else fields[field] = emptyValue(type, !!list, !!optional);
  }
  output[name] = fields;
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `/* Fichier généré par scripts/demo-prisma-defaults.mjs. Ne pas modifier à la main. */\n` +
    `export const PRISMA_DEFAULTS: Record<string, Record<string, unknown>> = ${JSON.stringify(output, null, 2)};\n`,
);
console.log(`${Object.keys(output).length} modèles écrits dans ${outFile}`);
