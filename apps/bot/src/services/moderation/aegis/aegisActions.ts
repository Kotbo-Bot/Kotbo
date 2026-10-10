/**
 * Effets d'une note de toxicité : retrait et sanction quand le bot agit seul,
 * carte « à vérifier » sinon. Puis les décisions du staff, depuis Discord
 * (boutons) ou le dashboard : confirmer, déclarer un faux positif, lever un
 * mode lent.
 */
import { SanctionStatus, SanctionType, type AegisDetection } from '@prisma/client';
import type { Client, Guild, GuildTextBasedChannel, Message } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import { registerTimeoutSanction, registerWarnSanction } from '../sanctionService.js';
import { safeNickname } from '../nicknameModerationService.js';
import type { EmotionResult } from './aegisClient.js';
import type { AegisRuntimeConfig } from './aegisConfig.js';
import type { AegisJob } from './aegisQueue.js';
import { buildButtons, buildToxicEmbed, closeAlert, pct, postAlert } from './aegisAlerts.js';
import { captureEvidence, evidenceLinks, reasonWithExcerpt } from './aegisEvidence.js';

export type Actor = { id: string; tag: string };

function botActor(client: Client): Actor {
  return { id: client.user!.id, tag: client.user!.tag };
}

async function fetchTextChannel(guild: Guild, channelId: string): Promise<GuildTextBasedChannel | null> {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  return channel && channel.isTextBased() ? channel : null;
}

async function fetchMessage(guild: Guild, channelId: string, messageId: string | null): Promise<Message | null> {
  if (!messageId) return null;
  const channel = await fetchTextChannel(guild, channelId);
  return channel ? channel.messages.fetch(messageId).catch(() => null) : null;
}

type SanctionOutcome = { action: 'DELETE' | 'WARN' | 'TIMEOUT'; sanctionId: string | null };


/** Applique la sanction de `autoAction` à l'auteur ; le retrait du message est à part. */
async function sanctionAuthor(
  client: Client,
  guild: Guild,
  authorId: string,
  config: Pick<AegisRuntimeConfig, 'autoAction' | 'warnWeight' | 'timeoutMinutes'>,
  reason: string,
  moderator: Actor,
  evidence: string[],
): Promise<SanctionOutcome> {
  const member = await guild.members.fetch(authorId).catch(() => null);
  const target = { id: authorId, tag: member?.user.tag ?? authorId };
  try {
    if (config.autoAction === 'DELETE_AND_WARN') {
      const sanction = await registerWarnSanction({ guildId: guild.id, target, moderator, reason, client, weight: config.warnWeight, evidenceLinks: evidence });
      return { action: 'WARN', sanctionId: sanction?.id ?? null };
    }
    if (config.autoAction === 'DELETE_AND_TIMEOUT' && member) {
      const sanction = await registerTimeoutSanction({
        guildId: guild.id,
        target,
        moderator,
        reason,
        durationMs: config.timeoutMinutes * 60_000,
        member,
        client,
        evidenceLinks: evidence,
      });
      return { action: 'TIMEOUT', sanctionId: sanction?.id ?? null };
    }
  } catch (err) {
    logger.warn('AegisAI', `Sanction impossible pour ${authorId} sur ${guild.id} :`, err);
  }
  return { action: 'DELETE', sanctionId: null };
}

async function noticeInChannel(message: Message): Promise<void> {
  if (!message.channel.isSendable()) return;
  const notice = await message.channel
    .send({
      content: `⚠️ <@${message.author.id}>, votre message a été supprimé : propos jugés insultants.`,
      allowedMentions: { users: [message.author.id] },
    })
    .catch(() => null);
  if (notice) setTimeout(() => void notice.delete().catch(() => null), 6000);
}

async function resetNickname(guild: Guild, userId: string, reason: string): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member?.manageable) return false;
  const locale = await resolveGuildLocale(guild.id, guild.preferredLocale);
  return member.setNickname(safeNickname(locale), reason).then(() => true).catch(() => false);
}

export type ToxicContext = {
  client: Client;
  guild: Guild;
  job: AegisJob;
  config: AegisRuntimeConfig;
  /** null : AegisAI indisponible, repéré par la liste de mots bannis locale. */
  toxicity: number | null;
  emotion?: EmotionResult;
  late: boolean;
  decision: 'auto' | 'review';
  /** Précision affichée sur la carte (membre exempté, par exemple). */
  note?: string;
};

