import { EmbedBuilder, type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// Retours envoyés depuis le dashboard : statuts, droits d'accès et MP.

export const FEEDBACK_STATUSES = ['NEW', 'ACKNOWLEDGED', 'PLANNED', 'DONE', 'DECLINED'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_TYPES = ['retour', 'bloquage', 'suggestion', 'autre'] as const;

export const FEEDBACK_MESSAGE_MAX = 2000;

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  NEW: 'Nouveau',
  ACKNOWLEDGED: 'Pris en compte',
  PLANNED: 'Prévu',
  DONE: 'Fait',
  DECLINED: 'Refusé',
};

const STATUS_COLORS: Record<FeedbackStatus, number> = {
  NEW: 0x3b82f6,
  ACKNOWLEDGED: 0x8b5cf6,
  PLANNED: 0xf59e0b,
  DONE: 0x10b981,
  DECLINED: 0x6b7280,
};

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

/** Texte d'un message de conversation : rogné, ou `null` s'il est vide ou n'est pas du texte. */
export function cleanFeedbackText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, FEEDBACK_MESSAGE_MAX);
  return text === '' ? null : text;
}

/** Seuls l'auteur du retour et les admins globaux peuvent le lire ou y répondre. */
export function canAccessFeedback(feedback: { userId: string }, userId: string, isAdmin: boolean): boolean {
  return isAdmin || feedback.userId === userId;
}

/** Admins globaux (propriétaire + table GlobalAdmin), sans doublon. */
export async function listGlobalAdminIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const owner = process.env.DISCORD_CLIENT_OWNER_ID;
  if (owner) ids.add(owner);
  const rows = await prisma.globalAdmin.findMany({ select: { userId: true } });
  for (const row of rows) ids.add(row.userId);
  return ids;
}

/** MP au mieux : un MP fermé ne doit jamais faire échouer l'action du staff. */
async function sendDm(client: Client, userId: string, embed: EmbedBuilder): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    logger.warn('Feedback', `MP impossible à ${userId} : ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Prévient l'auteur d'un changement de statut et/ou d'une réponse du staff. */
export function notifyFeedbackAuthor(
  client: Client,
  feedback: { id: string; userId: string; message: string },
  update: { status?: FeedbackStatus; reply?: string },
): Promise<boolean> {
  const embed = new EmbedBuilder()
    .setTitle(update.status ? `📬 Ton retour est : ${STATUS_LABELS[update.status]}` : '💬 Réponse à ton retour')
    .setColor(update.status ? STATUS_COLORS[update.status] : 0x3b82f6)
    .setDescription(update.reply ?? 'Le statut de ton retour a changé.')
    .addFields({ name: 'Ton retour', value: feedback.message.slice(0, 300) })
    .setFooter({ text: 'Tu peux répondre depuis le dashboard, dans Mes retours.' });
  return sendDm(client, feedback.userId, embed);
}

/** Prévient les admins qu'un auteur a répondu sur son retour. */
export async function notifyFeedbackAdmins(
  client: Client,
  feedback: { id: string },
  author: string,
  reply: string,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('💬 Réponse sur un retour')
    .setColor(0x3b82f6)
    .setDescription(reply)
    .addFields({ name: 'Auteur', value: author.slice(0, 100) })
    .setFooter({ text: `Retour ${feedback.id}` });
  for (const adminId of await listGlobalAdminIds()) await sendDm(client, adminId, embed);
}
