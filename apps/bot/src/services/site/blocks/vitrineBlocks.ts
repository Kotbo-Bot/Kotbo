/**
 * Blocs « vitrine » : équipe, règlement, actualités, partenaires, chiffres.
 */

import type { SitePartnerItem } from '@kotbo/shared';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import * as m from '../../../lib/paraglide/messages.js';
import { parseDiscordMarkdown } from '../../../api/shared/markdown.js';
import { attrs, cls, esc, truncate } from '../siteHtml.js';
import { avatar, emptyState, formatNumber, timeTag, type BlockContext, type BlockRegistry } from './blockContext.js';

// ─── Équipe ─────────────────────────────────────────────────────────────────

/** Champs de la fiche staff, activables par le propriétaire (`CommunitySite.staffPage`). */
export interface StaffPageSettings {
  bio: boolean;
  absence: boolean;
  seniority: boolean;
  stats: boolean;
}

export function readStaffPageSettings(raw: unknown): StaffPageSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    bio: value.bio !== false,
    absence: value.absence !== false,
    seniority: value.seniority !== false,
    stats: value.stats === true,
  };
}

interface StaffCard {
  userId: string;
  name: string;
  avatarUrl: string | null;
  grade: string;
  gradeColor: string | null;
  gradeLevel: number;
  joinedAt: string;
  bio: string | null;
  absent: boolean;
  tickets: number;
  appeals: number;
}

