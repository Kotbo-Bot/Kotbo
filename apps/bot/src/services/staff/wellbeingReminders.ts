/**
 * Relances de la cellule bien-être, passées toutes les heures.
 *
 * - Échéance de suivi atteinte : le référent est prévenu, ainsi que les
 *   destinataires des alertes s'ils suivent l'événement REMINDER. Une fois par
 *   échéance : la reporter la réarme.
 * - Dossier critique sans activité depuis `staleCriticalDays` : même relance,
 *   au plus une fois par période d'inactivité.
 *
 * Aucune relance ne dit quoi que ce soit du contenu d'un dossier.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { sendWellbeingAlert } from './wellbeingAlerts.js';
import { staleCutoff } from './wellbeingPolicy.js';

const SYSTEM_ACTOR = 'Relance automatique';

async function remind(client: Client, item: { id: string; guildId: string; assigneeId: string | null }, ctx: { reminder: 'review' | 'stale'; days?: number }) {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId: item.guildId } });
  if (!config?.enabled || !(await isModuleEnabled(item.guildId, 'wellbeing'))) return false;
  await sendWellbeingAlert(client, item.guildId, config, 'REMINDER', { actorId: '', ...ctx }, item.assigneeId ? [item.assigneeId] : []);
  await prisma.wellbeingCaseEvent.create({
    data: { caseId: item.id, actorId: null, actorName: SYSTEM_ACTOR, type: 'REMINDER', toValue: ctx.reminder },
  });
  return true;
}

export async function runWellbeingReminders(client: Client, now: Date = new Date()): Promise<void> {
  try {
    const due = await prisma.wellbeingCase.findMany({
      where: { status: { not: 'CLOSED' }, reviewAt: { lte: now }, reviewRemindedAt: null },
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
  } catch (error) {
    logger.error('Wellbeing', 'Relances de la cellule en échec :', error);
  }
}
