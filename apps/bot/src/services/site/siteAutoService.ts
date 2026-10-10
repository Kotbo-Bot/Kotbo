/**
 * Site qui se tient à jour seul.
 *
 *  - Annonces : un message posté dans un salon surveillé devient un article du
 *    blog (titre tiré de la première ligne, première image en couverture) ;
 *    modifié ou supprimé sur Discord, l'article suit.
 *  - Pages des modules : un module allumé reçoit sa page (classements,
 *    événements, démarches…), publiée et ajoutée au menu.
 *  - Nouveautés : ce qui a changé sur le serveur (modules, salons, emojis,
 *    articles, forum, boutique, votes), lu à la volée, sans journal à tenir.
 *  - Résumé de la semaine : un article publié chaque semaine au jour et à
 *    l'heure choisis (heure de Paris).
 *
 * Les articles générés ne sont pas annoncés sur Discord : ils en viennent, ou
 * le résumé n'a pas besoin d'un ping.
 */

import { ChannelType, type Client, type Message, type PartialMessage } from 'discord.js';
import { getModuleDefinition } from '@kotbo/contracts';
import { isoWeekKey, markdownToSiteDocument, normalizeSiteAuto, splitAnnouncement, type SiteAutoSettings } from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { getModuleStates } from '../core/moduleGate.js';
import { getMemberIdentities } from '../moderation/memberIdentityService.js';
import { isPubliclyVisible } from './blocks/discordBlocks.js';
import { createPage, publishPage, unpublishPage, updatePage } from './siteAdminService.js';
import { getSiteByGuild, type SiteRecord } from './siteService.js';
import { buildSiteBlueprint } from './siteTemplates.js';
import { storeSiteAsset, SITE_UPLOAD_MAX_BYTES } from './siteUploads.js';
import { siteUrl } from './siteNotifyService.js';

type Locale = 'fr' | 'en';

export function siteAutoSettings(site: Pick<SiteRecord, 'settings'>): SiteAutoSettings {
  const settings = typeof site.settings === 'object' && site.settings !== null ? (site.settings as Record<string, unknown>) : {};
  return normalizeSiteAuto(settings.auto);
}

async function localeOf(client: Client, guildId: string): Promise<Locale> {
  return (await resolveGuildLocale(guildId, client.guilds.cache.get(guildId)?.preferredLocale)) === 'en' ? 'en' : 'fr';
}

// ─── Annonces Discord → blog ────────────────────────────────────────────────

interface Watched {
  channelIds: string[];
}

function watchKey(guildId: string) {
  return `site-auto:announce:${guildId}`;
}

/** À appeler quand les réglages du site changent. */
export async function invalidateSiteAuto(guildId: string): Promise<void> {
  await cache.delete(watchKey(guildId));
}

async function watchedChannels(guildId: string): Promise<string[]> {
  const watched = await cache.wrap<Watched>(watchKey(guildId), 300, async () => {
    const site = await getSiteByGuild(guildId);
    if (!site) return { channelIds: [] };
    const auto = siteAutoSettings(site);
    return { channelIds: auto.announcements.enabled ? auto.announcements.channelIds : [] };
  });
  return watched.channelIds;
}

