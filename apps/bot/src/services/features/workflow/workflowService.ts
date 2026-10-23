import { cronMatches, hasBlockingIssue, validateGraph, getNodeDef, wallClockMinuteKey, FUN_GAME_LABELS, SANCTION_TYPE_LABELS, SUGGESTION_STATUS_LABELS, type WorkflowGraph } from '@kotbo/shared';
import { currentCascadeDepth, runWithCascadeDepth } from '@kotbo/core';
import type { Client, Guild } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { cache } from '../../../utils/cache.js';
import { resolveGuildTimezone } from '../../../utils/timezone.js';
import { isGuildActivated } from '../../../utils/activation.js';
import { isModuleEnabled } from '../../core/moduleGate.js';
import { createWorkflowEffects, toChannelValue, toMemberValue, toMessageValue, toRoleValue } from './effects.js';
import { RUN_INFO_KEY, runWorkflow, type ExecutionOutcome, type ExecutionState, type StepRecord } from './engine.js';
import { matchesTriggerChannelFilter } from './channelFilter.js';
import { matchesTriggerRoleFilter } from './roleFilter.js';
import { matchesTriggerReactionFilter } from './reactionFilter.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

/**
 * Orchestration des workflows : déclenchement depuis le bus d'événements,
 * persistance des exécutions et reprise de celles suspendues par un « Attendre ».
 */

/** Au-delà, on cesse de conserver le détail pas-à-pas d'une exécution. */
const MAX_STEPS_PERSISTED = 200;

/**
 * Nombre d'automatisations qu'une seule action de départ peut enchaîner.
 *
 * Une action à effet de bord publie ses propres événements - exclure un membre
 * publie `sanction:applied`, ouvrir un ticket publie `ticket:created` - et rien
 * n'empêche le workflow déclenché de reproduire l'action qui l'a réveillé. Sans
 * borne, « quand une sanction est appliquée, exclure le membre » se relance
 * indéfiniment.
 *
 * Le chaînage reste permis parce qu'il est légitime : un workflow qui en
 * déclenche un autre est une composition, pas une erreur. C'est sa répétition
 * sans fin qu'on coupe.
 */
const MAX_CASCADE_DEPTH = 3;

/**
 * Court volontairement : l'invalidation explicite ne touche que le cache
 * mémoire du processus qui écrit. En mode distribué (`EVENTBUS_DISTRIBUTED`),
 * le processus qui traite les événements garde sa copie jusqu'à expiration, et
 * cette borne fixe le délai maximal avant qu'un workflow fraîchement activé
 * ne parte.
 */
const TRIGGER_EVENTS_TTL_SECONDS = 60;

/** Préfixe `guild:` : `cache.invalidateGuild` balaie la clé avec le reste. */
function triggerEventsKey(guildId: string): string {
  return `guild:${guildId}:workflow-trigger-events`;
}

async function invalidateTriggerEvents(guildId: string): Promise<void> {
  await cache.delete(triggerEventsKey(guildId)).catch(() => null);
}

/**
 * Événements pour lesquels le serveur a au moins un workflow actif.
 *
 * `dispatchEvent` est appelée à chaque message, chaque réaction et chaque
 * arrivée : sans cette liste, un serveur sans le moindre workflow paierait une
 * requête SQL par message. La liste tient dans le cache mémoire de premier
 * niveau, et toute écriture sur un workflow la périme.
 */
async function activeTriggerEvents(guildId: string): Promise<string[]> {
  const key = triggerEventsKey(guildId);

  const cached = await cache.get<string[]>(key);
  if (cached) return cached;

  const rows = await prisma.workflow.findMany({
    where: { guildId, enabled: true },
    select: { triggerEvent: true },
    distinct: ['triggerEvent'],
  });

  const events = rows.map((row) => row.triggerEvent);
  await cache.set(key, events, TRIGGER_EVENTS_TTL_SECONDS);
  return events;
}

// ============================================================================
// ENREGISTREMENT
// ============================================================================

export interface SaveWorkflowInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  graph: WorkflowGraph;
}

