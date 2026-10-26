/**
 * Panneaux de discussion : publie le message à boutons, ouvre les fils après
 * le formulaire et applique les actions de leur propriétaire.
 *
 * Calqué sur le vocal temporaire : le membre qui ouvre le fil en devient
 * propriétaire, peut le confier à des membres de confiance, le transférer, et
 * un autre peut le réclamer quand il a disparu. Les règles de forme (boutons,
 * nom, message de départ) vivent dans @kotbo/shared.
 *
 * Le bot crée les fils : Discord ne laisse donc que les modérateurs (Gérer les
 * fils) les administrer. Chaque action passe par ici, qui vérifie les droits
 * du membre avant d'agir au nom du bot.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type Client,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type MediaChannel,
  type ThreadAutoArchiveDuration,
} from 'discord.js';
import type { PanelThread, ThreadPanel } from '@prisma/client';
import {
  buildThreadPanelName,
  buildThreadPanelStarter,
  defaultThreadPanel,
  normalizeThreadPanel,
  threadPanelCooldownLeft,
  type ThreadPanelAnswer,
  type ThreadPanelButton,
  type ThreadPanelData,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';

export const THREAD_PANEL_PREFIX = 'tpanel';

export function tr(locale: BotLocale, fr: string, en: string): string {
  return locale === 'fr' ? fr : en;
}

// ── Lecture ─────────────────────────────────────────────────────────────────

export interface LoadedThreadPanel {
  row: ThreadPanel;
  data: ThreadPanelData;
}

/** Une ligne qui ne passe plus la validation est éteinte plutôt qu'appliquée à moitié. */
export function toThreadPanelData(row: ThreadPanel): ThreadPanelData {
  const normalized = normalizeThreadPanel(row);
  if (normalized.ok) return normalized.value;
  return { ...defaultThreadPanel(), name: row.name, enabled: false, buttons: [] };
}

export async function loadThreadPanel(guildId: string, panelId: string): Promise<LoadedThreadPanel | null> {
  const row = await prisma.threadPanel.findFirst({ where: { id: panelId, guildId } });
  return row ? { row, data: toThreadPanelData(row) } : null;
}

export async function getPanelThread(threadId: string): Promise<PanelThread | null> {
  return prisma.panelThread.findUnique({ where: { threadId } });
}

/** Fil tel que Discord le voit : `gone` s'il n'existe plus, null si Discord n'a pas répondu. */
async function fetchThread(client: Client, threadId: string): Promise<AnyThreadChannel | 'gone' | null> {
  try {
    const channel = await client.channels.fetch(threadId);
    return channel?.isThread() ? channel : 'gone';
  } catch (err) {
    return (err as { code?: number }).code === 10003 ? 'gone' : null;
  }
}

async function markClosed(threadId: string, closed: boolean): Promise<void> {
  await prisma.panelThread.update({ where: { threadId }, data: { closedAt: closed ? new Date() : null } }).catch(() => null);
}

// ── Message du panneau ──────────────────────────────────────────────────────

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const;

export function buildThreadPanelMessage(panelId: string, data: ThreadPanelData) {
  const embed = new EmbedBuilder().setTitle(data.title).setColor(parseInt(data.color.slice(1), 16));
  if (data.description) embed.setDescription(data.description);
  if (data.imageUrl) embed.setImage(data.imageUrl);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < data.buttons.length; i += 5) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      data.buttons.slice(i, i + 5).map((button) => {
        const built = new ButtonBuilder()
          .setCustomId(`${THREAD_PANEL_PREFIX}:open:${panelId}:${button.id}`)
          .setLabel(button.label)
          .setStyle(BUTTON_STYLES[button.style]);
        if (button.emoji) built.setEmoji(button.emoji);
        return built;
      }),
    ));
  }
  return { embeds: [embed], components };
}

/**
 * Publie le panneau, ou met à jour le message déjà publié. Les erreurs de
 * Discord (permissions, emoji invalide) remontent à l'appelant.
 */
