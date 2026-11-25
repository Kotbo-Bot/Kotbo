/**
 * Relances de la cellule bien-être, passées toutes les heures.
 *
 * - Échéance de suivi atteinte : le référent est prévenu, ainsi que les
 *   destinataires des alertes s'ils suivent l'événement REMINDER. Une fois par
 *   échéance : la reporter la réarme.
 * - Dossier critique sans activité depuis `staleCriticalDays` : même relance,
 *   au plus une fois par période d'inactivité.
 *
 * - Effacement d'un dossier fermé dans une semaine : la cellule est prévenue
 *   une fois (PURGE_SOON) et peut le prolonger.
 * - Revue des accès : le propriétaire reçoit en privé, tous les 30 jours sans
 *   confirmation, la liste de qui lit les dossiers.
 * - Référent absent : ses relances vont au suppléant de la cellule.
 * - Résumé du lundi : chaque membre de la cellule reçoit ses chiffres de la semaine.
 *
 * Aucune relance ne dit quoi que ce soit du contenu d'un dossier.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { sendWellbeingAlert, sendWellbeingDirect } from './wellbeingAlerts.js';
import { appendCaseEvents } from './wellbeingEvents.js';
import {
  accessReviewMessage,
  cellMemberIds,
  digestCounts,
  digestDue,
  purgeNoticeCutoff,
  reminderRecipient,
  shouldSendAccessReview,
  staleCutoff,
  weeklyDigestText,
} from './wellbeingPolicy.js';
import { currentAbsence } from './wellbeingAbsence.js';

const SYSTEM_ACTOR = 'Relance automatique';

async function remind(client: Client, item: { id: string; guildId: string; assigneeId: string | null }, ctx: { reminder: 'review' | 'stale'; days?: number }) {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId: item.guildId } });
  if (!config?.enabled || !(await isModuleEnabled(item.guildId, 'wellbeing'))) return false;
  const absent = item.assigneeId && (await currentAbsence(item.guildId, item.assigneeId)) ? new Set([item.assigneeId]) : new Set<string>();
  const recipient = reminderRecipient(item.assigneeId, absent, config.backupUserId);
  await sendWellbeingAlert(client, item.guildId, config, 'REMINDER', { actorId: '', ...ctx }, recipient ? [recipient] : []);
  await appendCaseEvents(item.id, [{ actorId: null, actorName: SYSTEM_ACTOR, type: 'REMINDER', toValue: ctx.reminder }]);
  return true;
}

export async function runWellbeingReminders(client: Client, now: Date = new Date()): Promise<void> {
  try {
    const due = await prisma.wellbeingCase.findMany({
      where: { status: { not: 'CLOSED' }, deletedAt: null, reviewAt: { lte: now }, reviewRemindedAt: null },
      select: { id: true, guildId: true, assigneeId: true },
      take: 200,
    });
    for (const item of due) {
      // Marqué même si le module est coupé : la relance ne repartirait pas en rafale à sa réouverture.
      await remind(client, item, { reminder: 'review' });
      await prisma.wellbeingCase.update({ where: { id: item.id }, data: { reviewRemindedAt: now } });
    }

    const configs = await prisma.wellbeingConfig.findMany({
      where: { enabled: true, staleCriticalDays: { gt: 0 } },
      select: { guildId: true, staleCriticalDays: true },
    });
    for (const { guildId, staleCriticalDays } of configs) {
      const cutoff = staleCutoff(now, staleCriticalDays);
      const stale = await prisma.wellbeingCase.findMany({
        where: {
          guildId,
          severity: 'CRITICAL',
          status: { not: 'CLOSED' },
          deletedAt: null,
          lastActivityAt: { lt: cutoff },
          OR: [{ staleRemindedAt: null }, { staleRemindedAt: { lt: cutoff } }],
        },
        select: { id: true, guildId: true, assigneeId: true },
        take: 50,
      });
      for (const item of stale) {
        if (await remind(client, item, { reminder: 'stale', days: staleCriticalDays })) {
          await prisma.wellbeingCase.update({ where: { id: item.id }, data: { staleRemindedAt: now } });
        }
      }
    }
    await announcePurges(client, now);
    await sendAccessReviews(client, now);
    await sendWeeklyDigests(client, now);
  } catch (error) {
    logger.error('Wellbeing', 'Relances de la cellule en échec :', error);
  }
}

/**
 * Dossiers fermés effacés dans une semaine : une alerte par serveur, une seule
 * fois par dossier. Une annonce plus ancienne que la dernière modification ne
 * compte plus (dossier rouvert puis refermé) : il est annoncé à nouveau.
 */
