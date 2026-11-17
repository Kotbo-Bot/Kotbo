/**
 * Plafonds du plan Gratuit (`FREE_QUOTAS`), vérifiés à la création. Les offres
 * payantes passent sans compter.
 */
import { FREE_QUOTAS, type FreeQuotaKey } from '@kotbo/contracts';
import { UserFacingError } from '../../utils/userFacingError.js';
import { getGuildPlan } from './planService.js';

export class FreeQuotaError extends UserFacingError {}

const LABELS: Record<FreeQuotaKey, string> = {
  customForms: 'formulaires',
  recruitmentForms: 'formulaire de recrutement',
  backups: 'sauvegardes',
  scheduledTasks: 'tâches planifiées',
};

/** Le serveur est-il au plafond gratuit ? `count` n'est appelé que sur `FREE`. */
export async function isAtFreeQuota(guildId: string, key: FreeQuotaKey, count: () => Promise<number>): Promise<boolean> {
  if ((await getGuildPlan(guildId)) !== 'FREE') return false;
  return (await count()) >= FREE_QUOTAS[key];
}

export async function assertFreeQuota(guildId: string, key: FreeQuotaKey, count: () => Promise<number>): Promise<void> {
  if (!(await isAtFreeQuota(guildId, key, count))) return;
  throw new FreeQuotaError(
    `Le plan Gratuit est limité à ${FREE_QUOTAS[key]} ${LABELS[key]} : supprimes-en ou passe à Plus pour en créer davantage.`,
  );
}