export async function publishThreadPanel(client: Client, guildId: string, panelId: string): Promise<string> {
  const panel = await loadThreadPanel(guildId, panelId);
  if (!panel) throw new Error('Panneau introuvable.');
  if (panel.data.buttons.length === 0) throw new Error('Ce panneau n’a plus de bouton valide : enregistre-le de nouveau.');
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(panel.row.channelId);
  if (!channel || !channel.isTextBased() || channel.isThread()) throw new Error('Le salon du panneau n’existe plus.');

  const payload = buildThreadPanelMessage(panel.row.id, panel.data);
  if (panel.row.messageId) {
    const existing = await channel.messages.fetch(panel.row.messageId).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return existing.id;
    }
  }
  const sent = await channel.send(payload);
  await prisma.threadPanel.update({ where: { id: panel.row.id }, data: { messageId: sent.id } });
  return sent.id;
}

/** Retire le message publié, sans erreur s'il a déjà disparu. */
export async function unpublishThreadPanel(client: Client, row: Pick<ThreadPanel, 'guildId' | 'channelId' | 'messageId'>): Promise<void> {
  if (!row.messageId) return;
  const channel = client.guilds.cache.get(row.guildId)?.channels.cache.get(row.channelId);
  if (!channel?.isTextBased()) return;
  await channel.messages.delete(row.messageId).catch(() => null);
}

// ── Ouverture d'un fil ──────────────────────────────────────────────────────

type ForumLike = ForumChannel | MediaChannel;

function isForumLike(channel: GuildBasedChannel | undefined): channel is ForumLike {
  return channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;
}

/** Salon où le bouton ouvre ses fils. */
export function threadPanelParent(guild: Guild, panel: LoadedThreadPanel, button: ThreadPanelButton): GuildBasedChannel | undefined {
  return guild.channels.cache.get(button.targetChannelId ?? panel.row.channelId);
}

export type ThreadPanelOpenRefusal =
  | { code: 'disabled' }
  | { code: 'roles' }
  | { code: 'cooldown'; seconds: number }
  | { code: 'limit'; limit: number };

/** Fils encore ouverts du membre pour ce bouton ; ceux fermés entre-temps sont soldés au passage. */
async function countOpenThreads(client: Client, panelId: string, buttonId: string, ownerId: string): Promise<number> {
  const rows = await prisma.panelThread.findMany({ where: { panelId, buttonId, ownerId, closedAt: null }, select: { threadId: true } });
  let open = 0;
  for (const row of rows) {
    const thread = await fetchThread(client, row.threadId);
    // Sans réponse de Discord, le fil compte : mieux vaut refuser un fil de
    // trop que dépasser la limite.
    if (thread === null || (thread !== 'gone' && !thread.archived)) open += 1;
    else await markClosed(row.threadId, true);
  }
  return open;
}