export class WorkflowValidationError extends UserFacingError {
  constructor(public readonly issues: { code: string; message: string }[]) {
    super(issues.map((i) => i.message).join(' '));
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Le type et l'événement du déclencheur sont extraits du graphe et stockés à
 * plat : c'est ce qui permet de retrouver en une requête indexée les workflows
 * concernés par un événement, sans désérialiser tous les graphes du serveur.
 */
function extractTrigger(graph: WorkflowGraph): { triggerType: string; triggerEvent: string } {
  const trigger = graph.nodes.find((node) => getNodeDef(node.type)?.category === 'trigger');
  const def = trigger ? getNodeDef(trigger.type) : undefined;
  if (!trigger || !def?.event) {
    throw new WorkflowValidationError([{ code: 'NO_TRIGGER', message: 'Le workflow n\'a aucun déclencheur.' }]);
  }
  return { triggerType: trigger.type, triggerEvent: def.event };
}

function assertValid(graph: WorkflowGraph): void {
  const issues = validateGraph(graph);
  if (hasBlockingIssue(issues)) {
    throw new WorkflowValidationError(issues.filter((i) => i.severity === 'error'));
  }
}

export async function createWorkflow(guildId: string, input: SaveWorkflowInput, createdById: string) {
  assertValid(input.graph);
  const { triggerType, triggerEvent } = extractTrigger(input.graph);

  const workflow = await prisma.workflow.create({
    data: {
      guildId,
      name: input.name.trim().slice(0, 100) || 'Workflow',
      description: input.description?.slice(0, 500) ?? null,
      enabled: input.enabled ?? false,
      triggerType,
      triggerEvent,
      graph: input.graph as never,
      createdById,
    },
  });

  await invalidateTriggerEvents(guildId);
  return workflow;
}

export async function updateWorkflow(guildId: string, id: string, input: SaveWorkflowInput) {
  assertValid(input.graph);
  const { triggerType, triggerEvent } = extractTrigger(input.graph);

  const { count } = await prisma.workflow.updateMany({
    where: { id, guildId },
    data: {
      name: input.name.trim().slice(0, 100) || 'Workflow',
      description: input.description?.slice(0, 500) ?? null,
      enabled: input.enabled ?? false,
      triggerType,
      triggerEvent,
      graph: input.graph as never,
    },
  });

  if (count === 0) return null;

  await invalidateTriggerEvents(guildId);
  return prisma.workflow.findUnique({ where: { id } });
}

export async function deleteWorkflow(guildId: string, id: string): Promise<boolean> {
  const { count } = await prisma.workflow.deleteMany({ where: { id, guildId } });
  if (count > 0) await invalidateTriggerEvents(guildId);
  return count > 0;
}

/**
 * Bascule l'état d'un workflow. Passe par le service plutôt que par une écriture
 * directe depuis la route : c'est ce qui garantit que la liste des événements
 * actifs est périmée en même temps.
 */
export async function setWorkflowEnabled(guildId: string, id: string, enabled: boolean): Promise<boolean> {
  const { count } = await prisma.workflow.updateMany({ where: { id, guildId }, data: { enabled } });
  if (count > 0) await invalidateTriggerEvents(guildId);
  return count > 0;
}

export async function listWorkflows(guildId: string) {
  return prisma.workflow.findMany({
    where: { guildId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, name: true, description: true, enabled: true,
      triggerType: true, triggerEvent: true,
      runCount: true, successCount: true, failureCount: true,
      lastRunAt: true, lastError: true, updatedAt: true,
    },
  });
}

export async function getWorkflow(guildId: string, id: string) {
  return prisma.workflow.findFirst({ where: { id, guildId } });
}

// ============================================================================
// DÉCLENCHEMENT
// ============================================================================

function sanctionTypeLabel(type: string): string {
  return Object.hasOwn(SANCTION_TYPE_LABELS, type) ? SANCTION_TYPE_LABELS[type] : type;
}

/**
 * Traduit le payload d'un événement du bus en valeurs typées exposées par les
 * ports du nœud déclencheur.
 *
 * Retourne `null` quand l'événement ne peut pas être exploité (membre parti
 * entre-temps, salon supprimé) : le workflow n'est alors pas lancé.
 */
export async function buildTriggerOutputs(
  guild: Guild,
  triggerType: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const memberOf = async (userId: unknown) => {
    if (typeof userId !== 'string') return null;
    const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
    return member ? toMemberValue(member) : null;
  };

  const channelOf = (channelId: unknown) => {
    if (typeof channelId !== 'string') return null;
    const channel = guild.channels.cache.get(channelId);
    return channel && 'name' in channel ? toChannelValue(channel) : null;
  };

  const roleOf = (roleId: unknown) => {
    if (typeof roleId !== 'string') return null;
    const role = guild.roles.cache.get(roleId);
    return role ? toRoleValue(role) : null;
  };

  // Discord n'envoie avec une réaction que les identifiants du message : son
  // texte et son auteur viennent du cache, ou d'une lecture. Un message
  // devenu illisible garde son identifiant, qui suffit à y répondre ou à le
  // comparer.
  const reactedMessageOf = async (channelId: unknown, messageId: unknown) => {
    const id = String(messageId ?? '');
    const fallback = toMessageValue({ id, content: '', channelId: String(channelId ?? ''), authorId: '' });
    if (typeof channelId !== 'string' || !id) return fallback;
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !('messages' in channel)) return fallback;
    const cached = channel.messages.cache.get(id);
    const message = cached && !cached.partial ? cached : await channel.messages.fetch(id).catch(() => null);
    return message
      ? toMessageValue({ id, content: message.content, channelId, authorId: message.author.id })
      : fallback;
  };

  // Un ticket se ferme ou se note souvent après le départ de son auteur, et un
  // membre expulsé ou banni a déjà quitté le serveur quand la sanction est
  // annoncée : on reconstitue alors le minimum, comme pour un départ.
  const memberOrDeparted = async (userId: unknown, userTag: unknown) => {
    const member = await memberOf(userId);
    if (member) return member;
    const tag = String(userTag || userId || '');
    return {
      kind: 'Member', id: String(userId ?? ''), tag, displayName: tag, isBot: false,
      roleIds: [], accountCreatedAt: null, joinedAt: null,
    };
  };

  switch (triggerType) {
    case 'OnMemberJoin':
    case 'OnMemberLeave': {
      const member = await memberOf(payload.userId);
      // À la sortie d'un membre, Discord ne le résout plus : on reconstitue le
      // minimum exploitable à partir du payload.
      if (!member && triggerType === 'OnMemberLeave') {
        return {
          member: {
            kind: 'Member', id: String(payload.userId ?? ''), tag: String(payload.userTag ?? ''),
            displayName: String(payload.userTag ?? ''), isBot: Boolean(payload.isBot),
            roleIds: [], accountCreatedAt: null, joinedAt: null,
          },
        };
      }
      return member ? { member } : null;
    }

    case 'OnRoleAdded':
    case 'OnRoleRemoved': {
      const member = await memberOf(payload.userId);
      const role = roleOf(payload.roleId);
      return member && role ? { member, role } : null;
    }

    case 'OnPartnershipStage':
      return {
        partnerName: String(payload.partnerName ?? ''),
        stage: String(payload.toStage ?? ''),
        previousStage: String(payload.fromStage ?? ''),
        partnershipType: String(payload.type ?? ''),
        reason: String(payload.reason ?? ''),
      };

    case 'OnPartnershipCommitmentFailed':
      return {
        partnerName: String(payload.partnerName ?? ''),
        commitment: String(payload.label ?? payload.kind ?? ''),
        failureStreak: typeof payload.failureStreak === 'number' ? payload.failureStreak : 0,
      };

    case 'OnPartnershipReferral': {
      const member = await memberOf(payload.userId);
      // Sans le membre, le graphe n'a rien a manipuler : mieux vaut ne pas
      // declencher que declencher avec un membre vide.
      return member ? { member, partnerName: String(payload.partnerName ?? '') } : null;
    }

    case 'OnMessageSend': {
      const member = await memberOf(payload.authorId);
      const channel = channelOf(payload.channelId);
      if (!member || !channel) return null;
      return {
        member,
        channel,
        message: toMessageValue({
          id: String(payload.messageId ?? ''),
          content: String(payload.content ?? ''),
          channelId: String(payload.channelId ?? ''),
          authorId: String(payload.authorId ?? ''),
        }),
      };
    }

    case 'OnReactionAdd':
    case 'OnReactionRemove': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      const message = await reactedMessageOf(payload.channelId, payload.messageId);
      return {
        member,
        channel: channelOf(payload.channelId),
        emoji: String(payload.emoji ?? ''),
        message,
        author: message.authorId ? await memberOf(message.authorId) : null,
      };
    }

    case 'OnVoiceJoin': {
      const member = await memberOf(payload.userId);
      const channel = channelOf(payload.channelId);
      return member ? { member, channel } : null;
    }

    case 'OnVoiceLeave': {
      const member = await memberOf(payload.userId);
      const channel = channelOf(payload.channelId);
      const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 0;
      return member ? { member, channel, minutes: Math.floor(durationMs / 60_000) } : null;
    }

    case 'OnSanctionApplied': {
      if (typeof payload.targetId !== 'string') return null;
      const type = String(payload.type ?? '');
      const durationSeconds = typeof payload.duration === 'number' ? payload.duration : 0;
      return {
        member: await memberOrDeparted(payload.targetId, payload.targetTag),
        moderator: await memberOf(payload.moderatorId),
        type,
        typeLabel: sanctionTypeLabel(type),
        reason: String(payload.reason ?? ''),
        minutes: Math.max(0, Math.floor(durationSeconds / 60)),
        isWarn: type === 'WARN',
        isTimeout: type === 'TIMEOUT',
        isKick: type === 'KICK',
        isBan: type === 'BAN' || type === 'TEMP_BAN',
        isSoftban: type === 'SOFTBAN',
      };
    }

    case 'OnTicketCreated': {
      const member = await memberOf(payload.userId);
      const channel = channelOf(payload.channelId);
      return member
        ? { member, channel, subject: String(payload.subject ?? ''), ticketType: String(payload.ticketTypeLabel ?? '') }
        : null;
    }

    case 'OnTicketClosed': {
      const openedAt = typeof payload.openedAt === 'number' ? payload.openedAt : null;
      const closedAt = typeof payload.timestamp === 'number' ? payload.timestamp : Date.now();
      return {
        member: await memberOrDeparted(payload.userId, payload.userTag),
        closedBy: await memberOf(payload.closedById),
        staff: await memberOf(payload.claimedById),
        channel: channelOf(payload.channelId),
        subject: String(payload.subject ?? ''),
        ticketType: String(payload.ticketTypeLabel ?? ''),
        minutes: openedAt ? Math.max(0, Math.floor((closedAt - openedAt) / 60_000)) : 0,
      };
    }

    case 'OnTicketRated': {
      const rating = Number(payload.rating);
      if (!Number.isInteger(rating)) return null;
      return {
        member: await memberOrDeparted(payload.userId, payload.userTag),
        staff: await memberOf(payload.staffId),
        channel: channelOf(payload.channelId),
        rating,
        subject: String(payload.subject ?? ''),
        ticketType: String(payload.ticketTypeLabel ?? ''),
      };
    }

    case 'OnFormSubmitted': {
      const answers = Array.isArray(payload.answers) ? payload.answers as { label?: unknown; value?: unknown }[] : [];
      return {
        member: await memberOf(payload.userId),
        formName: String(payload.formName ?? ''),
        answers: answers.map((answer) => `${String(answer.label ?? '')} : ${String(answer.value ?? '')}`).join('\n'),
        authorName: String(payload.authorName ?? ''),
      };
    }

    case 'OnSuggestionCreated': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      return {
        member,
        content: String(payload.content ?? ''),
        channel: channelOf(payload.channelId),
        message: typeof payload.messageId === 'string'
          ? toMessageValue({
            id: payload.messageId,
            content: String(payload.content ?? ''),
            channelId: String(payload.channelId ?? ''),
            authorId: guild.client.user?.id ?? '',
          })
          : null,
      };
    }

