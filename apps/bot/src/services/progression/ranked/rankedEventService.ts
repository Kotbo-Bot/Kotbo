/**
 * Événements serveur multipliant les gains de RP sur une fenêtre de temps
 * (Message Rush, Reaction Storm, Vocal Time).
 *
 * L'événement actif est lu à chaque gain de RP, donc à chaque message : il est
 * mis en cache par guilde avec un TTL court. Un TTL plutôt qu'une invalidation
 * seule, parce qu'un événement s'éteint tout seul à `endsAt` sans qu'aucune
 * écriture ne vienne prévenir le cache.
 */

import type { Client } from 'discord.js';
import type { RankedEvent } from '@prisma/client';
import {
  eventAppliesToSource,
  RANKED_EVENT_TYPES,
  type RankedEventType,
  type RpSource,
} from '@kotbo/shared';
import prisma, { prismaRead } from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import { logger } from '../../../utils/logger.js';
import { cache } from '../../../utils/cache.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';

const LOG_TAG = 'RankedEvents';
const ACTIVE_TTL_SECONDS = 20;

function activeCacheKey(guildId: string): string {
  return `guild:${guildId}:ranked_active_event`;
}

export function isRankedEventType(value: unknown): value is RankedEventType {
  return typeof value === 'string' && (RANKED_EVENT_TYPES as readonly string[]).includes(value);
}

export async function invalidateActiveEventCache(guildId: string): Promise<void> {
  await cache.delete(activeCacheKey(guildId));
}

/**
 * Événement en cours, ou `null`. Le cache stocke aussi l'absence d'événement
 * (via un marqueur) : sans ça, la très grande majorité des messages - ceux des
 * serveurs sans événement - feraient chacun une requête inutile.
 */
async function getRunningEvent(guildId: string): Promise<RankedEvent | null> {
  const cached = await cache.get<RankedEvent | 'none'>(activeCacheKey(guildId));
  if (cached === 'none') return null;
  if (cached) {
    // Le cache peut avoir survécu à la fin de la fenêtre : on revérifie les
    // bornes plutôt que de multiplier le RP après l'heure.
    const now = Date.now();
    if (new Date(cached.startsAt).getTime() <= now && new Date(cached.endsAt).getTime() > now) return cached;
    await invalidateActiveEventCache(guildId);
  }

  const now = new Date();
  const event = await prismaRead.rankedEvent.findFirst({
    where: {
      guildId,
      status: { in: ['SCHEDULED', 'RUNNING'] },
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    orderBy: { multiplier: 'desc' },
  });

  await cache.set(activeCacheKey(guildId), event ?? 'none', ACTIVE_TTL_SECONDS);
  return event;
}

export type ActiveEventMultiplier = { multiplier: number; eventId: string | null; type: RankedEventType | null };

/**
 * Multiplicateur applicable à une source de RP donnée.
 *
 * Un « Message Rush » ne doit pas doubler le RP vocal : l'événement annoncé
 * comme une course au message récompenserait alors surtout ceux qui restent
 * connectés sans rien faire.
 */
export async function getActiveEventMultiplier(guildId: string, source: RpSource): Promise<ActiveEventMultiplier> {
  const event = await getRunningEvent(guildId).catch(() => null);
  if (!event || !isRankedEventType(event.type)) return { multiplier: 1, eventId: null, type: null };
  if (!eventAppliesToSource(event.type, source)) return { multiplier: 1, eventId: null, type: null };

  const multiplier = Number.isFinite(event.multiplier) ? Math.max(1, event.multiplier) : 1;
  return { multiplier, eventId: event.id, type: event.type };
}

/**
 * Ajoute au bilan de l'événement le RP dû au multiplicateur.
 *
 * `participants` n'est incrémenté qu'au premier crédit d'un membre, repéré par
 * un marqueur en cache : compter à chaque message donnerait un nombre de
 * participants égal au nombre de messages.
 */
export async function creditEventBonus(eventId: string, bonusRp: number, userId: string): Promise<void> {
  if (bonusRp <= 0) return;

  const seenKey = `ranked_event:${eventId}:participant:${userId}`;
  const alreadySeen = await cache.get<boolean>(seenKey);
  if (!alreadySeen) await cache.set(seenKey, true, 6 * 3600);

  await prisma.rankedEvent.update({
    where: { id: eventId },
    data: {
      bonusRpGranted: { increment: bonusRp },
      participants: alreadySeen ? undefined : { increment: 1 },
    },
  }).catch(() => null);
}

export async function listRankedEvents(guildId: string, limit = 25) {
  return prismaRead.rankedEvent.findMany({
    where: { guildId },
    orderBy: { startsAt: 'desc' },
    take: limit,
  });
}

export type CreateRankedEventInput = {
  type: RankedEventType;
  name: string;
  multiplier: number;
  startsAt: Date;
  endsAt: Date;
  announceChannelId?: string | null;
  createdBy?: string | null;
};

export async function createRankedEvent(guildId: string, input: CreateRankedEventInput): Promise<RankedEvent> {
  const startsAt = input.startsAt;
  const endsAt = input.endsAt;
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) throw new Error('startsAt invalide');
  if (!(endsAt instanceof Date) || Number.isNaN(endsAt.getTime())) throw new Error('endsAt invalide');
  if (endsAt <= startsAt) throw new Error('La fin doit suivre le début');

  await upsertRetryingRace(() => prisma.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } }));

  const event = await prisma.rankedEvent.create({
    data: {
      guildId,
      type: input.type,
      name: input.name.trim().slice(0, 80) || input.type,
      // Un multiplicateur sous 1 transformerait un « événement » en malus
      // silencieux ; le plafond, lui, borne l'inflation de RP.
      multiplier: Math.min(10, Math.max(1, Number(input.multiplier) || 1)),
      startsAt,
      endsAt,
      status: startsAt <= new Date() ? 'RUNNING' : 'SCHEDULED',
      announceChannelId: input.announceChannelId ?? null,
      createdBy: input.createdBy ?? null,
    },
  });

  await invalidateActiveEventCache(guildId);
  return event;
}