/** Retire et sanctionne, ou demande l'avis du staff. Rend la détection créée. */
export async function handleToxic(ctx: ToxicContext): Promise<AegisDetection> {
  const { client, guild, job, config } = ctx;
  // Avant tout retrait : une fois le message supprimé, il n'y a plus rien à
  // transcrire. Prise aussi pour une revue, l'auteur pouvant effacer son
  // message avant que le staff ne tranche.
  const evidenceUrl = job.source === 'NICKNAME' ? null : await captureEvidence(guild, job.channelId, job.messageId);
  const base = {
    guildId: guild.id,
    channelId: job.channelId,
    messageId: job.messageId,
    authorId: job.authorId,
    targetUserId: job.targetUserId,
    kind: 'TOXIC',
    source: job.source,
    toxicity: ctx.toxicity,
    emotion: ctx.emotion?.label ?? null,
    emotionScore: ctx.emotion?.score ?? null,
    excerpt: job.excerpt,
    late: ctx.late,
    evidenceUrl,
  };

  let decision = ctx.decision;
  let note: string | undefined = ctx.note;
  let message: Message | null = null;
  if (decision === 'auto' && job.source !== 'NICKNAME') {
    message = await fetchMessage(guild, job.channelId, job.messageId);
    // Déjà retiré (par son auteur ou un autre filtre) : on ne sanctionne pas
    // à l'aveugle, le staff juge sur l'extrait.
    if (!message) {
      decision = 'review';
      note = 'Le message avait déjà disparu quand la note est arrivée.';
    }
  }

  if (decision === 'review') {
    const detection = await prisma.aegisDetection.create({ data: { ...base, action: 'REVIEW', status: 'PENDING' } });
    await postAlert(guild, config.reviewChannelId, detection.id, {
      embeds: [buildToxicEmbed(detection, note)],
      components: buildButtons(detection),
    });
    return detection;
  }

  const scoreText = ctx.toxicity === null ? '' : ` (${pct(ctx.toxicity)})`;
  let action: string;
  let sanctionId: string | null = null;

  if (job.source === 'NICKNAME') {
    const renamed = await resetNickname(guild, job.authorId, reasonWithExcerpt(`[AegisAI] Pseudo toxique${scoreText}`, job.excerpt));
    action = renamed ? 'NICKNAME_RESET' : 'ALERT';
    if (!renamed) note = 'Le pseudo n’a pas pu être remplacé (rôle du membre au-dessus de celui du bot ?).';
  } else {
    await message!.delete().catch((err) => logger.warn('AegisAI', 'Suppression impossible :', err));
    if (config.notifyMember) await noticeInChannel(message!);
    const outcome = await sanctionAuthor(
      client,
      guild,
      job.authorId,
      config,
      reasonWithExcerpt(`[AegisAI] Propos toxiques${scoreText}`, job.excerpt),
      botActor(client),
      evidenceLinks(evidenceUrl),
    );
    action = outcome.action;
    sanctionId = outcome.sanctionId;
  }

  const detection = await prisma.aegisDetection.create({ data: { ...base, action, status: 'AUTO', sanctionId } });

  kotboEventBus.publish('automod:triggered', {
    guildId: guild.id,
    userId: job.authorId,
    channelId: job.channelId,
    rule: job.source === 'NICKNAME' ? 'Pseudo toxique (AegisAI)' : 'Propos toxiques (AegisAI)',
    matchedContent: job.excerpt.slice(0, 1000),
    action: action === 'TIMEOUT' ? 'TIMEOUT' : action === 'WARN' ? 'WARN' : action === 'DELETE' ? 'DELETE' : 'LOG',
    timestamp: Date.now(),
  });

  await postAlert(guild, config.reviewChannelId, detection.id, {
    embeds: [buildToxicEmbed(detection, note)],
    components: buildButtons(detection),
  });
  return detection;
}

// ── Décisions du staff ───────────────────────────────────────────────────────

export type DecisionResult = { ok: true; detection: AegisDetection } | { ok: false; error: string };

async function loadDetection(guildId: string, detectionId: string): Promise<AegisDetection | null> {
  return prisma.aegisDetection.findFirst({ where: { id: detectionId, guildId } });
}

