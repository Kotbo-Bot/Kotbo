/**
 * Fin de droit du bot perso : quand un serveur repasse sous l'offre Plus, son
 * bot est coupé et Kotbo reprend la main.
 *
 * On ne supprime rien. Le token, le profil et le domaine restent en base : le
 * serveur qui se réabonne n'a qu'à rallumer son bot. Seul l'état « actif » est
 * retiré (instance désactivée, `Guild.instanceId` remis à zéro).
 *
 * Si la bascule avait été faite, Kotbo n'est plus sur le serveur : le bot perso,
 * encore en place, y laisse un message avec un lien d'invitation visant ce
 * serveur seul. La ligne `Guild` étant intacte, le retour de Kotbo ne repasse ni
 * par l'activation libre-service ni par l'onboarding.
 */
import { comparePlans, normalizePlanKey } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { fetchExternal } from '../../utils/http.js';
import { openSecret } from '../../utils/secretBox.js';
import { getClient } from '../../utils/client.js';
import { refreshGuildOwnership } from '../../utils/guildOwnership.js';
import { refreshCustomDomains } from './customDomain.js';
import { findCustomInstance } from './customBotInstance.js';

const DISCORD_API = 'https://discord.com/api/v10';

/** Invitation de Kotbo qui ne propose que ce serveur (voir `/api/public/invite`). */
export function kotboReinviteUrl(apiUrl: string, guildId: string): string {
  return `${apiUrl.replace(/\/$/, '')}/api/public/invite?direct=1&guild_id=${guildId}`;
}

export function retireNoticeText(inviteUrl: string): string {
  return (
    "**L'abonnement de ce serveur est terminé : ce bot personnalisé est désormais arrêté.**\n" +
    `Pour retrouver Kotbo **avec toute votre configuration** (rien à refaire, pas d'onboarding), réinvitez-le ici : ${inviteUrl}\n` +
    'Vos réglages de bot personnalisé sont conservés : un nouvel abonnement Plus permettra de le rallumer.'
  );
}

async function discord<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
  const response = await fetchExternal(`${DISCORD_API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

/** Salon système du serveur, sinon MP au propriétaire. Renvoie false si rien n'est parti. */
async function sayAsCustomBot(token: string, guildId: string, content: string): Promise<boolean> {
  const guild = await discord<{ system_channel_id: string | null; owner_id: string }>(token, 'GET', `/guilds/${guildId}`);
  if (!guild) return false;

  if (guild.system_channel_id && (await discord(token, 'POST', `/channels/${guild.system_channel_id}/messages`, { content }))) return true;

  const dm = await discord<{ id: string }>(token, 'POST', '/users/@me/channels', { recipient_id: guild.owner_id });
  return dm ? (await discord(token, 'POST', `/channels/${dm.id}/messages`, { content })) !== null : false;
}

/**
 * À appeler après tout changement d'offre. Sans effet si le serveur a encore
 * droit au bot perso, ou s'il n'y a rien à couper : on peut donc l'appeler sans
 * condition, et les rejeux de webhook n'envoient pas le message deux fois.
 */
export async function retireCustomBotIfIneligible(guildId: string): Promise<void> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { plan: true, instanceId: true } });
  if (!guild || comparePlans(normalizePlanKey(guild.plan), 'PLUS') >= 0) return;

  const [instance, config] = await Promise.all([
    findCustomInstance(guildId),
    prisma.customBotConfig.findUnique({ where: { guildId } }),
  ]);
  const switched = Boolean(instance && guild.instanceId === instance.id);
  if (!switched && !instance?.enabled && !config?.enabled && !config?.isRunning) return;

  if (switched && config?.botToken) {
    try {
      const token = openSecret(config.botToken);
      const { getApiUrl } = await import('../../api/shared/core.js');
      const sent = token && (await sayAsCustomBot(token, guildId, retireNoticeText(kotboReinviteUrl(getApiUrl(), guildId))));
      if (!sent) logger.warn('CustomBot', `[${guildId}] Message de fin de droit non envoyé : le propriétaire devra réinviter Kotbo lui-même.`);
    } catch (err) {
      logger.warn('CustomBot', `[${guildId}] Message de fin de droit non envoyé :`, err);
    }
  }

  await prisma.guild.updateMany({ where: { id: guildId }, data: { instanceId: null } });
  if (instance) await prisma.whiteLabelInstance.update({ where: { id: instance.id }, data: { enabled: false } });
  await prisma.customBotConfig.updateMany({ where: { guildId }, data: { enabled: false, isRunning: false } });

  // shortcut: sans gestionnaire de shards (processus isolé), l'arrêt à chaud est
  // impossible ; l'instance désactivée ne repartira pas au prochain démarrage du launcher.
  if (instance) {
    const shard = getClient().shard;
    if (shard) void shard.send({ type: 'custom-instance-stop', instanceId: instance.id }).catch((err: unknown) => logger.warn('CustomBot', 'Arrêt non transmis au launcher :', err));
  }
  await Promise.all([refreshGuildOwnership(), refreshCustomDomains()]);

  logger.info('CustomBot', `[${guildId}] Bot perso coupé : le serveur n'a plus l'offre Plus.`);
}
