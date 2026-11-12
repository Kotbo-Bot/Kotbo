/**
 * Plan de la console admin : six espaces, chacun avec ses onglets.
 *
 * L'ancienne barre alignait dix-sept pages au meme niveau. Ici on choisit
 * d'abord un sujet (six entrees, memorisables), puis une vue dans ce sujet.
 * Les adresses des pages ne changent pas : favoris, palette et telemetrie
 * continuent de pointer au meme endroit.
 */
export interface AdminTab {
  path: string;
  label: string;
}

export interface AdminSpace {
  id: string;
  label: string;
  icon: string;
  /**
   * Couleur d'identite de l'espace (pastille d'icone, lavis d'en-tete). C'est
   * un repere, pas un etat : elle ne porte jamais de texte, donc pas de
   * contrainte de contraste a tenir dessus.
   */
  color: string;
  tabs: AdminTab[];
}

export const ADMIN_SPACES: AdminSpace[] = [
  {
    id: 'home',
    label: 'Accueil',
    icon: 'Home',
    color: '#5b6cff',
    tabs: [{ path: '/admin', label: 'Accueil' }],
  },
  {
    id: 'servers',
    label: 'Serveurs',
    icon: 'Server',
    color: '#0a9eec',
    tabs: [
      { path: '/admin/servers', label: 'Tous les serveurs' },
      { path: '/admin/activation', label: 'Codes d’activation' },
      { path: '/admin/whitelabel', label: 'Marque blanche' },
      { path: '/admin/instances', label: 'Self-host' },
    ],
  },
  {
    id: 'revenue',
    label: 'Revenus',
    icon: 'CreditCard',
    color: '#1fb26a',
    tabs: [
      { path: '/admin/billing', label: 'Abonnements' },
      { path: '/admin/analytics', label: 'Analytics' },
    ],
  },
  {
    id: 'moderation',
    label: 'Modération',
    icon: 'ShieldCheck',
    color: '#f0503c',
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
    color: '#e8890c',
    tabs: [
      { path: '/admin/broadcast', label: 'Annonces' },
      { path: '/admin/achievements', label: 'Succès' },
      { path: '/admin/feature-pages', label: 'Pages du site' },
    ],
  },
  {
    id: 'system',
    label: 'Système',
    icon: 'Cpu',
    color: '#8b6cf6',
    tabs: [
      { path: '/admin/shards', label: 'Shards' },
      { path: '/admin/config', label: 'Erreurs et maintenance' },
      { path: '/admin/audit', label: 'Journal d’audit' },
    ],
  },
];

/** `/admin/servers/123` appartient a l'onglet `/admin/servers`, mais `/admin` seul n'attrape pas tout. */
export function tabMatches(tab: AdminTab, path: string): boolean {
  if (tab.path === '/admin') return path === '/admin' || path === '/admin/';
  return path === tab.path || path.startsWith(`${tab.path}/`);
}

export function spaceForPath(path: string): AdminSpace {
  return ADMIN_SPACES.find((space) => space.tabs.some((tab) => tabMatches(tab, path))) ?? ADMIN_SPACES[0];
}
