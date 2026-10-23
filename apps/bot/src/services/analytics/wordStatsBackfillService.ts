import type { Prisma } from '@prisma/client';
/**
 * wordStatsBackfillService.ts
 *
 * Reconstruit les stats de mots à partir des messages DÉJÀ journalisés
 * (message_logs), au lieu d'attendre que le tracker live accumule des données.
 *
 * Évite le double comptage : le backfill ne traite que les messages antérieurs
 * à son instant de départ (`cutoff`), le tracker live ne traite que ceux qui
 * arrivent après l'activation. Les deux ensembles sont disjoints, et comme les
 * compteurs sont incrémentaux, ils peuvent viser le même jour sans conflit.
 *
 * Sur `force`, les stats existantes du serveur sont d'abord effacées pour
 * repartir d'une base propre plutôt que de s'additionner à elles-mêmes.
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { tokenize } from './wordStatsService.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const BATCH_SIZE = 2000;
/** Nombre de messages traités avant d'écrire les compteurs accumulés. */
const FLUSH_EVERY = 20_000;

export interface WordStatsBackfillStatus {
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  error?: string | null;
  processedMessages?: number;
  totalMessages?: number;
  indexedWords?: number;
  startedAt?: string;
  completedAt?: string;
}

async function setStatus(guildId: string, status: WordStatsBackfillStatus): Promise<void> {
  await prisma.guild
    .update({ where: { id: guildId }, data: { wordStatsBackfillStatus: status as unknown as Prisma.InputJsonValue } })
    .catch((err) => logger.warn('WordStatsBackfill', `Statut non enregistré pour ${guildId}:`, err));
}

export async function getBackfillStatus(guildId: string): Promise<WordStatsBackfillStatus> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { wordStatsBackfillStatus: true },
  });
  return (guild?.wordStatsBackfillStatus as WordStatsBackfillStatus | null) ?? { status: 'NOT_STARTED' };
}

/**
 * Lance l'indexation en arrière-plan. Retourne immédiatement.
 * Ne fait rien si une indexation est déjà en cours ou terminée (sauf `force`).
 */
export async function startWordStatsBackfill(guildId: string, force = false): Promise<void> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { wordStatsEnabled: true, messageLoggingEnabled: true, wordStatsBackfillStatus: true },
  });

  if (!guild?.wordStatsEnabled) return;

  const current = (guild.wordStatsBackfillStatus as WordStatsBackfillStatus | null)?.status ?? 'NOT_STARTED';
  if (!force && (current === 'IN_PROGRESS' || current === 'COMPLETED')) return;

  // Sans journalisation, il n'y a aucun historique à exploiter : le tracker live
  // alimentera les stats à partir de maintenant.
  if (!guild.messageLoggingEnabled) {
    await setStatus(guildId, {
      status: 'SKIPPED',
      error: "La journalisation des messages est désactivée : aucun historique à indexer.",
      completedAt: new Date().toISOString(),
    });
    return;
  }

  await setStatus(guildId, {
    status: 'IN_PROGRESS',
    processedMessages: 0,
    startedAt: new Date().toISOString(),
  });

  void runBackfill(guildId, force).catch(async (err) => {
    logger.error('WordStatsBackfill', `Échec de l'indexation pour ${guildId}:`, err);
    await setStatus(guildId, {
      status: 'FAILED',
      error: publicErrorMessage(err).slice(0, 500),
      completedAt: new Date().toISOString(),
    });
  });
}

async function flushBuffer(
  guildId: string,
  buffer: Map<string, Map<string, number>>,
): Promise<number> {
  let written = 0;
  for (const [dateKey, words] of buffer) {
    const entries = [...words.entries()];
    for (let i = 0; i < entries.length; i += 500) {
      const chunk = entries.slice(i, i + 500);
      await prisma.$transaction(
        chunk.map(([word, count]) =>
          prisma.guildWordStat.upsert({
            where: { guildId_dateKey_word: { guildId, dateKey, word } },
            create: { guildId, dateKey, word, count },
            update: { count: { increment: count } },
          }),
        ),
      );
      written += chunk.length;
    }
  }
  buffer.clear();
  return written;
}

