/**
 * Votes pour le serveur sur les sites de classement.
 *
 * Un vote n'est compté (et récompensé) que si le dernier vote compté du
 * membre sur ce site date d'au moins le délai du site ; la contrainte unique
 * (site, membre, fenêtre) bloque en plus deux vérifications simultanées. La
 * série de votes avance d'un jour par jour avec au moins un vote.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Client } from 'discord.js';
import {
  isSiteVoteProvider,
  normalizeSiteRewards,
  normalizeVoteCooldown,
  normalizeVoteUrl,
  previousSiteDayKey,
  SITE_VOTE_PROVIDERS,
  siteDayKey,
  siteStreakBonus,
  voteWindow,
  type SiteVoteProvider,
} from '@kotbo/shared';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { openSecret, sealSecret } from '../../utils/secretBox.js';
import { resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { getSiteByGuild } from './siteService.js';
import { grantSiteReward } from './siteRewardService.js';
import { publishGuildSignal } from './siteLive.js';
import { notifySiteMember } from './siteNotifyService.js';
import { verifyVote, voteKeyFromUrl } from './siteVoteVerifier.js';

export class SiteVoteError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}

const VOTE_SITES_MAX = 12;

export interface PublicVoteSite {
  id: string;
  provider: SiteVoteProvider;
  label: string;
  voteUrl: string;
  cooldownHours: number;
  verification: 'webhook' | 'user' | 'ip';
}

export async function listPublicVoteSites(guildId: string): Promise<PublicVoteSite[]> {
  const rows = await prisma.siteVoteSite.findMany({ where: { guildId, enabled: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  return rows
    .filter((row) => isSiteVoteProvider(row.provider))
    .map((row) => ({
      id: row.id,
      provider: row.provider as SiteVoteProvider,
      label: row.label,
      voteUrl: row.voteUrl,
      cooldownHours: row.cooldownHours,
      verification: SITE_VOTE_PROVIDERS[row.provider as SiteVoteProvider].verification,
    }));
}

// ─── Administration ─────────────────────────────────────────────────────────

export async function listAdminVoteSites(guildId: string, apiUrl: string) {
  const rows = await prisma.siteVoteSite.findMany({ where: { guildId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  const since = new Date(Date.now() - 30 * 86_400_000);
  const counts = await prisma.siteVote.groupBy({ by: ['voteSiteId'], where: { guildId, createdAt: { gte: since } }, _count: { _all: true } });
  const countBy = new Map(counts.map((c) => [c.voteSiteId, c._count._all]));
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    voteUrl: row.voteUrl,
    cooldownHours: row.cooldownHours,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    hasKey: Boolean(row.verificationKey),
    // Le secret n'est montré qu'en clair au gestionnaire, qui doit le coller sur top.gg.
    webhookUrl: row.webhookSecret ? `${apiUrl.replace(/\/$/, '')}/api/site-votes/webhook/${row.id}` : null,
    webhookSecret: row.webhookSecret ? openSecret(row.webhookSecret) : null,
    votes30d: countBy.get(row.id) ?? 0,
  }));
}

export interface VoteSiteInput {
  provider?: unknown;
  label?: unknown;
  voteUrl?: unknown;
  verificationKey?: unknown;
  cooldownHours?: unknown;
  enabled?: unknown;
}

export async function saveVoteSite(guildId: string, id: string | null, input: VoteSiteInput) {
  const site = await getSiteByGuild(guildId);
  if (!site) throw new SiteVoteError('site_missing', 404);
  const existing = id ? await prisma.siteVoteSite.findFirst({ where: { id, guildId } }) : null;
  if (id && !existing) throw new SiteVoteError('vote_site_missing', 404);

  const provider = existing ? (existing.provider as SiteVoteProvider) : input.provider;
  if (!isSiteVoteProvider(provider)) throw new SiteVoteError('invalid_provider');
  const spec = SITE_VOTE_PROVIDERS[provider];

  const voteUrl = input.voteUrl !== undefined ? normalizeVoteUrl(provider, input.voteUrl) : existing?.voteUrl ?? null;
  if (!voteUrl) throw new SiteVoteError('invalid_vote_url');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : existing?.label ?? spec.label;

  // Clé de vérification : saisie, sinon déduite du lien pour les sites qui l'y mettent.
  let sealedKey = existing?.verificationKey ?? null;
  if (typeof input.verificationKey === 'string' && input.verificationKey.trim()) sealedKey = sealSecret(input.verificationKey.trim().slice(0, 300));
  else if (input.verificationKey === null) sealedKey = null;
  if (!sealedKey && spec.verification !== 'webhook') {
    const fromUrl = voteKeyFromUrl(provider, voteUrl);
    if (fromUrl) sealedKey = sealSecret(fromUrl);
  }
  if (!sealedKey && spec.verification !== 'webhook') throw new SiteVoteError('vote_key_required');

  const data = {
    label,
    voteUrl,
    verificationKey: spec.verification === 'webhook' ? null : sealedKey,
    cooldownHours: input.cooldownHours !== undefined ? normalizeVoteCooldown(input.cooldownHours, provider) : existing?.cooldownHours ?? spec.cooldownHours,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true,
  };
  if (existing) return prisma.siteVoteSite.update({ where: { id: existing.id }, data });

  const total = await prisma.siteVoteSite.count({ where: { guildId } });
  if (total >= VOTE_SITES_MAX) throw new SiteVoteError('too_many_vote_sites', 409);
  return prisma.siteVoteSite.create({
    data: {
      ...data,
      siteId: site.id,
      guildId,
      provider,
      sortOrder: total,
      webhookSecret: spec.verification === 'webhook' ? sealSecret(randomBytes(24).toString('hex')) : null,
    },
  });
}

export async function regenerateVoteWebhookSecret(guildId: string, id: string) {
  const row = await prisma.siteVoteSite.findFirst({ where: { id, guildId } });
  if (!row) throw new SiteVoteError('vote_site_missing', 404);
  if (SITE_VOTE_PROVIDERS[row.provider as SiteVoteProvider]?.verification !== 'webhook') throw new SiteVoteError('invalid_provider');
  await prisma.siteVoteSite.update({ where: { id }, data: { webhookSecret: sealSecret(randomBytes(24).toString('hex')) } });
}

export async function deleteVoteSite(guildId: string, id: string): Promise<void> {
  await prisma.siteVoteSite.deleteMany({ where: { id, guildId } });
}

export async function reorderVoteSites(guildId: string, ids: unknown): Promise<void> {
  if (!Array.isArray(ids)) throw new SiteVoteError('invalid_field');
  await prisma.$transaction(
    ids
      .filter((id): id is string => typeof id === 'string')
      .slice(0, VOTE_SITES_MAX)
      .map((id, index) => prisma.siteVoteSite.updateMany({ where: { id, guildId }, data: { sortOrder: index } })),
  );
}

// ─── Comptage d'un vote ─────────────────────────────────────────────────────

export interface VoteResult {
  counted: boolean;
  /** Prochain vote compté possible sur ce site. */
  nextAt: string | null;
  coins: number;
  xp: number;
  streak: number;
}