/** Mentions, salons, rôles, emojis et dates Discord rendus lisibles hors de Discord. */
export function discordToMarkdown(message: Pick<Message, 'content' | 'guild' | 'mentions'>): string {
  const guild = message.guild;
  return message.content
    .replace(/<@!?(\d{17,20})>/g, (_all, id: string) => `@${message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.username ?? guild?.members.cache.get(id)?.displayName ?? '…'}`)
    .replace(/<#(\d{17,20})>/g, (_all, id: string) => `#${guild?.channels.cache.get(id)?.name ?? '…'}`)
    .replace(/<@&(\d{17,20})>/g, (_all, id: string) => `@${guild?.roles.cache.get(id)?.name ?? '…'}`)
    .replace(/<a?:(\w{1,32}):\d{17,20}>/g, ':$1:')
    .replace(/<t:(\d{1,12})(?::[tTdDfFR])?>/g, (_all, ts: string) =>
      new Date(Number(ts) * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' }),
    )
    .replace(/@(everyone|here)\b/g, '')
    .trim();
}

function announcementText(message: Message): string {
  const text = discordToMarkdown(message);
  if (text) return text;
  // Annonce publiée par un bot : le texte est souvent dans l'embed.
  const embed = message.embeds[0];
  if (!embed) return '';
  return [embed.title ? `## ${embed.title}` : '', embed.description ?? ''].filter(Boolean).join('\n\n').trim();
}

/** Première image du message copiée dans les images du site (les liens du CDN Discord expirent). */
async function coverFromMessage(site: SiteRecord, message: Message): Promise<string | null> {
  const image = [...message.attachments.values()].find((a) => a.contentType?.startsWith('image/') && a.size <= SITE_UPLOAD_MAX_BYTES);
  const url = image?.url ?? message.embeds[0]?.image?.url ?? null;
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (!/(^|\.)discordapp\.(com|net)$/.test(host) && !/(^|\.)discord\.com$/.test(host)) return null;
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const stored = await storeSiteAsset(site, { bytes, fileName: image?.name ?? 'annonce', uploadedById: message.author.id });
    return stored.ok ? stored.asset.url : null;
  } catch {
    return null;
  }
}

export async function handleAnnouncementMessage(client: Client, message: Message): Promise<void> {
  if (!message.guildId || message.system || message.author.id === client.user?.id) return;
  const channels = await watchedChannels(message.guildId);
  if (!channels.includes(message.channelId)) return;
  const site = await getSiteByGuild(message.guildId);
  if (!site) return;
  const auto = siteAutoSettings(site);
  const text = announcementText(message);
  if (text.length < auto.announcements.minLength) return;
  const key = `msg:${message.id}`;
  if (await prisma.siteAutoPost.findUnique({ where: { key } })) return;

  const locale = await localeOf(client, message.guildId);
  const fallback = m.site_auto_announce_title({ date: message.createdAt.toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) }, { locale });
  const { title, body } = splitAnnouncement(text, fallback);
  const page = await createPage(site, message.author.id, { kind: 'BLOG', title, content: markdownToSiteDocument(body || text) });
  const cover = await coverFromMessage(site, message);
  await updatePage(site, page.id, { tags: [auto.announcements.tag], ...(cover ? { coverUrl: cover } : {}) }, message.author.id);
  await publishPage(client, message.guildId, page.id, message.author.id, m.site_auto_announce_note({}, { locale }), { announce: false });
  await prisma.siteAutoPost.create({ data: { key, siteId: site.id, pageId: page.id } }).catch(() => null);
  logger.info('Site', `Annonce ${message.id} publiée sur le blog de ${message.guildId}`);
}