async function runBackfill(guildId: string, force: boolean): Promise<void> {
  // Frontière avec le tracker live : lui gère tout ce qui arrive à partir d'ici.
  const cutoff = new Date();

  if (force) {
    // Repartir de zéro, sinon l'indexation s'additionnerait aux compteurs existants.
    await prisma.guildWordStat.deleteMany({ where: { guildId } });
  }

  const totalMessages = await prisma.messageLog.count({
    where: { guildId, isBot: false, createdAt: { lt: cutoff }, content: { not: '' } },
  });

  logger.info('WordStatsBackfill', `Indexation de ${totalMessages} message(s) pour ${guildId}.`);

  const buffer = new Map<string, Map<string, number>>();
  let cursor: string | null = null;
  let processed = 0;
  let sinceFlush = 0;
  let indexedWords = 0;

  for (;;) {
    const batch: Array<{ id: string; content: string; createdAt: Date }> = await prisma.messageLog.findMany({
      where: {
        guildId,
        isBot: false,
        createdAt: { lt: cutoff },
        content: { not: '' },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, content: true, createdAt: true },
      // Curseur sur l'id : ordre total stable, insensible aux insertions concurrentes.
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (const msg of batch) {
      const words = tokenize(msg.content);
      if (words.length === 0) continue;

      const dateKey = msg.createdAt.toISOString().slice(0, 10);
      let dayBuffer = buffer.get(dateKey);
      if (!dayBuffer) {
        dayBuffer = new Map();
        buffer.set(dateKey, dayBuffer);
      }
      for (const word of words) {
        dayBuffer.set(word, (dayBuffer.get(word) ?? 0) + 1);
      }
    }

    cursor = batch[batch.length - 1].id;
    processed += batch.length;
    sinceFlush += batch.length;

    if (sinceFlush >= FLUSH_EVERY) {
      indexedWords += await flushBuffer(guildId, buffer);
      sinceFlush = 0;
      await setStatus(guildId, {
        status: 'IN_PROGRESS',
        processedMessages: processed,
        totalMessages,
        indexedWords,
        startedAt: new Date().toISOString(),
      });
    }

    if (batch.length < BATCH_SIZE) break;
  }

  indexedWords += await flushBuffer(guildId, buffer);

  await setStatus(guildId, {
    status: 'COMPLETED',
    processedMessages: processed,
    totalMessages,
    indexedWords,
    completedAt: new Date().toISOString(),
  });

  logger.success(
    'WordStatsBackfill',
    `Indexation terminée pour ${guildId} : ${processed} message(s), ${indexedWords} entrée(s) de mots.`,
  );
}

/**
 * Reconstruit `mentionedUserIds` sur les messages déjà journalisés en parsant
 * leur contenu. Rend l'analyse sociale (mentions reçues) exploitable sur
 * l'historique, au lieu de ne compter que les nouveaux messages.
 *
 * `repliedToAuthorId` n'est pas récupérable : l'information n'est pas dans le
 * contenu du message, seuls les nouveaux messages la porteront.
 */
export async function backfillMessageMentions(guildId: string): Promise<number> {
  const PAGE = 5000;
  let totalUpdated = 0;
  let cursor: string | null = null;

  // Curseur explicite plutôt qu'un WHERE auto-réducteur : les messages ne
  // contenant que des mentions de rôle (<@&id>) ne matchent pas la regex et
  // gardent un tableau vide. Sans curseur, ils seraient resélectionnés en
  // boucle et masqueraient les lignes restantes à traiter.
  for (;;) {
    const rows: Array<{ id: string }> = await prisma.messageLog.findMany({
      where: {
        guildId,
        content: { contains: '<@' },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PAGE,
    });

    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    totalUpdated += await prisma.$executeRaw`
      UPDATE "message_logs" m
      SET "mentionedUserIds" = sub.ids
      FROM (
        SELECT id,
               ARRAY(SELECT DISTINCT (regexp_matches(content, '<@!?(\d+)>', 'g'))[1]) AS ids
        FROM "message_logs"
        WHERE id = ANY(${ids})
      ) sub
      WHERE m.id = sub.id
        AND cardinality(sub.ids) > 0
        AND cardinality(m."mentionedUserIds") = 0
    `;

    cursor = ids[ids.length - 1];
    if (rows.length < PAGE) break;
  }

  if (totalUpdated > 0) {
    logger.info('WordStatsBackfill', `${totalUpdated} message(s) enrichi(s) de leurs mentions pour ${guildId}.`);
  }
  return totalUpdated;
}