async function announcePurges(client: Client, now: Date): Promise<void> {
  const soon = await prisma.wellbeingCase.findMany({
    where: {
      status: 'CLOSED',
      deletedAt: null,
      updatedAt: { lt: purgeNoticeCutoff(now) },
      OR: [{ purgeWarnedAt: null }, { purgeWarnedAt: { lt: prisma.wellbeingCase.fields.updatedAt } }],
    },
    select: { id: true, guildId: true, updatedAt: true },
    take: 500,
  });
  const byGuild = new Map<string, typeof soon>();
  for (const item of soon) byGuild.set(item.guildId, [...(byGuild.get(item.guildId) ?? []), item]);
  for (const [guildId, items] of byGuild) {
    const config = await prisma.wellbeingConfig.findUnique({ where: { guildId } });
    if (config?.enabled && (await isModuleEnabled(guildId, 'wellbeing'))) {
      await sendWellbeingAlert(client, guildId, config, 'PURGE_SOON', { actorId: '', caseCount: items.length });
    }
    // `updatedAt` est réécrit tel quel : marquer l'annonce ne doit pas repousser l'effacement d'un an.
    for (const item of items) {
      await prisma.wellbeingCase.update({ where: { id: item.id }, data: { purgeWarnedAt: now, updatedAt: item.updatedAt } });
    }
  }
}

/** Rappel au propriétaire de revoir qui lit les dossiers. */
async function sendAccessReviews(client: Client, now: Date): Promise<void> {
  const configs = await prisma.wellbeingConfig.findMany({ where: { enabled: true } });
  for (const config of configs) {
    if (!shouldSendAccessReview(config, now) || !(await isModuleEnabled(config.guildId, 'wellbeing'))) continue;
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) continue;
    const nameOf = (id: string) => {
      const role = guild.roles.cache.get(id);
      if (role) return `@${role.name}`;
      return guild.members.cache.get(id)?.user.username ?? `<@${id}>`;
    };
    const owner = await client.users.fetch(guild.ownerId).catch(() => null);
    const sent = owner
      ? await owner.send({ content: accessReviewMessage(guild.name, config, nameOf), allowedMentions: { parse: [] } }).then(() => true, () => false)
      : false;
    // Marqué même sans message privé possible : le rappel ne repart pas chaque heure.
    await prisma.wellbeingConfig.update({ where: { guildId: config.guildId }, data: { accessReviewSentAt: now } });
    if (!sent) logger.warn('Wellbeing', `Revue des accès : message privé impossible au propriétaire de ${config.guildId}.`);
  }
}

/** Résumé du lundi : à chaque membre de la cellule, ses chiffres, sans contenu. */
async function sendWeeklyDigests(client: Client, now: Date): Promise<void> {
  const configs = await prisma.wellbeingConfig.findMany({ where: { enabled: true } });
  for (const config of configs) {
    if (!digestDue(config.digestSentAt, now) || !(await isModuleEnabled(config.guildId, 'wellbeing'))) continue;
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) continue;
    // Marqué d'abord : une erreur d'envoi ne fait pas repartir le résumé chaque heure.
    await prisma.wellbeingConfig.update({ where: { guildId: config.guildId }, data: { digestSentAt: now } });
    const members = guild.members.cache.map((member) => ({ id: member.id, roleIds: [...member.roles.cache.keys()] }));
    const cases = await prisma.wellbeingCase.findMany({
      where: { guildId: config.guildId, deletedAt: null, status: { not: 'CLOSED' } },
      select: { status: true, severity: true, source: true, assigneeId: true, subjectUserId: true, reviewAt: true },
    });
    for (const memberId of cellMemberIds(config, members)) {
      const text = weeklyDigestText(guild.name, digestCounts(cases, memberId, now));
      if (text) await sendWellbeingDirect(client, [memberId], text);
    }
  }
}
