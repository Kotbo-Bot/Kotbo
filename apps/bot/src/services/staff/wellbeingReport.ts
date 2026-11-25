/**
 * Signalement à la cellule bien-être depuis Discord (`/bienetre signaler`).
 *
 * Un signalement anonyme ne garde aucune trace de son auteur : ni dans le
 * dossier, ni dans l'historique, ni dans l'alerte. Les comptages de commandes
 * et de modules l'ignorent aussi (voir `index.ts`). Seule la limite d'envoi
 * connaît l'auteur, en mémoire, le temps du délai.
 *
 * L'auteur reçoit un code de suivi (`/bienetre suivi`) : il y lit l'état de
 * son signalement et les derniers échanges avec la cellule, jamais qui le
 * traite. Avec ce code, il peut aussi répondre (`/bienetre repondre`) sans que
 * la cellule sache qui il est. Seule l'empreinte du code est gardée, si bien
 * que la base ne relie pas un code à une personne.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { sendWellbeingAlert } from './wellbeingAlerts.js';
import { openReporterMessage, sealCaseFields, sealWellbeing } from './wellbeingCrypto.js';
import { appendCaseEvents } from './wellbeingEvents.js';
import {
  REPORT_COOLDOWN_MS,
  REPORTER_REPLY_MAX,
  TRACKING_LOOKUP_COOLDOWN_MS,
  generateTrackingCode,
  reporterCanWrite,
  shouldAcceptReport,
  trackingCodeHash,
  trackingStatus,
  trackingThread,
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
 * Une même personne ne vérifie un code, ou n'écrit avec, qu'à ce rythme :
 * deviner un code par essais reste hors de portée. Chaque usage a son propre
 * délai, pour qu'on puisse répondre juste après avoir lu le suivi. Rien n'est
 * gardé au-delà du délai.
 */
function lookupThrottled(scope: 'track' | 'reply', guildId: string, userId: string): boolean {
  const key = `${scope}:${guildId}:${userId}`;
  const now = Date.now();
  const last = lastLookup.get(key);
  if (last !== undefined && now - last < TRACKING_LOOKUP_COOLDOWN_MS) return true;
  lastLookup.set(key, now);
  for (const [k, at] of lastLookup) if (now - at >= TRACKING_LOOKUP_COOLDOWN_MS) lastLookup.delete(k);
  return false;
}

async function findReport(guildId: string, code: string) {
  const item = await prisma.wellbeingCase.findUnique({
    where: { trackingCodeHash: trackingCodeHash(guildId, code) },
    select: {
      id: true,
      guildId: true,
      status: true,
      assigneeId: true,
      deletedAt: true,
      reporterMessages: { orderBy: { createdAt: 'asc' }, select: { fromReporter: true, content: true, createdAt: true } },
    },
  });
  return item && item.guildId === guildId ? item : null;
}

export interface TrackingMessage {
  fromReporter: boolean;
  content: string;
}

/** État d'un signalement d'après son code, et ses derniers échanges avec la cellule. */
export async function lookupWellbeingReport(
  guildId: string,
  userId: string,
  code: string,
): Promise<{ status: ReturnType<typeof trackingStatus> | 'cooldown'; thread: TrackingMessage[] }> {
  if (lookupThrottled('track', guildId, userId)) return { status: 'cooldown', thread: [] };
  const found = await findReport(guildId, code);
  // Un dossier à la corbeille ne montre plus ses échanges.
  const thread = found && !found.deletedAt
    ? trackingThread(found.reporterMessages).map((message) => {
        const { fromReporter, content } = openReporterMessage(guildId, message);
        return { fromReporter, content };
      })
    : [];
  return { status: trackingStatus(found), thread };
}

export type ReporterMessageOutcome = 'sent' | 'cooldown' | 'unknown' | 'closed' | 'empty';

/**
 * Message de l'auteur d'un signalement à la cellule, avec son code de suivi.
 * Rien ne relie le message à la personne qui l'envoie.
 */
export async function postReporterMessage(
  client: Client,
  guildId: string,
  userId: string,
  code: string,
  message: string,
): Promise<ReporterMessageOutcome> {
  const content = message.trim().slice(0, REPORTER_REPLY_MAX);
  if (!content) return 'empty';
  if (lookupThrottled('reply', guildId, userId)) return 'cooldown';
  const found = await findReport(guildId, code);
  if (!found) return 'unknown';
  const config = await prisma.wellbeingConfig.findUnique({ where: { guildId } });
  if (!config?.enabled || !reporterCanWrite(found, found.reporterMessages.filter((m) => m.fromReporter).length)) return 'closed';

  await prisma.wellbeingReporterMessage.create({
    data: { caseId: found.id, fromReporter: true, content: sealWellbeing(guildId, content) },
  });
  await prisma.wellbeingCase.update({ where: { id: found.id }, data: { lastActivityAt: new Date() } });
  await appendCaseEvents(found.id, [{ actorId: null, actorName: ANONYMOUS_NAME, type: 'REPORTER_MESSAGE' }]);
  void sendWellbeingAlert(client, guildId, config, 'REPORT', { actorId: '', followUp: true }, found.assigneeId ? [found.assigneeId] : []);
  return 'sent';
}
