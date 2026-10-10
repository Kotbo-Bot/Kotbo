/**
 * Configuration Kotbo × AegisAI d'un serveur : lecture en cache (chaque
 * message la consulte) et validation des modifications venues du dashboard.
 */
import type { AegisConfig } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';

/** Ce que le traitement lit : sans dates, la valeur fait l'aller-retour Redis telle quelle. */
export type AegisRuntimeConfig = Omit<AegisConfig, 'createdAt' | 'updatedAt' | 'trainingConsentAt' | 'trainingConsentById'>;

export const AEGIS_AUTO_ACTIONS = ['DELETE', 'DELETE_AND_WARN', 'DELETE_AND_TIMEOUT'] as const;
export const AEGIS_HARASSMENT_ACTIONS = ['ALERT', 'TIMEOUT'] as const;

const configKey = (guildId: string) => `guild:${guildId}:aegis-config`;
const CONFIG_TTL_SECONDS = 300;

/** Configuration active, ou null si le module est éteint sur ce serveur. */
export async function getAegisConfig(guildId: string): Promise<AegisRuntimeConfig | null> {
  const value = await cache.wrap<AegisRuntimeConfig | { enabled: false }>(configKey(guildId), CONFIG_TTL_SECONDS, async () => {
    const row = await prisma.aegisConfig.findUnique({ where: { guildId } });
    if (!row) return { enabled: false };
    const { createdAt: _c, updatedAt: _u, trainingConsentAt: _a, trainingConsentById: _b, ...runtime } = row;
    return runtime;
  });
  return value.enabled ? (value as AegisRuntimeConfig) : null;
}

export async function invalidateAegisConfig(guildId: string): Promise<void> {
  await cache.delete(configKey(guildId));
}

export class AegisConfigError extends Error {}

type Patch = Partial<Omit<AegisConfig, 'guildId' | 'createdAt' | 'updatedAt' | 'trainingConsentAt' | 'trainingConsentById'>>;

const SNOWFLAKE_RE = /^\d{17,20}$/;

function int(value: unknown, min: number, max: number, label: string): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new AegisConfigError(`${label} : entre ${min} et ${max}.`);
  return n;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new AegisConfigError(`${label} : oui ou non.`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new AegisConfigError(`${label} : valeur inconnue.`);
  }
  return value as T;
}

function channel(value: unknown, label: string): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) throw new AegisConfigError(`${label} : salon invalide.`);
  return value;
}

function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every((id) => typeof id === 'string' && SNOWFLAKE_RE.test(id))) {
    throw new AegisConfigError(`${label} : liste invalide.`);
  }
  return [...new Set(value as string[])];
}

const BOOLEAN_FIELDS = [
  'enabled', 'notifyMember', 'analyzeEdits', 'analyzeNicknames', 'analyzeTickets', 'ticketPriorityBoost',
  'conflictEnabled', 'harassmentEnabled', 'distressEnabled',
] as const;

const INT_FIELDS: Record<string, [number, number, string]> = {
  reviewThreshold: [50, 99, 'Seuil de revue'],
  autoThreshold: [50, 100, "Seuil d'action automatique"],
  warnWeight: [1, 3, 'Poids du warn'],
  timeoutMinutes: [1, 40_320, 'Durée du timeout'],
  conflictWindowSec: [30, 900, "Fenêtre d'escalade"],
  conflictMessageThreshold: [2, 30, "Seuil d'escalade"],
  conflictSlowmodeSec: [1, 21_600, 'Mode lent'],
  conflictDurationMin: [1, 240, 'Durée du mode lent'],
  harassmentWindowMin: [5, 1440, 'Fenêtre de harcèlement'],
  harassmentThreshold: [2, 20, 'Seuil de harcèlement'],
  distressThreshold: [50, 100, 'Seuil de détresse'],
  distressCooldownHours: [1, 168, 'Délai entre deux alertes de détresse'],
};

/**
 * Valide une modification partielle. Le consentement d'entraînement n'en
 * fait pas partie : il a sa propre route, qui note qui l'a donné et quand.
 */
export function sanitizeAegisPatch(body: Record<string, unknown>, current: Pick<AegisConfig, 'reviewThreshold' | 'autoThreshold'>): Patch {
  const patch: Patch = {};
  for (const field of BOOLEAN_FIELDS) {
    if (body[field] !== undefined) patch[field] = bool(body[field], field);
  }
  for (const [field, [min, max, label]] of Object.entries(INT_FIELDS)) {
    if (body[field] !== undefined) (patch as Record<string, number>)[field] = int(body[field], min, max, label);
  }
  if (body.autoAction !== undefined) patch.autoAction = oneOf(body.autoAction, AEGIS_AUTO_ACTIONS, 'Action automatique');
  if (body.harassmentAction !== undefined) patch.harassmentAction = oneOf(body.harassmentAction, AEGIS_HARASSMENT_ACTIONS, 'Action sur harcèlement');
  if (body.reviewChannelId !== undefined) patch.reviewChannelId = channel(body.reviewChannelId, 'Salon de revue');
  if (body.distressChannelId !== undefined) patch.distressChannelId = channel(body.distressChannelId, 'Salon des alertes de détresse');
  if (body.exemptChannelIds !== undefined) patch.exemptChannelIds = ids(body.exemptChannelIds, 'Salons exemptés');
  if (body.exemptRoleIds !== undefined) patch.exemptRoleIds = ids(body.exemptRoleIds, 'Rôles exemptés');

  const review = patch.reviewThreshold ?? current.reviewThreshold;
  const auto = patch.autoThreshold ?? current.autoThreshold;
  if (auto <= review) throw new AegisConfigError("Le seuil d'action automatique doit dépasser le seuil de revue.");
  return patch;
}
