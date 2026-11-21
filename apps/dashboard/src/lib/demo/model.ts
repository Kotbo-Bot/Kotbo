/**
 * Une ligne de base telle que Prisma la créerait pour le serveur de démo.
 *
 * Part des valeurs par défaut du schéma (`generated/prismaDefaults.ts`), fixe
 * `guildId` sur le serveur de démo, date les champs `now()` et applique les
 * retouches propres à l'histoire de la démo.
 */
import { PRISMA_DEFAULTS } from './generated/prismaDefaults';
import { DEMO_GUILD_ID } from './mode';

export function row<T extends Record<string, unknown> = Record<string, any>>(model: string, overrides: Record<string, unknown> = {}): T {
  const defaults = PRISMA_DEFAULTS[model];
  if (!defaults) throw new Error(`[démo] modèle Prisma inconnu : ${model}`);
  const now = new Date().toISOString();
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    base[key] = value === '__NOW__' ? now : Array.isArray(value) ? [...value] : value;
  }
  if ('guildId' in base) base.guildId = DEMO_GUILD_ID;
  return { ...base, ...overrides } as T;
}

/** Fusionne un corps de PATCH dans une ligne, en ignorant les champs inconnus de la ligne. */
export function merge<T extends Record<string, unknown>>(current: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object') return current;
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key in current) next[key] = value;
  }
  next.updatedAt = 'updatedAt' in current ? new Date().toISOString() : next.updatedAt;
  return next as T;
}