/** Le membre peut-il ouvrir un fil avec ce bouton ? Les admins passent toujours. */
export async function checkThreadPanelOpen(
  member: GuildMember,
  panel: LoadedThreadPanel,
  button: ThreadPanelButton,
): Promise<ThreadPanelOpenRefusal | null> {
  if (!panel.data.enabled) return { code: 'disabled' };
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  if (button.allowedRoleIds.length > 0 && !button.allowedRoleIds.some((id) => member.roles.cache.has(id))) {
    return { code: 'roles' };
  }
  if (button.cooldownSeconds > 0) {
    const last = await prisma.panelThread.findFirst({
      where: { panelId: panel.row.id, buttonId: button.id, ownerId: member.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const seconds = threadPanelCooldownLeft(button.cooldownSeconds, last?.createdAt ?? null, new Date());
    if (seconds > 0) return { code: 'cooldown', seconds };
  }
  if (button.maxOpenPerMember > 0) {
    const open = await countOpenThreads(member.client, panel.row.id, button.id, member.id);
    if (open >= button.maxOpenPerMember) return { code: 'limit', limit: button.maxOpenPerMember };
  }
  return null;
}

/** Tags qu'un post peut porter au plus ; ceux posés d'office passent en premier. */
const MAX_APPLIED_TAGS = 5;

/** Tags proposés au choix, tels que le forum les connaît encore. */
export function choosableForumTags(parent: GuildBasedChannel | undefined, button: ThreadPanelButton) {
  if (!isForumLike(parent) || button.forumChoiceTagIds.length === 0) return [];
  if (button.forumTagIds.length >= MAX_APPLIED_TAGS) return [];
  return parent.availableTags.filter((tag) => button.forumChoiceTagIds.includes(tag.id));
}

export function buildThreadPanelModal(
  panelId: string,
  button: ThreadPanelButton,
  parent: GuildBasedChannel | undefined,
  locale: BotLocale,
): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${THREAD_PANEL_PREFIX}:form:${panelId}:${button.id}`)
    .setTitle(button.label.slice(0, 45));

  const title = new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
  if (button.titlePlaceholder) title.setPlaceholder(button.titlePlaceholder);
  modal.addLabelComponents(new LabelBuilder().setLabel(button.titleLabel).setTextInputComponent(title));

  for (const field of button.fields) {
    const input = new TextInputBuilder()
      .setCustomId(`f_${field.id}`)
      .setStyle(field.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
      .setRequired(field.required)
      .setMaxLength(field.maxLength);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    modal.addLabelComponents(new LabelBuilder().setLabel(field.label).setTextInputComponent(input));
  }

  const tags = choosableForumTags(parent, button);
  if (tags.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('tags')
      .setRequired(false)
      .setMinValues(0)
      .setMaxValues(Math.min(tags.length, MAX_APPLIED_TAGS - button.forumTagIds.length))
      .addOptions(tags.slice(0, 25).map((tag) => ({
        label: tag.name,
        value: tag.id,
        ...(tag.emoji?.id ? { emoji: { id: tag.emoji.id } } : tag.emoji?.name ? { emoji: { name: tag.emoji.name } } : {}),
      })));
    modal.addLabelComponents(new LabelBuilder().setLabel(tr(locale, 'Tags', 'Tags')).setStringSelectMenuComponent(select));
  }
  return modal;
}

/** Boutons sous le message de départ du fil. */
function starterComponents(button: ThreadPanelButton, locale: BotLocale) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${THREAD_PANEL_PREFIX}:manage`).setLabel(tr(locale, 'Gérer', 'Manage')).setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${THREAD_PANEL_PREFIX}:close`).setLabel(tr(locale, 'Fermer', 'Close')).setEmoji('🔒').setStyle(ButtonStyle.Secondary),
  );
  if (button.target === 'forum' && button.resolvedTagId) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`${THREAD_PANEL_PREFIX}:resolve`).setLabel(tr(locale, 'Résolu', 'Resolved')).setEmoji('✅').setStyle(ButtonStyle.Success),
    );
  }
  return [row];
}

export type ThreadPanelCreateFailure = 'parent_missing' | 'parent_invalid' | 'bot_permissions' | 'failed';

export async function createPanelThread(p: {
  member: GuildMember;
  panel: LoadedThreadPanel;
  button: ThreadPanelButton;
  title: string;
  answers: ThreadPanelAnswer[];
  chosenTagIds: string[];
  locale: BotLocale;
}): Promise<{ ok: true; thread: AnyThreadChannel } | { ok: false; reason: ThreadPanelCreateFailure }> {
  const { member, panel, button, locale } = p;
  const guild = member.guild;
  const parent = threadPanelParent(guild, panel, button);
  if (!parent) return { ok: false, reason: 'parent_missing' };

  const forum = button.target === 'forum';
  if (forum ? !isForumLike(parent) : parent.type !== ChannelType.GuildText && !(button.target === 'public' && parent.type === ChannelType.GuildAnnouncement)) {
    return { ok: false, reason: 'parent_invalid' };
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const perms = me?.permissionsIn(parent);
  const needed = forum
    ? [PermissionFlagsBits.SendMessages]
    : [button.target === 'private' ? PermissionFlagsBits.CreatePrivateThreads : PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads];
  if (!perms || !needed.every((perm) => perms.has(perm))) return { ok: false, reason: 'bot_permissions' };

  const count = (await prisma.panelThread.count({ where: { panelId: panel.row.id, buttonId: button.id } })) + 1;
  const name = buildThreadPanelName(button, {
    title: p.title,
    displayName: member.displayName,
    username: member.user.username,
    count,
    date: new Date(),
  }, locale);

  const roleMentions = button.mentionRoleIds.map((id) => `<@&${id}>`).join(' ');
  const suffix = roleMentions ? `\n\n${roleMentions}` : '';
  const starter = buildThreadPanelStarter(button, { userMention: `<@${member.id}>`, title: p.title, answers: p.answers, count });
  const message = {
    content: starter.slice(0, 2000 - suffix.length) + suffix,
    components: starterComponents(button, locale),
    allowedMentions: { users: [member.id], roles: button.mentionRoleIds },
  };
  const reason = `Panneau de discussion « ${panel.data.name} » (${member.user.tag})`;
  const autoArchiveDuration = button.archiveMinutes as ThreadAutoArchiveDuration;

  let thread: AnyThreadChannel;
  try {
    if (forum) {
      const chosen = p.chosenTagIds.filter((id) => button.forumChoiceTagIds.includes(id));
      const appliedTags = [...new Set([...button.forumTagIds, ...chosen])].slice(0, MAX_APPLIED_TAGS);
      thread = await (parent as ForumLike).threads.create({
        name,
        autoArchiveDuration,
        rateLimitPerUser: button.slowmodeSeconds,
        appliedTags,
        message,
        reason,
      });
    } else {
      const textParent = parent as Extract<GuildBasedChannel, { type: ChannelType.GuildText | ChannelType.GuildAnnouncement }>;
      thread = button.target === 'private'
        ? await (textParent as Extract<GuildBasedChannel, { type: ChannelType.GuildText }>).threads.create({
          name,
          autoArchiveDuration,
          rateLimitPerUser: button.slowmodeSeconds,
          type: ChannelType.PrivateThread,
          // Seuls le bot et les modérateurs invitent : le propriétaire passe
          // par « Ajouter », qui respecte la liste des bannis.
          invitable: false,
          reason,
        })
        : await textParent.threads.create({ name, autoArchiveDuration, rateLimitPerUser: button.slowmodeSeconds, reason });
      await thread.members.add(member.id).catch(() => null);
      const sent = await thread.send(message);
      await sent.pin().catch(() => null);
    }
  } catch (err) {
    logger.error('ThreadPanel', `Création du fil impossible (panneau ${panel.row.id})`, err);
    return { ok: false, reason: 'failed' };
  }

  await prisma.panelThread.create({
    data: { threadId: thread.id, guildId: guild.id, panelId: panel.row.id, buttonId: button.id, parentId: parent.id, ownerId: member.id },
  });

  if (button.target === 'private' && button.joinRequests && parent.isTextBased()) {
    const announce = await parent.send({
      embeds: [new EmbedBuilder()
        .setColor(parseInt(panel.data.color.slice(1), 16))
        .setDescription(tr(locale, `🔒 **${name}**\nFil privé ouvert par <@${member.id}>.`, `🔒 **${name}**\nPrivate thread opened by <@${member.id}>.`))],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${THREAD_PANEL_PREFIX}:join:${thread.id}`)
          .setLabel(tr(locale, 'Demander à rejoindre', 'Ask to join'))
          .setEmoji('🙋')
          .setStyle(ButtonStyle.Secondary),
      )],
      allowedMentions: { parse: [] },
    }).catch(() => null);
    if (announce) await prisma.panelThread.update({ where: { threadId: thread.id }, data: { announceMessageId: announce.id } }).catch(() => null);
  }

  await logThreadPanel(guild, panel, tr(locale, 'Fil ouvert', 'Thread opened'), [
    { name: tr(locale, 'Fil', 'Thread'), value: `<#${thread.id}>`, inline: true },
    { name: tr(locale, 'Propriétaire', 'Owner'), value: `<@${member.id}>`, inline: true },
    { name: tr(locale, 'Bouton', 'Button'), value: button.label, inline: true },
  ]);
  return { ok: true, thread };
}