export async function handleAnnouncementUpdate(client: Client, message: Message | PartialMessage): Promise<void> {
  if (!message.guildId) return;
  const post = await prisma.siteAutoPost.findUnique({ where: { key: `msg:${message.id}` } });
  if (!post) return;
  const full = message.partial ? await message.fetch().catch(() => null) : message;
  if (!full) return;
  const site = await getSiteByGuild(message.guildId);
  if (!site) return;
  const locale = await localeOf(client, message.guildId);
  const text = announcementText(full);
  const { title, body } = splitAnnouncement(text, m.site_auto_announce_title({ date: full.createdAt.toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR') }, { locale }));
  await updatePage(site, post.pageId, { title, draftContent: markdownToSiteDocument(body || text) }, full.author.id);
  await publishPage(client, message.guildId, post.pageId, full.author.id, m.site_auto_announce_edited({}, { locale }), { announce: false });
}

export async function handleAnnouncementDelete(message: Message | PartialMessage): Promise<void> {
  if (!message.guildId) return;
  const post = await prisma.siteAutoPost.findUnique({ where: { key: `msg:${message.id}` } });
  if (!post) return;
  await unpublishPage(message.guildId, post.pageId).catch(() => null);
}

// ─── Pages des modules ──────────────────────────────────────────────────────

/** Pages du modèle que l'activation d'un module peut faire apparaître. */
const MODULE_PAGE_KEYS = ['team', 'rules', 'rankings', 'events', 'help', 'market'] as const;

/**
 * Crée les pages des modules allumés qui n'en ont pas encore. Une page déjà
 * créée une fois (même retirée depuis par le propriétaire) n'est pas recréée.
 */
export async function syncAutoModulePages(client: Client, guildId: string): Promise<number> {
  const site = await getSiteByGuild(guildId);
  if (!site || !siteAutoSettings(site).modulePages.enabled) return 0;
  const locale = await localeOf(client, guildId);
  const blueprint = buildSiteBlueprint('general', locale, await getModuleStates(guildId));
  const existing = await prisma.sitePage.findMany({ where: { siteId: site.id, kind: 'PAGE' }, select: { slug: true } });
  const slugs = new Set(existing.map((p) => p.slug));
  const done = new Set((await prisma.siteAutoPost.findMany({ where: { siteId: site.id, key: { startsWith: 'module:' } }, select: { key: true } })).map((p) => p.key));

  const navigation = Array.isArray(site.navigation) ? [...(site.navigation as unknown[])] : [];
  let created = 0;
  for (const template of blueprint.pages) {
    if (!(MODULE_PAGE_KEYS as readonly string[]).includes(template.key)) continue;
    const key = `module:${template.key}`;
    if (done.has(key) || slugs.has(template.slug)) continue;
    const page = await createPage(site, client.user?.id ?? 'kotbo', { kind: 'PAGE', title: template.title, slug: template.slug, content: template.content });
    if (template.excerpt) await updatePage(site, page.id, { excerpt: template.excerpt }, client.user?.id ?? 'kotbo');
    await publishPage(client, guildId, page.id, client.user?.id ?? 'kotbo', m.site_auto_module_note({}, { locale }), { announce: false });
    await prisma.siteAutoPost.create({ data: { key, siteId: site.id, pageId: page.id } }).catch(() => null);
    // Un menu vide est composé par défaut : on ne le fige pas en y ajoutant une entrée.
    if (template.inNav && navigation.length > 0 && navigation.length < 12) {
      navigation.push({ id: `nav-auto-${template.key}`, label: template.title, target: { type: 'page', pageId: page.id }, children: [] });
    }
    created += 1;
  }
  if (created > 0 && navigation.length > 0) {
    await prisma.communitySite.update({ where: { id: site.id }, data: { navigation: navigation as object[] } });
  }
  return created;
}

/** Appelé à l'activation d'un module ; ne bloque jamais la bascule. */
export function scheduleAutoModulePages(client: Client, guildId: string): void {
  setTimeout(() => {
    syncAutoModulePages(client, guildId).catch((err: unknown) => logger.warn('Site', `Pages automatiques non créées sur ${guildId} :`, err));
  }, 5_000);
}

// ─── Nouveautés du serveur ──────────────────────────────────────────────────

export type ChangelogKind = 'module' | 'channel' | 'emoji' | 'article' | 'wiki' | 'forum' | 'shop' | 'vote';

export interface ChangelogEntry {
  at: Date;
  kind: ChangelogKind;
  text: string;
  href?: string;
}

export async function collectChangelog(client: Client, site: SiteRecord, since: Date, locale: Locale): Promise<ChangelogEntry[]> {
  const o = { locale };
  const guild = client.guilds.cache.get(site.guildId) ?? null;
  const base = `/s/${site.slug}`;
  const [modules, pages, categories, offers, voteSites] = await Promise.all([
    prisma.moduleActivationStat.findMany({ where: { guildId: site.guildId, enabled: true, activatedAt: { gte: since } }, select: { moduleName: true, config: true, activatedAt: true } }),
    prisma.sitePage.findMany({
      where: { siteId: site.id, kind: { in: ['WIKI', 'BLOG'] }, visibility: 'PUBLIC', publishedAt: { not: null }, firstPublishedAt: { gte: since } },
      select: { kind: true, slug: true, publishedTitle: true, title: true, firstPublishedAt: true },
    }),
    prisma.siteForumCategory.findMany({ where: { siteId: site.id, createdAt: { gte: since } }, select: { name: true, slug: true, createdAt: true } }),
    prisma.shopOffer.findMany({ where: { guildId: site.guildId, enabled: true, createdAt: { gte: since } }, select: { name: true, createdAt: true } }),
    prisma.siteVoteSite.findMany({ where: { guildId: site.guildId, enabled: true, createdAt: { gte: since } }, select: { label: true, createdAt: true } }),
  ]);

  const entries: ChangelogEntry[] = [];
  for (const row of modules) {
    const featureKey = typeof (row.config as Record<string, unknown> | null)?.featureKey === 'string' ? ((row.config as Record<string, unknown>).featureKey as string) : row.moduleName;
    const name = getModuleDefinition(featureKey)?.name;
    if (name && row.activatedAt) entries.push({ at: row.activatedAt, kind: 'module', text: m.site_changelog_module({ name }, o) });
  }
  if (guild) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel.createdAt || channel.createdAt < since) continue;
      if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) continue;
      if (!isPubliclyVisible(guild, channel)) continue;
      entries.push({ at: channel.createdAt, kind: 'channel', text: m.site_changelog_channel({ name: channel.name }, o) });
    }
    for (const emoji of guild.emojis.cache.values()) {
      if (emoji.createdAt && emoji.createdAt >= since && emoji.name) entries.push({ at: emoji.createdAt, kind: 'emoji', text: m.site_changelog_emoji({ name: emoji.name }, o) });
    }
  }
  for (const page of pages) {
    const title = page.publishedTitle ?? page.title;
    entries.push({
      at: page.firstPublishedAt!,
      kind: page.kind === 'WIKI' ? 'wiki' : 'article',
      text: page.kind === 'WIKI' ? m.site_changelog_wiki({ title }, o) : m.site_changelog_article({ title }, o),
      href: `${base}/${page.kind === 'WIKI' ? 'wiki' : 'blog'}/${page.slug}`,
    });
  }
  for (const category of categories) entries.push({ at: category.createdAt, kind: 'forum', text: m.site_changelog_forum({ name: category.name }, o), href: `${base}/forum/${category.slug}` });
  for (const offer of offers) entries.push({ at: offer.createdAt, kind: 'shop', text: m.site_changelog_shop({ name: offer.name }, o), href: `${base}/shop` });
  for (const vote of voteSites) entries.push({ at: vote.createdAt, kind: 'vote', text: m.site_changelog_vote({ name: vote.label }, o), href: `${base}/votes` });
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ─── Résumé de la semaine ───────────────────────────────────────────────────

