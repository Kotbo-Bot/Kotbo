/**
 * Modèles de départ d'un site.
 *
 * Le propriétaire choisit un type de communauté (thème et ton), puis le site
 * est rempli d'après les modules actifs du serveur : une page Équipe si
 * l'annuaire staff tourne, une page Démarches avec les tickets, appels,
 * recrutement et suggestions qui sont ouverts, etc. Tout est éditable ensuite :
 * le modèle n'est qu'un premier jet.
 *
 * Les textes existent en français et en anglais, selon la langue du serveur.
 */

import { normalizeSiteDocument, type SiteDocument, type SiteNavItem, type SiteThemeKey } from '@kotbo/shared';
import type { ModuleStates } from '../core/moduleGate.js';

export const SITE_TEMPLATES = ['general', 'gaming', 'rp', 'esport', 'etude'] as const;
export type SiteTemplateKey = (typeof SITE_TEMPLATES)[number];

export function isSiteTemplate(value: unknown): value is SiteTemplateKey {
  return typeof value === 'string' && (SITE_TEMPLATES as readonly string[]).includes(value);
}

const THEMES: Record<SiteTemplateKey, SiteThemeKey> = {
  general: 'verre',
  gaming: 'neon',
  rp: 'royaume',
  esport: 'arcade',
  etude: 'documentation',
};

type Lang = 'fr' | 'en';
type Node = Record<string, unknown>;

const text = (value: string, marks?: Node[]): Node => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const p = (...parts: Array<string | Node>): Node => ({ type: 'paragraph', content: parts.map((x) => (typeof x === 'string' ? text(x) : x)) });
const h = (level: number, value: string): Node => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const mod = (module: string, config: Record<string, unknown> = {}): Node => ({ type: 'module', attrs: { module, config } });
const cell = (span: number, ...content: Node[]): Node => ({ type: 'gridCell', attrs: { span }, content });
const grid = (columns: number, ...cells: Node[]): Node => ({ type: 'grid', attrs: { columns }, content: cells });
const callout = (variant: string, icon: string, ...content: Node[]): Node => ({ type: 'callout', attrs: { variant, icon }, content });
const faqItem = (question: string, answer: string): Node => ({ type: 'faqItem', attrs: { question }, content: [p(answer)] });
const doc = (...content: Node[]): SiteDocument => normalizeSiteDocument({ type: 'doc', content });

interface Copy {
  welcome: string;
  intro: Record<SiteTemplateKey, string>;
  home: string;
  team: string;
  teamLead: string;
  rules: string;
  rulesLead: string;
  news: string;
  rankings: string;
  rankingsLead: string;
  events: string;
  eventsLead: string;
  help: string;
  helpLead: string;
  market: string;
  faq: string;
  faqItems: Array<[string, string]>;
  wikiWelcome: string;
  wikiWelcomeBody: string;
  wikiStart: string;
  blogWelcome: string;
  blogWelcomeBody: string;
  wiki: string;
  blog: string;
  latest: string;
  joinUs: string;
}

