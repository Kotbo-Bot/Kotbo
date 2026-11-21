/**
 * Génère `src/lib/generated/searchIndex.json` : pour chaque route du dashboard,
 * les mots des textes traduits que sa page affiche, pour que la palette de
 * recherche trouve un mot écrit n'importe où dans une page, pas seulement dans
 * son nom.
 *
 *   bun scripts/build-search-index.mjs
 *
 * Méthode : App.svelte relie chaque route à un fichier de page ; on lit ce
 * fichier et les composants Svelte qu'il importe (récursivement), on relève les
 * appels `m.cle()` et on les traduit avec messages/fr.json et en.json. Les
 * textes dynamiques (noms venus de l'API) ne sont pas indexés.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../src');
const messages = {
  fr: JSON.parse(readFileSync(resolve(here, '../messages/fr.json'), 'utf8')),
  en: JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8')),
};

const app = readFileSync(join(src, 'App.svelte'), 'utf8');
const routes = [];
for (const m of app.matchAll(/path="([^"]+)"[\s\S]{0,120}?import\("\.\/(pages\/[^"]+\.svelte)"\)/g)) {
  const path = m[1].replace(/\/\*$/, '');
  if (path.includes(':') || path.startsWith('/admin')) continue;
  routes.push({ path, file: m[2] });
}

const fileCache = new Map();
function collect(file, seen = new Set()) {
  const abs = join(src, file);
  if (seen.has(abs) || !existsSync(abs)) return new Set();
  seen.add(abs);
  if (fileCache.has(abs)) return fileCache.get(abs);
  const text = readFileSync(abs, 'utf8');
  const keys = new Set([...text.matchAll(/\bm\.([a-z0-9_]+)\s*\(/g)].map((x) => x[1]));
  for (const imp of text.matchAll(/from\s+['"](\.[^'"]+\.svelte)['"]/g)) {
    const target = join(dirname(file), imp[1]).replace(/\\/g, '/');
    for (const key of collect(target, seen)) keys.add(key);
  }
  fileCache.set(abs, keys);
  return keys;
}

const STOP = new Set(['les', 'des', 'une', 'pour', 'dans', 'sur', 'avec', 'que', 'qui', 'est', 'sont', 'pas', 'ton', 'tes', 'ses', 'vos', 'the', 'and', 'for', 'with', 'you', 'your', 'are', 'not', 'this', 'that', 'from', 'will', 'can', 'has', 'have', 'aux', 'par', 'plus', 'tout', 'tous', 'mais', 'ces', 'cet', 'cette', 'leur', 'elle', 'ils']);
const normalize = (value) => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function words(locale, keys) {
  const found = new Set();
  for (const key of keys) {
    const raw = messages[locale][key];
    if (typeof raw !== 'string') continue;
    const clean = normalize(raw.replace(/\{[^}]*\}/g, ' ').replace(/[*_`#<>]/g, ' '));
    for (const word of clean.split(/[^a-z0-9]+/)) {
      if (word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word)) found.add(word);
    }
  }
  return [...found].sort().join(' ');
}

const index = {};
for (const { path, file } of routes) {
  const keys = collect(file);
  if (keys.size === 0) continue;
  index[path] = { fr: words('fr', keys), en: words('en', keys) };
}

const outFile = join(src, 'lib/generated/searchIndex.json');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(index));
const kb = Math.round(JSON.stringify(index).length / 1024);
console.log(`${Object.keys(index).length} routes indexées (${kb} Ko) dans ${outFile}`);