interface StaffGroup {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  members: StaffCard[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const STAFF_TTL_SECONDS = 60;

async function loadStaffGroups(ctx: BlockContext): Promise<StaffGroup[]> {
  const guildId = ctx.site.guildId;
  return cache.wrap(`guild:${guildId}:site-staff`, STAFF_TTL_SECONDS, async () => {
    const now = new Date();
    const [members, hierarchies, roles, profiles, absences, ticketCounts, appealCounts] = await Promise.all([
      prisma.staffMember.findMany({
        where: { guildId, suspendedAt: null },
        select: {
          userId: true,
          grade: true,
          joinedStaffAt: true,
          displayName: true,
          username: true,
          avatarUrl: true,
          hierarchyGrades: { select: { hierarchyId: true, grade: true } },
        },
        take: 500,
      }),
      prisma.staffHierarchy.findMany({
        where: { guildId, enabled: true },
        select: { id: true, name: true, icon: true, color: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.staffRole.findMany({
        where: { guildId, enabled: true },
        select: { name: true, level: true, color: true, hierarchyId: true },
      }),
      prisma.siteStaffProfile.findMany({ where: { guildId }, select: { userId: true, bio: true, hidden: true } }),
      prisma.staffAbsence.findMany({
        where: {
          guildId,
          isVoid: false,
          status: { in: ['APPROVED', 'ACKNOWLEDGED'] },
          startDate: { lte: now },
          OR: [{ endDate: null }, { endDate: { gte: now } }],
        },
        select: { staffUserId: true },
      }),
      prisma.ticket.groupBy({ by: ['claimedById'], where: { guildId, claimedById: { not: null } }, _count: { _all: true } }),
      prisma.banAppeal.groupBy({ by: ['decidedByUserId'], where: { guildId, decidedByUserId: { not: null } }, _count: { _all: true } }),
    ]);

    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const absent = new Set(absences.map((a) => a.staffUserId));
    const tickets = new Map(ticketCounts.map((row) => [row.claimedById ?? '', row._count._all]));
    const appeals = new Map(appealCounts.map((row) => [row.decidedByUserId ?? '', row._count._all]));
    const roleKey = (hierarchyId: string | null, grade: string) => `${hierarchyId ?? ''}:${grade.toLowerCase()}`;
    const roleByGrade = new Map(roles.map((r) => [roleKey(r.hierarchyId, r.name), r]));
    const anyRoleByName = new Map(roles.map((r) => [r.name.toLowerCase(), r]));

    const card = (member: (typeof members)[number], hierarchyId: string | null, grade: string): StaffCard => {
      const role = roleByGrade.get(roleKey(hierarchyId, grade)) ?? anyRoleByName.get(grade.toLowerCase());
      const discordMember = ctx.guild?.members.cache.get(member.userId);
      return {
        userId: member.userId,
        name: discordMember?.displayName ?? member.displayName ?? member.username ?? member.userId,
        avatarUrl: discordMember?.displayAvatarURL({ size: 128 }) ?? member.avatarUrl ?? null,
        grade,
        gradeColor: role?.color && HEX.test(role.color) ? role.color : null,
        gradeLevel: role?.level ?? 0,
        joinedAt: member.joinedStaffAt.toISOString(),
        bio: profileByUser.get(member.userId)?.bio ?? null,
        absent: absent.has(member.userId),
        tickets: tickets.get(member.userId) ?? 0,
        appeals: appeals.get(member.userId) ?? 0,
      };
    };

    const visible = members.filter((member) => !profileByUser.get(member.userId)?.hidden);
    const groups: StaffGroup[] = hierarchies.map((h) => ({ id: h.id, name: h.name, icon: h.icon, color: h.color && HEX.test(h.color) ? h.color : null, members: [] }));
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const ungrouped: StaffCard[] = [];

    for (const member of visible) {
      const placed = member.hierarchyGrades.filter((g) => groupById.has(g.hierarchyId));
      if (placed.length === 0) {
        ungrouped.push(card(member, null, member.grade));
        continue;
      }
      for (const grade of placed) groupById.get(grade.hierarchyId)?.members.push(card(member, grade.hierarchyId, grade.grade));
    }
    if (ungrouped.length > 0) groups.push({ id: '', name: '', icon: null, color: null, members: ungrouped });

    for (const group of groups) {
      group.members.sort((a, b) => b.gradeLevel - a.gradeLevel || a.joinedAt.localeCompare(b.joinedAt));
    }
    return groups.filter((g) => g.members.length > 0);
  });
}

function renderStaffCard(card: StaffCard, fields: StaffPageSettings, ctx: BlockContext): string {
  const gradeStyle = card.gradeColor ? `--grade:${card.gradeColor}` : null;
  const status = fields.absence
    ? `<span class="${cls('pill', card.absent ? 'pill-muted' : 'pill-ok')}">${esc(card.absent ? m.site_staff_absent({}, { locale: ctx.locale }) : m.site_staff_present({}, { locale: ctx.locale }))}</span>`
    : '';
  const bio = fields.bio && card.bio ? `<p class="staff-bio">${esc(card.bio)}</p>` : '';
  const since = fields.seniority
    ? `<p class="staff-meta">${m.site_staff_since({ date: timeTag(card.joinedAt, ctx.locale, 'medium') }, { locale: ctx.locale })}</p>`
    : '';
  const stats: string[] = [];
  if (fields.stats && card.tickets > 0) stats.push(`<li>${esc(m.site_staff_stat_tickets({ count: formatNumber(card.tickets, ctx.locale) }, { locale: ctx.locale }))}</li>`);
  if (fields.stats && card.appeals > 0) stats.push(`<li>${esc(m.site_staff_stat_appeals({ count: formatNumber(card.appeals, ctx.locale) }, { locale: ctx.locale }))}</li>`);
  return `<article class="staff-card">
  ${avatar(card.avatarUrl, card.name, 'lg')}
  <div class="staff-body">
    <h3 class="staff-name">${esc(card.name)}</h3>
    <p class="staff-grade"${attrs({ style: gradeStyle })}>${esc(card.grade)}</p>
    ${status}${bio}${since}${stats.length > 0 ? `<ul class="staff-stats">${stats.join('')}</ul>` : ''}
  </div>
</article>`;
}

async function renderStaff(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const fields = readStaffPageSettings(ctx.site.staffPage);
  const wanted = Array.isArray(config.hierarchyIds) ? (config.hierarchyIds as string[]) : [];
  let groups = await loadStaffGroups(ctx);
  if (wanted.length > 0) groups = groups.filter((g) => wanted.includes(g.id));
  if (groups.length === 0) return emptyState(m.site_staff_empty({}, { locale: ctx.locale }));

  const layout = config.layout === 'org' ? 'org' : 'grid';
  return groups
    .map((group) => {
      const heading = group.name || (groups.length > 1 ? m.site_staff_other({}, { locale: ctx.locale }) : '');
      const title = heading
        ? `<h3 class="group-title"${attrs({ style: group.color ? `--group:${group.color}` : null })}>${group.icon ? `<span aria-hidden="true">${esc(group.icon)}</span> ` : ''}${esc(heading)}</h3>`
        : '';
      if (layout === 'org') {
        // Un palier par grade, du plus élevé au plus bas.
        const tiers = new Map<string, StaffCard[]>();
        for (const member of group.members) tiers.set(member.grade, [...(tiers.get(member.grade) ?? []), member]);
        const rows = [...tiers.entries()]
          .map(([grade, cards]) => `<div class="org-tier"><p class="org-grade">${esc(grade)}</p><div class="org-row">${cards.map((c) => renderStaffCard(c, fields, ctx)).join('')}</div></div>`)
          .join('');
        return `<div class="staff-group">${title}<div class="org">${rows}</div></div>`;
      }
      return `<div class="staff-group">${title}<div class="card-grid">${group.members.map((c) => renderStaffCard(c, fields, ctx)).join('')}</div></div>`;
    })
    .join('');
}

// ─── Règlement ──────────────────────────────────────────────────────────────

async function renderRules(ctx: BlockContext): Promise<string> {
  const articles = await prisma.guildRegulationArticle.findMany({
    where: { guildId: ctx.site.guildId, enabled: true },
    select: { id: true, title: true, description: true, emoji: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    take: 100,
  });
  if (articles.length === 0) return emptyState(m.site_rules_empty({}, { locale: ctx.locale }));
  const items = articles
    .map(
      (a, i) => `<li class="rule" id="regle-${i + 1}">
  <span class="rule-num" aria-hidden="true">${a.emoji ? esc(a.emoji) : i + 1}</span>
  <div><h3 class="rule-title">${esc(a.title)}</h3><div class="rule-desc rich">${parseDiscordMarkdown(a.description, ctx.guild)}</div></div>
</li>`,
    )
    .join('');
  return `<ol class="rules">${items}</ol>`;
}

// ─── Actualités ─────────────────────────────────────────────────────────────

async function renderNews(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const limit = Number(config.limit) || 6;
  const articles = await prisma.newsArticle.findMany({
    where: { guildId: ctx.site.guildId, published: true },
    select: { id: true, title: true, content: true, summary: true, imageUrl: true, category: true, authorName: true, publishedAt: true },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  });
  if (articles.length === 0) return emptyState(m.site_news_empty({}, { locale: ctx.locale }));
  const layout = config.layout === 'list' ? 'list' : 'cards';
  const items = articles
    .map((a) => {
      const image = a.imageUrl && /^https:\/\//.test(a.imageUrl) ? `<img class="card-cover"${attrs({ src: a.imageUrl, alt: '', loading: 'lazy', decoding: 'async' })}>` : '';
      const summary = a.summary || truncate(a.content.replace(/[*_~`>#|]/g, ''), 220);
      return `<article class="news-card">
  ${image}
  <div class="card-body">
    <p class="card-kicker">${esc(a.category)} · ${timeTag(a.publishedAt, ctx.locale, 'medium')}</p>
    <h3 class="card-title">${esc(a.title)}</h3>
    <p class="card-text">${esc(summary)}</p>
    <details class="news-more"><summary>${esc(m.site_read_more({}, { locale: ctx.locale }))}</summary><div class="rich">${parseDiscordMarkdown(a.content, ctx.guild)}</div></details>
  </div>
</article>`;
    })
    .join('');
  return `<div class="${layout === 'list' ? 'stack' : 'card-grid'}">${items}</div>`;
}

// ─── Partenaires (saisis à la main) ─────────────────────────────────────────

async function renderPartners(ctx: BlockContext, config: Record<string, unknown>): Promise<string> {
  const items = (Array.isArray(config.items) ? config.items : []) as SitePartnerItem[];
  if (items.length === 0) return emptyState(m.site_partners_empty({}, { locale: ctx.locale }));
  const cards = items
    .map(
      (p) => `<article class="partner-card">
  ${avatar(p.logoUrl || null, p.name, 'lg')}
  <div class="card-body">
    <h3 class="card-title">${esc(p.name)}</h3>
    ${p.description ? `<p class="card-text">${esc(p.description)}</p>` : ''}
    ${p.url ? `<a class="btn btn-secondary btn-sm"${attrs({ href: p.url, rel: 'noopener noreferrer', target: '_blank' })}>${esc(m.site_visit({}, { locale: ctx.locale }))}</a>` : ''}
  </div>
</article>`,
    )
    .join('');
  return `<div class="card-grid">${cards}</div>`;
}

// ─── Chiffres du serveur ────────────────────────────────────────────────────

export async function getGuildCounts(ctx: BlockContext): Promise<{ members: number; online: number; boosts: number; channels: number }> {
  return cache.wrap(`guild:${ctx.site.guildId}:site-counts`, 120, async () => {
    const fetched = await ctx.client.guilds.fetch({ guild: ctx.site.guildId, withCounts: true, force: true }).catch(() => null);
    const guild = fetched ?? ctx.guild;
    return {
      members: guild?.approximateMemberCount ?? guild?.memberCount ?? 0,
      online: guild?.approximatePresenceCount ?? 0,
      boosts: guild?.premiumSubscriptionCount ?? 0,
      channels: ctx.guild?.channels.cache.size ?? 0,
    };
  });
}

async function renderServerStats(ctx: BlockContext): Promise<string> {
  const counts = await getGuildCounts(ctx);
  const o = { locale: ctx.locale };
  const tile = (value: number, label: string) => `<div class="stat"><p class="stat-value">${esc(formatNumber(value, ctx.locale))}</p><p class="stat-label">${esc(label)}</p></div>`;
  return `<div class="stats">${tile(counts.members, m.site_stat_members({}, o))}${tile(counts.online, m.site_stat_online({}, o))}${tile(counts.boosts, m.site_stat_boosts({}, o))}${tile(counts.channels, m.site_stat_channels({}, o))}</div>`;
}

export const vitrineBlocks: BlockRegistry = {
  staff: renderStaff,
  rules: renderRules,
  news: renderNews,
  partners: renderPartners,
  serverStats: renderServerStats,
};
