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
 * - Les MP obligatoires, urgents ou porteurs de boutons partent tout de suite.
 *   Les autres attendent une minute en file (`NotificationDm`) pour partir
 *   ensemble, ou jusqu'au résumé quotidien si la personne l'a choisi.
 */
import { ButtonBuilder, ButtonStyle } from 'discord.js';
import { actionRow, v2Message, type ButtonList } from '@arcscord/components';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_NOTIFICATION_CHANNEL_PREFS,
  getNotificationKind,
  type NotificationCategory,
  type NotificationChannelPrefs,
  type NotificationKind,
  type NotificationSeverity,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { kotboContainer } from '../../utils/embeds.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { getCurrentInstance } from '../../utils/instanceContext.js';

export const MUTE_PREFIX = 'notif:mute:';
const GROUP_WINDOW_MS = 60_000;
const CLAIM_TIMEOUT_MS = 10 * 60_000;
// shortcut: heure fixe en UTC pour tout le monde, faute de fuseau par personne ; à revoir si la grille gagne un fuseau.
const DIGEST_HOUR_UTC = 8;
const GROUP_PREVIEW = 8;

export type NotifyInput = {
  guildId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  message: string;
  severity?: NotificationSeverity;
  /** Chemin du dashboard (ex. `/planning`), sans `?guild=` : le service l'ajoute. Un lien absolu est gardé tel quel. */
  link?: string;
  actorId?: string | null;
  groupKey?: string;
  data?: Prisma.InputJsonValue;
  /** `false` quand le serveur a coupé les MP de ce module (réglage du module). */
  dm?: boolean;
  /** `false` quand le serveur a coupé la boîte du dashboard pour ce module. */
  inbox?: boolean;
  /** Boutons propres au message (lien de recours…) : le MP part alors tout de suite, seul. */
  buttons?: ButtonBuilder[];
};

export type NotifyResult = {
  notification: Awaited<ReturnType<typeof writeInbox>> | null;
  dm: 'sent' | 'failed' | 'queued' | 'off';
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

// ─── Gabarit des MP ─────────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  SUCCESS: '✅',
  WARNING: '⚠️',
  ERROR: '❌',
  INFO: 'ℹ️',
  CRITICAL: '🚨',
};

const SEVERITY_COLOR: Record<NotificationSeverity, 'success' | 'warning' | 'danger' | 'primary'> = {
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'danger',
  INFO: 'primary',
  CRITICAL: 'danger',
};

const CATEGORY_LABEL: Record<NotificationCategory, (o: { locale: BotLocale }) => string> = {
  staff: (o) => m.ntf_cat_staff({}, o),
  planning: (o) => m.ntf_cat_planning({}, o),
  recruitment: (o) => m.ntf_cat_recruitment({}, o),
  moderation: (o) => m.ntf_cat_moderation({}, o),
  security: (o) => m.ntf_cat_security({}, o),
  tickets: (o) => m.ntf_cat_tickets({}, o),
  partnerships: (o) => m.ntf_cat_partnerships({}, o),
  community: (o) => m.ntf_cat_community({}, o),
  system: (o) => m.ntf_cat_system({}, o),
};

export function categoryLabel(category: NotificationCategory, locale: BotLocale): string {
  return CATEGORY_LABEL[category]({ locale });
}

type DmItem = {
  guildId: string;
  kind: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  link: string | null;
};

/** Titre précédé de l'emoji de gravité, sauf s'il commence déjà par un emoji. */
function withEmoji(item: DmItem): string {
  return /^\p{Extended_Pictographic}/u.test(item.title) ? item.title : `${SEVERITY_EMOJI[item.severity]} ${item.title}`;
}

function asSeverity(value: string): NotificationSeverity {
  return value in SEVERITY_EMOJI ? (value as NotificationSeverity) : 'INFO';
}

async function guildName(guildId: string): Promise<string> {
  const client = getClient();
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  return guild?.name ?? guildId;
}

