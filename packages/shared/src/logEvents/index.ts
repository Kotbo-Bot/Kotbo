/**
 * Catalogue des types de journaux que Kotbo publie dans un salon de logs.
 *
 * Une seule liste, lue par les deux côtés :
 *   - le bot s'en sert pour router chaque envoi (publié ou non, et où) ;
 *   - l'API s'en sert pour refuser un type inconnu à l'enregistrement ;
 *   - le dashboard s'en sert pour afficher la page de réglage.
 *
 * Avant ce catalogue, seuls les « logs avancés » (messages, membres, vocal…)
 * passaient par le réglage par événement. Une vingtaine de modules — AutoMod,
 * Vision, anti-raid, pseudos, doubles comptes… — écrivaient en direct dans le
 * salon de logs, sans que rien ne permette de les couper. Ajouter un envoi au
 * salon de logs, c'est désormais ajouter une entrée ici : sinon le type ne
 * passe pas la validation, et le test `logEventCatalog` le signale.
 *
 * Les libellés ne sont pas ici : ils vivent dans les fichiers de traduction du
 * dashboard, qui sont la seule source de texte affiché.
 */

export const LOG_EVENT_CATEGORIES = [
  'messages',
  'members',
  'moderation',
  'voice',
  'server',
  'automod',
  'security',
  'accounts',
] as const;

export type LogEventCategory = (typeof LOG_EVENT_CATEGORIES)[number];

export interface LogEventDefinition {
  type: string;
  category: LogEventCategory;
  /**
   * Le message porte des boutons sur lesquels le staff doit agir (valider une
   * liaison, accepter une demande…). Le couper ne désactive pas la
   * fonctionnalité : les demandes restent en attente sans que personne ne les
   * voie. Le dashboard prévient avant.
   */
  interactive?: boolean;
  /**
   * Le module a son propre réglage de salon. Quand il est rempli, il reste
   * prioritaire sur le salon choisi ici : c'est un choix explicite, fait au
   * plus près du module.
   */
  moduleChannel?: boolean;
  /**
   * L'alerte est postée par Discord lui-même (règles AutoMod natives), pas par
   * Kotbo. Un changement ne prend effet qu'à la resynchronisation des règles,
   * que l'API déclenche à l'enregistrement.
   */
  native?: boolean;
}

export const LOG_EVENTS = [
  // Messages
  { type: 'message_delete', category: 'messages' },
  { type: 'message_edit', category: 'messages' },
  { type: 'message_bulk_delete', category: 'messages' },

  // Membres
  { type: 'member_join', category: 'members' },
  { type: 'member_leave', category: 'members' },
  { type: 'member_roles_update', category: 'members' },
  { type: 'member_tag_update', category: 'members' },
  { type: 'member_timeout', category: 'members' },

  // Modération manuelle (journal d'audit Discord)
  { type: 'moderation_kick', category: 'moderation' },
  { type: 'moderation_ban', category: 'moderation' },
  { type: 'moderation_unban', category: 'moderation' },
  { type: 'moderation_timeout', category: 'moderation' },

  // Vocal
  { type: 'voice_join', category: 'voice' },
  { type: 'voice_leave', category: 'voice' },
  { type: 'voice_move', category: 'voice' },
  { type: 'voice_moderation', category: 'voice' },
  { type: 'voice_panel', category: 'voice' },

  // Structure du serveur
  { type: 'channel_lifecycle', category: 'server' },
  { type: 'role_lifecycle', category: 'server' },

  // AutoMod et filtres
  { type: 'automod_sanction', category: 'automod' },
  { type: 'automod_native_alert', category: 'automod', native: true },
  { type: 'automod_ghost_ping', category: 'automod' },
  { type: 'automod_spam', category: 'automod', moduleChannel: true },
  { type: 'automod_slowmode', category: 'automod' },
  { type: 'automod_files', category: 'automod' },
  { type: 'automod_other_servers', category: 'automod' },
  { type: 'automod_emoji', category: 'automod' },
  { type: 'automod_nickname', category: 'automod' },
  { type: 'automod_tag', category: 'automod', moduleChannel: true },
  { type: 'automod_clans', category: 'automod' },
  { type: 'vision_blocked', category: 'automod', moduleChannel: true },
  { type: 'aegis_alert', category: 'automod', interactive: true, moduleChannel: true },

  // Sécurité et anti-raid
  { type: 'security_honeypot', category: 'security' },
  { type: 'security_anti_bot', category: 'security' },
  { type: 'security_shield', category: 'security' },
  { type: 'security_admin_lock', category: 'security', interactive: true, moduleChannel: true },
  { type: 'security_captcha', category: 'security', moduleChannel: true },
  { type: 'security_ban_hygiene', category: 'security', interactive: true },

  // Doubles comptes et vérification
  { type: 'alt_detection', category: 'accounts', moduleChannel: true },
  { type: 'alt_validation', category: 'accounts', interactive: true, moduleChannel: true },
  { type: 'verification_warn_threshold', category: 'accounts', interactive: true, moduleChannel: true },
] as const satisfies readonly LogEventDefinition[];

export type LogEventType = (typeof LOG_EVENTS)[number]['type'];

export const LOG_EVENT_TYPES: readonly LogEventType[] = LOG_EVENTS.map((event) => event.type);

const TYPES = new Set<string>(LOG_EVENT_TYPES);

export function isLogEventType(value: unknown): value is LogEventType {
  return typeof value === 'string' && TYPES.has(value);
}

export function getLogEventDefinition(type: string): LogEventDefinition | null {
  return (LOG_EVENTS as readonly LogEventDefinition[]).find((event) => event.type === type) ?? null;
}

export function logEventsByCategory(category: LogEventCategory): LogEventDefinition[] {
  return (LOG_EVENTS as readonly LogEventDefinition[]).filter((event) => event.category === category);
}

/** Réglage d'un type, tel que la base le garde et que l'API l'échange. */
export interface LogEventConfig {
  eventType: string;
  enabled: boolean;
  channelId: string | null;
}

/**
 * Salon où part un journal, ou `null` s'il ne part pas.
 *
 * Ordre de priorité, du plus précis au plus général :
 *   1. type désactivé : rien ne part, quel que soit le salon ;
 *   2. salon propre au module (spam, Vision, captcha…), s'il est rempli ;
 *   3. salon choisi pour ce type dans la page Journaux ;
 *   4. salon de logs du serveur ;
 *   5. dernier recours propre à l'appelant (rare : l'hygiène des bans retombe
 *      sur le salon de vérification, comme avant).
 *
 * Fonction pure : le bot l'appelle pour router, le dashboard pour afficher où
 * chaque type partira réellement.
 */
export function routeLogEvent(input: {
  enabled: boolean;
  eventChannelId: string | null | undefined;
  moduleChannelId?: string | null;
  guildLogChannelId: string | null | undefined;
  fallbackChannelId?: string | null;
}): string | null {
  if (!input.enabled) return null;
  return input.moduleChannelId
    || input.eventChannelId
    || input.guildLogChannelId
    || input.fallbackChannelId
    || null;
}
