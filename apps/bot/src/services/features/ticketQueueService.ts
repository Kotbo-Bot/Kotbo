/**
 * Reprise des tickets en file d'attente.
 *
 * Un ticket part en file quand une limite Discord bloque sa creation (voir
 * `ticketCapacity.ts`). Il est retente des qu'une place peut s'etre liberee :
 * salon supprime, fil archive ou supprime. Un balayage periodique rattrape les
 * places liberees pendant un redemarrage ou sans evenement visible.
 *
 * L'ordre d'arrivee est respecte : les tickets sont repris par `queuedAt`
 * croissant, et un ticket qui echoue encore garde sa place.
 */
import { DiscordAPIError, type Client, type Guild } from 'discord.js';
import type { Ticket } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { type BotLocale, resolveGuildLocale } from '../../utils/i18n.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { createTicketWorkspace, resolveTicketPanelType, type TicketPanelTypeConfig } from './ticketService.js';

/** Tickets retentes par passage : borne les appels Discord quand la file est longue. */
const DRAIN_BATCH = 25;
/**
 * Delai entre l'evenement et la reprise. Regroupe les suppressions en rafale
 * (nettoyage de plusieurs tickets fermes) en un seul passage.
 */
const DRAIN_DEBOUNCE_MS = 3_000;
/** Duree pendant laquelle la liste des serveurs ayant une file est reutilisee. */
const QUEUED_GUILDS_TTL_MS = 30_000;
/** Membre introuvable : il a quitte le serveur. */
const DISCORD_UNKNOWN_MEMBER = 10007;

const draining = new Set<string>();
const scheduledDrains = new Map<string, ReturnType<typeof setTimeout>>();

type QueueEntry = { guildId: string; queueScope: string | null };
let queueEntriesCache: { at: number; entries: QueueEntry[] } | null = null;

/**
 * Serveurs ayant une file, avec la limite qui bloque chacun. Les evenements de
 * salon et de fil arrivent en continu : un cache court evite une requete par
 * evenement, le balayage periodique rattrape ce qu'il aurait manque.
 */
async function loadQueueEntries(): Promise<QueueEntry[]> {
  if (queueEntriesCache && Date.now() - queueEntriesCache.at < QUEUED_GUILDS_TTL_MS) {
    return queueEntriesCache.entries;
  }
  const entries = await prisma.ticket.findMany({
    where: { status: 'QUEUED' },
    select: { guildId: true, queueScope: true },
    distinct: ['guildId', 'queueScope'],
  });
  queueEntriesCache = { at: Date.now(), entries };
  return entries;
}

/**
 * Une place s'est peut-etre liberee sur `guildId` : relance la file des
 * serveurs concernes. Le serveur lui-meme, mais aussi ceux dont les tickets
 * vivent sur ce serveur staff lie, ou dans une de ses categories.
 */
export async function onTicketCapacityFreed(client: Client, guildId: string): Promise<void> {
  const entries = await loadQueueEntries();
  if (entries.length === 0) return;

  const targets = new Set<string>();
  for (const entry of entries) {
    if (entry.guildId === guildId || scopeTouchesGuild(client, entry.queueScope, guildId)) {
      targets.add(entry.guildId);
    }
  }
  for (const target of targets) scheduleTicketQueueDrain(client, target);
}

function scopeTouchesGuild(client: Client, scope: string | null, guildId: string): boolean {
  if (!scope) return false;
  const [limit, id] = scope.split(':');
  if (limit === 'CATEGORY_CHANNELS') {
    const category = client.channels.cache.get(id);
    return !!category && 'guildId' in category && category.guildId === guildId;
  }
  return id === guildId;
}

export function scheduleTicketQueueDrain(client: Client, guildId: string): void {
  if (scheduledDrains.has(guildId)) return;
  const timer = setTimeout(() => {
    scheduledDrains.delete(guildId);
    drainTicketQueue(client, guildId).catch((err) => {
      logger.error('TicketQueue', `Reprise de la file impossible sur ${guildId} :`, err);
    });
  }, DRAIN_DEBOUNCE_MS);
  timer.unref?.();
  scheduledDrains.set(guildId, timer);
}

/**
 * Balayage de secours : reprend la file de chaque serveur de ce shard. Les
 * serveurs d'un autre shard sont ignores, leur shard s'en charge.
 */
export async function drainAllTicketQueues(client: Client): Promise<void> {
  queueEntriesCache = null;
  const entries = await loadQueueEntries();
  const guildIds = new Set(entries.map((entry) => entry.guildId));
  for (const guildId of guildIds) {
    if (!client.guilds.cache.has(guildId)) continue;
    await drainTicketQueue(client, guildId).catch((err) => {
      logger.error('TicketQueue', `Reprise de la file impossible sur ${guildId} :`, err);
    });
  }
}