/** Un MP seul : titre, message, lien, et « Ne plus recevoir ce type » hors types obligatoires. */
export async function buildSingleDm(item: DmItem, buttons: ButtonBuilder[] = []) {
  const meta = getNotificationKind(item.kind);
  const locale = await resolveGuildLocale(item.guildId);
  const o = { locale };
  const row: ButtonBuilder[] = [];
  if (item.link) row.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(m.ntf_open({}, o)).setURL(item.link));
  row.push(...buttons);
  if (!meta.mandatory) {
    row.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel(m.ntf_mute({}, o))
        .setCustomId(`${MUTE_PREFIX}${meta.category}`),
    );
  }
  return v2Message(
    kotboContainer({
      color: SEVERITY_COLOR[item.severity],
      title: withEmoji(item).slice(0, 250),
      fields: [item.message.slice(0, 3500) || '​', ...(row.length ? [actionRow(...(row.slice(0, 5) as unknown as ButtonList))] : [])],
      footerTitle: m.ntf_footer({ guild: await guildName(item.guildId) }, o),
    }),
  );
}

/** Plusieurs MP rapprochés, ou le résumé du jour, en un seul message. */
export async function buildGroupedDm(items: DmItem[], digest: boolean) {
  const locale = await resolveGuildLocale(items[0].guildId);
  const o = { locale };
  const names = new Map<string, string>();
  for (const { guildId } of items) if (!names.has(guildId)) names.set(guildId, await guildName(guildId));

  const lines = items.slice(0, GROUP_PREVIEW).map((item) => {
    const body = item.message.length > 200 ? `${item.message.slice(0, 199)}…` : item.message;
    return `**${withEmoji(item)}** · ${names.get(item.guildId)}\n${body}`;
  });
  if (items.length > GROUP_PREVIEW) lines.push(m.ntf_more({ count: items.length - GROUP_PREVIEW }, o));

  const worst = items.some((i) => i.severity === 'CRITICAL' || i.severity === 'ERROR')
    ? 'danger'
    : items.some((i) => i.severity === 'WARNING')
      ? 'warning'
      : 'primary';
  const withLink = items.find((i) => i.link);
  const fields: Parameters<typeof kotboContainer>[0]['fields'] = [lines.join('\n\n').slice(0, 3500)];
  if (withLink) {
    fields.push(
      actionRow(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(m.ntf_inbox({}, o))
          .setURL(dashboardLink('/notifications', withLink.guildId)),
      ),
    );
  }
  return v2Message(
    kotboContainer({
      color: worst,
      title: digest ? m.ntf_digest_title({}, o) : m.ntf_group_title({ count: items.length }, o),
      fields,
      footerTitle: m.ntf_footer_group({}, o),
    }),
  );
}

async function sendTo(userId: string, payload: Awaited<ReturnType<typeof buildSingleDm>>): Promise<boolean> {
  try {
    const user = await getClient().users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (error) {
    logger.debug('Notification', `MP impossible pour ${userId}: ${error}`);
    return false;
  }
}

function nextDigestAt(now: Date): Date {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DIGEST_HOUR_UTC));
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

async function enqueueDm(userId: string, item: DmItem, category: string, digest: boolean, now: Date): Promise<void> {
  let sendAfter = digest ? nextDigestAt(now) : new Date(now.getTime() + GROUP_WINDOW_MS);
  if (!digest) {
    // Rejoint le lot déjà en attente pour que tout parte ensemble.
    const pending = await prisma.notificationDm.findFirst({
      where: { userId, digest: false, claimedAt: null },
      orderBy: { sendAfter: 'asc' },
      select: { sendAfter: true },
    });
    if (pending) sendAfter = pending.sendAfter;
  }
  await prisma.notificationDm.create({
    data: { userId, guildId: item.guildId, kind: item.kind, category, title: item.title, message: item.message, severity: item.severity, link: item.link, digest, sendAfter },
  });
}

/**
 * Passage toutes les minutes : envoie les MP dont l'heure est venue, un message
 * par personne (et un à part pour le résumé). La prise (`claimedAt`) est
 * atomique, deux processus ne peuvent pas envoyer la même ligne.
 */