    case 'OnSuggestionResolved': {
      const status = String(payload.status ?? '');
      return {
        member: await memberOrDeparted(payload.userId, payload.username),
        staff: await memberOf(payload.respondedById),
        content: String(payload.content ?? ''),
        response: String(payload.responseText ?? ''),
        statusLabel: Object.hasOwn(SUGGESTION_STATUS_LABELS, status) ? SUGGESTION_STATUS_LABELS[status] : status,
        upvotes: Number(payload.upvotes ?? 0),
        downvotes: Number(payload.downvotes ?? 0),
        isApproved: status === 'APPROVED',
        isRejected: status === 'REJECTED',
        isImplemented: status === 'IMPLEMENTED',
      };
    }

    // Le déclencheur planifié n'expose aucune entité : seules les propriétés
    // du serveur, toujours disponibles, alimentent les étapes.
    case 'OnSchedule':
      return {};

    case 'OnGiveawayEntry': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      return {
        member,
        prize: String(payload.prize ?? ''),
        participants: Number(payload.participantCount ?? 0),
      };
    }

    case 'OnGiveawayWinner': {
      // Sans membre resoluble, rien a faire : toutes les actions d'un tel
      // workflow s'adressent au gagnant.
      const member = await memberOf(payload.userId);
      if (!member) return null;
      return { member, prize: String(payload.prize ?? '') };
    }

    case 'OnGiveawayEnded':
      return {
        prize: String(payload.prize ?? ''),
        participants: Number(payload.participantCount ?? 0),
        winners: Number(payload.winnerCount ?? 0),
      };

    case 'OnLevelUp': {
      const member = await memberOf(payload.userId);
      return member ? { member, level: Number(payload.level ?? 0) } : null;
    }

    case 'OnBetResolved': {
      const winners = Array.isArray(payload.winners) ? payload.winners : [];
      const first = winners[0] as { userId?: unknown; netGain?: unknown } | undefined;
      // Un pari se joue à plusieurs mais les actions s'adressent à un membre :
      // le premier vainqueur alimente le port, les autres sont résumés par leur
      // nombre. Sans vainqueur résoluble, le workflow ne part pas - il n'aurait
      // personne à qui s'adresser.
      const member = await memberOf(first?.userId);
      if (!member) return null;
      return {
        member,
        subject: String(payload.subject ?? ''),
        side: String(payload.winningSideLabel ?? ''),
        netGain: Number(first?.netGain ?? 0),
        pot: Number(payload.pot ?? 0),
        winnerCount: winners.length,
      };
    }

    case 'OnBetRefunded': {
      const refunded = Array.isArray(payload.refunded) ? payload.refunded : [];
      const total = refunded.reduce(
        (sum: number, entry) => sum + Number((entry as { amount?: unknown }).amount ?? 0),
        0,
      );
      // Aucun membre à exposer : un pari annulé rend leur mise à plusieurs
      // personnes à la fois, aucune n'est le sujet de l'événement.
      return { subject: String(payload.subject ?? ''), reason: String(payload.reason ?? ''), refunded: total };
    }

    case 'OnClanDebtOpened': {
      const member = await memberOf(payload.userId);
      return member
        ? { member, amount: Number(payload.amount ?? 0), total: Number(payload.total ?? 0) }
        : null;
    }

    case 'OnClanDebtCleared': {
      const member = await memberOf(payload.userId);
      return member ? { member, repaid: Number(payload.repaid ?? 0) } : null;
    }

    case 'OnFunGameWon': {
      const game = typeof payload.game === 'string' ? payload.game : '';
      const label = Object.hasOwn(FUN_GAME_LABELS, game) ? FUN_GAME_LABELS[game] : undefined;
      // Un jeu inconnu du catalogue ferait mentir les conditions « le jeu est
      // … », toutes fausses : mieux vaut ne pas déclencher.
      if (!label) return null;

      const member = await memberOf(payload.userId);
      if (!member) return null;

      return {
        member,
        channel: channelOf(payload.channelId),
        message: toMessageValue({
          id: String(payload.messageId ?? ''),
          content: String(payload.content ?? ''),
          channelId: String(payload.channelId ?? ''),
          authorId: String(payload.userId ?? ''),
        }),
        game: label,
        answer: String(payload.answer ?? ''),
        isGuessNumber: game === 'guess_number',
        isEmojiRiddle: game === 'emoji_riddle',
      };
    }

    case 'OnMessageDelete': {
      const member = await memberOf(payload.authorId);
      // Sans auteur connu, rien à rattacher ; un message de bot (avertissement
      // éphémère, nettoyage) déclencherait sinon à chaque suppression du bot.
      if (!member || member.isBot) return null;
      return {
        member,
        channel: channelOf(payload.channelId),
        content: String(payload.content ?? ''),
      };
    }

    case 'OnAutoModTriggered': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      return {
        member,
        channel: channelOf(payload.channelId),
        rule: String(payload.rule ?? ''),
        action: String(payload.action ?? ''),
      };
    }

    case 'OnSanctionRevoked': {
      // Un banni n'est plus sur le serveur : comme pour un départ, on
      // reconstitue le minimum à partir du payload.
      if (typeof payload.targetId !== 'string') return null;
      const type = String(payload.type ?? '');
      return {
        member: await memberOrDeparted(payload.targetId, payload.targetTag),
        type,
        typeLabel: sanctionTypeLabel(type),
        isUnban: type === 'UNBAN',
        isUntimeout: type === 'UNTIMEOUT',
      };
    }

    case 'OnMemberInvited': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      return {
        member,
        inviter: await memberOf(payload.inviterId),
        inviteCode: String(payload.inviteCode ?? ''),
      };
    }

    case 'OnMessageEdit': {
      const member = await memberOf(payload.authorId);
      const channel = channelOf(payload.channelId);
      // Les bots modifient sans cesse leurs messages (compteurs, panneaux) :
      // chaque mise à jour lancerait l'automatisation.
      if (!member || member.isBot || !channel) return null;
      return {
        member,
        channel,
        message: toMessageValue({
          id: String(payload.messageId ?? ''),
          content: String(payload.newContent ?? ''),
          channelId: String(payload.channelId ?? ''),
          authorId: String(payload.authorId ?? ''),
        }),
        oldContent: String(payload.oldContent ?? ''),
      };
    }

    case 'OnVoiceMove': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      const joined = typeof payload.joinTimestamp === 'number' ? payload.joinTimestamp : null;
      const movedAt = typeof payload.timestamp === 'number' ? payload.timestamp : Date.now();
      return {
        member,
        channel: channelOf(payload.toChannelId),
        fromChannel: channelOf(payload.fromChannelId),
        minutes: joined ? Math.max(0, Math.floor((movedAt - joined) / 60_000)) : 0,
      };
    }

    case 'OnThreadCreated': {
      const member = await memberOf(payload.creatorId);
      const thread = channelOf(payload.threadId);
      // Un fil créé par un bot, dont celui qu'ouvre l'action « Créer un fil »,
      // relancerait l'automatisation sur son propre fil.
      if (!member || member.isBot || !thread) return null;
      return { thread, member, channel: channelOf(payload.channelId) };
    }

    case 'OnNicknameChanged': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      return {
        member,
        oldNickname: String(payload.oldNickname ?? ''),
        newNickname: String(payload.newNickname ?? ''),
      };
    }

    case 'OnMemberBoost': {
      const member = await memberOf(payload.userId);
      if (!member) return null;
      return { member, boostCount: guild.premiumSubscriptionCount ?? 0 };
    }

    case 'OnChannelCreated':
    case 'OnChannelDeleted': {
      if (typeof payload.channelId !== 'string') return null;
      // Un salon supprimé n'est plus en cache : sa valeur vient du payload.
      const channel = channelOf(payload.channelId) ?? {
        kind: 'Channel', id: payload.channelId, name: String(payload.channelName ?? ''), categoryName: null,
      };
      return { channel };
    }

    case 'OnRoleCreated':
    case 'OnRoleDeleted': {
      if (typeof payload.roleId !== 'string') return null;
      return { role: roleOf(payload.roleId) ?? { kind: 'Role', id: payload.roleId, name: String(payload.roleName ?? '') } };
    }

    default:
      return null;
  }
}