function parisNow(date = new Date()): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Mon');
  return { weekday, hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0) };
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

function trend(current: number, previous: number, locale: Locale): string {
  if (previous <= 0) return '';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return '';
  return ` (${pct > 0 ? '+' : ''}${pct.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR')} %)`;
}

/** Corps Markdown du résumé : chiffres, membres actifs, nouveautés, lectures, forum, votes. */
export async function buildWeeklySummary(client: Client, site: SiteRecord, locale: Locale, now = new Date()): Promise<{ title: string; markdown: string }> {
  const o = { locale };
  const fmt = (n: number) => n.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR');
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const prevStart = new Date(now.getTime() - 14 * 86_400_000);
  const guildId = site.guildId;
  const absolute = (await siteUrl(guildId)) ?? '';

  const [week, previous, top, changelog, forumTopics, voteRows] = await Promise.all([
    prisma.guildDailyStat.aggregate({ where: { guildId, dateKey: { gte: dayKey(weekStart), lt: dayKey(now) } }, _sum: { messagesCount: true, voiceMinutes: true, membersJoined: true } }),
    prisma.guildDailyStat.aggregate({ where: { guildId, dateKey: { gte: dayKey(prevStart), lt: dayKey(weekStart) } }, _sum: { messagesCount: true, voiceMinutes: true, membersJoined: true } }),
    prisma.memberDailyStat.groupBy({ by: ['userId'], where: { guildId, dateKey: { gte: dayKey(weekStart), lt: dayKey(now) } }, _sum: { messagesCount: true }, orderBy: { _sum: { messagesCount: 'desc' } }, take: 5 }),
    collectChangelog(client, site, weekStart, locale),
    prisma.siteForumTopic.findMany({ where: { guildId, deletedAt: null, createdAt: { gte: weekStart } }, orderBy: { replyCount: 'desc' }, take: 3, include: { category: { select: { slug: true } } } }),
    prisma.siteVote.groupBy({ by: ['userId'], where: { guildId, createdAt: { gte: weekStart } }, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 3 }),
  ]);

  const names = await getMemberIdentities(client, guildId, [...top.map((t) => t.userId), ...voteRows.map((v) => v.userId)]);
  const name = (id: string) => names.get(id)?.displayName ?? '…';
  const messages = week._sum.messagesCount ?? 0;
  const voiceHours = Math.round((week._sum.voiceMinutes ?? 0) / 60);
  const joined = week._sum.membersJoined ?? 0;

  const sections: string[] = [];
  sections.push(
    `## ${m.site_weekly_numbers({}, o)}`,
    [
      `- ${m.site_weekly_messages({ count: fmt(messages) }, o)}${trend(messages, previous._sum.messagesCount ?? 0, locale)}`,
      `- ${m.site_weekly_voice({ count: fmt(voiceHours) }, o)}${trend(voiceHours, Math.round((previous._sum.voiceMinutes ?? 0) / 60), locale)}`,
      `- ${m.site_weekly_joined({ count: fmt(joined) }, o)}`,
    ].join('\n'),
  );
  const active = top.filter((t) => (t._sum.messagesCount ?? 0) > 0);
  if (active.length) {
    sections.push(`## ${m.site_weekly_active({}, o)}`, active.map((t, i) => `${i + 1}. **${name(t.userId)}** · ${m.site_weekly_messages({ count: fmt(t._sum.messagesCount ?? 0) }, o)}`).join('\n'));
  }
  if (changelog.length) {
    sections.push(`## ${m.site_weekly_news({}, o)}`, changelog.slice(0, 12).map((e) => (e.href ? `- [${e.text}](${absolute.replace(/\/s\/[^/]+$/, '')}${e.href})` : `- ${e.text}`)).join('\n'));
  }
  if (forumTopics.length) {
    sections.push(
      `## ${m.site_weekly_forum({}, o)}`,
      forumTopics.map((t) => `- [${t.title}](${absolute}/forum/${t.category.slug}/${t.id}) · ${m.site_weekly_replies({ count: fmt(t.replyCount) }, o)}`).join('\n'),
    );
  }
  if (voteRows.length) {
    sections.push(`## ${m.site_weekly_voters({}, o)}`, voteRows.map((v, i) => `${i + 1}. **${name(v.userId)}** · ${m.site_weekly_votes({ count: fmt(v._count._all) }, o)}`).join('\n'));
  }
  sections.push(m.site_weekly_outro({}, o));

  const title = m.site_weekly_title({ date: weekStart.toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'long' }) }, o);
  return { title, markdown: sections.join('\n\n') };
}

