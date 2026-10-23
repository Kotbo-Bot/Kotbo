/**
 * En-tête de la démo publique (kotbo.fr/demo).
 *
 * Google indexe la démo et la montre en lien annexe sous kotbo.fr. Avec
 * l'en-tête du dashboard, ce lien s'appelait « Kotbo Dashboard » et laissait
 * croire à l'accès au vrai dashboard. On lui donne ici un titre et une
 * description de démo, une URL canonique et la langue de son contenu.
 *
 * Utilisé par `vite.config.ts` en mode `demo`, et exécutable seul pour
 * corriger une copie déjà publiée :
 *   bun scripts/demo-head.mjs ../../../kotbo-landing/static/demo/index.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_URL = 'https://kotbo.fr/demo/';
const TITLE = 'Démo du dashboard Kotbo, sans compte ni installation';
const DESCRIPTION =
  "Essaie le dashboard du bot Discord Kotbo sur un serveur fictif : modération, AutoMod, tickets, logs, staff et analytics. Aucun compte, rien à installer.";

/** @param {string} html */
export function applyDemoHead(html) {
  const out = html
    .replace(/<html lang="[^"]*">/, '<html lang="fr">')
    .replace(/<title>[^<]*<\/title>/, `<title>${TITLE}</title>`)
    .replace(/(<meta (?:property="og:|name="twitter:)title" content=")[^"]*"/g, `$1${TITLE}"`)
    .replace(/(<meta (?:name="|property="og:|name="twitter:)description" content=")[^"]*"/g, `$1${DESCRIPTION}"`);
  if (out.includes('rel="canonical"')) return out;
  return out.replace(
    '<meta property="og:site_name"',
    `<link rel="canonical" href="${DEMO_URL}" />\n    <meta property="og:url" content="${DEMO_URL}" />\n    <meta property="og:site_name"`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage : bun scripts/demo-head.mjs <index.html>');
    process.exit(1);
  }
  writeFileSync(file, applyDemoHead(readFileSync(file, 'utf8')));
  console.log(`En-tête de démo appliqué à ${file}`);
}
