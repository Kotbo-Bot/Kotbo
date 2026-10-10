/**
 * Journal et alertes du module Partenariats.
 *
 * Tout ce qui arrive à un dossier passe par `recordPartnershipEvent` : c'est
 * ce qui permet de reprendre un partenariat qu'on n'a pas suivi et de savoir
 * pourquoi il a tourné. Le journal est écrit même quand les notifications sont
 * coupées - couper le bruit ne doit pas couper la trace.
 *
 * Les quatre canaux d'alerte (salon staff, dashboard, message privé au
 * responsable, bilan périodique) sont indépendants et tous facultatifs. Une
 * alerte qui échoue n'interrompt jamais l'action qui l'a produite : un rôle
 * appliqué ne doit pas être annulé parce qu'un salon a été supprimé.
 */
import { ChannelType, EmbedBuilder, type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { queueAuditLog } from '../../utils/auditLogger.js';
import { getPartnershipSettings } from './partnershipSettings.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';

/** Teintes reprises de `COLORS_RAW`, sans importer le module d'embeds v2. */
const TONE_COLORS = {
  neutral: 0x8b93a7,
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
} as const;

export type PartnershipAlertTone = keyof typeof TONE_COLORS;

export interface PartnershipEventInput {
  partnershipId: string;
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
  /** D'où vient l'action. `bot` quand personne ne l'a demandée. */
  source?: 'dashboard' | 'discord' | 'bot' | 'guest_portal' | 'bridge';
}

/**
 * Écrit une ligne de chronologie. Ne lève jamais : un journal qui fait échouer
 * l'action qu'il journalise est pire que pas de journal du tout.
 */
export async function recordPartnershipEvent(input: PartnershipEventInput): Promise<void> {
  try {
    await prisma.partnershipEvent.create({
      data: {
        partnershipId: input.partnershipId,
        kind: input.kind,
        summary: input.summary.slice(0, 500),
        payload: (input.payload ?? undefined) as never,
        actorUserId: input.actorUserId ?? null,
        source: input.source ?? 'bot',
      },
    });
  } catch (error) {
    logger.error("Partenariats : echec d'ecriture du journal", { error, partnershipId: input.partnershipId });
  }
}

/**
 * Trace l'action dans le journal d'activité du serveur, celui que la page
 * « Journal d'activité » affiche. Distinct du journal du dossier : celui-ci
 * répond à « qu'a fait le staff sur ce serveur », l'autre à « qu'est-il arrivé
 * à ce partenariat ».
 */
export function auditPartnershipAction(params: {
  guildId: string;
  user: string;
  action: string;
  details: string;
}): void {
  queueAuditLog({
    guildId: params.guildId,
    user: params.user,
    action: params.action,
    context: 'Partenariats',
    module: 'partnerships',
    eventType: 'partnership',
    details: params.details.slice(0, 1000),
  });
}

export interface PartnershipAlertInput {
  guildId: string;
  title: string;
  description: string;
  tone?: PartnershipAlertTone;
  /** Champs affichés sous la description, dans l'ordre donné. */
  fields?: { name: string; value: string }[];
  /** Lien du dashboard vers le dossier concerné. */
  link?: string;
  /** Responsable du dossier : reçoit le message privé, s'il est activé. */
  ownerUserId?: string | null;
  client?: Client;
}

/**
 * Diffuse une alerte sur les canaux que le serveur a activés.
 *
 * Chaque canal est tenté indépendamment : un salon supprimé n'empêche pas la
 * notification du dashboard, et un membre qui a fermé ses messages privés
 * n'empêche pas le message dans le salon staff.
 */
export async function sendPartnershipAlert(input: PartnershipAlertInput): Promise<void> {
  const settings = await getPartnershipSettings(input.guildId);
  const tone = input.tone ?? 'info';

  if (settings.notifyStaffChannel && settings.staffChannelId) {
    await postToStaffChannel(input, settings.staffChannelId, settings.alertRoleIds, tone).catch((error) => {
      logger.warn('Partenariats : alerte non postee dans le salon staff', { error, guildId: input.guildId });
    });
  }

  if (settings.notifyDashboard) {
    await notifyDashboard(input, tone).catch((error) => {
      logger.warn('Partenariats : notification dashboard non creee', { error, guildId: input.guildId });
    });
  }

  if (settings.notifyOwnerDm && input.ownerUserId) {
    await dmOwner(input, tone).catch(() => {
      // Messages privés fermés : cas courant, sans conséquence sur le reste.
    });
  }
}

function buildEmbed(input: PartnershipAlertInput, tone: PartnershipAlertTone): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(input.title.slice(0, 256))
    .setDescription(input.description.slice(0, 4096))
    .setColor(TONE_COLORS[tone])
    .setTimestamp(new Date());

  for (const field of (input.fields ?? []).slice(0, 25)) {
    embed.addFields({ name: field.name.slice(0, 256), value: field.value.slice(0, 1024) });
  }
  return embed;
}