async function lastVote(voteSiteId: string, userId: string) {
  return prisma.siteVote.findFirst({ where: { voteSiteId, userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
}

/** Série : un jour de plus si le dernier jour de vote est la veille, sinon on repart à 1. */
async function advanceVoteStreak(guildId: string, userId: string): Promise<number> {
  const today = siteDayKey();
  const current = await prisma.siteMemberSettings.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { voteStreak: true, lastVoteDayKey: true } });
  if (current?.lastVoteDayKey === today) return current.voteStreak;
  const streak = current?.lastVoteDayKey === previousSiteDayKey(today) ? current.voteStreak + 1 : 1;
  await prisma.siteMemberSettings.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, voteStreak: streak, lastVoteDayKey: today },
    update: { voteStreak: streak, lastVoteDayKey: today },
  });
  return streak;
}

/** Compte un vote déjà établi (webhook ou vérification), récompense comprise. */
export async function recordVote(client: Client, voteSiteId: string, userId: string, source: 'webhook' | 'check'): Promise<VoteResult> {
  const voteSite = await prisma.siteVoteSite.findUnique({ where: { id: voteSiteId } });
  if (!voteSite || !voteSite.enabled) throw new SiteVoteError('vote_site_missing', 404);
  const now = new Date();
  const cooldownMs = voteSite.cooldownHours * 3_600_000;
  const previous = await lastVote(voteSite.id, userId);
  if (previous && now.getTime() - previous.createdAt.getTime() < cooldownMs) {
    return { counted: false, nextAt: new Date(previous.createdAt.getTime() + cooldownMs).toISOString(), coins: 0, xp: 0, streak: 0 };
  }

  const window = voteWindow(now, voteSite.cooldownHours);
  try {
    await prisma.siteVote.create({ data: { voteSiteId: voteSite.id, guildId: voteSite.guildId, userId, window, source } });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return { counted: false, nextAt: new Date(now.getTime() + cooldownMs).toISOString(), coins: 0, xp: 0, streak: 0 };
    throw err;
  }

  const streak = await advanceVoteStreak(voteSite.guildId, userId);
  const site = await getSiteByGuild(voteSite.guildId);
  const settings = normalizeSiteRewards(site?.rewards);
  const bonus = siteStreakBonus(streak, settings.vote.streakBonus, settings.vote.streakCap);
  const reward = await grantSiteReward(client, voteSite.guildId, userId, 'VOTE', `vote:${voteSite.id}:${window}`, bonus).catch(() => null);
  if (reward) {
    await prisma.siteVote.updateMany({ where: { voteSiteId: voteSite.id, userId, window }, data: { coins: reward.coins, xp: reward.xp } });
  }
  publishGuildSignal(voteSite.guildId, 'module:vote');
  publishGuildSignal(voteSite.guildId, 'module:voteLeaderboard');
  publishGuildSignal(voteSite.guildId, `user:${userId}`);
  return { counted: true, nextAt: new Date(now.getTime() + cooldownMs).toISOString(), coins: reward?.coins ?? 0, xp: reward?.xp ?? 0, streak };
}

