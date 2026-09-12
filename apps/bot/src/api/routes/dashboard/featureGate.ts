import type { Client } from 'discord.js';
import { cache } from '../../../utils/cache.js';
import { resolveMemberFeatureAccess, type DashboardAccess, type FeatureAccessMap } from '../../shared.js';

/**
 * Correspondance segment d'API -> fonctionnalite du centre de gestion.
 *
 * Retirer une section a un role ne retirait que son entree de barre laterale :
 * l'API continuait de servir la meme donnee a qui connaissait l'URL, ou a
 * n'importe quelle autre page du dashboard qui l'appelait au passage. Une
 * poignee de fichiers de routes verifiaient le droit pour leur compte, les
 * autres se contentaient du niveau Discord.
 *
 * La table vit ici et le repartiteur l'applique en un seul point, sur les
 * lectures. Les ecritures restent gardees route par route : elles passent deja
 * par `canManageSettings`, sauf une liste d'exceptions ou le droit exact
 * depend du geste (un membre du staff pose son absence sans etre moderateur).
 *
 * Ce qui n'y figure pas est ouvert a dessein :
 * - `channels`, `emojis`, `roles` alimentent les selecteurs de toutes les
 *   pages de configuration ; les fermer casserait des sections autorisees ;
 * - `settings`, `state`, `modules`, `language`, `timezone` portent l'etat du
 *   serveur dont la coquille du dashboard a besoin pour se rendre ;
 * - `user-settings`, `layout-presets` sont les preferences du lecteur ;
 * - `billing`, `onboarding`, `activate` doivent rester joignables meme quand
 *   le serveur n'a rien pris ;
 * - `members`, `sanctions`, `appeals`, `tickets`, `economy`, `fun` ont leur
 *   propre controle, plus fin, dans leur fichier de routes ;
 * - `staff`, `leadership`, `calls`, `reminders`, `tasks` sont l'annuaire et
 *   ses annexes, que les pages Reunions, Planning et Tutorat lisent pour
 *   afficher un nom : les fermer casserait des sections autorisees.
 */
export const SEGMENT_FEATURE_KEYS: Record<string, string | string[]> = {
  analytics: 'analytics',
  announcement: 'welcome_goodbye',
  campaigns: 'campaigns',
  'welcome-thread': 'welcome_goodbye',
  'audit-events': 'activity',
  'auto-thread': 'auto_thread',
  'channels-management': 'auto_thread',
  automod: 'automod',
  // La liste de mots bannis n'appartient pas a AutoMod : la moderation des
  // pseudos la lit par le meme service, sans passer par AutoMod. Une seule
  // clef fermait la page Pseudos a un role qui n'avait que cette section.
  'banned-words': ['automod', 'nickname_moderation'],
  'raid-protection': 'raid_protection',
  'nickname-moderation': 'nickname_moderation',
  detections: 'double_accounts',
  'linked-accounts': 'double_accounts',
  verification: 'double_accounts',
  logs: 'logs',
  'message-logs': 'logs',
  'ghost-members': 'members',
  invitations: 'members',
  'channel-health': 'channel_health',
  'channel-links': 'channel_links',
  'staff-server': 'staff_server',
  'command-access': 'commands',
  'daily-algo-problems': 'daily_algo',
  'daily-algo-runs': 'daily_algo',
  'daily-algo-weeks': 'daily_algo',
  'daily-algo-submissions': 'daily_algo',
  leveling: 'leveling',
  // Chacune de ces pages a son module et sa ligne de droits : les rabattre sur
  // « Leveling » laissait l'API ouverte a un role a qui le Centre de gestion
  // venait de fermer la section, et fermee a celui a qui il l'avait ouverte.
  // Meme regle que `ranked` ci-dessous.
  seasons: 'seasons',
  reputation: 'reputation',
  // La page Leveling lit l'etat des clans pour son bloc de bonus au clan
  // vainqueur : la clef « Clans » seule le lui refusait, et le bloc s'affichait
  // alors comme desactive au lieu de dire ce qu'il en est.
  clans: ['clans', 'leveling'],
  drops: 'drops',
  // La page Prestige appelle `ranked` : c'est bien « Prestige » qui la garde,
  // pas « Leveling », sinon la barre laterale cachait la page pendant que son
  // API restait ouverte.
  ranked: 'prestige',
  marketplace: 'marketplace',
  quests: 'quests',
  giveaways: 'giveaways',
  'reaction-roles': 'reaction_roles',
  // Recrutement, Appels de ban et l'editeur d'evenements listent les
  // formulaires a chaque ouverture pour en rattacher un : la clef
  // « Formulaires » seule fermait ces trois pages a un role qui les avait.
  'custom-forms': ['custom_forms', 'recruitment', 'ban_appeals', 'events'],
  'embed-builder': 'embed_builder',
  suggestions: 'suggestions',
  starboard: 'starboard',
  workflows: 'workflows',
  triggers: 'workflows',
  news: 'news',
  regulation: 'regulation',
  'social-follows': 'social_networks',
  notifications: 'inbox',
  pulse: 'dashboard',
  widget: 'dashboard',
  recruitment: 'recruitment',
  evaluations: 'evaluations',
  meetings: 'meetings',
  absences: 'absences',
  tutoring: 'tutoring',
  'mentor-reports': 'tutoring',
  'testing-periods': 'tutoring',
  satisfaction: 'tickets',
};

