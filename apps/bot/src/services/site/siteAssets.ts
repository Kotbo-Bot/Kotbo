/**
 * Feuille de style et script communs des sites, lus une fois sur le disque.
 *
 * Leur URL porte l'empreinte du contenu (`?v=<hash>`) : ils se mettent en
 * cache un an, et un déploiement qui les modifie change l'URL.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url));

interface LoadedAsset {
  body: string;
  version: string;
}

let loaded: { css: LoadedAsset; js: LoadedAsset } | null = null;

function load(name: string): LoadedAsset {
  const body = readFileSync(`${ASSET_DIR}${name}`, 'utf8');
  return { body, version: createHash('sha256').update(body).digest('hex').slice(0, 12) };
}

function assets(): { css: LoadedAsset; js: LoadedAsset } {
  // Relu à chaque appel hors production : la feuille se retouche sans redémarrer.
  if (!loaded || process.env.NODE_ENV !== 'production') {
    loaded = { css: load('site.css'), js: load('site.js') };
  }
  return loaded;
}

export function getSiteAssetVersions(): { css: string; js: string } {
  const a = assets();
  return { css: a.css.version, js: a.js.version };
}

export function getSiteStylesheet(): LoadedAsset {
  return assets().css;
}

export function getSiteScript(): LoadedAsset {
  return assets().js;
}