// ── Journal ─────────────────────────────────────────────────────────────────

export async function logThreadPanel(
  guild: Guild,
  panel: LoadedThreadPanel | null,
  title: string,
  fields: { name: string; value: string; inline?: boolean }[],
): Promise<void> {
  const channelId = panel?.data.logChannelId;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(parseInt(panel.data.color.slice(1), 16))
      .setAuthor({ name: panel.data.name })
      .setTitle(title)
      .addFields(fields.map((field) => ({ ...field, value: field.value.slice(0, 1024) })))
      .setTimestamp()],
    allowedMentions: { parse: [] },
  }).catch(() => null);
}

// ── Droits sur un fil ───────────────────────────────────────────────────────

export interface ThreadStanding {
  isOwner: boolean;
  isTrusted: boolean;
  isModerator: boolean;
}

export function threadStanding(member: GuildMember, record: PanelThread, thread: AnyThreadChannel): ThreadStanding {
  return {
    isOwner: record.ownerId === member.id,
    isTrusted: record.trustedIds.includes(member.id),
    isModerator: member.permissionsIn(thread).has(PermissionFlagsBits.ManageThreads),
  };
}

export const THREAD_ACTIONS = [
  'rename', 'close', 'reopen', 'lock', 'unlock', 'slowmode', 'pin', 'tags', 'resolve',
  'add', 'remove', 'ban', 'unban', 'trust', 'untrust', 'transfer', 'claim',
] as const;
export type ThreadAction = (typeof THREAD_ACTIONS)[number];

