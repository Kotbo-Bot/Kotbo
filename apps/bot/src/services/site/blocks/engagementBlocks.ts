/**
 * Blocs d'engagement : classements, clans, giveaways, événements, saisons,
 * marché, starboard.
 *
 * Les boutons d'action (participer, s'inscrire, acheter) portent un
 * `data-action` : le script du site les branche une fois le visiteur connu, et
 * la route d'action revérifie tout côté serveur.
 */

import { GuildScheduledEventStatus } from 'discord.js';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import * as m from '../../../lib/paraglide/messages.js';
import { parseDiscordMarkdown } from '../../../api/shared/markdown.js';
import { getMemberIdentities } from '../../moderation/memberIdentityService.js';
import { getRankedLeaderboard } from '../../progression/ranked/rankedLeaderboardService.js';
import { getReputationLeaderboard } from '../../community/reputationService.js';
import { attrs, cls, esc, truncate } from '../siteHtml.js';
import {
  avatar,
  discordMessageUrl,
  emptyState,
  formatNumber,
  timeTag,
  type BlockContext,
  type BlockRegistry,
} from './blockContext.js';
import { isPubliclyVisible } from './discordBlocks.js';

const LEADERBOARD_TTL_SECONDS = 120;

// ─── Classements ────────────────────────────────────────────────────────────

interface Row {
  userId: string;
  value: number;
  level?: number;
}

async function loadLeaderboard(guildId: string, variant: string, limit: number): Promise<Row[]> {
  return cache.wrap(`guild:${guildId}:site-lb:${variant}:${limit}`, LEADERBOARD_TTL_SECONDS, async () => {
    switch (variant) {
      case 'prestige':
        return (await getRankedLeaderboard(guildId, limit)).map((r) => ({ userId: r.userId, value: r.rp }));
      case 'reputation':
        return (await getReputationLeaderboard(guildId, limit)).entries.map((r) => ({ userId: r.userId, value: r.totalRep }));
      case 'economy':
        return (
          await prisma.rpgProfile.findMany({
            where: { guildId, balance: { gt: 0 } },
            orderBy: { balance: 'desc' },
            take: limit,
            select: { userId: true, balance: true },
          })
        ).map((r) => ({ userId: r.userId, value: r.balance }));
      case 'season': {
        const season = await prisma.levelingSeason.findFirst({ where: { guildId, status: 'ACTIVE' }, select: { id: true } });
        if (!season) return [];
        const snapshots = await prisma.seasonSnapshot.findMany({
          where: { guildId, seasonId: season.id },
          orderBy: { rank: 'asc' },
          take: limit,
          select: { userId: true, xp: true, level: true },
        });
        if (snapshots.length > 0) return snapshots.map((s) => ({ userId: s.userId, value: s.xp, level: s.level }));
        // Saison en cours sans instantané : même lecture que la page Saisons du dashboard.
        return (
          await prisma.memberLevel.findMany({ where: { guildId }, orderBy: { xp: 'desc' }, take: limit, select: { userId: true, xp: true, level: true } })
        ).map((r) => ({ userId: r.userId, value: r.xp, level: r.level }));
      }
      case 'xp':
      default:
        return (
          await prisma.memberLevel.findMany({
            where: { guildId, xp: { gt: 0 } },
            orderBy: { xp: 'desc' },
            take: limit,
            select: { userId: true, xp: true, level: true },
          })
        ).map((r) => ({ userId: r.userId, value: r.xp, level: r.level }));
    }
  });
}

const LEADERBOARD_TITLES = {
  xp: m.site_leaderboard_xp,
  prestige: m.site_leaderboard_prestige,
  reputation: m.site_leaderboard_reputation,
  season: m.site_leaderboard_season,
  economy: m.site_leaderboard_economy,
} as const;

