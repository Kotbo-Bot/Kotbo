/**
 * memberOverviewService.ts
 *
 * Vue Membres d'Analytics :
 *   - séries par jour : effectif, arrivées, départs, pic et moyenne en ligne ;
 *   - d'où viennent les arrivées : type de source (lien d'invitation, lien
 *     personnalisé, libellé posé sur un lien, inconnue), liens les plus
 *     utilisés et meilleurs inviteurs, avec la part encore présente ;
 *   - qualité des nouveaux : âge des comptes, onboarding Discord terminé,
 *     départs en moins de 24 heures.
 * Période seule : les arrivées et départs ne se filtrent ni par salon ni par
 * rôle (un membre parti n'a plus de rôle).
 */

import type { Client } from 'discord.js';
import { prismaRead } from '../../utils/db.js';
import { dayKeys, type DateRange } from './contentAnalyticsService.js';

const DAY_MS = 24 * 3600 * 1000;
const at = (key: string, end = false) => new Date(`${key}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export const ACCOUNT_AGE_BUCKETS = [
  { key: 'under1d', maxDays: 1 },
  { key: 'under7d', maxDays: 7 },
  { key: 'under30d', maxDays: 30 },
  { key: 'under365d', maxDays: 365 },
  { key: 'over365d', maxDays: Number.POSITIVE_INFINITY },
] as const;

export function accountAgeBucket(days: number): (typeof ACCOUNT_AGE_BUCKETS)[number]['key'] {
  return ACCOUNT_AGE_BUCKETS.find((b) => days < b.maxDays)?.key ?? 'over365d';
}

export type SourceKind = 'invite' | 'vanity' | 'label' | 'unknown';

export function sourceKindOf(code: string | null, vanity: string | null, labelled: boolean): SourceKind {
  if (!code) return 'unknown';
  if (vanity && code === vanity) return 'vanity';
  return labelled ? 'label' : 'invite';
}

export async function getMemberOverview(client: Client, guildId: string, range: DateRange, includeBots = false) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const [daily, prevDaily, invites, prevInvites, guildInvites, joiners] = await Promise.all([
    prismaRead.guildDailyStat.findMany({
      where: { guildId, dateKey: { gte: range.start, lte: range.end } },
      select: { dateKey: true, totalMembers: true, totalHumans: true, membersJoined: true, membersLeft: true, peakOnline: true, onlineMembers: true, tagHolders: true },
    }),
    prismaRead.guildDailyStat.findMany({
      where: { guildId, dateKey: { gte: range.prevStart, lte: range.prevEnd } },
      select: { dateKey: true, totalMembers: true, totalHumans: true, membersJoined: true, membersLeft: true, peakOnline: true, onlineMembers: true },
    }),
    prismaRead.memberInvite.findMany({
      where: { guildId, joinedAt: { gte: at(range.start), lte: at(range.end, true) } },
      select: { userId: true, inviteCode: true, inviterId: true, inviterTag: true, joinedAt: true, leftAt: true },
      take: 50_000,
    }),
    prismaRead.memberInvite.groupBy({
      by: ['inviterId'],
      where: { guildId, joinedAt: { gte: at(range.prevStart), lte: at(range.prevEnd, true) }, inviterId: { not: null } },
      _count: { _all: true },
    }),
    prismaRead.guildInvite.findMany({ where: { guildId }, select: { code: true, sourceLabel: true } }),
    prismaRead.memberProfile.findMany({
      where: { guildId, isBot: false, guildJoinedAt: { gte: at(range.start), lte: at(range.end, true) } },
      select: { userId: true, accountCreatedAt: true, guildJoinedAt: true, guildLeftAt: true, onboardingCompletedAt: true },
      take: 50_000,
    }),
  ]);

  // ── Séries ────────────────────────────────────────────────────────────────
  const total = (r: { totalMembers: number; totalHumans: number }) => (includeBots || r.totalHumans === 0 ? r.totalMembers : r.totalHumans);
  const curMap = new Map(daily.map((r) => [r.dateKey, r]));
  const prevMap = new Map(prevDaily.map((r) => [r.dateKey, r]));
  const prevKeys = dayKeys(range.prevStart, range.prevEnd);
  // Un jour sans ligne garde l'effectif connu la veille plutôt que de tomber à zéro.
  let lastTotal = 0;
  let lastPrevTotal = 0;
  let lastTagHolders: number | null = null;
  const series = dayKeys(range.start, range.end).map((dateKey, i) => {
    const c = curMap.get(dateKey);
    const p = prevMap.get(prevKeys[i]!);
    if (c && total(c) > 0) lastTotal = total(c);
    if (p && total(p) > 0) lastPrevTotal = total(p);
    // Relevé du soir reporté d'un jour sur l'autre ; null tant qu'aucun n'a été fait.
    if (c?.tagHolders != null) lastTagHolders = c.tagHolders;
    return {
      dateKey,
      members: lastTotal,
      joined: c?.membersJoined ?? 0,
      left: c?.membersLeft ?? 0,
      peakOnline: c?.peakOnline ?? 0,
      onlineMembers: c?.onlineMembers ?? 0,
      tagHolders: lastTagHolders,
      prevMembers: lastPrevTotal,
      prevJoined: p?.membersJoined ?? 0,
      prevLeft: p?.membersLeft ?? 0,
      prevPeakOnline: p?.peakOnline ?? 0,
      prevOnlineMembers: p?.onlineMembers ?? 0,
    };
  });

  // ── Sources ───────────────────────────────────────────────────────────────
  const labelOf = new Map(guildInvites.map((g) => [g.code, g.sourceLabel]));
  const vanity = guild?.vanityURLCode ?? null;
  const kinds: Record<SourceKind, { joined: number; stayed: number }> = {
    invite: { joined: 0, stayed: 0 }, vanity: { joined: 0, stayed: 0 }, label: { joined: 0, stayed: 0 }, unknown: { joined: 0, stayed: 0 },
  };
  const links = new Map<string, { code: string; label: string | null; inviterId: string | null; inviterTag: string | null; joined: number; stayed: number }>();
  const inviters = new Map<string, { tag: string | null; joined: number; stayed: number; left24h: number }>();
  for (const inv of invites) {
    const kind = sourceKindOf(inv.inviteCode, vanity, Boolean(inv.inviteCode && labelOf.get(inv.inviteCode)));
    const stayed = !inv.leftAt;
    kinds[kind].joined += 1;
    if (stayed) kinds[kind].stayed += 1;
    if (inv.inviteCode) {
      const link = links.get(inv.inviteCode) ?? { code: inv.inviteCode, label: labelOf.get(inv.inviteCode) ?? null, inviterId: inv.inviterId, inviterTag: inv.inviterTag, joined: 0, stayed: 0 };
      link.joined += 1;
      if (stayed) link.stayed += 1;
      links.set(inv.inviteCode, link);
    }
    if (inv.inviterId) {
      const e = inviters.get(inv.inviterId) ?? { tag: inv.inviterTag, joined: 0, stayed: 0, left24h: 0 };
      e.joined += 1;
      if (stayed) e.stayed += 1;
      if (inv.leftAt && inv.leftAt.getTime() - inv.joinedAt.getTime() < DAY_MS) e.left24h += 1;
      inviters.set(inv.inviterId, e);
    }
  }
  const prevInviter = new Map(prevInvites.map((r) => [r.inviterId!, r._count._all]));
  const missing = [...inviters.keys()].filter((id) => !guild?.members.cache.has(id));
  const profiles = missing.length > 0
    ? await prismaRead.memberProfile.findMany({
        where: { guildId, userId: { in: missing.slice(0, 2000) } },
        select: { userId: true, displayName: true, globalName: true, username: true, avatarUrl: true },
      })
    : [];
  const profileOf = new Map(profiles.map((p) => [p.userId, p]));

  // ── Qualité des nouveaux ──────────────────────────────────────────────────
  const age = Object.fromEntries(ACCOUNT_AGE_BUCKETS.map((b) => [b.key, 0])) as Record<(typeof ACCOUNT_AGE_BUCKETS)[number]['key'], number>;
  let ageKnown = 0;
  let onboarded = 0;
  let left24h = 0;
  for (const p of joiners) {
    if (p.accountCreatedAt && p.guildJoinedAt) {
      age[accountAgeBucket((p.guildJoinedAt.getTime() - p.accountCreatedAt.getTime()) / DAY_MS)] += 1;
      ageKnown += 1;
    }
    if (p.onboardingCompletedAt) onboarded += 1;
    if (p.guildJoinedAt && p.guildLeftAt && p.guildLeftAt.getTime() - p.guildJoinedAt.getTime() < DAY_MS) left24h += 1;
  }
  // Sans écran d'accueil Discord, personne n'a de date d'onboarding : on ne
  // présente pas un « 0 % » qui laisserait croire à un problème.
  const screening = Boolean(guild?.features.includes('MEMBER_VERIFICATION_GATE_ENABLED')) || onboarded > 0;

  return {
    range,
    memberCount: guild ? (includeBots ? guild.memberCount : Math.max(0, guild.memberCount - guild.members.cache.filter((m) => m.user.bot).size)) : null,
    series,
    // Estimation : Discord ne relie pas une arrivée à un tag. On donne les arrivées
    // sans source et l'évolution des porteurs, à rapprocher soi-même.
    tag: (() => {
      const known = series.filter((d) => d.tagHolders !== null);
      if (known.length === 0) return null;
      return {
        holders: known[known.length - 1]!.tagHolders as number,
        gained: (known[known.length - 1]!.tagHolders as number) - (known[0]!.tagHolders as number),
        unknownJoins: kinds.unknown.joined,
        unknownShare: pct(kinds.unknown.joined, invites.length),
        daysMeasured: known.length,
      };
    })(),
    sources: {
      tracked: invites.length,
      kinds: (Object.keys(kinds) as SourceKind[]).map((kind) => ({ kind, joined: kinds[kind].joined, retention: pct(kinds[kind].stayed, kinds[kind].joined) })),
      links: [...links.values()]
        .sort((a, b) => b.joined - a.joined)
        .slice(0, 15)
        .map((l) => ({ ...l, retention: pct(l.stayed, l.joined), isVanity: Boolean(vanity && l.code === vanity) })),
    },
    inviters: [...inviters.entries()]
      .map(([userId, e]) => {
        const member = guild?.members.cache.get(userId);
        const profile = profileOf.get(userId);
        return {
          userId,
          name: member?.displayName ?? profile?.displayName ?? profile?.globalName ?? profile?.username ?? e.tag,
          avatarUrl: member?.displayAvatarURL({ size: 64 }) ?? profile?.avatarUrl ?? null,
          joined: e.joined,
          previous: prevInviter.get(userId) ?? 0,
          stayed: e.stayed,
          retention: pct(e.stayed, e.joined),
          left24h: e.left24h,
        };
      })
      .sort((a, b) => b.joined - a.joined)
      .slice(0, 25),
    newcomers: {
      joined: joiners.length,
      accountAge: { known: ageKnown, buckets: ACCOUNT_AGE_BUCKETS.map((b) => ({ key: b.key, count: age[b.key] })) },
      onboarding: screening ? { completed: onboarded, rate: pct(onboarded, joiners.length) } : null,
      left24h: { count: left24h, rate: pct(left24h, joiners.length) },
    },
  };
}