/**
 * Sous-routes exemptes de la garde.
 *
 * Trois cas, tous des lectures qu'une page emprunte a une autre section :
 *
 * - `tutoring/apprentice-progress` : un apprenti lit sa propre progression a
 *   chaque ouverture du dashboard. La fermer avec la section Tutorat privait
 *   l'apprenti de son parcours au motif qu'il n'a pas acces a celui des autres.
 * - `staff-server/channels` : le selecteur de salons du serveur staff lie, que
 *   les pages Staff, Reunions, Tickets et Appels de ban affichent dans leurs
 *   listes deroulantes. Comme `channels` ou `roles`, le fermer casse des
 *   sections autorisees.
 * - `notifications/features` : la ligne de configuration par fonctionnalite
 *   (salon, role, journalisation), que dix pages relisent pour y trouver la
 *   leur. La garder sous « Boite de reception » refusait a chacune sa propre
 *   configuration.
 */
const UNGATED_SUBROUTES = new Set([
  'tutoring/apprentice-progress',
  'staff-server/channels',
  'notifications/features',
]);

function isUngatedSubroute(segment: string | undefined, subSegment?: string): boolean {
  if (!segment || !subSegment) return false;
  return UNGATED_SUBROUTES.has(`${segment}/${subSegment}`);
}

/**
 * Sous-routes exemptes de la garde des modules.
 *
 * Sous-ensemble de la liste ci-dessus : une lecture peut traverser la garde des
 * sections sans traverser celle des modules, qui elle ferme les routes d'un
 * module eteint - la progression d'un apprenti n'a rien a dire quand le Tutorat
 * est eteint. Le selecteur de salons du serveur staff, lui, part de pages qui
 * n'ont rien a voir avec le module « Serveur staff » et doit repondre vide
 * plutot que refuser : ces pages l'appellent a chaque ouverture.
 */
const MODULE_UNGATED_SUBROUTES = new Set(['staff-server/channels']);

export function isModuleUngatedSubroute(segment: string | undefined, subSegment?: string): boolean {
  if (!segment || !subSegment) return false;
  return MODULE_UNGATED_SUBROUTES.has(`${segment}/${subSegment}`);
}

/**
 * Modules qui partagent un segment avec son proprietaire declare.
 *
 * Le registre n'attribue un segment qu'a un module, et la garde des modules
 * ferme ses routes des que ce module est eteint. Les mots bannis servent aussi
 * la moderation des pseudos, qui continue de les appliquer AutoMod eteint : la
 * page Pseudos tombait alors sur un `module_disabled` pour une liste que le bot
 * lisait encore.
 *
 * N'y ajouter qu'un segment dont l'ecriture n'ouvre rien du module eteint.
 */
const SHARED_SEGMENT_MODULES: Record<string, string[]> = {
  'banned-words': ['nickname_moderation'],
};

export function sharedModulesForSegment(segment: string | undefined): string[] {
  if (!segment) return [];
  return SHARED_SEGMENT_MODULES[segment] ?? [];
}

export function featureKeysForSegment(
  segment: string | undefined,
  subSegment?: string,
): string[] | undefined {
  if (!segment) return undefined;
  if (isUngatedSubroute(segment, subSegment)) return undefined;
  const keys = SEGMENT_FEATURE_KEYS[segment];
  if (!keys) return undefined;
  return Array.isArray(keys) ? keys : [keys];
}

/**
 * Droits du membre, gardes quelques secondes.
 *
 * La garde ci-dessus tombe sur chaque lecture d'une section, et resoudre les
 * droits demande de relire toutes les fonctionnalites du serveur avec leurs
 * regles de role. Une page qui s'ouvre lance dix requetes : sans ce cache,
 * elle payait dix fois la meme lecture. La cle porte le prefixe `guild:` pour
 * que `cache.invalidateGuild`, deja appele apres chaque ecriture, la balaie -
 * un droit retire s'applique donc des l'enregistrement.
 */
const FEATURE_ACCESS_TTL_SECONDS = 15;

export async function getCachedFeatureAccess(
  client: Client,
  guildId: string,
  access: DashboardAccess,
  userId: string,
): Promise<FeatureAccessMap> {
  const key = `guild:${guildId}:feature-access:${userId}`;
  const cached = await cache.get<FeatureAccessMap>(key);
  if (cached) return cached;

  const featureAccess = await resolveMemberFeatureAccess(client, guildId, access, userId);
  await cache.set(key, featureAccess, FEATURE_ACCESS_TTL_SECONDS);
  return featureAccess;
}

/**
 * Meme question que la garde de lecture du repartiteur, pour les routes qu'elle
 * laisse passer (`staff`, `leadership`) mais dont un morceau appartient a une
 * section precise.
 */
export async function canViewFeatureSection(
  client: Client,
  guildId: string,
  access: DashboardAccess,
  userId: string,
  featureKey: string,
): Promise<boolean> {
  if (access.canManageSettings) return true;
  const featureAccess = await getCachedFeatureAccess(client, guildId, access, userId);
  return featureAccess[featureKey]?.canView !== false;
}
