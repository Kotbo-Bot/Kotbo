/**
 * Points d'entrée d'un vote de réputation, quelle que soit sa source (commande,
 * menu contextuel, réaction, dashboard) : les garde-fous, le vote lui-même,
 * puis ce qui en découle. Aussi les gestes du staff : ajustement, remises à zéro.
 *
 * Les suites (rôles de palier, annonce, gains, quêtes) partent sans être attendues : elles
 * parlent à Discord, et une interaction doit répondre en moins de trois
 * secondes. Leur échec est journalisé, jamais remonté au vote.
 */
import type { Client, GuildMember } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  adjustReputation,
  deleteReputationVote,
  getReputationConfig,
  giveRep,
  receivedTotal,
  recordVoteGains,
  resetGuildReputation,
  resetMemberReputation,
  type AdjustReputationResult,
  type GiveRepResult,
  type ReputationSettings,
} from './reputationService.js';
import { applyReputationGain, applyReputationLoss } from './reputationTierService.js';
import { grantRepRewards, reclaimRepRewards } from './reputationRewards.js';
import { incrementQuestProgress } from './questService.js';
import { hasMemberGuards, repGuardRefusal, type RepGuardCode } from './reputationGuards.js';

export interface RecordRepInput {
  guildId: string;
  giverId: string;
  receiverId: string;
  reason?: string;
  receiverIsBot?: boolean;
  channelId?: string;
  messageId?: string;
}

async function fetchMember(client: Client, guildId: string, userId: string): Promise<GuildMember | null> {
  const guild = client.guilds?.cache.get(guildId);
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

/**
 * Garde-fous du serveur. Un membre introuvable (parti, serveur hors du cache
 * de ce shard) ne bloque pas : seul ce qui est connu peut refuser.
 */
async function guardRefusal(client: Client, input: RecordRepInput, settings: ReputationSettings): Promise<RepGuardCode | null> {
  let giver: GuildMember | null = null;
  let receiver: GuildMember | null = null;
  if (hasMemberGuards(settings)) {
    [giver, receiver] = await Promise.all([
      fetchMember(client, input.guildId, input.giverId),
      fetchMember(client, input.guildId, input.receiverId),
    ]);
  }
  return repGuardRefusal({
    giver: {
      accountCreatedAt: giver?.user.createdAt ?? new Date(0),
      joinedAt: giver?.joinedAt ?? null,
      roleIds: giver ? [...giver.roles.cache.keys()] : [],
    },
    receiverRoleIds: receiver ? [...receiver.roles.cache.keys()] : [],
    channelId: input.channelId,
  }, settings);
}

export async function recordRep(client: Client, input: RecordRepInput): Promise<GiveRepResult> {
  const { guildId, giverId, receiverId, reason, receiverIsBot, channelId, messageId } = input;
  // Soi-même ou un bot : le motif propre de `giveRep` est plus clair qu'un garde-fou.
  if (giverId !== receiverId && !receiverIsBot) {
    const refusal = await guardRefusal(client, input, await getReputationConfig(guildId));
    if (refusal) return { success: false, code: refusal };
  }

  const result = await giveRep(guildId, giverId, receiverId, reason, { receiverIsBot, channelId, messageId });
  if (!result.success) return result;

  afterVote(client, input, result.newTotal, result.voteId).catch((err) => {
    logger.warn('Reputation', `Suites du vote pour ${receiverId} interrompues`, err);
  });
  return result;
}

/** Suites d'un vote accepté. Aucune n'en bloque une autre, aucune ne remonte. */
async function afterVote(client: Client, input: RecordRepInput, newTotal: number, voteId: string): Promise<void> {
  const { guildId, giverId, receiverId, channelId } = input;
  const settings = await getReputationConfig(guildId);
  const outcomes = await Promise.allSettled([
    // Un vote vaut toujours +1 : le total d'avant se déduit, sans relire la base.
    applyReputationGain(client, guildId, receiverId, newTotal - 1, newTotal),
    grantRepRewards(client, guildId, receiverId, settings, channelId).then((gains) => recordVoteGains(voteId, gains)),
    // Quête « remercier » : elle avance pour celui qui donne, quelle que soit la source du vote.
    incrementQuestProgress(client, guildId, giverId, 'GIVE_REP', 1, channelId),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logger.warn('Reputation', `Suite d'un vote pour ${receiverId} en échec`, outcome.reason);
    }
  }
}

/**
 * Retire un vote, reprend ses gains et les rôles de palier que le receveur ne
 * remplit plus. `null` si le vote n'existe pas.
 */
export async function revokeRep(client: Client, guildId: string, voteId: string) {
  const vote = await deleteReputationVote(guildId, voteId);
  if (!vote) return null;

  await reclaimRepRewards(client, guildId, vote.receiverId, { xp: vote.xpGranted, coins: vote.coinsGranted }).catch((err) => {
    logger.warn('Reputation', `Gains non repris après le retrait d'un vote pour ${vote.receiverId}`, err);
  });

  // Primaire : le vote vient d'être supprimé, un réplica pourrait encore le compter.
  const total = await receivedTotal(guildId, vote.receiverId, prisma);
  // Annuler un retrait du staff fait remonter le total : les paliers reviennent.
  const tiers = vote.value < 0
    ? applyReputationGain(client, guildId, vote.receiverId, total + vote.value, total)
    : applyReputationLoss(client, guildId, vote.receiverId, total);
  await tiers.catch((err) => {
    logger.warn('Reputation', `Paliers non mis à jour après le retrait d'un vote pour ${vote.receiverId}`, err);
  });
  return vote;
}

export interface AdjustRepInput {
  guildId: string;
  staffId: string;
  userId: string;
  amount: number;
  reason: string | null;
}

/** Ajustement du staff, puis les paliers gagnés ou perdus. Aucun gain d'XP ni de pièces. */
export async function adjustRep(client: Client, input: AdjustRepInput): Promise<AdjustReputationResult> {
  const { guildId, staffId, userId, amount, reason } = input;
  const result = await adjustReputation(guildId, staffId, userId, amount, reason);
  if (!result.success) return result;

  const tiers = result.after > result.before
    ? applyReputationGain(client, guildId, userId, result.before, result.after)
    : applyReputationLoss(client, guildId, userId, result.after);
  await tiers.catch((err) => {
    logger.warn('Reputation', `Paliers non mis à jour après un ajustement pour ${userId}`, err);
  });
  return result;
}

/** Remet un membre à zéro et lui retire ses rôles de palier. Les gains déjà versés restent. */
export async function resetMemberRep(client: Client, guildId: string, userId: string): Promise<number> {
  const count = await resetMemberReputation(guildId, userId);
  await applyReputationLoss(client, guildId, userId, 0).catch((err) => {
    logger.warn('Reputation', `Paliers non retirés après la remise à zéro de ${userId}`, err);
  });
  return count;
}

/**
 * Remet le serveur à zéro. Les rôles de palier repartent en arrière-plan, un
 * membre après l'autre : la requête du dashboard n'attend pas Discord.
 */
export async function resetGuildRep(client: Client, guildId: string): Promise<{ count: number; members: number }> {
  const { count, receiverIds } = await resetGuildReputation(guildId);
  void (async () => {
    for (const userId of receiverIds) {
      await applyReputationLoss(client, guildId, userId, 0).catch((err) => {
        logger.warn('Reputation', `Paliers non retirés après la remise à zéro du serveur pour ${userId}`, err);
      });
    }
  })();
  return { count, members: receiverIds.length };
}
