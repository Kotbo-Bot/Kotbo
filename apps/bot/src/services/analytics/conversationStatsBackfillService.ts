/**
 * conversationStatsBackfillService.ts
 *
 * Reconstruit les stats de conversation (temps de réponse par salon,
 * réponses et mentions entre membres) à partir des messages déjà journalisés
 * (message_logs : `repliedToAuthorId`, `mentionedUserIds`).
 *
 * Même contrat que le rattrapage des stats de contenu : la migration a posé un
 * `cutoff` pour chaque serveur qui journalise ses messages ; le rattrapage ne
 * lit que les messages antérieurs, le suivi en direct compte tout ce qui suit.
 *
 * Les tours de parole se rejouent dans l'ordre chronologique : le curseur est
 * donc (createdAt, id), pas l'id seul. Un redémarrage au milieu perd les tours
 * en attente à cet instant, ce qui décale au plus un tour par salon. Les tours
 * encore ouverts au `cutoff` ne sont pas comptés : leur réponse a pu arriver
 * après, côté suivi en direct.
 */

import type { Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { flushConversationStats, queueInteraction, queueTurnEvents, ResponseTracker } from './conversationStatsService.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const BATCH_SIZE = 1000;
const PAUSE_BETWEEN_BATCHES_MS = 250;
const START_DELAY_MS = 3 * 60_000;

export interface ConversationBackfillStatus {
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  cutoff: string;
  cursorAt?: string | null;
  cursorId?: string | null;
  processedMessages?: number;
  totalMessages?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string | null;
}

async function setStatus(guildId: string, status: ConversationBackfillStatus): Promise<void> {
  await prisma.guild
    .update({ where: { id: guildId }, data: { conversationStatsBackfillStatus: status as never } })
    .catch((err) => logger.warn('ConversationBackfill', `Statut non enregistré pour ${guildId} :`, err));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function statsChannelOf(guild: Guild, channelId: string): string {
  const channel = guild.channels.cache.get(channelId);
  return channel?.isThread() && channel.parentId ? channel.parentId : channelId;
}

async function runGuildBackfill(guild: Guild, initial: ConversationBackfillStatus): Promise<void> {
  const guildId = guild.id;
  const cutoff = new Date(initial.cutoff);
  const where = { guildId, isBot: false, createdAt: { lt: cutoff } };
  const totalMessages = initial.totalMessages ?? (await prisma.messageLog.count({ where }));
  let cursorAt = initial.cursorAt ? new Date(initial.cursorAt) : null;
  let cursorId = initial.cursorId ?? null;
  let processed = initial.processedMessages ?? 0;
  const startedAt = initial.startedAt ?? new Date().toISOString();
  const tracker = new ResponseTracker();

  await setStatus(guildId, { ...initial, status: 'IN_PROGRESS', totalMessages, startedAt });
  logger.info('ConversationBackfill', `Rattrapage de ${totalMessages} message(s) pour ${guildId}${cursorAt ? ' (reprise)' : ''}.`);

  for (;;) {
    const after = cursorAt && cursorId
      ? { OR: [{ createdAt: { gt: cursorAt } }, { createdAt: cursorAt, id: { gt: cursorId } }] }
      : {};
    const batch = await prisma.messageLog.findMany({
      where: { ...where, ...after },
      select: { id: true, channelId: true, authorId: true, createdAt: true, repliedToAuthorId: true, mentionedUserIds: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
    });
    if (batch.length === 0) break;

    for (const msg of batch) {
      queueTurnEvents(tracker.onMessage(guildId, msg.channelId, statsChannelOf(guild, msg.channelId), msg.authorId, msg.createdAt.getTime()));
      const dateKey = msg.createdAt.toISOString().slice(0, 10);
      const repliedTo = msg.repliedToAuthorId;
      if (repliedTo) queueInteraction(guildId, dateKey, msg.authorId, repliedTo, { replies: 1 });
      for (const userId of msg.mentionedUserIds) {
        if (userId !== repliedTo) queueInteraction(guildId, dateKey, msg.authorId, userId, { mentions: 1 });
      }
    }
    // Les tours vieux de plus de 6 h au fil de l'historique sont clos au passage.
    queueTurnEvents(tracker.sweep(batch[batch.length - 1]!.createdAt.getTime()));

    // Le second appel garantit que ce lot est écrit (cf. rattrapage du contenu).
    await flushConversationStats();
    await flushConversationStats();

    const last = batch[batch.length - 1]!;
    cursorAt = last.createdAt;
    cursorId = last.id;
    processed += batch.length;
    await setStatus(guildId, { ...initial, status: 'IN_PROGRESS', cursorAt: cursorAt.toISOString(), cursorId, processedMessages: processed, totalMessages, startedAt });

    if (batch.length < BATCH_SIZE) break;
    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  await setStatus(guildId, {
    status: 'COMPLETED',
    cutoff: initial.cutoff,
    cursorAt: cursorAt?.toISOString() ?? null,
    cursorId,
    processedMessages: processed,
    totalMessages,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  logger.success('ConversationBackfill', `Rattrapage terminé pour ${guildId} (${processed} message(s)).`);
}

export async function runPendingConversationBackfills(): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: {
      OR: [
        { conversationStatsBackfillStatus: { path: ['status'], equals: 'PENDING' } },
        { conversationStatsBackfillStatus: { path: ['status'], equals: 'IN_PROGRESS' } },
      ],
    },
    select: { id: true, analyticsEnabled: true, messageLoggingEnabled: true, conversationStatsBackfillStatus: true },
  });
  if (guilds.length === 0) return;

  const client = getClient();
  for (const row of guilds) {
    const status = row.conversationStatsBackfillStatus as ConversationBackfillStatus | null;
    if (!status?.cutoff) continue;
    if (!row.analyticsEnabled || !row.messageLoggingEnabled) {
      await setStatus(row.id, { ...status, status: 'SKIPPED', completedAt: new Date().toISOString() });
      continue;
    }
    const guild = client.guilds.cache.get(row.id);
    if (!guild) continue;
    try {
      await runGuildBackfill(guild, status);
    } catch (err) {
      logger.error('ConversationBackfill', `Échec du rattrapage pour ${row.id} :`, err);
      await setStatus(row.id, {
        ...status,
        status: 'FAILED',
        error: publicErrorMessage(err).slice(0, 500),
        completedAt: new Date().toISOString(),
      });
    }
  }
}

let scheduled = false;

export function scheduleConversationBackfills(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    void runPendingConversationBackfills().catch((err) => logger.error('ConversationBackfill', 'Rattrapages interrompus :', err));
  }, START_DELAY_MS);
}
