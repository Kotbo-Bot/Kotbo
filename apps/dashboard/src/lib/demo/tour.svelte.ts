/**
 * Visites guidées de la démo, à deux niveaux.
 *
 * - La visite principale passe une fois sur chaque grosse fonctionnalité
 *   (modération, sécurité, staff, tickets, XP) : une étape par page.
 * - Chaque page de cette visite a sa visite de page, qui en détaille les
 *   éléments un par un. Elle démarre à la première arrivée sur la page, ou
 *   depuis la visite principale (« Détailler cette page »), qui reprend ensuite
 *   à l'étape suivante.
 *
 * `DemoTour`, monté dans le layout, attend que la page rende l'élément visé par
 * `target` (un sélecteur CSS), le met en évidence et pose la bulle à côté.
 * Les textes ne promettent que des actions servies par `demo/routes/` : une
 * écriture absente du faux back-end ne doit pas être présentée comme faisable.
 */
import { router } from 'tinro';
import { m } from '../i18n';
import { DEMO_MODE, appPathname } from './mode';

export type TourStep = {
  /** Sélecteur de l'élément à montrer ; le premier visible à l'écran gagne. */
  target: string;
  title: () => string;
  body: () => string;
};

type MainStep = TourStep & {
  /** Page de l'étape, onglet compris. Sa visite de page, si elle existe, porte le même chemin. */
  href: string;
};

const tour = (id: string) => `[data-tour="${id}"]`;

export const mainSteps: MainStep[] = [
  {
    href: '/',
    target: tour('home-todo'),
    title: () => m.demo_tour_home_title(),
    body: () => m.demo_tour_home_body(),
  },
  {
    href: '/security/sanctions',
    target: tour('sanctions-list'),
    title: () => m.demo_tour_sanctions_title(),
    body: () => m.demo_tour_sanctions_body(),
  },
  {
    href: '/security/filters',
    target: tour('automod-spam'),
    title: () => m.demo_tour_automod_title(),
    body: () => m.demo_tour_automod_body(),
  },
  {
    href: '/staff-management',
    target: tour('staff-panel'),
    title: () => m.demo_tour_staff_title(),
    body: () => m.demo_tour_staff_body(),
  },
  {
    href: '/tickets',
    target: tour('tickets-list'),
    title: () => m.demo_tour_tickets_title(),
    body: () => m.demo_tour_tickets_body(),
  },
  {
    href: '/leveling/leaderboard',
    target: tour('leveling-leaderboard'),
    title: () => m.demo_tour_leveling_title(),
    body: () => m.demo_tour_leveling_body(),
  },
  {
    href: '/',
    target: tour('demo-banner'),
    title: () => m.demo_tour_end_title(),
    body: () => m.demo_tour_end_body(),
  },
];

const TABS = '#main-content [role="tablist"]';