/**
 * Ajoute un déclenchement au compteur d'une période et renvoie le total.
 *
 * Trois écritures conditionnelles plutôt qu'une lecture suivie d'une écriture :
 * deux messages du même membre traités en même temps se compteraient sinon une
 * seule fois, et la limite laisserait passer un déclenchement de trop.
 */
async function bumpMemberRun(workflowId: string, userId: string, period: 'day' | 'hour', periodKey: string): Promise<number> {
  const key = { workflowId, userId, period };

  const incremented = await prisma.workflowMemberRun.updateMany({
    where: { ...key, periodKey },
    data: { count: { increment: 1 } },
  });

  if (incremented.count === 0) {
    const reset = await prisma.workflowMemberRun.updateMany({
      where: { ...key, periodKey: { not: periodKey } },
      data: { periodKey, count: 1 },
    });

    if (reset.count === 0) {
      await prisma.workflowMemberRun.create({ data: { ...key, periodKey, count: 1 } }).catch(async (error: { code?: string }) => {
        // P2002 : la ligne vient d'être créée par un déclenchement simultané.
        if (error?.code !== 'P2002') throw error;
        await prisma.workflowMemberRun.updateMany({ where: { ...key, periodKey }, data: { count: { increment: 1 } } });
      });
    }
  }

  const row = await prisma.workflowMemberRun.findUnique({
    where: { workflowId_userId_period: key },
    select: { count: true },
  });
  return row?.count ?? 1;
}