function leaderboardValue(variant: string, value: number, ctx: BlockContext): string {
  const formatted = formatNumber(value, ctx.locale);
  const o = { locale: ctx.locale };
  if (variant === 'economy') return m.site_coins({ value: formatted }, o);
  if (variant === 'reputation') return m.site_rep({ value: formatted }, o);
  if (variant === 'prestige') return m.site_points({ value: formatted }, o);
  return `${formatted} XP`;
}

async function renderLeaderboard(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const variant = typeof config.variant === 'string' ? config.variant : 'xp';
  const limit = Number(config.limit) || 10;
  const rows = await loadLeaderboard(ctx.site.guildId, variant, limit);
  const o = { locale: ctx.locale };
  const titleFn = LEADERBOARD_TITLES[variant as keyof typeof LEADERBOARD_TITLES] ?? LEADERBOARD_TITLES.xp;
  if (rows.length === 0) return emptyState(m.site_leaderboard_empty({}, o));
  const identities = await getMemberIdentities(ctx.client, ctx.site.guildId, rows.map((r) => r.userId)).catch(() => new Map());
  const items = rows
    .map((row, i) => {
      const identity = identities.get(row.userId);
      const name = identity?.displayName ?? row.userId;
      const level = row.level !== undefined ? `<span class="lb-level">${esc(m.site_level({ level: row.level }, o))}</span>` : '';
      return `<li class="${cls('lb-row', i < 3 && `lb-top lb-top-${i + 1}`)}">
  <span class="lb-rank">${i + 1}</span>
  ${avatar(identity?.avatarUrl ?? null, name, 'sm')}
  <span class="lb-name">${esc(name)}</span>
  ${level}
  <span class="lb-value">${esc(leaderboardValue(variant, row.value, ctx))}</span>
</li>`;
    })
    .join('');
  return `<p class="mod-title">${esc(titleFn({}, o))}</p><ol class="leaderboard">${items}</ol>`;
}

// ─── Clans ──────────────────────────────────────────────────────────────────

interface ClanRow {
  name: string;
  description: string | null;
  icon: string | null;
  points: number;
  members: number;
  level: number | null;
}

async function loadClans(ctx: BlockContext, variant: string, limit: number): Promise<ClanRow[]> {
  const guildId = ctx.site.guildId;
  return cache.wrap(`guild:${guildId}:site-clans:${variant}:${limit}`, LEADERBOARD_TTL_SECONDS, async () => {
    if (variant === 'rpg') {
      const guilds = await prisma.rpgGuild.findMany({
        where: { guildId },
        orderBy: [{ level: 'desc' }, { xp: 'desc' }],
        take: limit,
        select: { name: true, description: true, emoji: true, level: true, xp: true, _count: { select: { members: true } } },
      });
      return guilds.map((g) => ({ name: g.name, description: g.description, icon: g.emoji, points: g.xp, members: g._count.members, level: g.level }));
    }
    const latest = await prisma.clanMemberContribution.aggregate({ where: { guildId }, _max: { season: true } });
    const season = latest._max.season ?? 1;
    const [clans, totals] = await Promise.all([
      prisma.clan.findMany({ where: { guildId }, select: { id: true, name: true, description: true, roleId: true } }),
      prisma.clanMemberContribution.groupBy({ by: ['clanId'], where: { guildId, season }, _sum: { xp: true } }),
    ]);
    const pointsByClan = new Map(totals.map((t) => [t.clanId, t._sum.xp ?? 0]));
    return clans
      .map((c) => ({
        name: c.name,
        description: c.description,
        icon: null,
        points: pointsByClan.get(c.id) ?? 0,
        members: ctx.guild?.roles.cache.get(c.roleId)?.members.size ?? 0,
        level: null,
      }))
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  });
}