const COPY: Record<Lang, Copy> = {
  fr: {
    welcome: 'Bienvenue',
    intro: {
      general: 'Une communauté accueillante, des salons pour discuter et une équipe à l’écoute.',
      gaming: 'Des parties, des tournois, des soirées : rejoins les joueurs du serveur.',
      rp: 'Un univers à explorer, des histoires à écrire ensemble.',
      esport: 'Entraînements, compétitions et classements : viens grimper avec nous.',
      etude: 'Entraide, ressources et sessions de travail en groupe.',
    },
    home: 'Accueil',
    team: 'L’équipe',
    teamLead: 'Les personnes qui font vivre le serveur au quotidien.',
    rules: 'Règlement',
    rulesLead: 'À lire avant de participer : ces règles s’appliquent à tous.',
    news: 'Actualités',
    rankings: 'Classements',
    rankingsLead: 'Les membres les plus actifs du serveur.',
    events: 'Événements',
    eventsLead: 'Ce qui se prépare sur le serveur.',
    help: 'Démarches',
    helpLead: 'Contacter l’équipe, faire appel d’une sanction, postuler ou proposer une idée.',
    market: 'Marché',
    faq: 'Questions fréquentes',
    faqItems: [
      ['Comment rejoindre le serveur ?', 'Clique sur le bouton « Rejoindre le serveur » de la page d’accueil.'],
      ['Comment contacter l’équipe ?', 'Ouvre un ticket depuis la page Démarches : la conversation reste synchronisée avec Discord.'],
      ['Où trouver le règlement ?', 'Il est sur la page Règlement, accessible depuis le menu.'],
    ],
    wikiWelcome: 'Bienvenue sur le wiki',
    wikiWelcomeBody: 'Ce wiki rassemble tout ce qu’il faut savoir sur le serveur. Les rédacteurs peuvent ajouter des pages et des sous-pages depuis leur espace.',
    wikiStart: 'Par où commencer ?',
    blogWelcome: 'Bienvenue sur notre site',
    blogWelcomeBody: 'Ce site est désormais en ligne. Tu y trouveras l’équipe, le règlement, les événements et toutes les démarches utiles.',
    wiki: 'Wiki',
    blog: 'Blog',
    latest: 'Derniers articles',
    joinUs: 'Rejoindre le serveur',
  },
  en: {
    welcome: 'Welcome',
    intro: {
      general: 'A welcoming community, channels to chat in and a team that listens.',
      gaming: 'Games, tournaments, game nights: join the server’s players.',
      rp: 'A world to explore and stories to write together.',
      esport: 'Practice, competitions and rankings: come climb with us.',
      etude: 'Mutual help, resources and group study sessions.',
    },
    home: 'Home',
    team: 'The team',
    teamLead: 'The people who keep the server running every day.',
    rules: 'Rules',
    rulesLead: 'Read before taking part: these rules apply to everyone.',
    news: 'News',
    rankings: 'Leaderboards',
    rankingsLead: 'The server’s most active members.',
    events: 'Events',
    eventsLead: 'What’s coming up on the server.',
    help: 'Help desk',
    helpLead: 'Contact the team, appeal a sanction, apply or suggest an idea.',
    market: 'Market',
    faq: 'FAQ',
    faqItems: [
      ['How do I join the server?', 'Click “Join the server” on the home page.'],
      ['How do I contact the team?', 'Open a ticket from the Help desk page: the conversation stays in sync with Discord.'],
      ['Where are the rules?', 'On the Rules page, linked from the menu.'],
    ],
    wikiWelcome: 'Welcome to the wiki',
    wikiWelcomeBody: 'This wiki gathers everything there is to know about the server. Editors can add pages and sub-pages from their space.',
    wikiStart: 'Where to start?',
    blogWelcome: 'Welcome to our website',
    blogWelcomeBody: 'This website is now live. You’ll find the team, the rules, events and every useful request.',
    wiki: 'Wiki',
    blog: 'Blog',
    latest: 'Latest articles',
    joinUs: 'Join the server',
  },
};

export interface TemplatePage {
  key: string;
  kind: 'PAGE' | 'WIKI' | 'BLOG';
  slug: string;
  title: string;
  excerpt?: string;
  content: SiteDocument;
  /** Publiée d'emblée (le site lui-même reste hors ligne tant qu'il n'est pas publié). */
  publish: boolean;
  inNav: boolean;
  isHome?: boolean;
}

export interface SiteBlueprint {
  theme: SiteThemeKey;
  tagline: string;
  pages: TemplatePage[];
  /** Menu, les cibles « page » désignées par la clé du modèle. */
  navigation: Array<{ label: string; pageKey?: string; section?: 'wiki' | 'blog' }>;
}

/** Adresses des pages du modèle, dans la langue du serveur. */
const SLUGS: Record<Lang, Record<string, string>> = {
  fr: { home: 'accueil', team: 'equipe', rules: 'reglement', rankings: 'classements', events: 'evenements', help: 'demarches', market: 'marche', faq: 'faq', 'wiki-welcome': 'bienvenue', 'blog-welcome': 'bienvenue' },
  en: { home: 'home', team: 'team', rules: 'rules', rankings: 'leaderboards', events: 'events', help: 'help', market: 'market', faq: 'faq', 'wiki-welcome': 'welcome', 'blog-welcome': 'welcome' },
};