/**
 * Compteurs du nœud « Fréquence du membre », déclenchement en cours compris.
 * Jour et heure s'entendent dans le fuseau du serveur : « aujourd'hui » est la
 * journée que voient ses membres, pas celle d'UTC.
 */
async function countMemberRun(workflowId: string, guildId: string, userId: string) {
  const timezone = await resolveGuildTimezone(guildId);
  const minute = wallClockMinuteKey(new Date(), timezone);
  const [memberToday, memberThisHour] = await Promise.all([
    bumpMemberRun(workflowId, userId, 'day', minute.slice(0, 10)),
    bumpMemberRun(workflowId, userId, 'hour', minute.slice(0, 13)),
  ]);
  return { memberToday, memberThisHour };
}

/**
 * Exécute un workflow sur un payload et consigne le résultat.
 *
 * Partagé entre le déclenchement par événement et le balayage des
 * planifications, qui ne diffèrent que par la façon de choisir les workflows
 * à lancer.
 */
async function runAndPersist(
  guild: Guild,
  workflow: { id: string; triggerType: string; graph: unknown },
  payload: Record<string, unknown>,
  source: string,
): Promise<void> {
  try {
    const triggerOutputs = await buildTriggerOutputs(guild, workflow.triggerType, payload);
    // Payload inexploitable pour ce déclencheur : rien à faire, ce n'est pas
    // une erreur du workflow.
    if (!triggerOutputs) return;

    // Compté seulement si le graphe s'en sert : chaque message du serveur
    // coûterait sinon deux écritures aux automatisations qui ne limitent rien.
    // Un échec du comptage empêche l'exécution : une limite qu'on ne peut pas
    // vérifier ne doit pas laisser passer la récompense qu'elle protège.
    const graph = workflow.graph as WorkflowGraph;
    if (graph.nodes.some((node) => node.type === 'RunInfo')) {
      const member = triggerOutputs.member as { id?: unknown } | undefined;
      triggerOutputs[RUN_INFO_KEY] = typeof member?.id === 'string'
        ? await countMemberRun(workflow.id, guild.id, member.id)
        : { memberToday: 0, memberThisHour: 0 };
    }

    // Les actions publient leurs propres événements : elles s'exécutent donc un
    // cran plus loin dans la cascade, ce que `dispatchEvent` relit pour refuser
    // de repartir au-delà de `MAX_CASCADE_DEPTH`.
    const depth = currentCascadeDepth() + 1;
    const outcome = await runWithCascadeDepth(depth, () => runWorkflow({
      graph,
      effects: createWorkflowEffects(guild),
      triggerOutputs,
    }));

    // Une exécution suspendue par un « Attendre » reprend dans un tout autre
    // contexte : la profondeur voyage donc avec son état, sinon la reprise
    // relancerait la cascade depuis zéro.
    outcome.state.cascadeDepth = depth;

    await persistOutcome(workflow.id, guild.id, outcome, payload);
  } catch (error) {
    logger.error('Workflow', `Échec du workflow ${workflow.id} sur ${source}:`, error);
  }
}

/**
 * Lance tous les workflows actifs d'un serveur abonnés à un événement.
 *
 * Les exécutions sont lancées en parallèle mais chacune est isolée : l'échec de
 * l'une n'empêche pas les autres de tourner.
 */
export async function dispatchEvent(
  client: Client,
  guildId: string,
  busEvent: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isGuildActivated(guildId)) return;

  // Sortie immédiate et sans requête pour l'immense majorité des événements,
  // qui n'intéressent aucun workflow du serveur.
  if (!(await activeTriggerEvents(guildId)).includes(busEvent)) return;

  // Testé ici plutôt qu'à l'entrée : au-dessus, l'avertissement partirait aussi
  // pour les événements que personne n'écoute, donc à chaque message.
  const depth = currentCascadeDepth();
  if (depth >= MAX_CASCADE_DEPTH) {
    logger.warn(
      'Workflow',
      `Cascade interrompue sur ${busEvent} pour ${guildId} : ${depth} automatisations déjà enchaînées.`,
    );
    return;
  }

  const workflows = await prisma.workflow.findMany({
    where: { guildId, enabled: true, triggerEvent: busEvent },
  });
  if (workflows.length === 0) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const eligible = workflows.filter((workflow) => {
    const graph = workflow.graph as unknown as WorkflowGraph;
    return matchesTriggerChannelFilter(guild, graph, payload)
      && matchesTriggerRoleFilter(graph, payload)
      && matchesTriggerReactionFilter(graph, payload);
  });

  await Promise.all(eligible.map(async (workflow) => {
    await runAndPersist(guild, workflow, payload, busEvent);
  }));
}

