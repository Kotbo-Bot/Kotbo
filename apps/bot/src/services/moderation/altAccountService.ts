import { SanctionType, LinkedAccountType, LinkedAccountStatus } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { type Client  } from 'discord.js';
import * as sanctionService from './sanctionService.js';
import { notify } from '../notifications/notifyService.js';
import { syncMemberClanFromDcLink } from '../community/clanService.js';
import { recordDecision } from './dc/learning.js';

/**
 * Service pour la gestion des comptes liés (Main/Alt)
 */

/**
 * Récupère tous les IDs de comptes liés à un utilisateur (inclut l'utilisateur lui-même)
 */
export async function getAllLinkedUserIds(guildId: string, userId: string): Promise<string[]> {
  // Seuls les deux identifiants du lien sont lus : inutile de rapatrier la
  // ligne complete (motif de liaison, horodatages, moderateur...).
  const linkColumns = { user1Id: true, user2Id: true } as const;

  const linked = await prisma.linkedAccount.findMany({
    where: {
      guildId,
      status: LinkedAccountStatus.VALIDATED,
      OR: [
        { user1Id: userId },
        { user2Id: userId }
      ]
    },
    select: linkColumns,
  });

  const ids = new Set<string>();
  ids.add(userId);

  let frontier: string[] = [];
  for (const link of linked) {
    for (const id of [link.user1Id, link.user2Id]) {
      if (!ids.has(id)) {
        ids.add(id);
        frontier.push(id);
      }
    }
  }

  // Parcours de la chaine de liens (rare, mais possible). Chaque tour
  // n'interroge que les identifiants decouverts au tour precedent : la version
  // initiale renvoyait l'ensemble accumule, si bien que les memes liens
  // etaient relus a chaque iteration, avec une clause `IN` qui grossissait
  // pendant que le nombre de resultats nouveaux tendait vers zero.
  while (frontier.length > 0) {
    const moreLinked = await prisma.linkedAccount.findMany({
      where: {
        guildId,
        status: LinkedAccountStatus.VALIDATED,
        OR: [
          { user1Id: { in: frontier } },
          { user2Id: { in: frontier } }
        ]
      },
      select: linkColumns,
    });

    const nextFrontier: string[] = [];
    for (const link of moreLinked) {
      for (const id of [link.user1Id, link.user2Id]) {
        if (!ids.has(id)) {
          ids.add(id);
          nextFrontier.push(id);
        }
      }
    }
    frontier = nextFrontier;
  }

  return Array.from(ids);
}

/**
 * Lie deux comptes officiellement
 */
/**
 * Replie les comptes liés d'un serveur sur un identifiant unique.
 *
 * Un membre qui parie depuis son compte principal et depuis son double compte
 * apparaîtrait deux fois dans un classement, avec ses victoires et sa meilleure
 * série coupées en deux. L'identifiant retenu est le plus petit, comme partout
 * ailleurs dans le bot.
 *
 * Une seule requête, quel que soit le nombre de personnes à replier : le faire
 * compte par compte demanderait autant d'allers-retours que de participants.
 */
export async function buildLinkedAccountFolder(guildId: string): Promise<(id: string) => string> {
  const links = await prisma.linkedAccount.findMany({
    where: { guildId, status: LinkedAccountStatus.VALIDATED },
    select: { user1Id: true, user2Id: true },
  });

  const parents = new Map<string, string>();
  const rootOf = (id: string): string => {
    const parent = parents.get(id);
    if (!parent || parent === id) return id;
    const root = rootOf(parent);
    parents.set(id, root);
    return root;
  };

  for (const link of links) {
    const a = rootOf(link.user1Id);
    const b = rootOf(link.user2Id);
    if (a === b) continue;
    parents.set(a < b ? b : a, a < b ? a : b);
  }

  return rootOf;
}