/** Le membre dit avoir voté : on demande au site de classement, puis on compte. */
export async function checkMemberVote(client: Client, guildId: string, voteSiteId: string, userId: string, ip: string | null): Promise<VoteResult & { verified: boolean }> {
  const voteSite = await prisma.siteVoteSite.findFirst({ where: { id: voteSiteId, guildId, enabled: true } });
  if (!voteSite || !isSiteVoteProvider(voteSite.provider)) throw new SiteVoteError('vote_site_missing', 404);
  const provider = voteSite.provider;
  if (SITE_VOTE_PROVIDERS[provider].verification === 'webhook') throw new SiteVoteError('vote_automatic');

  const previous = await lastVote(voteSite.id, userId);
  const cooldownMs = voteSite.cooldownHours * 3_600_000;
  if (previous && Date.now() - previous.createdAt.getTime() < cooldownMs) {
    return { verified: true, counted: false, nextAt: new Date(previous.createdAt.getTime() + cooldownMs).toISOString(), coins: 0, xp: 0, streak: 0 };
  }

  const key = voteSite.verificationKey ? openSecret(voteSite.verificationKey) : null;
  if (!key) throw new SiteVoteError('vote_key_required');
  const verified = await verifyVote(provider, { key, ip, userId });
  if (!verified) return { verified: false, counted: false, nextAt: null, coins: 0, xp: 0, streak: 0 };
  return { verified: true, ...(await recordVote(client, voteSite.id, userId, 'check')) };
}

/** Appel de webhook (top.gg) : secret comparé en temps constant. */
export async function handleVoteWebhook(client: Client, voteSiteId: string, authorization: string | null, body: Record<string, unknown>): Promise<'ok' | 'ignored' | 'unauthorized' | 'missing'> {
  const voteSite = await prisma.siteVoteSite.findUnique({ where: { id: voteSiteId } });
  if (!voteSite || !voteSite.webhookSecret) return 'missing';
  const secret = openSecret(voteSite.webhookSecret);
  const given = Buffer.from(authorization ?? '');
  const expected = Buffer.from(secret ?? '');
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) return 'unauthorized';

  // Vote d'essai depuis le tableau de bord de top.gg : accepté, rien n'est compté.
  if (body.type === 'test') return 'ignored';
  const userId = typeof body.user === 'string' ? body.user : '';
  if (!/^\d{17,20}$/.test(userId)) return 'ignored';
  if (typeof body.guild === 'string' && body.guild !== voteSite.guildId) return 'ignored';
  await recordVote(client, voteSite.id, userId, 'webhook');
  return 'ok';
}

// ─── Lecture ────────────────────────────────────────────────────────────────

export interface VoterStatus {
  voteSiteId: string;
  lastVoteAt: string | null;
  nextAt: string | null;
}