/** Visites de page, par chemin exact (onglet compris). */
export const pageTours: Record<string, TourStep[]> = {
  '/': [
    {
      target: '#main-content [role="list"] > [role="listitem"]:nth-child(1)',
      title: () => m.demo_page_home_stats_title(),
      body: () => m.demo_page_home_stats_body(),
    },
    {
      target: '#main-content [role="list"] > [role="listitem"]:nth-child(2)',
      title: () => m.demo_page_home_chart_title(),
      body: () => m.demo_page_home_chart_body(),
    },
    {
      target: '.home-floating-actions button',
      title: () => m.demo_page_home_edit_title(),
      body: () => m.demo_page_home_edit_body(),
    },
  ],
  '/security/sanctions': [
    {
      target: TABS,
      title: () => m.demo_page_sanctions_tabs_title(),
      body: () => m.demo_page_sanctions_tabs_body(),
    },
    {
      target: `${tour('sanctions-list')} input`,
      title: () => m.demo_page_sanctions_search_title(),
      body: () => m.demo_page_sanctions_search_body(),
    },
    {
      target: `${tour('sanctions-list')} thead`,
      title: () => m.demo_page_sanctions_columns_title(),
      body: () => m.demo_page_sanctions_columns_body(),
    },
    {
      target: `${tour('sanctions-list')} tbody tr:first-child td:last-child`,
      title: () => m.demo_page_sanctions_row_title(),
      body: () => m.demo_page_sanctions_row_body(),
    },
  ],
  '/security/filters': [
    {
      target: TABS,
      title: () => m.demo_page_automod_tabs_title(),
      body: () => m.demo_page_automod_tabs_body(),
    },
    {
      target: tour('automod-spam-threshold'),
      title: () => m.demo_page_automod_threshold_title(),
      body: () => m.demo_page_automod_threshold_body(),
    },
    {
      target: `${tour('automod-spam')} select`,
      title: () => m.demo_page_automod_action_title(),
      body: () => m.demo_page_automod_action_body(),
    },
    {
      target: tour('automod-more'),
      title: () => m.demo_page_automod_more_title(),
      body: () => m.demo_page_automod_more_body(),
    },
  ],
  '/staff-management': [
    {
      target: tour('staff-stats'),
      title: () => m.demo_page_staff_stats_title(),
      body: () => m.demo_page_staff_stats_body(),
    },
    {
      target: TABS,
      title: () => m.demo_page_staff_tabs_title(),
      body: () => m.demo_page_staff_tabs_body(),
    },
    {
      target: tour('staff-actions'),
      title: () => m.demo_page_staff_actions_title(),
      body: () => m.demo_page_staff_actions_body(),
    },
    {
      target: `${tour('staff-panel')} > div:first-child button`,
      title: () => m.demo_page_staff_add_title(),
      body: () => m.demo_page_staff_add_body(),
    },
  ],
  '/tickets': [
    {
      target: `${tour('tickets-list')} > div:first-child`,
      title: () => m.demo_page_tickets_filters_title(),
      body: () => m.demo_page_tickets_filters_body(),
    },
    {
      target: `${tour('tickets-list')} .overflow-y-auto > :first-child`,
      title: () => m.demo_page_tickets_item_title(),
      body: () => m.demo_page_tickets_item_body(),
    },
    {
      target: tour('tickets-chat'),
      title: () => m.demo_page_tickets_chat_title(),
      body: () => m.demo_page_tickets_chat_body(),
    },
    {
      target: TABS,
      title: () => m.demo_page_tickets_tabs_title(),
      body: () => m.demo_page_tickets_tabs_body(),
    },
  ],
  '/leveling': [
    {
      target: `${tour('leveling-presets')} > :first-child`,
      title: () => m.demo_page_leveling_presets_title(),
      body: () => m.demo_page_leveling_presets_body(),
    },
    {
      target: tour('leveling-announce'),
      title: () => m.demo_page_leveling_announce_title(),
      body: () => m.demo_page_leveling_announce_body(),
    },
    {
      target: tour('leveling-advanced'),
      title: () => m.demo_page_leveling_advanced_title(),
      body: () => m.demo_page_leveling_advanced_body(),
    },
  ],
  '/leveling/leaderboard': [
    {
      target: TABS,
      title: () => m.demo_page_leveling_tabs_title(),
      body: () => m.demo_page_leveling_tabs_body(),
    },
    {
      target: tour('leveling-stats'),
      title: () => m.demo_page_leveling_stats_title(),
      body: () => m.demo_page_leveling_stats_body(),
    },
    {
      target: tour('leveling-podium'),
      title: () => m.demo_page_leveling_podium_title(),
      body: () => m.demo_page_leveling_podium_body(),
    },
    {
      target: `${tour('leveling-leaderboard')} input`,
      title: () => m.demo_page_leveling_search_title(),
      body: () => m.demo_page_leveling_search_body(),
    },
  ],
};

/**
 * Autres adresses d'une même page : le menu ouvre `/staff-management/members`,
 * l'onglet par défaut écrit en toutes lettres.
 */
const PAGE_ALIASES: Record<string, string> = {
  '/staff-management/members': '/staff-management',
  '/leveling/accueil': '/leveling',
  '/tickets/tickets': '/tickets',
  '/security/sanctions/sanctions': '/security/sanctions',
  '/security/filters/bot': '/security/filters',
};

/** Chemin de la visite de page qui couvre `path`, s'il y en a une. */
export function tourPageFor(path: string): string | null {
  const page = PAGE_ALIASES[path] ?? path;
  return page in pageTours ? page : null;
}

const MAIN_SEEN_KEY = 'kotbo_demo_tour_seen';
const PAGES_SEEN_KEY = 'kotbo_demo_page_tours_seen';

type Active =
  | { kind: 'main'; index: number }
  | { kind: 'page'; path: string; index: number; resumeMain: number | null };

let active = $state<Active | null>(null);
/** Sens du dernier déplacement : une étape de page sans repère est sautée dans ce sens. */
let direction = $state<1 | -1>(1);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Stockage refusé : les visites reviendront à la prochaine ouverture, sans plus.
  }
}

