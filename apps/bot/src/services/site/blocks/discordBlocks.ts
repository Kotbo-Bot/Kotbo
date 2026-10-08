/**
 * Blocs « Discord en direct » : membres, bouton Rejoindre, vocaux, fil d'un salon.
 *
 * Confidentialité : un salon n'apparaît sur le site que si `@everyone` peut le
 * voir sur Discord. Un salon réservé au staff ne doit jamais fuiter par un
 * bloc mal configuré, quel que soit le réglage du propriétaire.
 */

import { ChannelType, PermissionFlagsBits, type Guild, type GuildBasedChannel, type TextChannel } from 'discord.js';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import { logger } from '../../../utils/logger.js';
import * as m from '../../../lib/paraglide/messages.js';
import { parseDiscordMarkdown } from '../../../api/shared/markdown.js';
import { attrs, esc } from '../siteHtml.js';
import { avatar, discordMessageUrl, emptyState, formatDateTime, formatNumber, type BlockContext, type BlockRegistry } from './blockContext.js';
import { getGuildCounts } from './vitrineBlocks.js';

/** `@everyone` voit-il ce salon (et, au besoin, son historique) ? */
export function isPubliclyVisible(guild: Guild, channel: GuildBasedChannel, needHistory = false): boolean {
  const perms = channel.permissionsFor(guild.roles.everyone);
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) return false;
  return !needHistory || perms.has(PermissionFlagsBits.ReadMessageHistory);
}

// ─── Membres ────────────────────────────────────────────────────────────────

async function renderMembers(ctx: BlockContext): Promise<string> {
  const counts = await getGuildCounts(ctx);
  const o = { locale: ctx.locale };
  return `<div class="presence">
  <span class="presence-dot" aria-hidden="true"></span>
  <span>${esc(m.site_members_online({ count: formatNumber(counts.online, ctx.locale) }, o))}</span>
  <span class="presence-sep" aria-hidden="true">·</span>
  <span>${esc(m.site_members_total({ count: formatNumber(counts.members, ctx.locale) }, o))}</span>
</div>`;
}

// ─── Rejoindre ──────────────────────────────────────────────────────────────

const SITE_INVITE_LABEL = 'Site web';

/** Salon où créer l'invitation : celui des règles, l'accueil, ou le premier salon public. */
function pickInviteChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  const usable = (channel: GuildBasedChannel | null | undefined): channel is TextChannel =>
    Boolean(
      channel &&
        channel.type === ChannelType.GuildText &&
        isPubliclyVisible(guild, channel) &&
        me &&
        channel.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite),
    );
  if (usable(guild.rulesChannel)) return guild.rulesChannel;
  if (usable(guild.systemChannel)) return guild.systemChannel;
  const first = guild.channels.cache
    .filter((c): c is TextChannel => usable(c))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first();
  return first ?? null;
}

/**
 * Lien d'invitation du site : l'URL personnalisée du serveur s'il en a une,
 * sinon une invitation permanente créée une fois et étiquetée « Site web »
 * dans le module Invitations, pour mesurer ce que le site amène.
 */
export async function getSiteInviteUrl(ctx: BlockContext): Promise<string | null> {
  const guild = ctx.guild;
  if (!guild) return null;
  if (guild.vanityURLCode) return `https://discord.gg/${guild.vanityURLCode}`;

  const code = await cache.wrap(`guild:${guild.id}:site-invite`, 3600, async () => {
    const settings = (ctx.site.settings ?? {}) as Record<string, unknown>;
    const stored = typeof settings.joinInviteCode === 'string' ? settings.joinInviteCode : null;
    if (stored) {
      const alive = await guild.invites.fetch({ code: stored, cache: false }).catch(() => null);
      if (alive) return stored;
    }
    const channel = pickInviteChannel(guild);
    if (!channel) return null;
    const invite = await channel
      .createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: 'Bouton « Rejoindre » du site communautaire' })
      .catch((err: unknown) => {
        logger.warn('Site', `Invitation du site impossible sur ${guild.id} :`, err);
        return null;
      });
    if (!invite) return null;
    await prisma.$transaction([
      prisma.communitySite.update({ where: { id: ctx.site.id }, data: { settings: { ...settings, joinInviteCode: invite.code } } }),
      prisma.guildInvite.upsert({
        where: { code: invite.code },
        create: { guildId: guild.id, code: invite.code, inviterId: guild.client.user.id, sourceLabel: SITE_INVITE_LABEL },
        update: { sourceLabel: SITE_INVITE_LABEL, isDeleted: false },
      }),
    ]);
    return invite.code;
  });
  return code ? `https://discord.gg/${code}` : null;
}