/** Réservées au propriétaire (et aux modérateurs) : elles disent qui gère le fil. */
const OWNER_ACTIONS = new Set<ThreadAction>(['trust', 'untrust', 'transfer']);

export function canRunThreadAction(standing: ThreadStanding, action: ThreadAction): boolean {
  if (action === 'claim') return !standing.isOwner;
  if (standing.isOwner || standing.isModerator) return true;
  return standing.isTrusted && !OWNER_ACTIONS.has(action);
}

/** Actions que le menu « Gérer » propose, selon le fil et le rôle du membre. */
export function availableThreadActions(
  standing: ThreadStanding,
  record: PanelThread,
  thread: AnyThreadChannel,
  button: ThreadPanelButton | null,
): ThreadAction[] {
  const forum = thread.parent?.type === ChannelType.GuildForum || thread.parent?.type === ChannelType.GuildMedia;
  return THREAD_ACTIONS.filter((action) => {
    if (action === 'claim' || !canRunThreadAction(standing, action)) return false;
    if (action === 'close') return !thread.archived;
    if (action === 'reopen') return thread.archived;
    if (action === 'lock') return !thread.locked;
    if (action === 'unlock') return !!thread.locked;
    if (action === 'tags') return forum && !!button && button.forumChoiceTagIds.length > 0;
    if (action === 'resolve') return forum && !!button?.resolvedTagId;
    if (action === 'unban') return record.bannedIds.length > 0;
    if (action === 'untrust') return record.trustedIds.length > 0;
    return true;
  });
}

export const THREAD_ACTION_LABELS: Record<ThreadAction, [fr: string, en: string, emoji: string]> = {
  rename: ['Renommer', 'Rename', '✏️'],
  close: ['Fermer', 'Close', '🔒'],
  reopen: ['Rouvrir', 'Reopen', '🔓'],
  lock: ['Verrouiller', 'Lock', '⛔'],
  unlock: ['Déverrouiller', 'Unlock', '✅'],
  slowmode: ['Mode lent', 'Slowmode', '🐢'],
  pin: ['Épingler un message', 'Pin a message', '📌'],
  tags: ['Changer les tags', 'Change tags', '🏷️'],
  resolve: ['Marquer résolu', 'Mark resolved', '✅'],
  add: ['Ajouter des membres', 'Add members', '➕'],
  remove: ['Retirer des membres', 'Remove members', '➖'],
  ban: ['Bannir du fil', 'Ban from thread', '🚫'],
  unban: ['Débannir', 'Unban', '♻️'],
  trust: ['Membres de confiance', 'Trusted members', '🤝'],
  untrust: ['Retirer la confiance', 'Remove trust', '🫥'],
  transfer: ['Transférer le fil', 'Transfer the thread', '👑'],
  claim: ['Réclamer le fil', 'Claim the thread', '🙋'],
};

/**
 * Le fil peut-il être réclamé ? Oui si le propriétaire a quitté le serveur,
 * ou s'il n'y a rien écrit depuis `claimAfterDays` jours quand le bouton le
 * permet.
 */