export async function drainTicketQueue(client: Client, guildId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild || draining.has(guildId)) return;
  draining.add(guildId);

  try {
    const queued = await prisma.ticket.findMany({
      where: { guildId, status: 'QUEUED' },
      orderBy: { queuedAt: 'asc' },
      take: DRAIN_BATCH,
    });
    if (queued.length === 0) return;

    const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
    if (!guildConfig) return;
    const locale = await resolveGuildLocale(guildId, guild.preferredLocale);

    // Limites constatees pendant ce passage : les tickets qui attendent la
    // meme place ne sont pas retentes, ils echoueraient pareil.
    const blocked = new Set<string>();
    let changed = false;

    for (const ticket of queued) {
      if (ticket.queueScope && blocked.has(ticket.queueScope)) continue;
      const outcome = await retryQueuedTicket(client, guild, guildConfig, locale, ticket);
      if (outcome.blockedScope) blocked.add(outcome.blockedScope);
      if (outcome.changed) changed = true;
    }

    if (changed) {
      queueEntriesCache = null;
      broadcastDashboardStateChange(guildId, 'tickets_updated');
    }
  } finally {
    draining.delete(guildId);
  }
}

/**
 * Le type d'origine du ticket, avec le mode retenu a l'ouverture : la
 * configuration a pu changer pendant l'attente, le membre a demande ce mode-la.
 * Un MP direct (`/ticket open` en MP) n'a pas de type : son libelle et son
 * relais vers le serveur staff sont relus sur la ligne.
 */
function queuedTicketType(guildConfig: Record<string, unknown>, ticket: Ticket): TicketPanelTypeConfig {
  const mode = ticket.mode === 'DM' || ticket.mode === 'THREAD' ? ticket.mode : 'CHANNEL';
  const configured = resolveTicketPanelType(guildConfig, ticket.ticketTypeId);
  if (ticket.ticketTypeId || mode !== 'DM') return { ...configured, mode };
  return {
    id: '',
    label: ticket.ticketTypeLabel ?? 'MP Direct',
    mode,
    staffServerRelay: ticket.staffServerGuildId !== null,
  };
}

async function retryQueuedTicket(
  client: Client,
  guild: Guild,
  guildConfig: NonNullable<Awaited<ReturnType<typeof prisma.guild.findUnique>>>,
  locale: BotLocale,
  ticket: Ticket,
): Promise<{ blockedScope?: string; changed?: boolean }> {
  const member = await guild.members.fetch(ticket.userId).catch((err: unknown) =>
    err instanceof DiscordAPIError && err.code === DISCORD_UNKNOWN_MEMBER ? 'gone' as const : null);

  // Parti pendant l'attente : creer son salon n'aurait plus personne a servir.
  if (member === 'gone') {
    await prisma.ticket.updateMany({
      where: { id: ticket.id, status: 'QUEUED' },
      data: { status: 'REJECTED', rejectionReason: "Membre parti avant qu'une place se libère.", queueScope: null },
    });
    return { changed: true };
  }
  // Echec passager de Discord : on retentera au prochain passage.
  if (!member) return {};

  try {
    const result = await createTicketWorkspace(client, {
      guild,
      user: { id: ticket.userId, username: member.user.username },
      ticketType: queuedTicketType(guildConfig as unknown as Record<string, unknown>, ticket),
      guildConfig,
      reason: ticket.reason,
      description: ticket.description,
      locale,
      existingTicketId: ticket.id,
    });

    if (result.queued) return { blockedScope: result.queueScope };

    logger.info('TicketQueue', `Ticket ${ticket.id} sorti de la file d'attente sur ${guild.id}.`);

    // Le mode MP previent deja le membre dans sa conversation.
    if (ticket.mode !== 'DM') {
      const { notify } = await import('../notifications/notifyService.js');
      await notify({
        guildId: guild.id,
        userId: ticket.userId,
        kind: 'tickets.update',
        title: 'Ton ticket est ouvert',
        message: `Une place s'est libérée sur **${guild.name}**.\n\n${result.userMessage}`,
        severity: 'SUCCESS',
      }).catch(() => null);
    }
    return { changed: true };
  } catch (err) {
    logger.error('TicketQueue', `Reprise du ticket ${ticket.id} impossible :`, err);
    // Le mode fil enregistre le ticket OPEN avant de creer le fil : sans fil,
    // il retourne en file plutot que de rester ouvert sans espace.
    await prisma.ticket.updateMany({
      where: { id: ticket.id, status: 'OPEN', channelId: null, threadId: null },
      data: { status: 'QUEUED' },
    }).catch(() => null);
    return {};
  }
}