// ============================================================================
// PLANIFICATIONS
// ============================================================================

/** Motif du nœud « Planification » d'un graphe, s'il en porte un. */
function readSchedule(graph: WorkflowGraph): string | null {
  const node = graph.nodes.find((candidate) => candidate.type === 'OnSchedule');
  const expression = typeof node?.config?.cron === 'string' ? node.config.cron : '';
  return expression.trim() || null;
}

/**
 * Lance les workflows planifiés dont le motif tombe sur cette minute.
 *
 * Contrairement aux autres déclencheurs, celui-ci ne s'abonne à rien : c'est
 * un balayage, appelé chaque minute par le cron. Passer par le bus lancerait
 * tous les workflows planifiés du serveur à chaque tick, puisque le dispatch
 * sélectionne par événement et non par workflow.
 *
 * Le motif est lu dans le fuseau du serveur, pas dans celui du process : le bot
 * tourne en UTC, et « tous les jours à 9h00 » serait sinon parti à 11h à Paris.
 *
 * `lastRunAt` sert de garde-fou : deux passages dans la même minute - tick qui
 * se chevauche, second processus en mode distribué - ne relancent pas le même
 * workflow. La minute est réservée par une écriture conditionnelle, la seule
 * façon de trancher quand les deux passages lisent avant que l'un écrive.
 *
 * Seuls les serveurs de ce processus sont lus : le cron appelle ce balayage
 * dans chaque processus. Confié à la file d'attente, il n'était traité que par
 * un seul processus par minute, qui sautait les serveurs des autres shards - et
 * une minute sautée ne se rattrape pas, la planification ne partait jamais.
 */
export async function dispatchScheduledWorkflows(client: Client, now = new Date()): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()];
  if (guildIds.length === 0) return;

  const workflows = await prisma.workflow.findMany({
    where: { enabled: true, triggerEvent: 'schedule:fired', guildId: { in: guildIds } },
  });
  if (workflows.length === 0) return;

  const minuteStart = new Date(now);
  minuteStart.setSeconds(0, 0);

  /** Un fuseau par serveur : plusieurs planifications s'y partagent la lecture. */
  const timezones = new Map<string, string>();

  for (const workflow of workflows) {
    try {
      if (!isGuildActivated(workflow.guildId)) continue;
      if (!(await isModuleEnabled(workflow.guildId, 'workflows'))) continue;
      // Déjà parti cette minute d'après la copie qu'on vient de lire : inutile
      // d'aller jusqu'à la réservation, qui coûte une écriture.
      if (workflow.lastRunAt && workflow.lastRunAt >= minuteStart) continue;

      const graph = workflow.graph as unknown as WorkflowGraph;
      const expression = readSchedule(graph);
      if (!expression) continue;

      let timezone = timezones.get(workflow.guildId);
      if (timezone === undefined) {
        timezone = await resolveGuildTimezone(workflow.guildId);
        timezones.set(workflow.guildId, timezone);
      }
      if (!cronMatches(expression, now, timezone)) continue;

      const guild = client.guilds.cache.get(workflow.guildId);
      if (!guild) continue;

      // La nuit du retour à l'heure d'hiver, l'horloge repasse par la même
      // heure : « tous les jours à 02h30 » y tombe deux fois, à une heure
      // d'intervalle. Les deux instants sont distincts, donc la réservation
      // ci-dessous les accepte tous les deux - seule la minute murale les
      // confond, et c'est bien elle que l'admin a réglée.
      if (workflow.lastRunAt
        && wallClockMinuteKey(workflow.lastRunAt, timezone) === wallClockMinuteKey(now, timezone)) {
        continue;
      }

      // Réservation de la minute avant d'exécuter. Le test ci-dessus porte sur
      // une lecture déjà ancienne : deux balayages concurrents la passent tous
      // les deux. Ici c'est la base qui départage, et le perdant s'abstient.
      const { count } = await prisma.workflow.updateMany({
        where: {
          id: workflow.id,
          OR: [{ lastRunAt: null }, { lastRunAt: { lt: minuteStart } }],
        },
        // `minuteStart` et non l'horloge : le balayage est séquentiel, un
        // workflow lent en amont pousserait sinon le repère dans la minute
        // d'après et la garde de l'heure d'hiver ne le reconnaîtrait plus.
        data: { lastRunAt: minuteStart },
      });
      if (count === 0) continue;

      await runAndPersist(guild, workflow, { firedAt: minuteStart.toISOString(), cron: expression }, 'schedule');
    } catch (error) {
      logger.error('Workflow', `Échec du balayage planifié pour ${workflow.id}:`, error);
    }
  }
}

// ============================================================================
// PERSISTANCE DES EXÉCUTIONS
// ============================================================================

async function writeSteps(executionId: string, steps: StepRecord[]): Promise<void> {
  if (steps.length === 0) return;
  const kept = steps.slice(0, MAX_STEPS_PERSISTED);

  await prisma.workflowExecutionStep.createMany({
    data: kept.map((step) => ({
      executionId,
      order: step.order,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      status: step.status,
      inputs: step.inputs as never,
      outputs: step.outputs as never,
      error: step.error ?? null,
      durationMs: step.durationMs,
    })),
  });
}

/**
 * Minute où la planification est tombée. Seul `dispatchScheduledWorkflows` pose
 * `firedAt` : la clé suffit à reconnaître une exécution planifiée.
 */