export async function isThreadClaimable(thread: AnyThreadChannel, record: PanelThread, button: ThreadPanelButton | null): Promise<boolean> {
  const owner = await thread.guild.members.fetch(record.ownerId).catch((err: { code?: number }) => (err.code === 10007 ? 'left' : null));
  if (owner === 'left') return true;
  if (!owner || !button?.claimAfterDays) return false;

  const threshold = Date.now() - button.claimAfterDays * 86_400_000;
  if (record.createdAt.getTime() > threshold) return false;
  // shortcut: seuls les 100 derniers messages sont lus ; un fil très bavard
  // où le propriétaire s'est tu plus haut reste réclamable, ce qui est voulu.
  const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return false;
  const lastOwnerMessage = messages.find((message) => message.author.id === record.ownerId);
  return !lastOwnerMessage || lastOwnerMessage.createdTimestamp < threshold;
}

// ── Bannis des fils publics ─────────────────────────────────────────────────

const BANS_TTL_SECONDS = 300;

function bansKey(guildId: string): string {
  return `guild:${guildId}:tpanel:bans`;
}

/** Fils ouverts qui ont des bannis : seul ce petit ensemble est lu à chaque message. */
export async function getThreadBans(guildId: string): Promise<Record<string, string[]>> {
  const cached = await cache.get<Record<string, string[]>>(bansKey(guildId));
  if (cached) return cached;
  const rows = await prisma.panelThread.findMany({
    where: { guildId, closedAt: null, bannedIds: { isEmpty: false } },
    select: { threadId: true, bannedIds: true },
  }).catch(() => []);
  const bans = Object.fromEntries(rows.map((row) => [row.threadId, row.bannedIds]));
  await cache.set(bansKey(guildId), bans, BANS_TTL_SECONDS);
  return bans;
}

async function invalidateThreadBans(guildId: string): Promise<void> {
  await cache.delete(bansKey(guildId));
}

// ── Actions ─────────────────────────────────────────────────────────────────

export interface ThreadActionContext {
  thread: AnyThreadChannel;
  member: GuildMember;
  record: PanelThread;
  locale: BotLocale;
}

export type ThreadActionResult = { ok: boolean; message: string };

const SNOWFLAKE = /\d{17,20}/g;
const MEMBER_ACTIONS = new Set<ThreadAction>(['add', 'remove', 'ban', 'unban', 'trust', 'untrust', 'transfer']);