async function renderClans(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const variant = config.variant === 'rpg' ? 'rpg' : 'leveling';
  const clans = await loadClans(ctx, variant, Number(config.limit) || 10);
  const o = { locale: ctx.locale };
  if (clans.length === 0) return emptyState(m.site_clans_empty({}, o));
  const items = clans
    .map(
      (clan, i) => `<li class="${cls('lb-row', i < 3 && `lb-top lb-top-${i + 1}`)}">
  <span class="lb-rank">${i + 1}</span>
  <span class="clan-icon" aria-hidden="true">${esc(clan.icon ?? clan.name.slice(0, 1).toUpperCase())}</span>
  <span class="lb-name">${esc(clan.name)}${clan.description ? `<small>${esc(truncate(clan.description, 90))}</small>` : ''}</span>
  ${clan.level !== null ? `<span class="lb-level">${esc(m.site_level({ level: clan.level }, o))}</span>` : ''}
  <span class="lb-meta">${esc(m.site_clan_members({ count: formatNumber(clan.members, ctx.locale) }, o))}</span>
  <span class="lb-value">${esc(m.site_points({ value: formatNumber(clan.points, ctx.locale) }, o))}</span>
</li>`,
    )
    .join('');
  return `<ol class="leaderboard">${items}</ol>`;
}

// ─── Giveaways ──────────────────────────────────────────────────────────────

async function renderGiveaways(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const filter = config.filter === 'ended' || config.filter === 'all' ? config.filter : 'active';
  const limit = Number(config.limit) || 6;
  const giveaways = await prisma.giveaway.findMany({
    where: { guildId: ctx.site.guildId, ...(filter === 'all' ? {} : { ended: filter === 'ended' }) },
    orderBy: filter === 'active' ? { endsAt: 'asc' } : { endsAt: 'desc' },
    take: limit,
    select: { id: true, prize: true, description: true, endsAt: true, ended: true, winnerCount: true, participants: true, winners: true, validationStatus: true },
  });
  const o = { locale: ctx.locale };
  if (giveaways.length === 0) return emptyState(m.site_giveaways_empty({}, o));
  const viewerId = ctx.viewer?.userId;
  const winnerIds = giveaways.filter((g) => g.ended && g.validationStatus !== 'PENDING').flatMap((g) => g.winners);
  const identities = winnerIds.length > 0 ? await getMemberIdentities(ctx.client, ctx.site.guildId, winnerIds).catch(() => new Map()) : new Map();

  const cards = giveaways
    .map((g) => {
      const joined = Boolean(viewerId && g.participants.includes(viewerId));
      const action = g.ended
        ? `<span class="pill pill-muted">${esc(m.site_giveaway_ended({}, o))}</span>`
        : `<button type="button" class="${cls('btn btn-sm', joined ? 'btn-secondary' : 'btn-primary')}"${attrs({
            'data-action': 'giveaway-toggle',
            'data-id': g.id,
            'data-joined': joined ? '1' : '0',
            'data-requires-login': '1',
          })}>${esc(joined ? m.site_giveaway_leave({}, o) : m.site_giveaway_join({}, o))}</button>`;
      const winners =
        g.ended && g.validationStatus !== 'PENDING' && g.winners.length > 0
          ? `<p class="card-text">🏆 ${g.winners.map((id) => esc(identities.get(id)?.displayName ?? id)).join(', ')}</p>`
          : '';
      return `<article class="giveaway-card">
  <div class="card-body">
    <p class="card-kicker">${g.ended ? esc(m.site_giveaway_ended({}, o)) : m.site_giveaway_ends({ date: timeTag(g.endsAt, ctx.locale, 'medium') }, o)}</p>
    <h3 class="card-title">🎁 ${esc(g.prize)}</h3>
    ${g.description ? `<div class="card-text rich">${parseDiscordMarkdown(truncate(g.description, 400), ctx.guild)}</div>` : ''}
    <p class="card-meta">${esc(m.site_giveaway_participants({ count: formatNumber(g.participants.length, ctx.locale) }, o))} · ${esc(m.site_giveaway_winners({ count: g.winnerCount }, o))}</p>
    ${winners}
    <div class="card-actions">${joined && !g.ended ? `<span class="pill pill-ok">${esc(m.site_giveaway_joined({}, o))}</span>` : ''}${action}</div>
  </div>
</article>`;
    })
    .join('');
  return `<div class="card-grid">${cards}</div>`;
}

