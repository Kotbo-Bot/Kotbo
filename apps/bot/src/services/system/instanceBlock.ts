/**
 * Instance bloquée : sans bail valide, ou bannie par l'administration Kotbo
 * (voir statsService.ts).
 *
 * Le blocage ne coupait que les commandes et les boutons. Le dashboard, les
 * fonctions automatiques (automod, logs, accueil...) et les tâches planifiées
 * tournaient encore : une instance non autorisée restait utilisable. Ces règles
 * disent ce qui reste ouvert une fois l'instance bloquée ; tout le reste est
 * coupé à trois endroits centraux (API, `client.emit`, tâches planifiées).
 */
import { Events } from 'discord.js';

export const INSTANCE_BLOCKED_MESSAGE = "Cette instance auto-hébergée a été désactivée par l'administration Kotbo.";

export function isInstanceBlocked(): boolean {
  return !!global.KOTBO_INSTANCE_BANNED;
}

export function instanceBlockReason(): string | null {
  return global.KOTBO_INSTANCE_BANNED?.reason ?? null;
}

/**
 * Tâches qui continuent : le ping, seul moyen de retrouver un bail, et les
 * purges, car la conservation limitée des données ne dépend pas du bail.
 */
export function isJobAllowedWhileBlocked(jobName: string): boolean {
  return jobName === 'stats-ping' || jobName === 'data-retention' || jobName.endsWith('-prune');
}

/**
 * Routes qui restent ouvertes : santé, connexion, et ce qu'il faut au
 * dashboard pour s'ouvrir et afficher le motif du blocage.
 */
const OPEN_PATHS = [/^\/health(\/|$)/, /^\/api\/auth\//, /^\/api\/internal\//, /^\/api\/public\/stats\//, /^\/api\/user\/(me|guilds|servers)$/];

export function isPathAllowedWhileBlocked(path: string): boolean {
  return OPEN_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Passent aussi les journaux et l'état de connexion de discord.js : sans eux,
 * une instance bloquée ne dirait plus rien de ses erreurs.
 */
const ALWAYS_DELIVERED = new Set<string | symbol>([
  Events.InteractionCreate,
  Events.Error,
  Events.Warn,
  Events.Debug,
  Events.ShardDisconnect,
  Events.ShardError,
  Events.ShardReconnecting,
  Events.ShardResume,
  Events.Invalidated,
]);

/** Seules les interactions (pour le message de blocage) et les journaux passent. */
export function shouldDeliverEvent(eventName: string | symbol, blocked: boolean): boolean {
  return !blocked || ALWAYS_DELIVERED.has(eventName);
}