async function renderJoin(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const url = await getSiteInviteUrl(ctx);
  if (!url) return '';
  const label = (typeof config.label === 'string' && config.label) || m.site_join_server({}, { locale: ctx.locale });
  return `<p class="btn-row ta-center"><a class="btn btn-primary btn-lg btn-discord"${attrs({ href: url, rel: 'noopener', target: '_blank' })}>${esc(label)}</a></p>`;
}

// ─── Vocaux ─────────────────────────────────────────────────────────────────

async function renderVoice(ctx: BlockContext): Promise<string> {
  const guild = ctx.guild;
  if (!guild) return '';
  const byChannel = new Map<string, Array<{ name: string; avatarUrl: string | null }>>();
  for (const state of guild.voiceStates.cache.values()) {
    const channel = state.channel;
    if (!channel || !state.member || state.member.user.bot) continue;
    if (channel.id === guild.afkChannelId || !isPubliclyVisible(guild, channel)) continue;
    const list = byChannel.get(channel.id) ?? [];
    list.push({ name: state.member.displayName, avatarUrl: state.member.displayAvatarURL({ size: 64 }) });
    byChannel.set(channel.id, list);
  }
  const o = { locale: ctx.locale };
  if (byChannel.size === 0) return emptyState(m.site_voice_empty({}, o));
  const total = [...byChannel.values()].reduce((sum, list) => sum + list.length, 0);
  const rooms = [...byChannel.entries()]
    .map(([channelId, members]) => {
      const channel = guild.channels.cache.get(channelId);
      const faces = members
        .slice(0, 12)
        .map((member) => `<li title="${esc(member.name)}">${avatar(member.avatarUrl, member.name, 'sm')}<span class="voice-name">${esc(member.name)}</span></li>`)
        .join('');
      const more = members.length > 12 ? `<li class="voice-more">+${members.length - 12}</li>` : '';
      return `<div class="voice-room"><p class="voice-channel">🔊 ${esc(channel?.name ?? '')}</p><ul class="voice-members">${faces}${more}</ul></div>`;
    })
    .join('');
  return `<p class="mod-meta">${esc(m.site_voice_count({ count: formatNumber(total, ctx.locale) }, o))}</p><div class="voice">${rooms}</div>`;
}

// ─── Fil d'un salon ─────────────────────────────────────────────────────────

interface FeedMessage {
  id: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  createdAt: string;
  images: string[];
}

async function renderChannelFeed(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const guild = ctx.guild;
  const channelId = typeof config.channelId === 'string' ? config.channelId : '';
  if (!guild || !channelId) return '';
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || !isPubliclyVisible(guild, channel, true)) return '';
  const limit = Number(config.limit) || 5;

  const messages = await cache.wrap<FeedMessage[]>(`guild:${guild.id}:site-feed:${channelId}:${limit}`, 60, async () => {
    const fetched = await channel.messages.fetch({ limit: Math.min(50, limit * 3) }).catch(() => null);
    if (!fetched) return [];
    return [...fetched.values()]
      .filter((msg) => !msg.system && (msg.content.trim() || msg.attachments.size > 0 || msg.embeds.length > 0))
      .slice(0, limit)
      .map((msg) => ({
        id: msg.id,
        authorName: msg.member?.displayName ?? msg.author.displayName ?? msg.author.username,
        authorAvatar: (msg.member ?? msg.author).displayAvatarURL({ size: 64 }),
        content: msg.content || msg.embeds[0]?.description || msg.embeds[0]?.title || '',
        createdAt: msg.createdAt.toISOString(),
        images: [...msg.attachments.values()]
          .filter((a) => a.contentType?.startsWith('image/'))
          .map((a) => a.url)
          .slice(0, 4),
      }));
  });

  if (messages.length === 0) return emptyState(m.site_feed_empty({}, { locale: ctx.locale }));
  const items = messages
    .map(
      (msg) => `<li class="feed-item">
  ${avatar(msg.authorAvatar, msg.authorName, 'md')}
  <div class="feed-body">
    <p class="feed-head"><strong>${esc(msg.authorName)}</strong> <a class="feed-time"${attrs({ href: discordMessageUrl(guild.id, channelId, msg.id), rel: 'noopener', target: '_blank' })}>${esc(formatDateTime(msg.createdAt, ctx.locale))}</a></p>
    <div class="feed-content rich">${parseDiscordMarkdown(msg.content, guild)}</div>
    ${msg.images.map((src) => `<img class="feed-image"${attrs({ src, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })}>`).join('')}
  </div>
</li>`,
    )
    .join('');
  return `<p class="mod-meta">#${esc(channel.name)}</p><ul class="feed">${items}</ul>`;
}

export const discordBlocks: BlockRegistry = {
  members: renderMembers,
  join: renderJoin,
  voice: renderVoice,
  channelFeed: renderChannelFeed,
};
