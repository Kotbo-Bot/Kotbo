import {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  type Guild,
} from 'discord.js';
import { logger } from '../../utils/logger.js';

/**
 * Événement planifié Discord miroir d'un giveaway.
 *
 * L'événement démarre à l'heure du tirage : l'onglet « Événements » du serveur
 * affiche donc le concours avec son compte à rebours, et Discord notifie les
 * membres qui s'y sont déclarés intéressés. Il est externe (pas de vocal) et
 * pointe vers le message du concours.
 */

type EventSource = {
  prize: string;
  description: string | null;
  endsAt: Date;
  guildId: string;
  channelId: string;
  messageId: string | null;
};

/** Discord refuse un début dans le passé : marge pour la latence de l'appel. */
const START_MARGIN_MS = 60_000;
const EVENT_DURATION_MS = 60 * 60_000;

export const giveawayEventName = (prize: string) => prize.trim().slice(0, 100);

/** Rend l'identifiant de l'événement, ou `null` : le giveaway reste valable sans lui. */
export async function createGiveawayEvent(
  guild: Guild,
  giveaway: EventSource,
  channelName: string,
): Promise<string | null> {
  try {
    const start = new Date(Math.max(giveaway.endsAt.getTime(), Date.now() + START_MARGIN_MS));
    const link = giveaway.messageId
      ? `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`
      : `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}`;
    const description = [giveaway.description?.trim(), link].filter(Boolean).join('\n\n').slice(0, 1000);

    const event = await guild.scheduledEvents.create({
      name: giveawayEventName(giveaway.prize),
      description,
      scheduledStartTime: start,
      scheduledEndTime: new Date(start.getTime() + EVENT_DURATION_MS),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: `#${channelName}`.slice(0, 100) },
    });
    return event.id;
  } catch (err) {
    // Le plus souvent : le bot n'a pas « Gérer les événements ».
    logger.warn('GiveawayEvent', `Événement planifié non créé : ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Supprime l'événement miroir. Un événement déjà disparu n'est pas une erreur. */
export async function deleteGiveawayEvent(guild: Guild, eventId: string | null | undefined): Promise<void> {
  if (!eventId) return;
  try {
    const event = await guild.scheduledEvents.fetch(eventId).catch(() => null);
    await event?.delete();
  } catch (err) {
    logger.warn('GiveawayEvent', `Événement planifié non supprimé : ${err instanceof Error ? err.message : err}`);
  }
}
