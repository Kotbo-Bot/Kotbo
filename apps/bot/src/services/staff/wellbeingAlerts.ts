/**
 * Alertes de la cellule bien-être : un salon et des membres choisis par le
 * propriétaire sont prévenus des accès aux dossiers et des changements.
 *
 * L'envoi ne bloque jamais la requête et n'échoue jamais pour elle : une
 * alerte perdue est journalisée, le geste reste tracé dans l'audit.
 */
import type { Client } from 'discord.js';
import { logger } from '../../utils/logger.js';
import {
  DEFAULT_ALERT_EVENTS,
  READ_ALERT_COOLDOWN_MS,
  alertText,
  cleanAlertEvents,
  shouldSendReadAlert,
  type AlertContext,
  type WellbeingAccessLists,
  type WellbeingAlertEvent,
} from './wellbeingPolicy.js';

const READ_EVENTS: ReadonlySet<WellbeingAlertEvent> = new Set(['TEAM_READ', 'EMERGENCY_READ']);
const lastReadAlert = new Map<string, number>();

/** Consultation déjà signalée récemment par cette personne : on n'en renvoie pas. */
function throttled(key: string, now: number): boolean {
  if (!shouldSendReadAlert(lastReadAlert.get(key), now)) return true;
  lastReadAlert.set(key, now);
  if (lastReadAlert.size > 1_000) {
    for (const [k, at] of lastReadAlert) if (now - at >= READ_ALERT_COOLDOWN_MS) lastReadAlert.delete(k);
  }
  return false;
}

async function sendToChannel(client: Client, guildId: string, channelId: string, content: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  // Un salon d'un autre serveur ne reçoit rien, même si l'id a été forcé en base.
  if (!channel || !('guildId' in channel) || channel.guildId !== guildId || !channel.isSendable()) {
    throw new Error(`salon ${channelId} indisponible`);
  }
  await channel.send({ content, allowedMentions: { parse: [] } });
}

export async function sendWellbeingAlert(
  client: Client,
  guildId: string,
  config: WellbeingAccessLists | null,
  event: WellbeingAlertEvent,
  ctx: AlertContext,
  /** Prévenus en message privé même si l'événement n'est pas coché (le référent d'un dossier). */
  directUserIds: readonly string[] = [],
): Promise<void> {
  try {
    if (!config) return;
    const subscribed = cleanAlertEvents(config.alertEvents ?? DEFAULT_ALERT_EVENTS).includes(event);
    // L'auteur du geste n'a pas à se prévenir lui-même.
    const recipients = [...new Set([...(subscribed ? config.alertUserIds ?? [] : []), ...directUserIds])]
      .filter((id) => id && id !== ctx.actorId);
    const channelId = subscribed ? config.alertChannelId : null;
    if (!channelId && recipients.length === 0) return;
    if (READ_EVENTS.has(event) && throttled(`${guildId}:${ctx.actorId}:${event}`, Date.now())) return;

    const content = alertText(event, ctx);
    const results = await Promise.allSettled([
      ...(channelId ? [sendToChannel(client, guildId, channelId, content)] : []),
      ...recipients.map(async (id) => {
        const user = await client.users.fetch(id);
        await user.send({ content, allowedMentions: { parse: [] } });
      }),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') logger.warn('Wellbeing', `Alerte ${event} non remise :`, result.reason);
    }
  } catch (error) {
    logger.error('Wellbeing', `Alerte ${event} en échec :`, error);
  }
}