function scheduledFiredAt(payload: Record<string, unknown>): Date | null {
  const raw = payload.firedAt;
  if (typeof raw !== 'string') return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function persistOutcome(
  workflowId: string,
  guildId: string,
  outcome: ExecutionOutcome,
  triggerPayload: Record<string, unknown>,
  existingExecutionId?: string,
): Promise<string> {
  const suspended = outcome.status === 'SUSPENDED';

  // Pour une exécution planifiée, `lastRunAt` est le repère de minute murale lu
  // par la garde de l'heure d'hiver : l'instant de fin le décalerait. Sur une
  // reprise, on n'y touche pas : la réservation l'a déjà posé, et l'heure de
  // reprise (ou le `firedAt` d'origine, vieux de toute l'attente) le fausserait.
  const firedAt = scheduledFiredAt(triggerPayload);
  const lastRunAt = !firedAt ? new Date() : existingExecutionId ? undefined : firedAt;
  const failed = outcome.status === 'FAILED';

  const data = {
    status: suspended ? 'WAITING' : failed ? 'FAILED' : 'COMPLETED',
    context: outcome.state as never,
    resumeAt: suspended ? outcome.resumeAt : null,
    nodeVisits: outcome.state.nodeVisits,
    iterations: outcome.state.iterations,
    error: failed ? outcome.error.slice(0, 1000) : null,
    completedAt: suspended ? null : new Date(),
  };

  const executionId = existingExecutionId
    ? (await prisma.workflowExecution.update({ where: { id: existingExecutionId }, data })).id
    : (await prisma.workflowExecution.create({
      data: { workflowId, guildId, triggerPayload: triggerPayload as never, ...data },
    })).id;

  await writeSteps(executionId, outcome.steps);

  // Les compteurs du workflow ne bougent qu'une fois l'exécution terminée :
  // une suspension n'est ni un succès ni un échec.
  if (!suspended) {
    await prisma.workflow.update({
      where: { id: workflowId },
      data: {
        runCount: { increment: 1 },
        successCount: failed ? undefined : { increment: 1 },
        failureCount: failed ? { increment: 1 } : undefined,
        lastRunAt,
        lastError: failed ? outcome.error.slice(0, 500) : null,
      },
    });
  }

  return executionId;
}

// ============================================================================
// REPRISE DES EXÉCUTIONS SUSPENDUES
// ============================================================================

/** Exécutions reprises par passage ; le reste attend la minute suivante. */
const RESUME_BATCH_SIZE = 50;

/**
 * Durée pendant laquelle une exécution reprise est réputée en cours. Bien
 * au-delà du budget d'exécution (quinze secondes entre deux nœuds) : passé ce
 * délai, le processus qui la portait s'est arrêté en route.
 */
const RUNNING_LEASE_MS = 15 * 60_000;

const INTERRUPTED_ERROR =
  'Interrompue : le bot s\'est arrêté pendant l\'exécution. Les étapes déjà faites ne sont pas rejouées.';

/**
 * Clôt les exécutions restées « en cours » au-delà de leur bail.
 *
 * Une reprise marque l'exécution en cours avant de la lancer ; si le bot
 * s'arrête à ce moment, personne ne la terminait et elle restait affichée en
 * cours pour toujours. Elle est close en échec plutôt que relancée : une partie
 * de ses actions a pu s'exécuter, et les rejouer donnerait deux fois un rôle ou
 * des pièces. Une ligne sans échéance vient d'une version qui n'en posait pas :
 * tout processus qui la portait a forcément redémarré depuis.
 */
async function closeInterruptedExecutions(guildIds: string[]): Promise<void> {
  const now = new Date();
  const stale = await prisma.workflowExecution.findMany({
    where: {
      status: 'RUNNING',
      guildId: { in: guildIds },
      OR: [{ resumeAt: null }, { resumeAt: { lte: now } }],
    },
    select: { id: true, workflowId: true, resumeAt: true },
    take: RESUME_BATCH_SIZE,
  });

  for (const execution of stale) {
    // Le bail relu fait partie du filtre : une exécution prolongée entre la
    // lecture et l'écriture n'est pas close.
    const { count } = await prisma.workflowExecution.updateMany({
      where: { id: execution.id, status: 'RUNNING', resumeAt: execution.resumeAt },
      data: { status: 'FAILED', resumeAt: null, completedAt: now, error: INTERRUPTED_ERROR },
    });
    if (count === 0) continue;

    await prisma.workflow.update({
      where: { id: execution.workflowId },
      data: { runCount: { increment: 1 }, failureCount: { increment: 1 }, lastError: INTERRUPTED_ERROR },
    }).catch(() => null);
  }
}

/**
 * Relance les exécutions dont l'attente est écoulée.
 *
 * Appelée par un cron : c'est ce qui rend un nœud « Attendre » fiable au-delà
 * d'un redémarrage du bot, contrairement à une minuterie en mémoire.
 *
 * Le lot est pris parmi les serveurs de ce processus, les plus en retard
 * d'abord. Sans ce filtre, cinquante exécutions dues sur les serveurs d'un
 * autre shard remplissaient le lot à chaque passage : elles étaient ignorées,
 * et celles de ce processus n'étaient jamais atteintes.
 */
export async function resumePendingExecutions(client: Client): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()];
  if (guildIds.length === 0) return;

  await closeInterruptedExecutions(guildIds);

  const due = await prisma.workflowExecution.findMany({
    where: { status: 'WAITING', resumeAt: { lte: new Date() }, guildId: { in: guildIds } },
    include: { workflow: true },
    orderBy: { resumeAt: 'asc' },
    take: RESUME_BATCH_SIZE,
  });

  for (const execution of due) {
    // Une erreur avant la réservation (base indisponible) ne doit pas clore une
    // exécution qu'on n'a jamais reprise : elle reste en attente pour le
    // passage suivant.
    let claimed = false;
    try {
      const guild = client.guilds.cache.get(execution.guildId);
      if (!guild) continue;

      if (!execution.workflow.enabled) {
        await prisma.workflowExecution.updateMany({
          where: { id: execution.id, status: 'WAITING' },
          data: { status: 'CANCELLED', completedAt: new Date(), error: 'Workflow désactivé pendant l\'attente.' },
        });
        continue;
      }

      // Réservation conditionnelle : un même serveur peut être vu par deux
      // processus (shard qui se reconnecte, bot principal et instance en marque
      // blanche présents tous les deux). Seul celui dont l'écriture trouve
      // encore l'exécution en attente la reprend.
      // En cours, `resumeAt` porte le bail : voir `closeInterruptedExecutions`.
      const { count } = await prisma.workflowExecution.updateMany({
        where: { id: execution.id, status: 'WAITING' },
        data: { status: 'RUNNING', resumeAt: new Date(Date.now() + RUNNING_LEASE_MS) },
      });
      if (count === 0) continue;
      claimed = true;

      const state = execution.context as unknown as ExecutionState;
      // Une exécution enregistrée avant l'introduction du compteur n'en porte
      // pas : on la place à l'intérieur d'une automatisation plutôt qu'à la
      // racine, ce qui lui laisse de quoi enchaîner sans repartir de zéro.
      const depth = typeof state?.cascadeDepth === 'number' ? state.cascadeDepth : 1;

      const outcome = await runWithCascadeDepth(depth, () => runWorkflow({
        graph: execution.workflow.graph as unknown as WorkflowGraph,
        effects: createWorkflowEffects(guild),
        state,
      }));

      // Un second « Attendre » repasse par ici : la profondeur doit survivre à
      // chaque reprise, pas seulement à la première.
      outcome.state.cascadeDepth = depth;

      await persistOutcome(
        execution.workflowId,
        execution.guildId,
        outcome,
        (execution.triggerPayload as Record<string, unknown>) ?? {},
        execution.id,
      );
    } catch (error) {
      logger.error('Workflow', `Échec de la reprise de l'exécution ${execution.id}:`, error);
      if (!claimed) continue;
      await prisma.workflowExecution.updateMany({
        where: { id: execution.id, status: 'RUNNING' },
        data: { status: 'FAILED', resumeAt: null, completedAt: new Date(), error: String(error).slice(0, 1000) },
      }).catch(() => null);
    }
  }
}