export async function flushNotificationDms(now = new Date()): Promise<number> {
  await prisma.notificationDm.updateMany({
    where: { claimedAt: { lt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } },
    data: { claimedAt: null },
  });
  const due = await prisma.notificationDm.findMany({
    where: { sendAfter: { lte: now }, claimedAt: null },
    select: { userId: true },
    distinct: ['userId'],
    take: 200,
  });

  let sent = 0;
  for (const { userId } of due) {
    const rows = await prisma.notificationDm.updateManyAndReturn({
      where: { userId, sendAfter: { lte: now }, claimedAt: null },
      data: { claimedAt: now },
    });
    for (const digest of [false, true]) {
      const batch = rows.filter((r) => r.digest === digest).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (batch.length === 0) continue;
      const items = batch.map((r) => ({ ...r, severity: asSeverity(r.severity) }));
      const payload = items.length === 1 && !digest ? await buildSingleDm(items[0]) : await buildGroupedDm(items, digest);
      if (await sendTo(userId, payload)) sent += 1;
    }
    // MP fermés compris : réessayer chaque minute reviendrait à frapper à une porte fermée.
    await prisma.notificationDm.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  }
  return sent;
}

/** Le bouton « Ne plus recevoir ce type » : coupe les MP (et le résumé) de la famille. */
export async function muteCategoryDm(userId: string, category: NotificationCategory): Promise<void> {
  await prisma.notificationPreference.upsert({
    where: { userId_category: { userId, category } },
    create: { userId, category, dm: false, digest: false },
    update: { dm: false, digest: false },
  });
  await prisma.notificationDm.deleteMany({ where: { userId, category, claimedAt: null } });
}

// ─── Point d'entrée ─────────────────────────────────────────────────────────

export async function notify(input: NotifyInput, now = new Date()): Promise<NotifyResult> {
  const meta = getNotificationKind(input.kind);
  const prefs = meta.mandatory ? DEFAULT_NOTIFICATION_CHANNEL_PREFS : await getChannelPrefs(input.userId, meta.category);

  const isStaff = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId: input.guildId, userId: input.userId } },
    select: { userId: true },
  });

  let notification = null;
  if (isStaff && prefs.dashboard && input.inbox !== false) {
    notification = await writeInbox(input, meta.category);
    broadcastDashboardStateChange(input.guildId, 'notifications_updated');
  }

  if (input.dm === false || !prefs.dm) return { notification, dm: 'off' };

  // Un membre hors staff n'a pas accès au dashboard : seul un lien absolu (site, recours…) lui sert.
  const external = !!input.link && /^https?:\/\//.test(input.link);
  const item: DmItem = {
    guildId: input.guildId,
    kind: input.kind,
    title: input.title,
    message: input.message,
    severity: input.severity ?? 'INFO',
    link: input.link && (isStaff || external) ? dashboardLink(input.link, input.guildId) : null,
  };

  if (prefs.digest && !meta.mandatory) {
    await enqueueDm(input.userId, item, meta.category, true, now);
    return { notification, dm: 'queued' };
  }
  if (meta.mandatory || meta.urgent || input.buttons?.length) {
    const ok = await sendTo(input.userId, await buildSingleDm(item, input.buttons));
    return { notification, dm: ok ? 'sent' : 'failed' };
  }
  await enqueueDm(input.userId, item, meta.category, false, now);
  return { notification, dm: 'queued' };
}

/** Même notification pour plusieurs personnes ; un échec n'arrête pas les autres. */
export async function notifyMany(userIds: Iterable<string>, input: Omit<NotifyInput, 'userId'>): Promise<void> {
  await Promise.allSettled([...new Set(userIds)].map((userId) => notify({ ...input, userId })));
}

/** MP au membre qu'on s'apprête à sortir du serveur (protection, captcha, piège) : à attendre avant l'expulsion. */
export async function notifyJoinBlocked(guildId: string, userId: string, message: string, link?: string): Promise<void> {
  const locale = await resolveGuildLocale(guildId);
  await notify({ guildId, userId, kind: 'security.join_blocked', title: m.ntf_join_blocked_title({}, { locale }), message, severity: 'WARNING', link }).catch(
    () => null,
  );
}