function seenPages(): string[] {
  try {
    const parsed = JSON.parse(read(PAGES_SEEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function markPageSeen(path: string) {
  const seen = seenPages();
  if (!seen.includes(path)) write(PAGES_SEEN_KEY, JSON.stringify([...seen, path]));
}

export function hrefPath(href: string): string {
  return href.split(/[?#]/)[0];
}

function goMain(index: number) {
  active = { kind: 'main', index };
  const step = mainSteps[index];
  if (appPathname() !== hrefPath(step.href)) router.goto(step.href);
}

function startPage(path: string, resumeMain: number | null) {
  markPageSeen(path);
  direction = 1;
  active = { kind: 'page', path, index: 0, resumeMain };
}

/** Fin d'une visite de page : la visite principale reprend si elle l'avait lancée. */
function endPage(resumeMain: number | null) {
  if (resumeMain === null) {
    active = null;
  } else if (resumeMain >= mainSteps.length - 1) {
    finishMain();
  } else {
    direction = 1;
    goMain(resumeMain + 1);
  }
}

function finishMain() {
  active = null;
  write(MAIN_SEEN_KEY, '1');
}

export const demoTour = {
  get active(): boolean {
    return active !== null;
  },

  get kind(): 'main' | 'page' | null {
    return active?.kind ?? null;
  },

  get index(): number {
    return active?.index ?? 0;
  },

  get steps(): TourStep[] {
    if (!active) return [];
    return active.kind === 'main' ? mainSteps : (pageTours[active.path] ?? []);
  },

  get step(): TourStep | null {
    return active ? (this.steps[active.index] ?? null) : null;
  },

  get total(): number {
    return this.steps.length;
  },

  get isLast(): boolean {
    return active !== null && active.index === this.steps.length - 1;
  },

  get direction(): 1 | -1 {
    return direction;
  },

  /** Chemin sur lequel l'étape en cours doit se trouver. */
  get path(): string | null {
    if (!active) return null;
    return active.kind === 'main' ? hrefPath(mainSteps[active.index].href) : active.path;
  },

  /** Le visiteur est sur la page de l'étape en cours, quelle que soit l'adresse employée. */
  isOnStepPage(path: string): boolean {
    const expected = this.path;
    return expected !== null && (path === expected || tourPageFor(path) === expected);
  },

  /** La visite de page lancée depuis la visite principale doit y revenir. */
  get resumesMain(): boolean {
    return active?.kind === 'page' && active.resumeMain !== null;
  },

  /** L'étape principale en cours a une visite de page à proposer. */
  get canDetail(): boolean {
    return active?.kind === 'main' && hrefPath(mainSteps[active.index].href) in pageTours && !this.isLast;
  },

  /** Une visite de page couvre ce chemin : la fiche d'aide générique y est inutile. */
  coversPage(path: string): boolean {
    return tourPageFor(path) !== null;
  },

  start() {
    direction = 1;
    goMain(0);
  },

  /** Première ouverture de la démo seulement. */
  startIfNew() {
    if (DEMO_MODE && read(MAIN_SEEN_KEY) !== '1' && active === null) this.start();
  },

  /** Arrivée sur une page : sa visite démarre si personne ne l'a encore vue. */
  onPageVisit(path: string) {
    const page = tourPageFor(path);
    if (!DEMO_MODE || active !== null || page === null) return;
    if (seenPages().includes(page)) return;
    startPage(page, null);
  },

  detail() {
    if (active?.kind !== 'main' || !this.canDetail) return;
    startPage(hrefPath(mainSteps[active.index].href), active.index);
  },

  next() {
    if (!active) return;
    direction = 1;
    if (active.kind === 'main') {
      if (active.index >= mainSteps.length - 1) return finishMain();
      return goMain(active.index + 1);
    }
    if (active.index >= this.steps.length - 1) return endPage(active.resumeMain);
    active = { ...active, index: active.index + 1 };
  },

  previous() {
    if (!active || active.index === 0) return;
    direction = -1;
    if (active.kind === 'main') return goMain(active.index - 1);
    active = { ...active, index: active.index - 1 };
  },

  /** Étape de page sans repère à l'écran : on passe à la voisine, dans le sens du déplacement. */
  skipMissing() {
    if (active?.kind !== 'page') return;
    if (direction === -1 && active.index > 0) return this.previous();
    this.next();
  },

  /** « Passer » : une visite de page rend la main à la visite principale, la principale s'arrête. */
  skip() {
    if (!active) return;
    if (active.kind === 'page') return endPage(active.resumeMain);
    finishMain();
  },

  /** Échap ou départ de la page : tout s'arrête. */
  stop() {
    if (active?.kind === 'main' || (active?.kind === 'page' && active.resumeMain !== null)) {
      write(MAIN_SEEN_KEY, '1');
    }
    active = null;
  },
};