export async function voterStatus(guildId: string, userId: string, sites: PublicVoteSite[]): Promise<{ streak: number; sites: VoterStatus[] }> {
  const [settings, last] = await Promise.all([
    prisma.siteMemberSettings.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { voteStreak: true, lastVoteDayKey: true } }),
    prisma.siteVote.groupBy({ by: ['voteSiteId'], where: { guildId, userId, voteSiteId: { in: sites.map((s) => s.id) } }, _max: { createdAt: true } }),
  ]);
  const lastBy = new Map(last.map((l) => [l.voteSiteId, l._max.createdAt]));
  const today = siteDayKey();
  const streakAlive = settings?.lastVoteDayKey === today || settings?.lastVoteDayKey === previousSiteDayKey(today);
  return {
    streak: streakAlive ? settings?.voteStreak ?? 0 : 0,
    sites: sites.map((site) => {
      const lastAt = lastBy.get(site.id) ?? null;
      const next = lastAt ? new Date(lastAt.getTime() + site.cooldownHours * 3_600_000) : null;
      return { voteSiteId: site.id, lastVoteAt: lastAt?.toISOString() ?? null, nextAt: next && next.getTime() > Date.now() ? next.toISOString() : null };
    }),
  };
}

/** Meilleurs votants depuis le début du mois (heure de Paris). */
export async function topVoters(guildId: string, limit: number): Promise<Array<{ userId: string; votes: number }>> {
  const [y, mo] = siteDayKey().split('-').map(Number);
  const since = new Date(Date.UTC(y, mo - 1, 1) - 2 * 3_600_000);
  const rows = await prisma.siteVote.groupBy({
    by: ['userId'],
    where: { guildId, createdAt: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { userId: 'desc' } },
    take: limit,
  });
  return rows.map((row) => ({ userId: row.userId, votes: row._count._all }));
}

// ─── Rappels ────────────────────────────────────────────────────────────────

/**
 * Rappel en MP aux membres qui l'ont demandé, quand un site où ils ont voté
 * dans les 30 derniers jours accepte de nouveau leur vote. Un rappel par
 * ouverture de vote.
 */
export async function sendVoteReminders(client: Client): Promise<number> {
  const members = await prisma.siteMemberSettings.findMany({
    where: { notifications: { path: ['voteReminder'], equals: true } },
    select: { id: true, guildId: true, userId: true, lastVoteReminderAt: true },
    take: 5_000,
  });
  const since = new Date(Date.now() - 30 * 86_400_000);
  let sent = 0;
  for (const member of members) {
    const votes = await prisma.siteVote.groupBy({
      by: ['voteSiteId'],
      where: { guildId: member.guildId, userId: member.userId, createdAt: { gte: since } },
      _max: { createdAt: true },
    });
    if (votes.length === 0) continue;
    const sites = await prisma.siteVoteSite.findMany({ where: { id: { in: votes.map((v) => v.voteSiteId) }, enabled: true }, select: { id: true, label: true, cooldownHours: true } });
    const now = Date.now();
    const open = sites
      .map((site) => {
        const last = votes.find((v) => v.voteSiteId === site.id)?._max.createdAt;
        return last ? { site, openAt: last.getTime() + site.cooldownHours * 3_600_000 } : null;
      })
      .filter((x): x is { site: (typeof sites)[number]; openAt: number } => Boolean(x) && x!.openAt <= now)
      .filter((x) => !member.lastVoteReminderAt || member.lastVoteReminderAt.getTime() < x.openAt);
    if (open.length === 0) continue;

    await prisma.siteMemberSettings.update({ where: { id: member.id }, data: { lastVoteReminderAt: new Date() } });
    const guild = client.guilds.cache.get(member.guildId);
    const locale = (await resolveGuildLocale(member.guildId, guild?.preferredLocale)) === 'en' ? 'en' : 'fr';
    const delivered = await notifySiteMember(client, member.guildId, member.userId, 'voteReminder', {
      title: m.site_notify_vote_title({}, { locale }),
      body: m.site_notify_vote_body({ sites: open.map((o) => o.site.label).join(', ') }, { locale }),
      path: '/votes',
    }).catch((err: unknown) => {
      logger.warn('SiteVote', `Rappel de vote non envoyé (${member.guildId}/${member.userId}) :`, err);
      return false;
    });
    if (delivered) sent += 1;
  }
  return sent;
}