/** Plan du site d'après le type de communauté et les modules allumés. */
export function buildSiteBlueprint(template: SiteTemplateKey, lang: Lang, modules: ModuleStates): SiteBlueprint {
  const c = COPY[lang];
  const on = (key: string) => modules[key] !== false;
  const pages: TemplatePage[] = [];

  const homeCells: Node[] = [cell(2, mod('serverStats')), cell(1, mod('members'), mod('join', { label: c.joinUs }))];
  pages.push({
    key: 'home',
    kind: 'PAGE',
    slug: 'accueil',
    title: c.home,
    content: doc(
      h(1, c.welcome),
      p(c.intro[template]),
      grid(3, ...homeCells),
      ...(on('news') ? [h(2, c.news), mod('news', { limit: 3 })] : []),
      ...(on('site_blog') ? [h(2, c.latest), mod('blogList', { limit: 3 })] : []),
    ),
    publish: true,
    inNav: true,
    isHome: true,
  });

  if (on('staff_directory')) {
    pages.push({ key: 'team', kind: 'PAGE', slug: 'equipe', title: c.team, excerpt: c.teamLead, content: doc(p(c.teamLead), mod('staff', { layout: 'grid' })), publish: true, inNav: true });
  }
  if (on('regulation')) {
    pages.push({ key: 'rules', kind: 'PAGE', slug: 'reglement', title: c.rules, excerpt: c.rulesLead, content: doc(callout('info', '📜', p(c.rulesLead)), mod('rules')), publish: true, inNav: true });
  }

  const rankings: Node[] = [];
  if (on('leveling')) rankings.push(mod('leaderboard', { variant: 'xp', limit: 10 }));
  if (on('prestige')) rankings.push(mod('leaderboard', { variant: 'prestige', limit: 10 }));
  if (on('reputation')) rankings.push(mod('leaderboard', { variant: 'reputation', limit: 10 }));
  if (on('seasons')) rankings.push(mod('seasons', { limit: 10 }));
  if (on('clans')) rankings.push(mod('clans', { variant: 'leveling', limit: 10 }));
  if (rankings.length > 0) {
    const cells = rankings.map((node) => cell(1, node));
    pages.push({ key: 'rankings', kind: 'PAGE', slug: 'classements', title: c.rankings, excerpt: c.rankingsLead, content: doc(p(c.rankingsLead), grid(Math.min(2, cells.length), ...cells)), publish: true, inNav: true });
  }

  const events: Node[] = [];
  if (on('events')) events.push(mod('events', { limit: 6 }));
  if (on('giveaways')) events.push(mod('giveaways', { filter: 'active', limit: 6 }));
  if (events.length > 0) {
    pages.push({ key: 'events', kind: 'PAGE', slug: 'evenements', title: c.events, excerpt: c.eventsLead, content: doc(p(c.eventsLead), ...events), publish: true, inNav: true });
  }

  const help: Node[] = [];
  if (on('tickets')) help.push(mod('ticket'));
  if (on('ban_appeals')) help.push(mod('appeal'));
  if (on('recruitment') || on('custom_forms')) help.push(mod('recruitment'));
  if (on('suggestions')) help.push(mod('suggestions', { limit: 10, filter: 'open' }));
  if (help.length > 0) {
    pages.push({ key: 'help', kind: 'PAGE', slug: 'demarches', title: c.help, excerpt: c.helpLead, content: doc(p(c.helpLead), ...help), publish: true, inNav: true });
  }

  if (on('marketplace')) {
    pages.push({ key: 'market', kind: 'PAGE', slug: 'marche', title: c.market, content: doc(mod('marketplace', { limit: 12 })), publish: true, inNav: false });
  }

  pages.push({
    key: 'faq',
    kind: 'PAGE',
    slug: 'faq',
    title: c.faq,
    content: doc({ type: 'faq', content: c.faqItems.map(([q, a]) => faqItem(q, a)) }),
    publish: true,
    inNav: false,
  });

  if (on('site_wiki')) {
    pages.push({
      key: 'wiki-welcome',
      kind: 'WIKI',
      slug: 'bienvenue',
      title: c.wikiWelcome,
      content: doc(p(c.wikiWelcomeBody), h(2, c.wikiStart), mod('wikiIndex')),
      publish: true,
      inNav: false,
    });
  }
  if (on('site_blog')) {
    // Brouillon : un premier article publié d'office parlerait à la place du propriétaire.
    pages.push({ key: 'blog-welcome', kind: 'BLOG', slug: 'bienvenue', title: c.blogWelcome, excerpt: c.blogWelcomeBody, content: doc(p(c.blogWelcomeBody)), publish: false, inNav: false });
  }

  const navigation: SiteBlueprint['navigation'] = pages.filter((pg) => pg.inNav).map((pg) => ({ label: pg.title, pageKey: pg.key }));
  if (on('site_wiki')) navigation.push({ label: c.wiki, section: 'wiki' });
  if (on('site_blog')) navigation.push({ label: c.blog, section: 'blog' });

  for (const page of pages) page.slug = SLUGS[lang][page.key] ?? page.slug;
  return { theme: THEMES[template], tagline: c.intro[template], pages, navigation };
}

/** Menu au format stocké, une fois les pages créées et leurs identifiants connus. */
export function blueprintNavigation(blueprint: SiteBlueprint, pageIdByKey: Map<string, string>): SiteNavItem[] {
  return blueprint.navigation
    .map((item, i): SiteNavItem | null => {
      if (item.section) return { id: `nav-${i}`, label: item.label, target: { type: 'section', section: item.section }, children: [] };
      const pageId = item.pageKey ? pageIdByKey.get(item.pageKey) : undefined;
      if (!pageId) return null;
      return { id: `nav-${i}`, label: item.label, target: item.pageKey === 'home' ? { type: 'section', section: 'home' } : { type: 'page', pageId }, children: [] };
    })
    .filter((item): item is SiteNavItem => item !== null);
}
