import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';

/** Au-delà de MAX demandes par modérateur dans la fenêtre, on refuse et on alerte. */
export const VERIFICATION_SPAM_WINDOW_MS = 10 * 60 * 1000;
export const VERIFICATION_SPAM_MAX = 5;

/** Plafond global (tous serveurs confondus) de demandes manuelles par heure. */
export const VERIFICATION_GLOBAL_MAX_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

export const VERIFICATION_SPAM_MESSAGE = '🚫 Vous avez un peu abusé, veuillez réessayer plus tard.';

// shortcut: compteurs en mémoire, perdus au redémarrage et non partagés entre processus ; passer à Redis si le bot est shardé.
const attempts = new Map<string, number[]>();
let lastGlobalAlertAt = 0;

/** Enregistre une tentative et renvoie le nombre de tentatives dans la fenêtre (celle-ci incluse). */
export function registerVerificationAttempt(guildId: string, moderatorId: string, now = Date.now()): number {
  const key = `${guildId}:${moderatorId}`;
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < VERIFICATION_SPAM_WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length;
}

async function alertBotAdmins(client: Client, title: string, description: string, fields: { name: string; value: string }[]) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields.map((f) => ({ ...f, inline: false })))
    .setTimestamp();
  const { notifyBotAdmins } = await import('../analytics/acquisitionAlertsService.js');
  await notifyBotAdmins(client, embed).catch((err) => {
    logger.warn('VerificationSpam', 'Alerte aux admins du bot non délivrée:', err);
  });
}

/**
 * Renvoie true si le modérateur abuse : la demande doit alors être refusée.
 * Les admins du bot ne sont prévenus qu'une fois par salve (au premier dépassement).
 */
export async function isVerificationRequestSpam(
  client: Client,
  params: { guildId: string; guildName: string; moderatorId: string; moderatorTag: string },
): Promise<boolean> {
  const count = registerVerificationAttempt(params.guildId, params.moderatorId);
  if (count <= VERIFICATION_SPAM_MAX) return false;

  if (count === VERIFICATION_SPAM_MAX + 1) {
    logger.warn('VerificationSpam', `${params.moderatorTag} (${params.moderatorId}) spamme les demandes de vérification sur ${params.guildId}.`);
    await alertBotAdmins(
      client,
      '🚨 Spam de demandes de vérification',
      `<@${params.moderatorId}> (${params.moderatorTag}) a dépassé ${VERIFICATION_SPAM_MAX} demandes en ${VERIFICATION_SPAM_WINDOW_MS / 60000} min.\n`
        + 'Les demandes suivantes sont refusées jusqu\'à la fin de la fenêtre.',
      [
        { name: 'Serveur', value: `${params.guildName} (${params.guildId})` },
        { name: 'Modérateur', value: params.moderatorId },
      ],
    );
  }
  return true;
}

/** « 3 j », « 5 h », « 12 min » : la durée d'attente restante, arrondie vers le haut. */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.ceil(hours / 24)} j`;
}

export type VerificationEligibility =
  | { allowed: true }
  | { allowed: false; reason: 'PENDING' | 'WEEKLY' | 'GLOBAL'; message: string; cooldownUntil: Date | null };

/**
 * Une demande manuelle est-elle permise ?
 *
 * - une seule demande en cours par membre ;
 * - une demande par semaine et par membre sur un même serveur (délai porté par
 *   `getVerificationHistory`, que le bouton du dashboard lit aussi) ;
 * - 5 demandes par heure sur l'ensemble du bot. Les sessions issues d'un appel
 *   de ban (`appealId`) ne comptent pas : ce ne sont pas des demandes du staff.
 */
export async function checkVerificationEligibility(
  client: Client,
  params: { guildId: string; guildName: string; userId: string; moderatorTag: string },
): Promise<VerificationEligibility> {
  const { getVerificationHistory } = await import('./securityVerificationService.js');
  const history = await getVerificationHistory(params.guildId, params.userId);

  if (history.hasPending) {
    return {
      allowed: false,
      reason: 'PENDING',
      message: 'Une demande de vérification est déjà en cours pour ce membre.',
      cooldownUntil: history.cooldownUntil,
    };
  }
  if (history.cooldownUntil) {
    return {
      allowed: false,
      reason: 'WEEKLY',
      message: `Une vérification a déjà été demandée pour ce membre cette semaine. Réessayez dans ${formatWait(history.cooldownUntil.getTime() - Date.now())}.`,
      cooldownUntil: history.cooldownUntil,
    };
  }

  const { default: prisma } = await import('../../utils/db.js');
  const lastHour = await prisma.securityVerification.count({
    where: { createdAt: { gte: new Date(Date.now() - HOUR_MS) }, appealId: null },
  });
  if (lastHour >= VERIFICATION_GLOBAL_MAX_PER_HOUR) {
    // Une alerte par heure suffit : les refus suivants n'apprennent rien de plus aux admins.
    if (Date.now() - lastGlobalAlertAt > HOUR_MS) {
      lastGlobalAlertAt = Date.now();
      await alertBotAdmins(
        client,
        '🚨 Plafond global de vérifications atteint',
        `${lastHour} vérifications ont été créées en moins d'une heure (plafond : ${VERIFICATION_GLOBAL_MAX_PER_HOUR}). Les demandes manuelles suivantes sont refusées.`,
        [
          { name: 'Dernière tentative', value: `${params.moderatorTag} sur ${params.guildName} (${params.guildId})` },
        ],
      );
    }
    return { allowed: false, reason: 'GLOBAL', message: VERIFICATION_SPAM_MESSAGE, cooldownUntil: null };
  }

  return { allowed: true };
}
