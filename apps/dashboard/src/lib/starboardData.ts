/**
 * Contrôle des réponses de l'API Starlight.
 *
 * Le dashboard et le bot ne sont pas toujours déployés en même temps : un bot
 * plus ancien ne renvoie que les réglages, sans statistiques. Une telle
 * réponse est refusée, la page affiche alors son état d'erreur ; un champ
 * ajouté plus tard prend sa valeur par défaut.
 */
import { defaultStarboardSettings, type StarboardSettings } from '@kotbo/shared';
import type { StarboardOverview } from './api/starboard';

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/** Réglages du formulaire, et eux seuls : `enabled` appartient à l'en-tête du module. */
export function toStarboardConfig(raw: unknown): StarboardSettings | null {
  if (!isObject(raw)) return null;
  const config = defaultStarboardSettings();
  for (const key of Object.keys(config) as Array<keyof StarboardSettings>) {
    const value = raw[key];
    if (value === undefined) continue;
    const fallback = config[key];
    if (Array.isArray(fallback)) {
      if (Array.isArray(value)) (config as unknown as Record<string, unknown>)[key] = [...value];
    } else if (fallback !== null && typeof fallback === 'object') {
      if (isObject(value) && !Array.isArray(value)) (config as unknown as Record<string, unknown>)[key] = { ...value };
    } else {
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return config;
}

export function toStarboardOverview(raw: unknown): StarboardOverview | null {
  if (!isObject(raw) || !isObject(raw.stats)) return null;
  const config = toStarboardConfig(raw.config);
  if (!config) return null;
  const health = isObject(raw.health) ? raw.health : {};
  return {
    config,
    stats: raw.stats as unknown as StarboardOverview['stats'],
    topEntries: Array.isArray(raw.topEntries) ? (raw.topEntries as StarboardOverview['topEntries']) : [],
    channelStats: Array.isArray(raw.channelStats) ? (raw.channelStats as StarboardOverview['channelStats']) : [],
    health: {
      channelFound: typeof health.channelFound === 'boolean' ? health.channelFound : null,
      missingPermissions: Array.isArray(health.missingPermissions) ? (health.missingPermissions as string[]) : [],
    },
    messageLabels: isObject(raw.messageLabels) ? (raw.messageLabels as unknown as StarboardOverview['messageLabels']) : null,
    blockedMembers: Array.isArray(raw.blockedMembers) ? (raw.blockedMembers as StarboardOverview['blockedMembers']) : [],
    topAuthors: Array.isArray(raw.topAuthors) ? (raw.topAuthors as StarboardOverview['topAuthors']) : [],
    unmanageableTierRoleIds: Array.isArray(raw.unmanageableTierRoleIds) ? (raw.unmanageableTierRoleIds as string[]) : [],
  };
}
