/**
 * Page du dashboard qui correspond au « module » d'une entrée du journal
 * d'actions. Le champ est du texte libre posé par le bot, d'où la table :
 * un module absent reste un simple texte, jamais un lien cassé.
 */
const MODULE_PAGES: Record<string, string> = {
  'staff management': '/staff-management/members',
  staff: '/staff-management/members',
  économie: '/economy',
  economy: '/economy',
  sanctions: '/security/sanctions',
  modération: '/security/sanctions',
  moderation: '/security/sanctions',
  clans: '/clans',
  tickets: '/tickets',
  invitations: '/invitations',
  'gestion des salons': '/channels-management',
  salons: '/channels-management',
  fun: '/fun',
  raidprotection: '/security/anti-raid',
  mcp: '/mcp-settings',
  sauvegardes: '/backups',
  réputation: '/reputation',
  règlement: '/regulation',
  actualités: '/news',
  news: '/news',
  suggestions: '/suggestions',
  planificateur: '/schedules',
  leveling: '/leveling',
  leaderboard: '/leveling',
  giveaways: '/giveaways',
  vérification: '/security/accounts/verification',
  'modération des pseudos': '/security/filters/nicknames',
  membres: '/members',
  campagnes: '/campaigns',
  automod: '/security/filters',
  seasons: '/seasons',
  prestige: '/prestige',
  announcement: '/announcement',
  drops: '/drops',
  antispam: '/security/filters',
};

export function logModuleHref(module: string): string | null {
  return MODULE_PAGES[module.trim().toLowerCase()] ?? null;
}
