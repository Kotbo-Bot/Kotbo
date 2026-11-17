import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';

/** Au-delà de MAX demandes par modérateur dans la fenêtre, on refuse et on alerte. */
export const VERIFICATION_SPAM_WINDOW_MS = 10 * 60 * 1000;
export const VERIFICATION_SPAM_MAX = 5;

export const VERIFICATION_SPAM_MESSAGE = '🚫 Vous avez un peu abusé, veuillez réessayer plus tard.';

// shortcut: compteur en mémoire, perdu au redémarrage et non partagé entre processus ; passer à Redis si le bot est shardé.
const attempts = new Map<string, number[]>();

/** Enregistre une tentative et renvoie le nombre de tentatives dans la fenêtre (celle-ci incluse). */
export function registerVerificationAttempt(guildId: string, moderatorId: string, now = Date.now()): number {
  const key = `${guildId}:${moderatorId}`;
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < VERIFICATION_SPAM_WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length;
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
    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('🚨 Spam de demandes de vérification')
      .setDescription(
        `<@${params.moderatorId}> (${params.moderatorTag}) a dépassé ${VERIFICATION_SPAM_MAX} demandes en ${VERIFICATION_SPAM_WINDOW_MS / 60000} min.\n`
        + 'Les demandes suivantes sont refusées jusqu\'à la fin de la fenêtre.',
      )
      .addFields(
        { name: 'Serveur', value: `${params.guildName} (${params.guildId})`, inline: false },
        { name: 'Modérateur', value: params.moderatorId, inline: false },
      )
      .setTimestamp();
    const { notifyBotAdmins } = await import('../analytics/acquisitionAlertsService.js');
    await notifyBotAdmins(client, embed).catch((err) => {
      logger.warn('VerificationSpam', 'Alerte aux admins du bot non délivrée:', err);
    });
  }
  return true;
}
