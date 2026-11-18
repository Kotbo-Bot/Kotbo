import type { MemberHistoryEntry, MemberHistoryField } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

/**
 * Enregistre un changement d'attribut d'identité pour un membre.
 * Pseudos, descriptions, pseudos d'affichage, photos de profil, tags et pronoms.
 */
export async function recordMemberIdentityChange(
  guildId: string,
  userId: string,
  field: MemberHistoryField,
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
): Promise<void> {
  const oldVal = oldValue?.trim() || null;
  const newVal = newValue?.trim() || null;

  // Rien n'a changé
  if (oldVal === newVal) return;
  // Pas d'ancienne ni de nouvelle valeur signifiante
  if (!oldVal && !newVal) return;

  try {
    // Évite les doublons consécutifs identiques
    const latest = await prisma.memberProfileHistory.findFirst({
      where: { guildId, userId, field },
      orderBy: { recordedAt: 'desc' },
      select: { newValue: true },
    });

    if (latest && latest.newValue === newVal) {
      return;
    }

    await prisma.memberProfileHistory.create({
      data: {
        guildId,
        userId,
        field,
        oldValue: oldVal,
        newValue: newVal,
      },
    });
  } catch (err) {
    logger.warn('MemberHistory', `Erreur lors de l'enregistrement de l'historique ${field} pour ${userId}:`, err);
  }
}

/**
 * Compare deux états d'identité d'un membre et enregistre chaque divergence observée.
 */
export async function compareAndRecordIdentityChanges(
  guildId: string,
  userId: string,
  before: {
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    primaryGuildTag?: string | null;
    pronouns?: string | null;
  },
  after: {
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    primaryGuildTag?: string | null;
    pronouns?: string | null;
  },
): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (before.username !== undefined && after.username !== undefined && before.username !== after.username) {
    tasks.push(recordMemberIdentityChange(guildId, userId, 'username', before.username, after.username));
  }
  if (before.displayName !== undefined && after.displayName !== undefined && before.displayName !== after.displayName) {
    tasks.push(recordMemberIdentityChange(guildId, userId, 'displayName', before.displayName, after.displayName));
  }
  if (before.avatarUrl !== undefined && after.avatarUrl !== undefined && before.avatarUrl !== after.avatarUrl) {
    tasks.push(recordMemberIdentityChange(guildId, userId, 'avatar', before.avatarUrl, after.avatarUrl));
  }
  if (before.bio !== undefined && after.bio !== undefined && before.bio !== after.bio) {
    tasks.push(recordMemberIdentityChange(guildId, userId, 'bio', before.bio, after.bio));
  }
  if (before.primaryGuildTag !== undefined && after.primaryGuildTag !== undefined && before.primaryGuildTag !== after.primaryGuildTag) {
    tasks.push(recordMemberIdentityChange(guildId, userId, 'tag', before.primaryGuildTag, after.primaryGuildTag));
  }
  if (before.pronouns !== undefined && after.pronouns !== undefined && before.pronouns !== after.pronouns) {
    tasks.push(recordMemberIdentityChange(guildId, userId, 'pronouns', before.pronouns, after.pronouns));
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

/**
 * Récupère l'historique d'identité d'un membre, du plus récent au plus ancien.
 */
export async function getMemberIdentityHistory(
  guildId: string,
  userId: string,
  limit = 100,
): Promise<MemberHistoryEntry[]> {
  const rows = (await prisma.memberProfileHistory.findMany({
    where: { guildId, userId },
    orderBy: { recordedAt: 'desc' },
    take: limit,
  }).catch((err) => {
    logger.warn('MemberHistory', `Erreur de lecture de l'historique pour ${userId}:`, err);
    return [];
  })) ?? [];

  return rows.map((r) => ({
    id: r.id,
    field: r.field as MemberHistoryField,
    oldValue: r.oldValue,
    newValue: r.newValue,
    recordedAt: r.recordedAt.toISOString(),
  }));
}
