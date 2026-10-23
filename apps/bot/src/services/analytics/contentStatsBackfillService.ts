/**
 * contentStatsBackfillService.ts
 *
 * Reconstruit les stats de contenu à partir des messages déjà journalisés
 * (message_logs), pour ne pas attendre des semaines avant d'avoir des chiffres.
 *
 * Pas de double comptage : la migration qui a créé les tables a posé, pour
 * chaque serveur qui journalise ses messages, un `cutoff` égal à l'instant où
 * elle s'est appliquée, donc avant que le tracker live ne tourne. Le rattrapage
 * ne lit que les messages antérieurs, le live compte tout ce qui suit.
 *
 * Ce que message_logs ne permet pas de retrouver : stickers, sondages,
 * transferts et réactions. Ces compteurs démarrent au déploiement.
 *
 * Reprise : le curseur (id du dernier message traité) est enregistré après
 * chaque lot écrit. Un arrêt brutal entre l'écriture d'un lot et celle du
 * curseur recompterait ce lot ; les lots font 1 000 messages pour borner ce cas.
 */

import type { Guild } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { analyzeMessageContent } from './messageContentAnalyzer.js';
import { dateKeyOf, flushContentStats, recordMessageAnalysis } from './contentStatsService.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const BATCH_SIZE = 1000;
const PAUSE_BETWEEN_BATCHES_MS = 250;
const START_DELAY_MS = 2 * 60_000;
const EXPLICIT_MENTION_RE = /<@[!&]?\d{17,20}>|@everyone|@here/;

export interface ContentStatsBackfillStatus {
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  cutoff: string;
  cursor?: string | null;
  processedMessages?: number;
  totalMessages?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string | null;
}

async function setStatus(guildId: string, status: ContentStatsBackfillStatus): Promise<void> {
  await prisma.guild
    .update({ where: { id: guildId }, data: { contentStatsBackfillStatus: status as never } })
    .catch((err) => logger.warn('ContentStatsBackfill', `Statut non enregistré pour ${guildId} :`, err));
}

export async function getContentStatsBackfillStatus(guildId: string): Promise<ContentStatsBackfillStatus | null> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { contentStatsBackfillStatus: true } });
  return (guild?.contentStatsBackfillStatus as ContentStatsBackfillStatus | null) ?? null;
}

interface LoggedAttachment {
  name?: string | null;
  contentType?: string | null;
}

function readAttachments(raw: unknown): LoggedAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .map((a) => ({
      name: typeof a.name === 'string' ? a.name : null,
      contentType: typeof a.contentType === 'string' ? a.contentType : null,
    }));
}

function resolveChannel(guild: Guild, channelId: string): { channelId: string; inThread: boolean } {
  const channel = guild.channels.cache.get(channelId);
  if (channel?.isThread() && channel.parentId) return { channelId: channel.parentId, inThread: true };
  return { channelId, inThread: false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runGuildBackfill(guild: Guild, initial: ContentStatsBackfillStatus): Promise<void> {
  const guildId = guild.id;
  const cutoff = new Date(initial.cutoff);
  const where = { guildId, isBot: false, createdAt: { lt: cutoff } };

  const totalMessages = initial.totalMessages ?? (await prisma.messageLog.count({ where }));
  let cursor = initial.cursor ?? null;
  let processed = initial.processedMessages ?? 0;
  const startedAt = initial.startedAt ?? new Date().toISOString();

  await setStatus(guildId, { ...initial, status: 'IN_PROGRESS', totalMessages, startedAt });
  logger.info('ContentStatsBackfill', `Rattrapage de ${totalMessages} message(s) pour ${guildId}${cursor ? ' (reprise)' : ''}.`);

  for (;;) {
    const batch = await prisma.messageLog.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: {
        id: true,
        channelId: true,
        authorId: true,
        content: true,
        attachments: true,
        repliedToAuthorId: true,
        editedAt: true,
        createdAt: true,
      },
      // Curseur sur l'id : ordre total stable, insensible aux insertions concurrentes.
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    if (batch.length === 0) break;

    for (const msg of batch) {
      const attachments = readAttachments(msg.attachments);
      const { channelId, inThread } = resolveChannel(guild, msg.channelId);
      const analysis = analyzeMessageContent({
        content: msg.content,
        attachments,
        stickers: [],
        isGuildEmoji: (id) => guild.emojis.cache.has(id),
        isVoiceMessage: attachments.some((a) => a.name === 'voice-message.ogg'),
        isReply: msg.repliedToAuthorId !== null,
        hasMention: EXPLICIT_MENTION_RE.test(msg.content),
        inThread,
      });
      if (msg.editedAt) analysis.counters.styleEdited = 1;
      recordMessageAnalysis(guildId, dateKeyOf(msg.createdAt), channelId, msg.authorId, analysis);
    }

    // Le second appel garantit que ce lot est écrit : le premier peut rejoindre
    // un flush du minuteur parti avant que le lot ne soit dans le tampon.
    await flushContentStats();
    await flushContentStats();

    cursor = batch[batch.length - 1]!.id;
    processed += batch.length;
    await setStatus(guildId, { ...initial, status: 'IN_PROGRESS', cursor, processedMessages: processed, totalMessages, startedAt });

    if (batch.length < BATCH_SIZE) break;
    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  await setStatus(guildId, {
    status: 'COMPLETED',
    cutoff: initial.cutoff,
    cursor,
    processedMessages: processed,
    totalMessages,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  logger.success('ContentStatsBackfill', `Rattrapage terminé pour ${guildId} (${processed} message(s)).`);
}

/** Traite, un serveur après l'autre, tous les rattrapages en attente ou interrompus. */
export async function runPendingContentStatsBackfills(): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: {
      OR: [
        { contentStatsBackfillStatus: { path: ['status'], equals: 'PENDING' } },
        { contentStatsBackfillStatus: { path: ['status'], equals: 'IN_PROGRESS' } },
      ],
    },
    select: { id: true, analyticsEnabled: true, messageLoggingEnabled: true, contentStatsBackfillStatus: true },
  });
  if (guilds.length === 0) return;

  const client = getClient();
  for (const row of guilds) {
    const status = row.contentStatsBackfillStatus as ContentStatsBackfillStatus | null;
    if (!status?.cutoff) continue;

    if (!row.analyticsEnabled || !row.messageLoggingEnabled) {
      await setStatus(row.id, { ...status, status: 'SKIPPED', completedAt: new Date().toISOString() });
      continue;
    }
    // Kotbo n'est pas (ou plus) sur ce serveur : on réessaiera au prochain démarrage.
    const guild = client.guilds.cache.get(row.id);
    if (!guild) continue;

    try {
      await runGuildBackfill(guild, status);
    } catch (err) {
      logger.error('ContentStatsBackfill', `Échec du rattrapage pour ${row.id} :`, err);
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

/** Lance les rattrapages en arrière-plan, une fois le bot connecté et ses caches remplis. */
export function scheduleContentStatsBackfills(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    void runPendingContentStatsBackfills().catch((err) =>
      logger.error('ContentStatsBackfill', 'Rattrapages interrompus :', err),
    );
  }, START_DELAY_MS);
}