/** Confirme une détection en attente : retrait et sanction pour un message toxique. */
export async function confirmDetection(client: Client, guild: Guild, detectionId: string, actor: Actor): Promise<DecisionResult> {
  const detection = await loadDetection(guild.id, detectionId);
  if (!detection) return { ok: false, error: 'Détection introuvable.' };
  if (detection.status !== 'PENDING') return { ok: false, error: 'Cette détection a déjà été traitée.' };

  // Bascule d'abord le statut : deux modérateurs qui cliquent ensemble ne
  // doivent pas sanctionner deux fois.
  const claimed = await prisma.aegisDetection.updateMany({
    where: { id: detection.id, status: 'PENDING' },
    data: { status: 'CONFIRMED', reviewedById: actor.id, reviewedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: 'Cette détection a déjà été traitée.' };

  let action = detection.action;
  let sanctionId: string | null = detection.sanctionId;
  let evidenceUrl = detection.evidenceUrl;
  let decision = `Pris en charge par <@${actor.id}>`;

  if (detection.kind === 'TOXIC') {
    const config = await prisma.aegisConfig.findUnique({ where: { guildId: guild.id } });
    const reason = reasonWithExcerpt(`[AegisAI] Propos toxiques confirmés par ${actor.tag}`, detection.excerpt);
    if (detection.source === 'NICKNAME') {
      action = (await resetNickname(guild, detection.authorId, reason)) ? 'NICKNAME_RESET' : 'ALERT';
      decision = `Confirmé par <@${actor.id}>${action === 'NICKNAME_RESET' ? ' : pseudo remplacé' : ' (pseudo non modifiable)'}`;
    } else {
      // Détection antérieure à la capture des preuves : on la prend maintenant,
      // avant de retirer le message.
      evidenceUrl ??= await captureEvidence(guild, detection.channelId, detection.messageId);
      const message = await fetchMessage(guild, detection.channelId, detection.messageId);
      if (message) await message.delete().catch(() => null);
      const outcome = config
        ? await sanctionAuthor(client, guild, detection.authorId, config, reason, actor, evidenceLinks(evidenceUrl))
        : { action: 'DELETE' as const, sanctionId: null };
      action = outcome.action;
      sanctionId = outcome.sanctionId;
      decision = `Confirmé par <@${actor.id}> : ${outcome.action === 'WARN' ? 'avertissement' : outcome.action === 'TIMEOUT' ? 'exclusion temporaire' : 'message retiré'}`;
    }
  }

  const updated = await prisma.aegisDetection.update({ where: { id: detection.id }, data: { action, sanctionId, evidenceUrl } });
  await closeAlert(guild, updated, decision);
  return { ok: true, detection: updated };
}

/** Lève un mode lent posé par l'escalade, s'il tient encore. */
export async function liftSlowmode(guild: Guild, detection: AegisDetection, reason: string): Promise<boolean> {
  if (detection.kind !== 'CONFLICT' || detection.restoredAt || detection.previousSlowmode === null) return false;
  const claimed = await prisma.aegisDetection.updateMany({
    where: { id: detection.id, restoredAt: null },
    data: { restoredAt: new Date() },
  });
  if (claimed.count === 0) return false;
  const channel = await fetchTextChannel(guild, detection.channelId);
  if (channel && 'setRateLimitPerUser' in channel) {
    await channel.setRateLimitPerUser(detection.previousSlowmode, reason).catch((err) => {
      logger.warn('AegisAI', `Mode lent non levé sur ${detection.channelId} :`, err);
    });
  }
  return true;
}

/**
 * Faux positif : la détection sort des comptes, et ce que le bot a fait seul
 * est défait (warn archivé, exclusion levée, mode lent levé).
 */
export async function dismissDetection(guild: Guild, detectionId: string, actor: Actor): Promise<DecisionResult> {
  const detection = await loadDetection(guild.id, detectionId);
  if (!detection) return { ok: false, error: 'Détection introuvable.' };
  if (detection.status !== 'PENDING' && detection.status !== 'AUTO') return { ok: false, error: 'Cette détection a déjà été traitée.' };

  const claimed = await prisma.aegisDetection.updateMany({
    where: { id: detection.id, status: { in: ['PENDING', 'AUTO'] } },
    data: { status: 'DISMISSED', reviewedById: actor.id, reviewedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: 'Cette détection a déjà été traitée.' };

  const undone: string[] = [];
  if (detection.sanctionId) {
    const sanction = await prisma.sanction.findFirst({ where: { id: detection.sanctionId, guildId: guild.id } });
    if (sanction?.type === SanctionType.WARN && !sanction.archivedAt) {
      await prisma.sanction.update({
        where: { id: sanction.id },
        data: { archivedAt: new Date(), archivedByUserId: actor.id, resolutionNote: 'Faux positif AegisAI : avertissement archivé.' },
      });
      undone.push('avertissement archivé');
    }
    if (sanction?.type === SanctionType.TIMEOUT && sanction.status === SanctionStatus.ACTIVE) {
      const member = await guild.members.fetch(sanction.targetUserId).catch(() => null);
      if (member?.isCommunicationDisabled()) await member.timeout(null, `Faux positif AegisAI (${actor.tag})`).catch(() => null);
      await prisma.sanction.update({ where: { id: sanction.id }, data: { status: SanctionStatus.RESOLVED, resolvedAt: new Date() } });
      undone.push('exclusion levée');
    }
  }
  if (await liftSlowmode(guild, detection, `Faux positif AegisAI (${actor.tag})`)) undone.push('mode lent levé');

  const updated = (await loadDetection(guild.id, detection.id))!;
  await closeAlert(guild, updated, `Faux positif selon <@${actor.id}>${undone.length ? ` : ${undone.join(', ')}` : ''}`);
  return { ok: true, detection: updated };
}

/** Bouton « Lever le mode lent » : la carte garde son bouton « Faux positif ». */
export async function unslowDetection(guild: Guild, detectionId: string, actor: Actor): Promise<DecisionResult> {
  const detection = await loadDetection(guild.id, detectionId);
  if (!detection) return { ok: false, error: 'Détection introuvable.' };
  if (!(await liftSlowmode(guild, detection, `Levé par ${actor.tag}`))) return { ok: false, error: 'Le mode lent est déjà levé.' };
  const updated = (await loadDetection(guild.id, detection.id))!;
  await closeAlert(guild, updated, `Mode lent levé par <@${actor.id}>`, buildButtons(updated));
  return { ok: true, detection: updated };
}
