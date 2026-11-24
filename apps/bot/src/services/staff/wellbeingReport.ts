/**
 * Signalement à la cellule bien-être depuis Discord (`/bienetre signaler`).
 *
 * Un signalement anonyme ne garde aucune trace de son auteur : ni dans le
 * dossier, ni dans l'historique, ni dans l'alerte. Les comptages de commandes
 * et de modules l'ignorent aussi (voir `index.ts`). Seule la limite d'envoi
 * connaît l'auteur, en mémoire, le temps du délai.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { sendWellbeingAlert } from './wellbeingAlerts.js';
import { sealCaseFields } from './wellbeingCrypto.js';
import { shouldAcceptReport, REPORT_COOLDOWN_MS } from './wellbeingPolicy.js';

export const REPORT_MODAL_PREFIX = 'wellbeing:report:';
export const REPORT_MAX_LENGTH = 2000;

const ANONYMOUS_ID = 'ANONYMOUS';
const ANONYMOUS_NAME = 'Anonyme';
const lastReport = new Map<string, number>();

export type ReportOutcome = 'sent' | 'disabled' | 'cooldown' | 'empty';

/** La cellule accepte-t-elle les signalements sur ce serveur ? */
export async function reportsOpen(guildId: string): Promise<boolean> {
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId }, select: { enabled: true, reportEnabled: true } });
  return !!config?.enabled && config.reportEnabled;
}

export async function submitWellbeingReport(
  client: Client,
  guildId: string,
  author: { id: string; username: string },
  message: string,
  anonymous: boolean,
): Promise<ReportOutcome> {
  const summary = message.trim().slice(0, REPORT_MAX_LENGTH);
  if (!summary) return 'empty';
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId } });
  if (!config?.enabled || !config.reportEnabled) return 'disabled';

  const key = `${guildId}:${author.id}`;
  const now = Date.now();
  if (!shouldAcceptReport(lastReport.get(key), now)) return 'cooldown';
  lastReport.set(key, now);
  for (const [k, at] of lastReport) if (now - at >= REPORT_COOLDOWN_MS) lastReport.delete(k);

  const created = await prisma.wellbeingCase.create({
    data: {
      guildId,
      subjectUserId: anonymous ? null : author.id,
      ...sealCaseFields(guildId, {
        title: 'Signalement depuis Discord',
        subjectName: anonymous ? ANONYMOUS_NAME : author.username,
        summary,
      }),
      category: 'SIGNALEMENT',
      severity: 'NORMAL',
      source: 'DISCORD',
      createdById: anonymous ? ANONYMOUS_ID : author.id,
      createdByName: anonymous ? ANONYMOUS_NAME : author.username,
    },
    select: { id: true },
  });
  await prisma.wellbeingCaseEvent.create({
    data: {
      caseId: created.id,
      actorId: anonymous ? null : author.id,
      actorName: anonymous ? ANONYMOUS_NAME : author.username,
      type: 'CREATED',
      toValue: 'DISCORD',
    },
  });
  void sendWellbeingAlert(client, guildId, config, 'REPORT', { actorId: anonymous ? '' : author.id, anonymous });
  return 'sent';
}