/** Publie le résumé d'une semaine (une seule fois par semaine ISO). */
export async function publishWeeklySummary(client: Client, site: SiteRecord, now = new Date()): Promise<string | null> {
  const key = `weekly:${isoWeekKey(now)}`;
  const existing = await prisma.siteAutoPost.findUnique({ where: { key } });
  if (existing) return existing.pageId;
  const locale = await localeOf(client, site.guildId);
  const { title, markdown } = await buildWeeklySummary(client, site, locale, now);
  const author = client.user?.id ?? 'kotbo';
  const page = await createPage(site, author, { kind: 'BLOG', title, content: markdownToSiteDocument(markdown) });
  await updatePage(site, page.id, { tags: [m.site_weekly_tag({}, { locale })] }, author);
  await publishPage(client, site.guildId, page.id, author, m.site_weekly_note({}, { locale }), { announce: false });
  await prisma.siteAutoPost.create({ data: { key, siteId: site.id, pageId: page.id } }).catch(() => null);
  return page.id;
}

/** Passage horaire : publie le résumé des sites dont c'est le jour et l'heure. */
export async function runWeeklySummaries(client: Client): Promise<number> {
  const { weekday, hour } = parisNow();
  const sites = await prisma.communitySite.findMany({ where: { published: true, suspendedAt: null }, select: { guildId: true, settings: true } });
  let published = 0;
  for (const row of sites) {
    if (!client.guilds.cache.has(row.guildId)) continue;
    const auto = normalizeSiteAuto((row.settings as Record<string, unknown> | null)?.auto);
    if (!auto.weeklySummary.enabled || auto.weeklySummary.weekday !== weekday || auto.weeklySummary.hour !== hour) continue;
    const site = await getSiteByGuild(row.guildId);
    if (!site) continue;
    try {
      if (await publishWeeklySummary(client, site)) published += 1;
    } catch (err) {
      logger.warn('Site', `Résumé de la semaine non publié sur ${row.guildId} :`, err);
    }
  }
  return published;
}