export async function cancelRankedEvent(guildId: string, eventId: string): Promise<boolean> {
  const cancelled = await prisma.rankedEvent.updateMany({
    where: { id: eventId, guildId, status: { in: ['SCHEDULED', 'RUNNING'] } },
    data: { status: 'CANCELLED' },
  });
  if (cancelled.count > 0) await invalidateActiveEventCache(guildId);
  return cancelled.count > 0;
}

function eventTypeLabel(type: string, locale: 'fr' | 'en'): string {
  switch (type) {
    case 'MESSAGE_RUSH': return m.ranked_event_type_message_rush({}, { locale });
    case 'REACTION_STORM': return m.ranked_event_type_reaction_storm({}, { locale });
    case 'VOCAL_TIME': return m.ranked_event_type_vocal_time({}, { locale });
    default: return m.ranked_event_type_custom({}, { locale });
  }
}

async function announceEvent(client: Client, event: RankedEvent, phase: 'start' | 'end'): Promise<string | null> {
  if (!event.announceChannelId) return null;

  const guild = client.guilds.cache.get(event.guildId) || await client.guilds.fetch(event.guildId).catch(() => null);
  if (!guild) return null;
  const channel = guild.channels.cache.get(event.announceChannelId);
  if (!channel?.isTextBased()) return null;

  const locale = await resolveGuildLocale(event.guildId, guild.preferredLocale);
  const content = phase === 'start'
    ? m.ranked_event_started({
        name: event.name,
        type: eventTypeLabel(event.type, locale),
        multiplier: event.multiplier.toFixed(1),
        timestamp: `<t:${Math.floor(event.endsAt.getTime() / 1000)}:R>`,
      }, { locale })
    : m.ranked_event_ended({
        name: event.name,
        participants: event.participants,
        bonus: event.bonusRpGranted,
      }, { locale });

  const message = await channel.send({ content }).catch(() => null);
  return message?.id ?? null;
}

/**
 * Fait passer les événements d'un état à l'autre. Appelée par le cron minute :
 * le multiplicateur, lui, ne dépend que des dates, donc un cron en retard ne
 * fausse jamais les gains - il ne retarde que l'annonce.
 */
export async function progressRankedEvents(client: Client): Promise<void> {
  const now = new Date();

  const toStart = await prismaRead.rankedEvent.findMany({
    where: { status: 'SCHEDULED', startsAt: { lte: now }, endsAt: { gt: now } },
    take: 100,
  });

  for (const event of toStart) {
    const announceMessageId = await announceEvent(client, event, 'start').catch(() => null);
    await prisma.rankedEvent.update({
      where: { id: event.id },
      data: { status: 'RUNNING', announceMessageId: announceMessageId ?? event.announceMessageId },
    }).catch(() => null);
    await invalidateActiveEventCache(event.guildId);
    logger.info(LOG_TAG, `Événement "${event.name}" démarré sur ${event.guildId}`);
  }

  const toEnd = await prismaRead.rankedEvent.findMany({
    where: { status: { in: ['SCHEDULED', 'RUNNING'] }, endsAt: { lte: now } },
    take: 100,
  });

  for (const event of toEnd) {
    await prisma.rankedEvent.update({ where: { id: event.id }, data: { status: 'ENDED' } }).catch(() => null);
    await invalidateActiveEventCache(event.guildId);
    await announceEvent(client, event, 'end').catch(() => null);
    logger.info(LOG_TAG, `Événement "${event.name}" terminé sur ${event.guildId} (${event.participants} participants)`);
  }
}
