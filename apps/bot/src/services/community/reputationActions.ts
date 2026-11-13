/**
 * Points d'entrée d'un vote de réputation, quelle que soit sa source (commande,
 * menu contextuel, dashboard) : le vote lui-même, puis ce qui en découle.
 *
 * Les suites (rôles de palier, annonce) partent sans être attendues : elles
 * parlent à Discord, et une interaction doit répondre en moins de trois
 * secondes. Leur échec est journalisé, jamais remonté au vote.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { deleteReputationVote, giveRep, receivedTotal, type GiveRepResult } from './reputationService.js';
import { applyReputationGain, applyReputationLoss } from './reputationTierService.js';

export interface RecordRepInput {
  guildId: string;
  giverId: string;
  receiverId: string;
  reason?: string;
  receiverIsBot?: boolean;
  channelId?: string;
  messageId?: string;
}

export async function recordRep(client: Client, input: RecordRepInput): Promise<GiveRepResult> {
  const { guildId, giverId, receiverId, reason, receiverIsBot, channelId, messageId } = input;
  const result = await giveRep(guildId, giverId, receiverId, reason, { receiverIsBot, channelId, messageId });
  if (!result.success) return result;

  // Un vote vaut toujours +1 : le total d'avant se déduit, sans relire la base.
  applyReputationGain(client, guildId, receiverId, result.newTotal - 1, result.newTotal).catch((err) => {
    logger.warn('Reputation', `Paliers non appliqués après un vote pour ${receiverId}`, err);
  });
  return result;
}

/** Retire un vote et les rôles de palier que le receveur ne remplit plus. `null` si le vote n'existe pas. */
export async function revokeRep(client: Client, guildId: string, voteId: string) {
  const vote = await deleteReputationVote(guildId, voteId);
  if (!vote) return null;

  // Primaire : le vote vient d'être supprimé, un réplica pourrait encore le compter.
  const total = await receivedTotal(guildId, vote.receiverId, prisma);
  await applyReputationLoss(client, guildId, vote.receiverId, total).catch((err) => {
    logger.warn('Reputation', `Paliers non retirés après le retrait d'un vote pour ${vote.receiverId}`, err);
  });
  return vote;
}
