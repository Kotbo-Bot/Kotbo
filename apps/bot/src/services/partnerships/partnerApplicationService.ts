/**
 * Candidatures de partenariat.
 *
 * Distinctes des dossiers : la plupart des candidatures n'en deviendront pas
 * un, et les mélanger polluerait le pipeline de demandes non instruites.
 *
 * Chaque candidature est passée au crible à la réception (`screenApplication`)
 * et le résultat est affiché au staff avant décision. Le filtrage ne refuse
 * jamais de lui-même, sauf si le serveur l'a explicitement demandé pour les
 * seuils d'effectif : un signal du réseau ou un serveur récent sont des
 * éléments d'appréciation, pas des verdicts.
 */
import type { PartnerApplication, PartnerApplicationStatus } from '@prisma/client';
import { isPartnershipType } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { notify } from '../notifications/notifyService.js';
import { getPartnershipSettings } from './partnershipSettings.js';
import { sendPartnershipAlert } from './partnershipEvents.js';
import { createPartner } from './partnerService.js';
import { createPartnership, type PartnershipActor } from './partnershipService.js';

export interface ApplicationInput {
  guildId: string | null;
  source?: 'form' | 'ticket' | 'command' | 'directory' | 'manual';
  applicantUserId?: string | null;
  applicantTag?: string | null;
  projectName: string;
  projectKind?: string;
  projectGuildId?: string | null;
  inviteUrl?: string | null;
  memberCount?: number | null;
  description?: string | null;
  requestedType?: string | null;
  answers?: Record<string, unknown>;
}

/**
 * Enregistre une candidature, la passe au crible et prévient le staff.
 *
 * Renvoie la candidature créée, ou `null` si les candidatures sont fermées -
 * ce que l'appelant doit savoir dire au demandeur plutôt que de laisser croire
 * que sa demande est partie.
 */
export async function submitApplication(input: ApplicationInput): Promise<PartnerApplication | null> {
  if (input.guildId) {
    const settings = await getPartnershipSettings(input.guildId);
    if (!settings.enabled || !settings.applicationsOpen) return null;
  }

  const screening = input.guildId ? await screenApplication(input.guildId, input) : { flags: [], blocking: false };

  const application = await prisma.partnerApplication.create({
    data: {
      scope: input.guildId ? 'GUILD' : 'PLATFORM',
      guildId: input.guildId,
      source: input.source ?? 'form',
      applicantUserId: input.applicantUserId ?? null,
      applicantTag: input.applicantTag?.slice(0, 60) ?? null,
      projectName: input.projectName.slice(0, 120),
      projectKind: input.projectKind ?? 'SERVER',
      projectGuildId: input.projectGuildId ?? null,
      inviteUrl: input.inviteUrl?.slice(0, 300) ?? null,
      memberCount: input.memberCount ?? null,
      description: input.description?.slice(0, 4000) ?? null,
      requestedType: input.requestedType && isPartnershipType(input.requestedType) ? input.requestedType : null,
      answers: (input.answers ?? undefined) as never,
      screening: screening as never,
    },
  });

  if (input.guildId && screening.blocking) {
    const settings = await getPartnershipSettings(input.guildId);
    if (settings.autoRejectBelowThreshold) {
      return decideApplication(application.id, 'REJECTED', {
        userId: 'bot',
        source: 'bot',
        reason: screening.flags.join(' ; '),
      });
    }
  }

  if (input.guildId) {
    await sendPartnershipAlert({
      guildId: input.guildId,
      title: 'Nouvelle demande de partenariat',
      description: `${application.projectName}${application.memberCount ? ` - ${application.memberCount} membres` : ''}`,
      tone: screening.flags.length > 0 ? 'warning' : 'info',
      fields: screening.flags.length > 0 ? [{ name: 'Points de vigilance', value: screening.flags.join('\n') }] : undefined,
      link: '/partnerships/applications',
    });
  }

  return application;
}

export interface ScreeningResult {
  flags: string[];
  /** Au moins un critère dur n'est pas tenu (seuils configurés). */
  blocking: boolean;
  reputation?: { reportCount: number; severityScore: number } | null;
}

/**
 * Contrôles automatiques à la réception.
 *
 * Ce qui est vérifié : les seuils du serveur, la liste de blocage locale, un
 * dossier passé rompu avec le même partenaire, et - si le serveur a activé la
 * consultation - les signaux du réseau. Rien de tout cela ne décide : tout est
 * affiché.
 */
export async function screenApplication(guildId: string, input: ApplicationInput): Promise<ScreeningResult> {
  const settings = await getPartnershipSettings(guildId);
  const flags: string[] = [];
  let blocking = false;

  if (settings.minMemberCount > 0) {
    if (input.memberCount == null) {
      flags.push('Effectif non communiqué.');
    } else if (input.memberCount < settings.minMemberCount) {
      flags.push(`Effectif inférieur au seuil (${input.memberCount} < ${settings.minMemberCount}).`);
      blocking = true;
    }
  }

  if (input.projectGuildId) {
    const blocked = await prisma.partnerBlocklistEntry.findFirst({
      where: { guildId, subjectType: 'guild', subjectRef: input.projectGuildId },
    });
    if (blocked) {
      flags.push(`Serveur sur la liste de blocage : ${blocked.reason ?? 'sans motif'}.`);
      blocking = true;
    }

    const pastBreach = await prisma.partnership.findFirst({
      where: { guildId, stage: 'BREACHED', partner: { partnerGuildId: input.projectGuildId } },
      select: { endReason: true, endedAt: true },
    });
    if (pastBreach) {
      flags.push(`Partenariat déjà rompu avec ce serveur : ${pastBreach.endReason ?? 'motif non enregistré'}.`);
    }

    if (settings.minServerAgeDays > 0) {
      const age = await estimateGuildAgeDays(input.projectGuildId);
      if (age !== null && age < settings.minServerAgeDays) {
        flags.push(`Serveur créé il y a ${age} jours (seuil : ${settings.minServerAgeDays}).`);
        blocking = true;
      }
    }
  }

  if (input.applicantUserId) {
    const blockedUser = await prisma.partnerBlocklistEntry.findFirst({
      where: { guildId, subjectType: 'user', subjectRef: input.applicantUserId },
    });
    if (blockedUser) {
      flags.push('Demandeur sur la liste de blocage.');
      blocking = true;
    }
  }

  let reputation: ScreeningResult['reputation'] = null;
  if (settings.reputationConsume && input.projectGuildId) {
    const signal = await prisma.partnerReputationSignal.findUnique({
      where: { subjectGuildId: input.projectGuildId },
    });
    if (signal && signal.reportCount > 0) {
      reputation = { reportCount: signal.reportCount, severityScore: signal.severityScore };
      flags.push(
        `Réseau : ${signal.reportCount} signalement(s) par ${signal.reporterCount} serveur(s). À apprécier, pas un verdict.`,
      );
    }
  }

  return { flags, blocking, reputation };
}