export async function linkAccounts(params: {
  guildId: string;
  user1Id: string;
  user2Id: string;
  type: LinkedAccountType;
  status?: LinkedAccountStatus;
  reason?: string;
  linkedByUserId?: string;
  metadata?: unknown;
}) {
  const { guildId, user1Id, user2Id, type, status = LinkedAccountStatus.VALIDATED, reason, linkedByUserId, metadata } = params;

  // Trier les IDs pour éviter les doublons inversés (user1 < user2)
  const [idA, idB] = [user1Id, user2Id].sort();

  if (idA === idB) return null;

  const result = await prisma.linkedAccount.upsert({
    where: {
      guildId_user1Id_user2Id: {
        guildId,
        user1Id: idA,
        user2Id: idB
      }
    },
    update: {
      type,
      status,
      reason,
      linkedByUserId,
      metadata: metadata || undefined
    },
    create: {
      guildId,
      user1Id: idA,
      user2Id: idB,
      type,
      status,
      reason,
      linkedByUserId,
      metadata: metadata || undefined
    }
  });

  // Notifier les deux utilisateurs (uniquement si validé) et synchroniser leurs clans
  if (status === LinkedAccountStatus.VALIDATED) {
    // Toute liaison validée par un humain (bouton d'alerte, dashboard, /dc, MCP)
    // confirme les détections en attente sur ces comptes : le modèle en apprend.
    if (linkedByUserId) void recordDecision(guildId, [idA, idB], 'TRUE_POSITIVE', linkedByUserId);

    const linked = (userId: string, other: string) => notify({
      guildId, userId, kind: 'security.alt_linked', title: '🔗 Comptes liés',
      message: `Votre compte a été officiellement lié à <@${other}>.`, severity: 'SUCCESS', link: '/profile',
      actorId: linkedByUserId,
    });
    await Promise.all([
      linked(idA, idB),
      linked(idB, idA),
      syncMemberClanFromDcLink(guildId, idA, idB)
    ].map(p => p.catch(() => null)));
  }

  return result;
}

/**
 * Supprime un lien entre deux comptes
 */
export async function unlinkAccounts(guildId: string, user1Id: string, user2Id: string) {
  const [idA, idB] = [user1Id, user2Id].sort();

  const result = await prisma.linkedAccount.deleteMany({
    where: {
      guildId,
      user1Id: idA,
      user2Id: idB
    }
  });

  // Notifier les deux utilisateurs
  const unlinked = (userId: string, other: string) => notify({
    guildId, userId, kind: 'security.alt_unlinked', title: '🔗 Liaison supprimée',
    message: `La liaison avec le compte <@${other}> a été supprimée.`, link: '/profile',
  });
  await Promise.all([unlinked(idA, idB), unlinked(idB, idA)].map(p => p.catch(() => null)));

  return result;
}

/**
 * Synchronise une sanction sur tous les comptes liés
 */
export async function synchronizeSanction(params: {
  client: Client;
  guildId: string;
  originalUserId: string;
  type: SanctionType;
  moderator: { id: string; tag: string };
  reason: string;
  durationMs?: number;
  evidenceLinks?: string[];
}) {
  const { client, guildId, originalUserId, type, moderator, reason, durationMs, evidenceLinks } = params;

  const linkedIds = await getAllLinkedUserIds(guildId, originalUserId);
  const otherIds = linkedIds.filter(id => id !== originalUserId);

  if (otherIds.length === 0) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  logger.info('AltAccount', `Synchronisation de la sanction ${type} pour ${originalUserId} sur ses alts: ${otherIds.join(', ')}`);

  const syncedTargetTags: string[] = [];

  for (const altId of otherIds) {
    try {
      const altMember = await guild.members.fetch(altId).catch(() => null);

      const target = { id: altId, tag: altMember?.user.tag || `Utilisateur inconnu (${altId})` };
      const syncReason = `[Synchronisation DC] ${reason}`;

      switch (type) {
        case SanctionType.WARN:
          await sanctionService.registerWarnSanction({ guildId, target, moderator, reason: syncReason, evidenceLinks, isSync: true });
          break;

        case SanctionType.KICK:
          if (altMember) {
            await altMember.kick(syncReason).catch(() => null);
          }
          await sanctionService.registerKickSanction({ guildId, target, moderator, reason: syncReason, evidenceLinks, isSync: true });
          break;

        case SanctionType.TIMEOUT:
          if (altMember && durationMs) {
            await sanctionService.registerTimeoutSanction({
              guildId,
              target,
              moderator,
              reason: syncReason,
              durationMs,
              member: altMember,
              evidenceLinks,
              isSync: true
            });
          }
          break;

        case SanctionType.BAN:
        case SanctionType.TEMP_BAN:
          await guild.members.ban(altId, { reason: syncReason }).catch(() => null);
          await sanctionService.registerBanSanction({
            guildId,
            target,
            moderator,
            reason: syncReason,
            temporaryDurationMs: durationMs,
            evidenceLinks,
            isSync: true
          });
          break;

        case SanctionType.SOFTBAN:
          await guild.members.ban(altId, { deleteMessageSeconds: 7 * 24 * 3600, reason: syncReason }).catch(() => null);
          await guild.members.unban(altId, `Unban synchronisation softban`).catch(() => null);
          await sanctionService.registerSoftbanSanction({ guildId, target, moderator, reason: syncReason, evidenceLinks, isSync: true });
          break;
      }

      syncedTargetTags.push(target.tag);
    } catch (error) {
      logger.error('AltAccount', `Erreur lors de la synchronisation de la sanction pour l'alt ${altId}:`, error);
    }
  }

  // Une seule notification staff consolidée pour toute la synchronisation, plutôt qu'une par compte lié.
  const originalTarget = await guild.members.fetch(originalUserId).catch(() => null);
  await sanctionService.notifyStaffOfSyncedSanction(
    guildId,
    {
      type,
      targetUserId: originalUserId,
      targetTag: originalTarget?.user.tag || `Utilisateur inconnu (${originalUserId})`,
      moderatorTag: moderator.tag,
      moderatorUserId: moderator.id,
      reason,
    },
    syncedTargetTags,
  ).catch(() => null);
}

