/**
 * Plan de la console admin : six espaces, chacun avec ses vues.
 *
 * On choisit d'abord un sujet (six entrees, memorisables), puis une vue dans
 * ce sujet. Les adresses historiques n'ont pas change : favoris, palette et
 * telemetrie continuent de pointer au meme endroit.
 */
export interface AdminTab {
  path: string;
  label: string;
}

export interface AdminSpace {
  id: string;
  label: string;
  icon: string;
  tabs: AdminTab[];
}

export const ADMIN_SPACES: AdminSpace[] = [
  {
    id: 'home',
    label: 'Accueil',
    icon: 'Home',
    tabs: [{ path: '/admin', label: 'Accueil' }],
  },
  {
    id: 'servers',
    label: 'Serveurs',
    icon: 'Server',
    tabs: [
      { path: '/admin/servers', label: 'Tous les serveurs' },
      { path: '/admin/activation', label: 'Codes d’activation' },
      { path: '/admin/whitelabel', label: 'Marque blanche' },
      { path: '/admin/instances', label: 'Self-host' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: 'TrendingUp',
    tabs: [
      { path: '/admin/activity', label: 'Activité' },
      { path: '/admin/analytics', label: 'Acquisition' },
      { path: '/admin/analytics/revenue', label: 'Revenus' },
      { path: '/admin/analytics/segments', label: 'Segments' },
      { path: '/admin/analytics/retention', label: 'Rétention' },
      { path: '/admin/analytics/usage', label: 'Usage du dashboard' },
      { path: '/admin/analytics/modules', label: 'Modules' },
      { path: '/admin/analytics/alerts', label: 'Alertes' },
      { path: '/admin/billing', label: 'Abonnements' },
    ],
  },
  {
    id: 'moderation',
    label: 'Modération',
    icon: 'ShieldCheck',
    tabs: [
      { path: '/admin/security', label: 'Accès et liste noire' },
      { path: '/admin/content', label: 'Mots globaux' },
      { path: '/admin/sites', label: 'Sites' },
      { path: '/admin/gdpr', label: 'Export RGPD' },
    ],
  },
  {
    id: 'comms',
    label: 'Communication',
    icon: 'Megaphone',
    tabs: [
      { path: '/admin/broadcast', label: 'Annonces' },
      { path: '/admin/achievements', label: 'Succès' },
      { path: '/admin/feature-pages', label: 'Pages du site' },
    ],
  },
  {
    id: 'supervision',
    label: 'Supervision',
    icon: 'activity',
    tabs: [
      { path: '/admin/ai', label: 'AegisAI et Vision' },
      { path: '/admin/shards', label: 'Shards' },
      { path: '/admin/performance', label: 'Performances' },
      { path: '/admin/config', label: 'Erreurs et maintenance' },
      { path: '/admin/audit', label: 'Journal d’audit' },
    ],
  },
];

/** `/admin/servers/123` appartient a la vue `/admin/servers`, mais `/admin` seul n'attrape pas tout. */
export function tabMatches(tab: AdminTab, path: string): boolean {
  if (tab.path === '/admin') return path === '/admin' || path === '/admin/';
  return path === tab.path || path.startsWith(`${tab.path}/`);
}

/** La vue active : la plus precise de celles qui correspondent (`/admin/analytics/revenue` avant `/admin/analytics`). */
export function tabForPath(space: AdminSpace, path: string): AdminTab {
  const matches = space.tabs.filter((tab) => tabMatches(tab, path)).sort((a, b) => b.path.length - a.path.length);
  return matches[0] ?? space.tabs[0];
}

export function spaceForPath(path: string): AdminSpace {
  return ADMIN_SPACES.find((space) => space.tabs.some((tab) => tabMatches(tab, path))) ?? ADMIN_SPACES[0];
}