/**
 * Âge du serveur, déduit de son identifiant Discord.
 *
 * Un identifiant Discord porte sa date de création dans ses 42 bits de poids
 * fort : pas besoin d'y être présent pour savoir qu'un serveur a trois jours.
 */
async function estimateGuildAgeDays(guildId: string): Promise<number | null> {
  if (!/^\d{17,20}$/.test(guildId)) return null;
  const DISCORD_EPOCH = 1_420_070_400_000n;
  const createdAt = Number((BigInt(guildId) >> 22n) + DISCORD_EPOCH);
  if (!Number.isFinite(createdAt)) return null;
  return Math.floor((Date.now() - createdAt) / 86_400_000);
}

// ─── Décision ────────────────────────────────────────────────────────────────

export interface DecisionActor extends PartnershipActor {
  reason?: string;
}

/**
 * Tranche une candidature. Une acceptation crée la fiche partenaire et ouvre
 * le dossier ; un refus est conservé - c'est un historique utile quand la même
 * communauté repostule six mois plus tard.
 */
export async function decideApplication(
  applicationId: string,
  status: PartnerApplicationStatus,
  actor: DecisionActor,
): Promise<PartnerApplication> {
  const application = await prisma.partnerApplication.findUnique({ where: { id: applicationId } });
  if (!application) throw new Error('Candidature introuvable.');

  if (status !== 'ACCEPTED') {
    const updated = await prisma.partnerApplication.update({
      where: { id: applicationId },
      data: {
        status,
        decisionReason: actor.reason?.slice(0, 1000) ?? null,
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
      },
    });
    await notifyApplicant(updated, false);
    return updated;
  }

  const partner = await createPartner(
    {
      guildId: application.guildId,
      kind: application.projectKind,
      displayName: application.projectName,
      description: application.description,
      partnerGuildId: application.projectGuildId,
      inviteUrl: application.inviteUrl,
      memberCount: application.memberCount,
    },
    actor,
  );

  if (application.applicantUserId) {
    await prisma.partnerContact.create({
      data: {
        partnerId: partner.id,
        userId: application.applicantUserId,
        displayName: application.applicantTag ?? 'Contact',
        role: 'manager',
        primary: true,
      },
    });
  }

  const partnership = await createPartnership(
    {
      guildId: application.guildId,
      partnerId: partner.id,
      type: application.requestedType ?? 'CROSS_PROMO',
      title: application.projectName,
      summary: application.description,
    },
    actor,
  );

  const updated = await prisma.partnerApplication.update({
    where: { id: applicationId },
    data: {
      status: 'ACCEPTED',
      partnerId: partner.id,
      partnershipId: partnership.id,
      decisionReason: actor.reason?.slice(0, 1000) ?? null,
      decidedByUserId: actor.userId,
      decidedAt: new Date(),
    },
  });

  await notifyApplicant(updated, true);
  return updated;
}

/**
 * Prévient le demandeur du sort de sa candidature. En message privé, et sans
 * jamais faire échouer la décision : des messages privés fermés sont courants
 * et ne regardent pas le staff qui vient de trancher.
 */
async function notifyApplicant(application: PartnerApplication, accepted: boolean): Promise<void> {
  if (!application.applicantUserId) return;

  const message = accepted
    ? `Votre demande de partenariat pour **${application.projectName}** a été acceptée. L'équipe vous recontacte pour la suite.`
    : `Votre demande de partenariat pour **${application.projectName}** n'a pas été retenue.${
        application.decisionReason ? `\n\nMotif : ${application.decisionReason}` : ''
      }`;

  if (application.guildId) {
    await notify({
      guildId: application.guildId,
      userId: application.applicantUserId,
      kind: 'partnerships.application_decided',
      title: accepted ? 'Demande de partenariat acceptée' : 'Demande de partenariat refusée',
      message,
      severity: accepted ? 'SUCCESS' : 'ERROR',
    }).catch(() => null);
    return;
  }

  // Demande faite à Kotbo lui-même : aucun serveur pour porter la notification.
  const user = await getClient()
    .users.fetch(application.applicantUserId)
    .catch(() => null);
  if (!user) return;

  await user.send({ content: message, allowedMentions: { parse: [] } }).catch(() => {
    logger.info('Partenariats : demandeur injoignable en message prive', { applicationId: application.id });
  });
}

export async function listApplications(guildId: string | null, status?: PartnerApplicationStatus) {
  return prisma.partnerApplication.findMany({
    where: { guildId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
