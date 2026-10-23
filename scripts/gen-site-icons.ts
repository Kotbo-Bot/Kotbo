// Génère packages/shared/src/site/icons.ts à partir de lucide-svelte installé.
// Usage : bun scripts/gen-site-icons.ts node_modules/lucide-svelte/dist/icons packages/shared/src/site/icons.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const [lucideDir, outFile] = process.argv.slice(2);

// nom Kotbo -> candidats Lucide (le premier trouvé gagne)
const WANTED: Record<string, string[]> = {
  users: ['users'],
  'users-round': ['users-round', 'users'],
  scroll: ['scroll-text', 'scroll'],
  newspaper: ['newspaper'],
  handshake: ['handshake'],
  chart: ['chart-column', 'bar-chart-3', 'chart-bar'],
  gavel: ['gavel'],
  'user-plus': ['user-plus'],
  clipboard: ['clipboard-list'],
  ticket: ['ticket'],
  lightbulb: ['lightbulb'],
  trophy: ['trophy'],
  shield: ['shield'],
  gift: ['gift'],
  calendar: ['calendar'],
  'calendar-range': ['calendar-range', 'calendar-days'],
  cart: ['shopping-cart'],
  bag: ['shopping-bag'],
  star: ['star'],
  user: ['circle-user', 'user-circle', 'user'],
  book: ['book-open'],
  pen: ['pen-line', 'pen'],
  search: ['search'],
  login: ['log-in'],
  logout: ['log-out'],
  volume: ['volume-2'],
  message: ['message-square'],
  'message-circle': ['message-circle'],
  puzzle: ['puzzle'],
  pilcrow: ['pilcrow'],
  h1: ['heading-1'],
  h2: ['heading-2'],
  h3: ['heading-3'],
  list: ['list'],
  'list-ordered': ['list-ordered'],
  'list-checks': ['list-checks'],
  quote: ['quote'],
  code: ['code'],
  info: ['info'],
  'circle-check': ['circle-check', 'check-circle'],
  alert: ['triangle-alert', 'alert-triangle'],
  octagon: ['octagon-alert', 'alert-octagon'],
  note: ['notebook-pen', 'sticky-note', 'pencil'],
  columns2: ['columns-2', 'columns'],
  columns3: ['columns-3'],
  grid: ['layout-grid'],
  minus: ['minus'],
  table: ['table'],
  help: ['circle-question-mark', 'circle-help'],
  pointer: ['mouse-pointer-click'],
  toc: ['list-tree'],
  image: ['image'],
  play: ['circle-play', 'play'],
  link: ['link'],
  'align-left': ['align-left', 'text-align-start'],
  'align-center': ['align-center', 'text-align-center'],
  'align-right': ['align-right', 'text-align-end'],
  trash: ['trash-2'],
  'row-add': ['between-horizontal-end', 'rows-3'],
  'col-add': ['between-vertical-end', 'columns-3'],
  'row-remove': ['rows-2'],
  'col-remove': ['columns-2'],
  gamepad: ['gamepad-2'],
  castle: ['castle'],
  graduation: ['graduation-cap'],
  globe: ['globe'],
  tag: ['tag'],
  lock: ['lock'],
  sun: ['sun'],
  moon: ['moon'],
  menu: ['menu'],
  rss: ['rss'],
  'external-link': ['external-link'],
  'chevron-up': ['chevron-up'],
  'chevron-down': ['chevron-down'],
  'arrow-right': ['arrow-right'],
  package: ['package'],
  clock: ['clock'],
  coins: ['coins'],
  vote: ['vote'],
  forum: ['messages-square'],
  layers: ['layers'],
  sparkle: ['award'],
  bell: ['bell'],
  check: ['check'],
  x: ['x'],
  copy: ['copy'],
  activity: ['activity'],
  'file-text': ['file-text'],
  history: ['history'],
  home: ['house', 'home'],
  palette: ['palette'],
  flame: ['flame'],
  heart: ['heart'],
};

const out: string[] = [];
const missing: string[] = [];
for (const [name, candidates] of Object.entries(WANTED)) {
  const found = candidates.find((c) => existsSync(join(lucideDir, `${c}.svelte`)));
  if (!found) { missing.push(name); continue; }
  const src = readFileSync(join(lucideDir, `${found}.svelte`), 'utf8');
  const match = src.match(/const iconNode = (\[.*?\]);\n/s);
  if (!match) { missing.push(name); continue; }
  const nodes = JSON.parse(match[1]) as Array<[string, Record<string, string>]>;
  const inner = nodes
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('');
  out.push(`  ${JSON.stringify(name)}: ${JSON.stringify(inner)},`);
}

const file = `/**
 * Icônes du site communautaire, partagées par le rendu public (bot) et
 * l'éditeur (dashboard) : un même jeu de pictogrammes au trait, pas d'emoji.
 *
 * Tracés repris de Lucide (https://lucide.dev), licence ISC :
 * Copyright (c) Lucide Icons and Contributors. Fichier généré, ne pas éditer
 * à la main : ajouter l'icône dans scripts/gen-site-icons.ts et relancer.
 */

export const SITE_ICONS = {
${out.join('\n')}
} as const;

export type SiteIconName = keyof typeof SITE_ICONS;

export function isSiteIconName(value: unknown): value is SiteIconName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SITE_ICONS, value);
}

/** SVG complet, au trait de la couleur du texte, décoratif par défaut. */
export function siteIconSvg(name: SiteIconName, size = 20, className = 'icon'): string {
  return \`<svg class="\${className}" width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">\${SITE_ICONS[name]}</svg>\`;
}
`;
writeFileSync(outFile, file);
console.log('icons', out.length, 'missing', missing);