/** Applique une action du propriétaire. `values` : nom, délai, message, membres ou tags selon l'action. */
export async function runThreadAction(ctx: ThreadActionContext, action: ThreadAction, values: string[] = []): Promise<ThreadActionResult> {
  const { thread, member, record, locale } = ctx;
  const t = (fr: string, en: string) => tr(locale, fr, en);
  const fail = (fr: string, en: string): ThreadActionResult => ({ ok: false, message: t(fr, en) });
  const done = (fr: string, en: string): ThreadActionResult => ({ ok: true, message: t(fr, en) });

  const standing = threadStanding(member, record, thread);
  if (!canRunThreadAction(standing, action)) {
    return action === 'claim'
      ? fail('Ce fil est déjà à toi.', 'This thread is already yours.')
      : fail('Seuls le propriétaire du fil, ses membres de confiance et les modérateurs peuvent faire ça.', 'Only the thread owner, their trusted members and moderators can do that.');
  }

  const panel = await loadThreadPanel(record.guildId, record.panelId);
  const button = panel?.data.buttons.find((b) => b.id === record.buttonId) ?? null;
  const reason = `${THREAD_ACTION_LABELS[action][0]} par ${member.user.tag} (panneau de discussion)`;
  const update = (data: Partial<Pick<PanelThread, 'ownerId' | 'trustedIds' | 'bannedIds' | 'closedAt'>>) =>
    prisma.panelThread.update({ where: { threadId: thread.id }, data });

  // Les membres visés : jamais soi-même, le propriétaire, un bot ni un modérateur.
  const targetIds = MEMBER_ACTIONS.has(action) ? [...new Set(values.flatMap((value) => value.match(SNOWFLAKE) ?? []))] : [];
  const protectedTarget = async (id: string): Promise<boolean> => {
    if (id === member.id || id === record.ownerId) return true;
    const target = await thread.guild.members.fetch(id).catch(() => null);
    return !target || target.user.bot || target.permissionsIn(thread).has(PermissionFlagsBits.ManageThreads);
  };
  const mentions = (ids: string[]) => ids.map((id) => `<@${id}>`).join(', ');

  let result: ThreadActionResult;
  try {
    switch (action) {
      case 'rename': {
        const name = (values[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!name) return fail('Donne un nom au fil.', 'Give the thread a name.');
        await thread.setName(name, reason);
        result = done(`Fil renommé en **${name}**.`, `Thread renamed to **${name}**.`);
        break;
      }
      case 'close': {
        await update({ closedAt: new Date() });
        await thread.setArchived(true, reason);
        result = done('Fil fermé. Un message ou « Rouvrir » le relance.', 'Thread closed. A message or “Reopen” brings it back.');
        break;
      }
      case 'reopen': {
        await thread.setArchived(false, reason);
        await update({ closedAt: null });
        result = done('Fil rouvert.', 'Thread reopened.');
        break;
      }
      case 'lock':
      case 'unlock': {
        await thread.setLocked(action === 'lock', reason);
        result = action === 'lock'
          ? done('Fil verrouillé : seuls les modérateurs peuvent encore y écrire.', 'Thread locked: only moderators can still post.')
          : done('Fil déverrouillé.', 'Thread unlocked.');
        break;
      }
      case 'slowmode': {
        const seconds = Math.max(0, Math.min(21_600, Math.floor(Number(values[0]) || 0)));
        await thread.setRateLimitPerUser(seconds, reason);
        result = seconds ? done(`Mode lent : un message toutes les ${seconds} s.`, `Slowmode: one message every ${seconds}s.`) : done('Mode lent coupé.', 'Slowmode off.');
        break;
      }
      case 'pin': {
        const messageId = (values[0] ?? '').match(SNOWFLAKE)?.pop();
        const message = messageId ? await thread.messages.fetch(messageId).catch(() => null) : null;
        if (!message) return fail('Message introuvable dans ce fil : colle son lien ou son identifiant.', 'Message not found in this thread: paste its link or ID.');
        await message.pin(reason);
        result = done('Message épinglé.', 'Message pinned.');
        break;
      }
      case 'tags':
      case 'resolve': {
        if (!button || !thread.parent || !isForumLike(thread.parent)) return fail('Réservé aux posts de forum.', 'Forum posts only.');
        if (action === 'tags') {
          const chosen = values.filter((id) => button.forumChoiceTagIds.includes(id));
          const kept = thread.appliedTags.filter((id) => !button.forumChoiceTagIds.includes(id));
          await thread.setAppliedTags([...new Set([...kept, ...chosen])].slice(0, MAX_APPLIED_TAGS), reason);
          result = done('Tags mis à jour.', 'Tags updated.');
        } else {
          if (button.resolvedTagId && !thread.appliedTags.includes(button.resolvedTagId)) {
            // Le tag « résolu » passe devant : s'il n'y a plus de place, c'est le dernier tag qui saute.
            await thread.setAppliedTags([button.resolvedTagId, ...thread.appliedTags].slice(0, MAX_APPLIED_TAGS), reason);
          }
          await update({ closedAt: new Date() });
          await thread.setArchived(true, reason);
          result = done('Post marqué résolu et fermé.', 'Post marked resolved and closed.');
        }
        break;
      }
      case 'add': {
        const banned = targetIds.filter((id) => record.bannedIds.includes(id));
        const allowed = targetIds.filter((id) => !record.bannedIds.includes(id));
        for (const id of allowed) await thread.members.add(id);
        result = done(
          `Ajouté${allowed.length > 1 ? 's' : ''} : ${mentions(allowed) || 'personne'}.${banned.length ? ` Bannis ignorés : ${mentions(banned)}.` : ''}`,
          `Added: ${mentions(allowed) || 'nobody'}.${banned.length ? ` Banned members skipped: ${mentions(banned)}.` : ''}`,
        );
        break;
      }
      case 'remove':
      case 'ban': {
        const targets: string[] = [];
        for (const id of targetIds) if (!(await protectedTarget(id))) targets.push(id);
        if (targets.length === 0) return fail('Personne à retirer : le propriétaire, les modérateurs et les bots sont protégés.', 'Nobody to remove: the owner, moderators and bots are protected.');
        for (const id of targets) await thread.members.remove(id).catch(() => null);
        if (action === 'ban') {
          await update({
            bannedIds: [...new Set([...record.bannedIds, ...targets])],
            trustedIds: record.trustedIds.filter((id) => !targets.includes(id)),
          });
          await invalidateThreadBans(record.guildId);
          result = done(`Banni${targets.length > 1 ? 's' : ''} du fil : ${mentions(targets)}.`, `Banned from the thread: ${mentions(targets)}.`);
        } else {
          result = done(`Retiré${targets.length > 1 ? 's' : ''} du fil : ${mentions(targets)}.`, `Removed from the thread: ${mentions(targets)}.`);
        }
        break;
      }
      case 'unban': {
        await update({ bannedIds: record.bannedIds.filter((id) => !targetIds.includes(id)) });
        await invalidateThreadBans(record.guildId);
        result = done(`Débanni${targetIds.length > 1 ? 's' : ''} : ${mentions(targetIds)}.`, `Unbanned: ${mentions(targetIds)}.`);
        break;
      }
      case 'trust': {
        const targets: string[] = [];
        for (const id of targetIds) if (!(await protectedTarget(id))) targets.push(id);
        if (targets.length === 0) return fail('Choisis des membres du serveur, hors bots et modérateurs.', 'Pick server members, not bots or moderators.');
        for (const id of targets) await thread.members.add(id).catch(() => null);
        await update({
          trustedIds: [...new Set([...record.trustedIds, ...targets])],
          bannedIds: record.bannedIds.filter((id) => !targets.includes(id)),
        });
        await invalidateThreadBans(record.guildId);
        result = done(`De confiance : ${mentions(targets)}. Ils ont les mêmes boutons que toi, sauf le transfert.`, `Trusted: ${mentions(targets)}. They get the same controls as you, except transfer.`);
        break;
      }
      case 'untrust': {
        await update({ trustedIds: record.trustedIds.filter((id) => !targetIds.includes(id)) });
        result = done(`Confiance retirée : ${mentions(targetIds)}.`, `Trust removed: ${mentions(targetIds)}.`);
        break;
      }
      case 'transfer': {
        const id = targetIds[0];
        const target = id ? await thread.guild.members.fetch(id).catch(() => null) : null;
        if (!target || target.user.bot || id === record.ownerId) return fail('Choisis un autre membre du serveur.', 'Pick another server member.');
        if (record.bannedIds.includes(target.id)) return fail('Ce membre est banni du fil.', 'This member is banned from the thread.');
        await thread.members.add(target.id).catch(() => null);
        await update({ ownerId: target.id, trustedIds: record.trustedIds.filter((t) => t !== target.id) });
        result = done(`Le fil appartient maintenant à ${target}.`, `The thread now belongs to ${target}.`);
        break;
      }
      case 'claim': {
        if (record.bannedIds.includes(member.id)) return fail('Tu es banni de ce fil.', 'You are banned from this thread.');
        if (!(await isThreadClaimable(thread, record, button))) {
          return fail('Le propriétaire est toujours là : tu ne peux pas réclamer ce fil.', 'The owner is still around: you can’t claim this thread.');
        }
        await thread.members.add(member.id).catch(() => null);
        await update({ ownerId: member.id, trustedIds: record.trustedIds.filter((t) => t !== member.id) });
        result = done('Le fil est maintenant à toi.', 'The thread is now yours.');
        break;
      }
    }
  } catch (err) {
    logger.error('ThreadPanel', `Action ${action} impossible sur le fil ${thread.id}`, err);
    return fail('Discord a refusé l’action : vérifie que le bot a « Gérer les fils » dans ce salon.', 'Discord refused the action: check the bot has “Manage Threads” in this channel.');
  }

  const logLocale = await resolveGuildLocale(thread.guild.id);
  await logThreadPanel(thread.guild, panel, tr(logLocale, THREAD_ACTION_LABELS[action][0], THREAD_ACTION_LABELS[action][1]), [
    { name: tr(logLocale, 'Fil', 'Thread'), value: `<#${thread.id}>`, inline: true },
    { name: tr(logLocale, 'Par', 'By'), value: `<@${member.id}>`, inline: true },
    ...(targetIds.length ? [{ name: tr(logLocale, 'Membres', 'Members'), value: mentions(targetIds), inline: false }] : []),
  ]);
  return result;
}
