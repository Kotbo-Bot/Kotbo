/**
 * Modules dérivés des notes AegisAI : escalade d'un salon, harcèlement d'un
 * membre, détresse, et humeur des tickets. Les détecteurs (purs) sont dans
 * aegisSignals.ts ; ici, leurs effets.
 */
import type { Client, Guild } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import { logger } from '../../../utils/logger.js';
import { registerTimeoutSanction } from '../sanctionService.js';
import type { EmotionResult } from './aegisClient.js';
import type { AegisRuntimeConfig } from './aegisConfig.js';
import type { AegisJob } from './aegisQueue.js';
import { buildButtons, buildConflictEmbed, buildDistressEmbed, buildHarassmentEmbed, postAlert } from './aegisAlerts.js';
import { liftSlowmode } from './aegisActions.js';
import { captureEvidence, evidenceLinks, reasonWithExcerpt } from './aegisEvidence.js';

// ── Escalade ────────────────────────────────────────────────────────────────

const pendingRestores = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRestore(client: Client, detectionId: string, guildId: string, at: Date): void {
  const delay = Math.max(0, at.getTime() - Date.now());
  const timer = setTimeout(() => {
    pendingRestores.delete(detectionId);
    void restoreSlowmode(client, guildId, detectionId);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  pendingRestores.set(detectionId, timer);
}

async function restoreSlowmode(client: Client, guildId: string, detectionId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  const detection = await prisma.aegisDetection.findUnique({ where: { id: detectionId } });
  if (!guild || !detection) return;
  await liftSlowmode(guild, detection, 'Fin du mode lent posé par AegisAI');
}

/**
 * Lève les modes lents échus. Rattrape ceux dont le minuteur s'est perdu
 * dans un redémarrage du bot ; appelé au démarrage puis chaque minute.
 */
export async function restoreDueSlowmodes(client: Client): Promise<void> {
  const due = await prisma.aegisDetection.findMany({
    where: { kind: 'CONFLICT', restoredAt: null, restoreAt: { lte: new Date() } },
    select: { id: true, guildId: true },
    take: 100,
  });
  for (const row of due) {
    if (pendingRestores.has(row.id)) continue;
    if (!client.guilds.cache.has(row.guildId)) continue;
    await restoreSlowmode(client, row.guildId, row.id).catch((err) => logger.warn('AegisAI', 'Mode lent non levé :', err));
  }
}

export async function raiseConflict(
  client: Client,
  guild: Guild,
  job: AegisJob,
  config: AegisRuntimeConfig,
  authors: string[],
  count: number,
): Promise<void> {
  // L'échange qui a fait monter le ton, pris avant que le mode lent ne le fige.
  const evidenceUrl = await captureEvidence(guild, job.channelId, null, 25);
  const channel = guild.channels.cache.get(job.channelId);
  let previousSlowmode: number | null = null;
  let applied = false;
  if (channel && channel.isTextBased() && 'setRateLimitPerUser' in channel && 'rateLimitPerUser' in channel) {
    const current = channel.rateLimitPerUser ?? 0;
    // Un mode lent déjà plus strict est laissé tel quel.
    if (current < config.conflictSlowmodeSec) {
      applied = await channel
        .setRateLimitPerUser(config.conflictSlowmodeSec, 'AegisAI : le ton monte')
        .then(() => true)
        .catch(() => false);
      if (applied) previousSlowmode = current;
    }
  }

  const restoreAt = applied ? new Date(Date.now() + config.conflictDurationMin * 60_000) : null;
  const detection = await prisma.aegisDetection.create({
    data: {
      guildId: guild.id,
      channelId: job.channelId,
      messageId: job.messageId,
      authorId: job.authorId,
      kind: 'CONFLICT',
      source: 'MESSAGE',
      action: applied ? 'SLOWMODE' : 'ALERT',
      status: applied ? 'AUTO' : 'PENDING',
      previousSlowmode,
      restoreAt,
      evidenceUrl,
    },
  });
  if (restoreAt) scheduleRestore(client, detection.id, guild.id, restoreAt);

  await postAlert(guild, config.reviewChannelId, detection.id, {
    embeds: [buildConflictEmbed(detection, authors, count, applied ? config.conflictSlowmodeSec : null, config.conflictDurationMin)],
    components: buildButtons(detection, { canUnslow: applied }),
  });
}

// ── Harcèlement ─────────────────────────────────────────────────────────────

export async function raiseHarassment(
  client: Client,
  guild: Guild,
  job: AegisJob,
  config: AegisRuntimeConfig,
  count: number,
): Promise<void> {
  if (!job.targetUserId) return;
  const since = new Date(Date.now() - config.harassmentWindowMin * 60_000);
  const recent = await prisma.aegisDetection.findMany({
    where: { guildId: guild.id, kind: 'TOXIC', authorId: job.authorId, targetUserId: job.targetUserId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { excerpt: true, evidenceUrl: true },
    take: 5,
  });
  // Le fil de l'échange en cours, puis la preuve de chaque message en cause
  // (ceux que le bot a retirés n'existent plus que là).
  const evidenceUrl = await captureEvidence(guild, job.channelId, job.messageId, 20);
  const links = evidenceLinks(evidenceUrl, ...recent.map((r) => r.evidenceUrl));

  let action = 'ALERT';
  let sanctionId: string | null = null;
  // Un membre exempté n'est jamais exclu d'office : le staff tranche sur la carte.
  if (config.harassmentAction === 'TIMEOUT' && !job.exempt) {
    const member = await guild.members.fetch(job.authorId).catch(() => null);
    if (member) {
      const sanction = await registerTimeoutSanction({
        guildId: guild.id,
        target: { id: job.authorId, tag: member.user.tag },
        moderator: { id: client.user!.id, tag: client.user!.tag },
        reason: reasonWithExcerpt(`[AegisAI] Harcèlement de ${job.targetUserId} (${count} messages toxiques)`, job.excerpt),
        durationMs: config.timeoutMinutes * 60_000,
        member,
        client,
        evidenceLinks: links,
      }).catch((err) => {
        logger.warn('AegisAI', 'Exclusion pour harcèlement impossible :', err);
        return null;
      });
      if (sanction) {
        action = 'TIMEOUT';
        sanctionId = sanction.id;
      }
    }
  }

  const detection = await prisma.aegisDetection.create({
    data: {
      guildId: guild.id,
      channelId: job.channelId,
      messageId: job.messageId,
      authorId: job.authorId,
      targetUserId: job.targetUserId,
      kind: 'HARASSMENT',
      source: 'MESSAGE',
      excerpt: job.excerpt,
      action,
      status: action === 'TIMEOUT' ? 'AUTO' : 'PENDING',
      sanctionId,
      evidenceUrl,
    },
  });

  kotboEventBus.publish('automod:triggered', {
    guildId: guild.id,
    userId: job.authorId,
    channelId: job.channelId,
    rule: 'Harcèlement (AegisAI)',
    matchedContent: job.excerpt.slice(0, 1000),
    action: action === 'TIMEOUT' ? 'TIMEOUT' : 'LOG',
    timestamp: Date.now(),
  });

  await postAlert(guild, config.reviewChannelId, detection.id, {
    embeds: [buildHarassmentEmbed(detection, count, recent.map((r) => r.excerpt).filter((e): e is string => Boolean(e)))],
    components: buildButtons(detection),
  });
}

// ── Détresse ────────────────────────────────────────────────────────────────

export async function raiseDistress(guild: Guild, job: AegisJob, config: AegisRuntimeConfig, emotion: EmotionResult, toxicity: number | undefined): Promise<void> {
  const detection = await prisma.aegisDetection.create({
    data: {
      guildId: guild.id,
      channelId: job.channelId,
      messageId: job.messageId,
      authorId: job.authorId,
      kind: 'DISTRESS',
      source: 'MESSAGE',
      toxicity: toxicity ?? null,
      emotion: emotion.label,
      emotionScore: emotion.score,
      excerpt: job.excerpt,
      action: 'ALERT',
      status: 'PENDING',
    },
  });
  await postAlert(guild, config.distressChannelId ?? config.reviewChannelId, detection.id, {
    embeds: [buildDistressEmbed(detection)],
    components: buildButtons(detection),
  });
}

// ── Tickets ─────────────────────────────────────────────────────────────────

type TicketRef = { id: string | null; userId?: string; priority?: string };

async function ticketOfChannel(guildId: string, channelId: string): Promise<TicketRef> {
  // Hors préfixe `guild:` : une écriture du dashboard n'a pas à vider ce cache.
  return cache.wrap<TicketRef>(`aegis-ticket:${channelId}`, 600, async () => {
    const ticket = await prisma.ticket.findFirst({
      where: { guildId, status: { in: ['OPEN', 'CLAIMED'] }, OR: [{ channelId }, { threadId: channelId }] },
      select: { id: true, userId: true, priority: true },
    });
    return ticket ?? { id: null };
  });
}

const BOOSTABLE_PRIORITIES = new Set(['LOW', 'NORMAL']);

/**
 * Humeur de l'auteur d'un ticket : dernière émotion marquée et pic de
 * toxicité. Une colère ou une détresse forte peut relever la priorité.
 */
export async function updateTicketMood(
  job: AegisJob,
  config: AegisRuntimeConfig,
  emotion: EmotionResult | undefined,
  toxicity: number | undefined,
  distress: boolean,
): Promise<void> {
  const marked = emotion && emotion.label !== 'neutral';
  if (!marked && toxicity === undefined) return;
  const ticket = await ticketOfChannel(job.guildId, job.channelId);
  if (!ticket.id || ticket.userId !== job.authorId) return;

  const current = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { peakToxicity: true, priority: true } });
  if (!current) return;
  const data: Record<string, unknown> = {};
  if (marked) {
    data.moodLabel = emotion.label;
    data.moodScore = emotion.score;
    data.moodUpdatedAt = new Date();
  }
  if (toxicity !== undefined && toxicity > (current.peakToxicity ?? 0)) data.peakToxicity = toxicity;
  const urgent = distress || (emotion?.label === 'anger' && emotion.score >= 0.9);
  if (config.ticketPriorityBoost && urgent && BOOSTABLE_PRIORITIES.has(current.priority)) data.priority = 'HIGH';
  if (Object.keys(data).length === 0) return;
  await prisma.ticket.update({ where: { id: ticket.id }, data });
}