async function postToStaffChannel(
  input: PartnershipAlertInput,
  channelId: string,
  alertRoleIds: string[],
  tone: PartnershipAlertTone,
): Promise<void> {
  const client = input.client ?? getClient();
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  // Les rôles ne sont mentionnés que pour ce qui demande une décision : une
  // alerte informative qui ping l'équipe finit par être coupée entièrement.
  const mentions =
    (tone === 'warning' || tone === 'danger') && alertRoleIds.length > 0
      ? alertRoleIds.map((id) => `<@&${id}>`).join(' ')
      : undefined;

  await channel.send({
    content: mentions,
    embeds: [buildEmbed(input, tone)],
    allowedMentions: { roles: alertRoleIds },
  });
}

/**
 * Une notification par destinataire : le modèle `Notification` vise une
 * personne, pas un rôle.
 *
 * Le responsable du dossier la reçoit toujours. À défaut de responsable, elle
 * part à l'équipe - c'est le seul moyen qu'un dossier que personne ne porte ne
 * disparaisse pas des écrans. Quand il y a un responsable, lui seul est
 * notifié : inonder l'équipe entière pour chaque changement d'étape reviendrait
 * à faire couper le canal.
 */
async function notifyDashboard(input: PartnershipAlertInput, tone: PartnershipAlertTone): Promise<void> {
  const type = tone === 'danger' ? 'ERROR' : tone === 'warning' ? 'WARNING' : tone === 'success' ? 'SUCCESS' : 'INFO';

  const recipients = new Set<string>();
  if (input.ownerUserId) {
    recipients.add(input.ownerUserId);
  } else {
    const staff = await prisma.staffMember.findMany({
      where: { guildId: input.guildId },
      select: { userId: true },
      take: 50,
    });
    for (const member of staff) recipients.add(member.userId);
  }

  if (recipients.size === 0) return;

  await prisma.notification.createMany({
    data: Array.from(recipients).map((userId) => ({
      guildId: input.guildId,
      userId,
      title: input.title.slice(0, 200),
      message: input.description.slice(0, 1000),
      type,
      link: input.link ?? '/partnerships',
    })),
  });
  // Sans cet evenement, la cloche ne l'apprenait qu'au sondage suivant, et la
  // notification de bureau partait avec deux minutes de retard.
  broadcastDashboardStateChange(input.guildId, 'notifications_updated');
}

async function dmOwner(input: PartnershipAlertInput, tone: PartnershipAlertTone): Promise<void> {
  if (!input.ownerUserId) return;
  const client = input.client ?? getClient();
  const user = await client.users.fetch(input.ownerUserId).catch(() => null);
  if (!user) return;
  await user.send({ embeds: [buildEmbed(input, tone)] });
}

/**
 * Mémoire des alertes répétables : une échéance de renouvellement ou un
 * paiement en retard reste vrai à chaque passage du cron. Sans cette mémoire,
 * l'alerte partirait toutes les heures jusqu'à ce que quelqu'un la coupe.
 *
 * Renvoie `true` si l'alerte doit partir, et note le passage dans ce cas.
 */
export async function shouldFireAlert(key: string, minIntervalHours: number): Promise<boolean> {
  const existing = await prisma.partnershipAlertState.findUnique({ where: { key } });
  const now = Date.now();

  if (existing && now - existing.lastFiredAt.getTime() < minIntervalHours * 3_600_000) return false;

  await prisma.partnershipAlertState.upsert({
    where: { key },
    create: { key, lastFiredAt: new Date(now) },
    update: { lastFiredAt: new Date(now) },
  });
  return true;
}

/** Oublie une alerte dont la cause a disparu, pour qu'elle puisse resonner. */
export async function clearAlertState(key: string): Promise<void> {
  await prisma.partnershipAlertState.deleteMany({ where: { key } });
}