// ============================================================================
// PURGE DU JOURNAL
// ============================================================================

/**
 * Durée de conservation du journal. Une exécution porte le payload de son
 * déclencheur, donc le contenu des messages, y compris supprimés : le garder
 * indéfiniment n'est ni tenable en volume ni défendable pour les membres.
 */
const EXECUTION_RETENTION_DAYS = 30;

/**
 * Plafond par workflow, en plus de la durée : un déclencheur sur chaque message
 * d'un serveur actif produit des centaines de milliers de lignes en trente
 * jours, bien plus qu'on n'en consultera jamais.
 */
const EXECUTIONS_KEPT_PER_WORKFLOW = 1000;

/** Les exécutions en attente ou en cours portent un état qu'il faut reprendre. */
const FINISHED_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Suppression par lots : un seul DELETE sur la table entière la verrouillerait. */
const PRUNE_BATCH_SIZE = 2000;

async function deleteExecutionsInBatches(where: Prisma.WorkflowExecutionWhereInput): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = await prisma.workflowExecution.findMany({ where, select: { id: true }, take: PRUNE_BATCH_SIZE });
    if (batch.length === 0) return deleted;

    const { count } = await prisma.workflowExecution.deleteMany({
      where: { id: { in: batch.map((row) => row.id) } },
    });
    deleted += count;
    if (batch.length < PRUNE_BATCH_SIZE) return deleted;
  }
}

/**
 * Efface, workflow par workflow, les exécutions terminées trop anciennes ou au
 * delà du plafond. Le filtre porte toujours sur un `workflowId` : c'est ce qui
 * sert l'index `[workflowId, startedAt]`, sans lequel chaque lot relirait la
 * table entière. Les étapes suivent par la cascade de la clé étrangère. Les
 * compteurs du workflow ne bougent pas : ils résument tout l'historique, pas
 * seulement ce qui reste consultable.
 */
export async function pruneWorkflowExecutions(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EXECUTION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const workflows = await prisma.workflow.findMany({ select: { id: true } });

  let deleted = 0;
  for (const { id: workflowId } of workflows) {
    const oldestKept = await prisma.workflowExecution.findFirst({
      where: { workflowId, status: { in: FINISHED_STATUSES } },
      orderBy: { startedAt: 'desc' },
      skip: EXECUTIONS_KEPT_PER_WORKFLOW - 1,
      select: { startedAt: true },
    });
    const threshold = oldestKept && oldestKept.startedAt > cutoff ? oldestKept.startedAt : cutoff;

    deleted += await deleteExecutionsInBatches({
      workflowId,
      status: { in: FINISHED_STATUSES },
      startedAt: { lt: threshold },
    });
  }

  return deleted;
}

export const EXECUTION_STATUSES = ['RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * Journal des exécutions, des plus récentes aux plus anciennes.
 *
 * `before` pagine sur la date de départ : la page suivante reprend strictement
 * avant la dernière exécution reçue. `failedStep` nomme le nœud qui a échoué,
 * pour qu'un échec se comprenne sans ouvrir le rejeu.
 */
export async function listExecutions(
  guildId: string,
  workflowId?: string,
  take = 25,
  options: { status?: ExecutionStatus; before?: Date } = {},
) {
  const executions = await prisma.workflowExecution.findMany({
    where: {
      guildId,
      ...(workflowId ? { workflowId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.before ? { startedAt: { lt: options.before } } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: Math.min(100, Math.max(1, take)),
    select: {
      id: true, workflowId: true, status: true, error: true,
      nodeVisits: true, iterations: true, resumeAt: true,
      startedAt: true, completedAt: true,
      steps: { where: { status: 'ERROR' }, orderBy: { order: 'desc' }, take: 1, select: { nodeType: true } },
    },
  });

  return executions.map(({ steps, ...execution }) => ({
    ...execution,
    failedStep: steps[0]?.nodeType ?? null,
  }));
}

export async function getExecutionDetail(guildId: string, executionId: string) {
  return prisma.workflowExecution.findFirst({
    where: { id: executionId, guildId },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
}