// ─── Événements ─────────────────────────────────────────────────────────────

interface EventItem {
  id: string;
  source: 'kotbo' | 'discord';
  title: string;
  description: string | null;
  startsAt: Date | null;
  live: boolean;
  count: number;
  countKind: 'registrations' | 'interested';
  image: string | null;
  registrable: boolean;
  formId: string | null;
  url: string | null;
}

async function loadEvents(ctx: BlockContext, limit: number): Promise<EventItem[]> {
  const guildId = ctx.site.guildId;
  const kotbo = await prisma.event.findMany({
    where: { guildId, status: { in: ['PUBLISHED', 'ONGOING'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      title: true,
      description: true,
      type: true,
      status: true,
      triggerType: true,
      triggerValue: true,
      formId: true,
      discordEventId: true,
      _count: { select: { registrations: true } },
    },
  });
  const items: EventItem[] = kotbo.map((e) => {
    const scheduled = e.triggerType === 'SCHEDULED' && e.triggerValue ? new Date(e.triggerValue) : null;
    return {
      id: e.id,
      source: 'kotbo',
      title: e.title,
      description: e.description,
      startsAt: scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : null,
      live: e.status === 'ONGOING',
      count: e._count.registrations,
      countKind: 'registrations',
      image: null,
      registrable: e.type === 'CUSTOM' && e.status !== 'ONGOING',
      formId: e.formId,
      url: null,
    };
  });

  // Événements programmés natifs de Discord, que l'équipe crée souvent sans passer par Kotbo.
  const linked = new Set(kotbo.map((e) => e.discordEventId).filter(Boolean));
  const scheduled = ctx.guild
    ? await cache.wrap(`guild:${guildId}:site-scheduled-events`, 120, async () => {
        const events = await ctx.guild!.scheduledEvents.fetch({ withUserCount: true }).catch(() => null);
        return events
          ? [...events.values()]
              .filter((e) => e.status === GuildScheduledEventStatus.Scheduled || e.status === GuildScheduledEventStatus.Active)
              .map((e) => ({
                id: e.id,
                name: e.name,
                description: e.description,
                start: e.scheduledStartAt?.toISOString() ?? null,
                live: e.status === GuildScheduledEventStatus.Active,
                count: e.userCount ?? 0,
                image: e.coverImageURL({ size: 512 }),
                url: e.url,
              }))
          : [];
      })
    : [];
  for (const e of scheduled) {
    if (linked.has(e.id)) continue;
    items.push({
      id: e.id,
      source: 'discord',
      title: e.name,
      description: e.description,
      startsAt: e.start ? new Date(e.start) : null,
      live: e.live,
      count: e.count,
      countKind: 'interested',
      image: e.image,
      registrable: false,
      formId: null,
      url: e.url,
    });
  }
  // En cours d'abord, puis par date de début, les dates inconnues à la fin.
  return items
    .sort((a, b) => Number(b.live) - Number(a.live) || (a.startsAt?.getTime() ?? Infinity) - (b.startsAt?.getTime() ?? Infinity))
    .slice(0, limit);
}

async function renderEvents(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const events = await loadEvents(ctx, Number(config.limit) || 6);
  const o = { locale: ctx.locale };
  if (events.length === 0) return emptyState(m.site_events_empty({}, o));
  const layout = config.layout === 'list' ? 'stack' : 'card-grid';
  const cards = events
    .map((e) => {
      const count =
        e.countKind === 'registrations'
          ? m.site_event_registrations({ count: formatNumber(e.count, ctx.locale) }, o)
          : m.site_event_interested({ count: formatNumber(e.count, ctx.locale) }, o);
      let action = '';
      if (e.registrable && e.formId) {
        action = `<a class="btn btn-primary btn-sm"${attrs({ href: `${ctx.basePath}/form/${e.formId}?event=${e.id}` })}>${esc(m.site_event_register({}, o))}</a>`;
      } else if (e.registrable) {
        action = `<button type="button" class="btn btn-primary btn-sm"${attrs({ 'data-action': 'event-register', 'data-id': e.id, 'data-requires-login': '1' })}>${esc(m.site_event_register({}, o))}</button>`;
      } else if (e.url) {
        action = `<a class="btn btn-secondary btn-sm"${attrs({ href: e.url, rel: 'noopener', target: '_blank' })}>${esc(m.site_open_in_discord({}, o))}</a>`;
      }
      return `<article class="event-card">
  ${e.image ? `<img class="card-cover"${attrs({ src: e.image, alt: '', loading: 'lazy', decoding: 'async' })}>` : ''}
  <div class="card-body">
    <p class="card-kicker">${e.live ? `<span class="pill pill-live">${esc(m.site_event_live({}, o))}</span>` : e.startsAt ? timeTag(e.startsAt, ctx.locale, 'full') : ''}</p>
    <h3 class="card-title">${esc(e.title)}</h3>
    ${e.description ? `<div class="card-text rich">${parseDiscordMarkdown(truncate(e.description, 400), ctx.guild)}</div>` : ''}
    <p class="card-meta">${esc(count)}</p>
    ${action ? `<div class="card-actions">${action}</div>` : ''}
  </div>
</article>`;
    })
    .join('');
  return `<div class="${layout}">${cards}</div>`;
}

// ─── Saisons ────────────────────────────────────────────────────────────────

async function renderSeasons(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const season = await prisma.levelingSeason.findFirst({
    where: { guildId: ctx.site.guildId, status: 'ACTIVE' },
    select: { name: true, number: true, endDate: true },
  });
  const o = { locale: ctx.locale };
  if (!season) return emptyState(m.site_season_none({}, o));
  const board = await renderLeaderboard(ctx, { variant: 'season', limit: config.limit });
  return `<div class="season-head"><p class="mod-title">${esc(season.name)} <span class="pill">#${season.number}</span></p><p class="mod-meta">${m.site_season_ends({ date: timeTag(season.endDate, ctx.locale, 'medium') }, o)}</p></div>${board.replace(/^<p class="mod-title">[^<]*<\/p>/, '')}`;
}

// ─── Marché ─────────────────────────────────────────────────────────────────

async function renderMarketplace(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const guildId = ctx.site.guildId;
  const listings = await prisma.marketplaceListing.findMany({
    where: { guildId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: Number(config.limit) || 12,
    select: { id: true, sellerId: true, itemId: true, quantity: true, upgrade: true, type: true, price: true, currentBid: true, expiresAt: true },
  });
  const o = { locale: ctx.locale };
  if (listings.length === 0) return emptyState(m.site_market_empty({}, o));
  const [items, identities] = await Promise.all([
    prisma.rpgItem.findMany({ where: { guildId, id: { in: [...new Set(listings.map((l) => l.itemId))] } }, select: { id: true, name: true, emoji: true, rarity: true } }),
    getMemberIdentities(ctx.client, guildId, listings.map((l) => l.sellerId)).catch(() => new Map()),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const viewerId = ctx.viewer?.userId;
  const cards = listings
    .map((l) => {
      const item = itemById.get(l.itemId);
      const seller = identities.get(l.sellerId)?.displayName ?? l.sellerId;
      const isAuction = l.type === 'AUCTION';
      const price = formatNumber(isAuction ? (l.currentBid ?? l.price) : l.price, ctx.locale);
      const canBuy = !isAuction && l.sellerId !== viewerId;
      return `<article class="${cls('market-card', `rarity-${(item?.rarity ?? 'COMMON').toLowerCase()}`)}">
  <div class="card-body">
    <p class="market-item"><span class="market-emoji" aria-hidden="true">${esc(item?.emoji ?? '📦')}</span> ${esc(item?.name ?? '?')}${l.upgrade > 0 ? ` <span class="pill">+${l.upgrade}</span>` : ''} ${l.quantity > 1 ? `<span class="market-qty">${esc(m.site_market_quantity({ count: l.quantity }, o))}</span>` : ''}</p>
    <p class="card-meta">${esc(m.site_market_seller({ name: seller }, o))}</p>
    <p class="market-price">${isAuction ? `<small>${esc(m.site_market_bid({}, o))}</small> ` : ''}${esc(m.site_coins({ value: price }, o))}</p>
    ${canBuy ? `<div class="card-actions"><button type="button" class="btn btn-primary btn-sm"${attrs({ 'data-action': 'market-buy', 'data-id': l.id, 'data-requires-login': '1' })}>${esc(m.site_market_buy({}, o))}</button></div>` : ''}
  </div>
</article>`;
    })
    .join('');
  return `<div class="card-grid card-grid-sm">${cards}</div>`;
}

// ─── Starboard ──────────────────────────────────────────────────────────────

interface StarItem {
  channelId: string;
  messageId: string;
  authorName: string;
  authorAvatar: string | null;
  content: string;
  image: string | null;
  score: number;
  createdAt: string;
}

async function renderStarboard(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const guild = ctx.guild;
  if (!guild) return '';
  const limit = Number(config.limit) || 6;
  const items = await cache.wrap<StarItem[]>(`guild:${guild.id}:site-starboard:${limit}`, 600, async () => {
    const entries = await prisma.starboardEntry.findMany({
      where: { guildId: guild.id, starMessageId: { not: null } },
      orderBy: [{ peakScore: 'desc' }, { postedAt: 'desc' }],
      take: limit * 2,
      select: { channelId: true, messageId: true, score: true, peakScore: true },
    });
    const out: StarItem[] = [];
    for (const entry of entries) {
      if (out.length >= limit) break;
      const channel = guild.channels.cache.get(entry.channelId);
      // Un message mis en avant depuis un salon privé reste sur Discord.
      if (!channel || !channel.isTextBased() || !isPubliclyVisible(guild, channel, true)) continue;
      const msg = await channel.messages.fetch(entry.messageId).catch(() => null);
      if (!msg) continue;
      out.push({
        channelId: entry.channelId,
        messageId: entry.messageId,
        authorName: msg.member?.displayName ?? msg.author.username,
        authorAvatar: (msg.member ?? msg.author).displayAvatarURL({ size: 64 }),
        content: msg.content,
        image: [...msg.attachments.values()].find((a) => a.contentType?.startsWith('image/'))?.url ?? null,
        score: Math.max(entry.score, entry.peakScore),
        createdAt: msg.createdAt.toISOString(),
      });
    }
    return out;
  });
  const o = { locale: ctx.locale };
  if (items.length === 0) return emptyState(m.site_starboard_empty({}, o));
  const cards = items
    .map(
      (s) => `<article class="star-card">
  <div class="card-body">
    <p class="feed-head">${avatar(s.authorAvatar, s.authorName, 'sm')} <strong>${esc(s.authorName)}</strong> <span class="star-score">⭐ ${esc(formatNumber(s.score, ctx.locale))}</span></p>
    ${s.content ? `<div class="card-text rich">${parseDiscordMarkdown(truncate(s.content, 600), guild)}</div>` : ''}
    ${s.image ? `<img class="feed-image"${attrs({ src: s.image, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })}>` : ''}
    <p class="card-meta">${timeTag(s.createdAt, ctx.locale, 'medium')} · <a${attrs({ href: discordMessageUrl(guild.id, s.channelId, s.messageId), rel: 'noopener', target: '_blank' })}>${esc(m.site_open_in_discord({}, o))}</a></p>
  </div>
</article>`,
    )
    .join('');
  return `<div class="card-grid">${cards}</div>`;
}

export const engagementBlocks: BlockRegistry = {
  leaderboard: renderLeaderboard,
  clans: renderClans,
  giveaways: renderGiveaways,
  events: renderEvents,
  seasons: renderSeasons,
  marketplace: renderMarketplace,
  starboard: renderStarboard,
};