/**
 * Trouve les sanctions équivalentes sur les comptes alternatifs
 */
export async function findLinkedSanctionsForAltAccounts(sanction: any): Promise<any[]> {
  const linkedIds = await getAllLinkedUserIds(sanction.guildId, sanction.targetUserId);
  const altIds = linkedIds.filter(id => id !== sanction.targetUserId);
  if (altIds.length === 0) return [];

  const oneMinuteMs = 60 * 1000;
  const minCreated = new Date(sanction.createdAt.getTime() - oneMinuteMs);
  const maxCreated = new Date(sanction.createdAt.getTime() + oneMinuteMs);

  const potentialSanctions = await prisma.sanction.findMany({
    where: {
      guildId: sanction.guildId,
      targetUserId: { in: altIds },
      type: sanction.type,
      moderatorUserId: sanction.moderatorUserId,
      createdAt: {
        gte: minCreated,
        lte: maxCreated
      }
    }
  });

  const cleanReason = (r: string) => r.replace('[Synchronisation DC] ', '').trim();
  const cleanS1 = cleanReason(sanction.reason);

  return potentialSanctions.filter(s => {
    const cleanS = cleanReason(s.reason);
    return cleanS === cleanS1 || cleanS.includes(cleanS1) || cleanS1.includes(cleanS);
  });
}

/**
 * Synchronise les rapports de sanction sur les comptes liés (création/mise à jour)
 */
export async function syncAltAccountSanctionReports(
  guildId: string,
  sanctionId: string,
  evidenceLinks: string[],
  sourceReportData?: any
) {
  const sanction = await prisma.sanction.findUnique({
    where: { id: sanctionId }
  });
  if (!sanction) return;

  const linkedSanctions = await findLinkedSanctionsForAltAccounts(sanction);
  if (linkedSanctions.length === 0) return;

  const sourceReport = sourceReportData || await prisma.sanctionReport.findFirst({
    where: { sanctionId }
  });
  if (!sourceReport) return;

  const { formatSanctionDurationLabel } = await import('./sanctionService.js');

  for (const altSanction of linkedSanctions) {
    const existingReport = await prisma.sanctionReport.findFirst({
      where: { guildId, sanctionId: altSanction.id }
    });

    if (existingReport) {
      await prisma.sanctionReport.update({
        where: { id: existingReport.id },
        data: {
          evidenceLinks,
          brokenRules: sourceReport.brokenRules,
          detailedReason: sourceReport.detailedReason,
          additionalNotes: sourceReport.additionalNotes,
        }
      });
    } else {
      const staffPseudo = altSanction.moderatorTag?.trim() || sourceReport.staffPseudo;
      const memberPseudo = altSanction.targetTag?.trim() || `Utilisateur ${altSanction.targetUserId}`;
      const memberReference = altSanction.targetUserId;
      const sanctionDurationLabel = formatSanctionDurationLabel(altSanction.durationSeconds);

      await prisma.sanctionReport.create({
        data: {
          guildId,
          sanctionId: altSanction.id,
          staffPseudo,
          incidentAt: sourceReport.incidentAt,
          memberPseudo,
          memberReference,
          sanctionType: altSanction.type,
          sanctionDurationLabel,
          brokenRules: sourceReport.brokenRules,
          detailedReason: sourceReport.detailedReason,
          evidenceLinks,
          additionalNotes: sourceReport.additionalNotes,
          createdByUserId: sourceReport.createdByUserId,
          createdByTag: sourceReport.createdByTag,
        }
      });
    }
  }
}
