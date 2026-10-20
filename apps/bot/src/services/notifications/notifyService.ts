/**
 * notifyService.ts
 *
 * Point d'entrée unique des notifications : chaque envoi passe par `notify()`
 * avec un `kind` du catalogue (@kotbo/contracts). Le service décide, selon la
 * grille de préférences de la personne, s'il écrit dans la boîte du dashboard
 * et s'il envoie un message privé.
 *
 * - La boîte n'est tenue que pour le staff du serveur : un membre n'a pas de
 *   dashboard où la lire.
 * - Un type `mandatory` passe outre la grille : la personne est directement
 *   concernée.
 * - Avec `groupKey`, une notification non lue de même clé est mise à jour
 *   (`count` + 1) au lieu d'en empiler une nouvelle.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_NOTIFICATION_CHANNEL_PREFS,
  getNotificationKind,
  type NotificationChannelPrefs,
  type NotificationKind,
  type NotificationSeverity,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';

export type NotifyInput = {
  guildId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  message: string;
  severity?: NotificationSeverity;
  /** Chemin du dashboard (ex. `/planning`), sans `?guild=` : le service l'ajoute. */
  link?: string;
  actorId?: string | null;
  groupKey?: string;
  data?: Prisma.InputJsonValue;
  /** `false` quand le serveur a coupé les MP de ce module (réglage du module). */
  dm?: boolean;
};

// Pas `getDashboardUrl` (api/shared/core) : ce module tire toute l'API dans le graphe d'import.
function dashboardOrigin(): string {
  try {
    return getCurrentInstance().dashboardUrl;
  } catch {
    return process.env.DASHBOARD_URL || 'http://localhost:5173';
  }
}

/** Lien absolu vers le dashboard, ouvert sur le bon serveur. */
export function dashboardLink(path: string, guildId: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const url = new URL(path, dashboardOrigin().replace(/\/$/, '') + '/');
  url.searchParams.set('guild', guildId);
  return url.toString();
}

export async function getChannelPrefs(userId: string, category: string): Promise<NotificationChannelPrefs> {
  const row = await prisma.notificationPreference.findUnique({
    where: { userId_category: { userId, category } },
    select: { dashboard: true, dm: true, digest: true },
  });
  return row ?? DEFAULT_NOTIFICATION_CHANNEL_PREFS;
}

async function writeInbox(input: NotifyInput, category: string) {
  const severity = input.severity ?? 'INFO';
  if (input.groupKey) {
    const existing = await prisma.notification.findFirst({
      where: { guildId: input.guildId, userId: input.userId, groupKey: input.groupKey, isRead: false, archivedAt: null },
      select: { id: true },
    });
    if (existing) {
      return prisma.notification.update({
        where: { id: existing.id },
        data: {
          title: input.title,
          message: input.message,
          type: severity,
          link: input.link,
          actorId: input.actorId ?? null,
          data: input.data,
          count: { increment: 1 },
        },
      });
    }
  }
  return prisma.notification.create({
    data: {
      guildId: input.guildId,
      userId: input.userId,
      kind: input.kind,
      category,
      title: input.title,
      message: input.message,
      type: severity,
      link: input.link,
      actorId: input.actorId ?? null,
      groupKey: input.groupKey,
      data: input.data,
    },
  });
}

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  SUCCESS: '✅',
  WARNING: '⚠️',
  ERROR: '❌',
  INFO: 'ℹ️',
  CRITICAL: '🚨',
};

const SEVERITY_COLOR: Record<NotificationSeverity, `#${string}`> = {
  SUCCESS: '#57F287',
  WARNING: '#FEE75C',
  ERROR: '#ED4245',
  INFO: '#5865F2',
  CRITICAL: '#ED4245',
};

async function sendDm(input: NotifyInput, withDashboardButton: boolean): Promise<void> {
  try {
    const client = getClient();
    const user = await client.users.fetch(input.userId).catch(() => null);
    if (!user) return;
    const severity = input.severity ?? 'INFO';
    const guild = client.guilds.cache.get(input.guildId) ?? (await client.guilds.fetch(input.guildId).catch(() => null));

    const embed = new EmbedBuilder()
      .setTitle(`${SEVERITY_EMOJI[severity]} ${input.title}`.slice(0, 256))
      .setDescription(input.message.slice(0, 4096))
      .setColor(SEVERITY_COLOR[severity])
      .setTimestamp();
    if (guild) embed.setFooter({ text: `Serveur : ${guild.name}` });

    const components =
      input.link && withDashboardButton
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setLabel('Voir sur le Dashboard')
                .setStyle(ButtonStyle.Link)
                .setURL(dashboardLink(input.link, input.guildId)),
            ),
          ]
        : [];

    await user.send({ embeds: [embed], components, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.debug('Notification', `MP impossible pour ${input.userId}: ${error}`);
  }
}

export async function notify(input: NotifyInput) {
  const meta = getNotificationKind(input.kind);
  const prefs = meta.mandatory ? DEFAULT_NOTIFICATION_CHANNEL_PREFS : await getChannelPrefs(input.userId, meta.category);

  const isStaff = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId: input.guildId, userId: input.userId } },
    select: { userId: true },
  });

  let notification = null;
  if (isStaff && prefs.dashboard) {
    notification = await writeInbox(input, meta.category);
    broadcastDashboardStateChange(input.guildId, 'notifications_updated');
  }

  // shortcut: `digest` est ignoré tant que le résumé quotidien n'existe pas (vague 2).
  if (input.dm !== false && prefs.dm) {
    await sendDm(input, !!isStaff);
  }

  return notification;
}

/** Même notification pour plusieurs personnes ; un échec n'arrête pas les autres. */
export async function notifyMany(userIds: Iterable<string>, input: Omit<NotifyInput, 'userId'>): Promise<void> {
  await Promise.allSettled([...new Set(userIds)].map((userId) => notify({ ...input, userId })));
}
