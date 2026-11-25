/**
 * Signalement à la cellule bien-être depuis Discord (`/bienetre signaler`).
 *
 * Un signalement anonyme ne garde aucune trace de son auteur : ni dans le
 * dossier, ni dans l'historique, ni dans l'alerte. Les comptages de commandes
 * et de modules l'ignorent aussi (voir `index.ts`). Seule la limite d'envoi
 * connaît l'auteur, en mémoire, le temps du délai.
 *
 * L'auteur reçoit un code de suivi (`/bienetre suivi`) : il y lit l'état de
 * son signalement, jamais son contenu ni qui le traite. Seule l'empreinte du
 * code est gardée, si bien que la base ne relie pas un code à une personne.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { sendWellbeingAlert } from './wellbeingAlerts.js';
import { sealCaseFields } from './wellbeingCrypto.js';
import { appendCaseEvents } from './wellbeingEvents.js';
import {
  REPORT_COOLDOWN_MS,
  TRACKING_LOOKUP_COOLDOWN_MS,
  generateTrackingCode,
  shouldAcceptReport,
  trackingCodeHash,
  trackingStatus,
} from './wellbeingPolicy.js';

export const REPORT_MODAL_PREFIX = 'wellbeing:report:';
export const REPORT_MAX_LENGTH = 2000;

const ANONYMOUS_ID = 'ANONYMOUS';
const ANONYMOUS_NAME = 'Anonyme';
const lastReport = new Map<string, number>();

export type ReportOutcome = 'sent' | 'disabled' | 'cooldown' | 'empty';
export interface ReportResult {
  outcome: ReportOutcome;
  /** Code de suivi, rendu une seule fois à l'auteur. */
  code?: string;
}

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
): Promise<ReportResult> {
  const summary = message.trim().slice(0, REPORT_MAX_LENGTH);
  if (!summary) return { outcome: 'empty' };
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId } });
  if (!config?.enabled || !config.reportEnabled) return { outcome: 'disabled' };

  const key = `${guildId}:${author.id}`;
  const now = Date.now();
  if (!shouldAcceptReport(lastReport.get(key), now)) return { outcome: 'cooldown' };
  lastReport.set(key, now);
  for (const [k, at] of lastReport) if (now - at >= REPORT_COOLDOWN_MS) lastReport.delete(k);

  const code = generateTrackingCode();
  const created = await prisma.wellbeingCase.create({
    data: {
      guildId,
      trackingCodeHash: trackingCodeHash(guildId, code),
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
  await appendCaseEvents(created.id, [{
    actorId: anonymous ? null : author.id,
    actorName: anonymous ? ANONYMOUS_NAME : author.username,
    type: 'CREATED',
    toValue: 'DISCORD',
  }]);
  void sendWellbeingAlert(client, guildId, config, 'REPORT', { actorId: anonymous ? '' : author.id, anonymous });
  return { outcome: 'sent', code };
}

const lastLookup = new Map<string, number>();

/**
 * État d'un signalement d'après son code. La limite par personne rend un code
 * impossible à deviner par essais ; elle ne garde rien au-delà du délai.
 */
export async function lookupWellbeingReport(
  guildId: string,
  userId: string,
  code: string,
): Promise<ReturnType<typeof trackingStatus> | 'cooldown'> {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = lastLookup.get(key);
  if (last !== undefined && now - last < TRACKING_LOOKUP_COOLDOWN_MS) return 'cooldown';
  lastLookup.set(key, now);
  for (const [k, at] of lastLookup) if (now - at >= TRACKING_LOOKUP_COOLDOWN_MS) lastLookup.delete(k);

  const item = await prisma.wellbeingCase.findUnique({
    where: { trackingCodeHash: trackingCodeHash(guildId, code) },
    select: { guildId: true, status: true, assigneeId: true, deletedAt: true },
  });
  return trackingStatus(item && item.guildId === guildId ? item : null);
}
