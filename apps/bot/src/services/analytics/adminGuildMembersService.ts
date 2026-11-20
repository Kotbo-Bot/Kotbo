/**
 * Fiche serveur de la console admin, volet membres : cohortes et rétention,
 * profil des membres, membres et staff les plus actifs, membres à risque,
 * sources d'arrivée et recoupement nominatif avec les autres serveurs Kotbo
 * (réservé à l'équipe Kotbo, jamais exposé au dashboard d'un serveur).
 */

import type { Client } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { guildIconUrl } from '../core/serverTagService.js';
import { ACCOUNT_AGE_BUCKETS, accountAgeBucket, getMemberOverview } from './memberOverviewService.js';
import { parseRange } from './contentAnalyticsService.js';

const DAY_MS = 86_400_000;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

type CohortRow = {
  month: string;
  joined: number;
  e1: number; s1: number;
  e7: number; s7: number;
  e30: number; s30: number;
  here: number;
};

type PersonRow = { userId: string; name: string; avatarUrl: string | null };

async function people(guildId: string, userIds: string[]): Promise<Map<string, PersonRow>> {
  if (userIds.length === 0) return new Map();
  const rows = await prisma.memberProfile.findMany({
    where: { guildId, userId: { in: userIds } },
    select: { userId: true, displayName: true, globalName: true, username: true, avatarUrl: true },
  });
  return new Map(rows.map((r) => [r.userId, { userId: r.userId, name: r.displayName ?? r.globalName ?? r.username ?? r.userId, avatarUrl: r.avatarUrl }]));
}

export async function getGuildMembersSheet(client: Client, guildId: string, days: number) {
  const guild = client.guilds.cache.get(guildId) ?? null;
  const since = new Date(Date.now() - days * DAY_MS);
  const sinceKey = since.toISOString().slice(0, 10);
  const since90 = new Date(Date.now() - 90 * DAY_MS);
  const sixMonths = new Date(Date.now() - 183 * DAY_MS);

  const [cohorts, present, bots, locales, tags, roleRows, top, moderators, declared, riskSanctions, riskToxic, overlap, overview] = await Promise.all([
    prisma.$queryRaw<CohortRow[]>`
      SELECT to_char(date_trunc('month', "guildJoinedAt"), 'YYYY-MM') AS month,
             COUNT(*)::int AS joined,
             COUNT(*) FILTER (WHERE now() - "guildJoinedAt" >= interval '1 day')::int AS e1,
             COUNT(*) FILTER (WHERE now() - "guildJoinedAt" >= interval '1 day' AND ("guildLeftAt" IS NULL OR "guildLeftAt" - "guildJoinedAt" >= interval '1 day'))::int AS s1,
             COUNT(*) FILTER (WHERE now() - "guildJoinedAt" >= interval '7 days')::int AS e7,
             COUNT(*) FILTER (WHERE now() - "guildJoinedAt" >= interval '7 days' AND ("guildLeftAt" IS NULL OR "guildLeftAt" - "guildJoinedAt" >= interval '7 days'))::int AS s7,
             COUNT(*) FILTER (WHERE now() - "guildJoinedAt" >= interval '30 days')::int AS e30,
             COUNT(*) FILTER (WHERE now() - "guildJoinedAt" >= interval '30 days' AND ("guildLeftAt" IS NULL OR "guildLeftAt" - "guildJoinedAt" >= interval '30 days'))::int AS s30,
             COUNT(*) FILTER (WHERE "guildLeftAt" IS NULL)::int AS here
        FROM "member_profiles"
       WHERE "guildId" = ${guildId} AND "isBot" = false AND "guildJoinedAt" >= ${sixMonths}
       GROUP BY 1 ORDER BY 1`,
    prisma.memberProfile.findMany({
      where: { guildId, guildLeftAt: null, isBot: false },
      select: { accountCreatedAt: true },
      take: 100_000,
    }),
    prisma.memberProfile.count({ where: { guildId, guildLeftAt: null, isBot: true } }),
    prisma.memberProfile.groupBy({
      by: ['locale'],
      where: { guildId, guildLeftAt: null, isBot: false, locale: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { locale: 'desc' } },
      take: 8,
    }),
    prisma.memberProfile.groupBy({
      by: ['primaryGuildId'],
      where: { guildId, guildLeftAt: null, isBot: false, primaryGuildId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { primaryGuildId: 'desc' } },
      take: 10,
    }),
    prisma.$queryRaw<Array<{ roleId: string; n: number }>>`
      SELECT r AS "roleId", COUNT(*)::int AS n
        FROM "member_profiles", unnest("rolesSnapshot") AS r
       WHERE "guildId" = ${guildId} AND "guildLeftAt" IS NULL AND "isBot" = false
       GROUP BY r ORDER BY n DESC LIMIT 12`.catch(() => []),
    prisma.memberDailyStat.groupBy({
      by: ['userId'],
      where: { guildId, dateKey: { gte: sinceKey } },
      _sum: { messagesCount: true, voiceMinutes: true },
      orderBy: { _sum: { messagesCount: 'desc' } },
      take: 10,
    }),
    prisma.sanction.groupBy({
      by: ['moderatorUserId'],
      where: { guildId, createdAt: { gte: since90 } },
      _count: { _all: true },
      orderBy: { _count: { moderatorUserId: 'desc' } },
      take: 25,
    }),
    prisma.staffMember.findMany({ where: { guildId }, select: { userId: true } }).catch(() => []),
    prisma.sanction.groupBy({
      by: ['targetUserId'],
      where: { guildId, createdAt: { gte: since90 } },
      _count: { _all: true },
      orderBy: { _count: { targetUserId: 'desc' } },
      take: 10,
    }),
    prisma.aegisMemberDailyStat.groupBy({
      by: ['userId'],
      where: { guildId, dateKey: { gte: sinceKey }, toxic: { gt: 0 } },
      _sum: { toxic: true, analyzed: true },
      orderBy: { _sum: { toxic: 'desc' } },
      take: 10,
    }).catch(() => []),
    prisma.$queryRaw<Array<{ guildId: string; n: number }>>`
      SELECT b."guildId", COUNT(*)::int AS n
        FROM "member_profiles" a
        JOIN "member_profiles" b ON b."userId" = a."userId" AND b."guildId" <> a."guildId" AND b."guildLeftAt" IS NULL
       WHERE a."guildId" = ${guildId} AND a."guildLeftAt" IS NULL AND a."isBot" = false
       GROUP BY b."guildId" ORDER BY n DESC LIMIT 10`.catch(() => []),
    getMemberOverview(client, guildId, parseRange(new URLSearchParams({ period: String(days) }))).catch(() => null),
  ]);

  // Âge des comptes présents.
  const ages = Object.fromEntries(ACCOUNT_AGE_BUCKETS.map((b) => [b.key, 0])) as Record<string, number>;
  let agesKnown = 0;
  for (const p of present) {
    if (!p.accountCreatedAt) continue;
    ages[accountAgeBucket((Date.now() - p.accountCreatedAt.getTime()) / DAY_MS)] += 1;
    agesKnown += 1;
  }

  // Noms des serveurs des tags et du recoupement.
  const otherIds = [...new Set([...tags.map((t) => t.primaryGuildId!), ...overlap.map((o) => o.guildId)])];
  const external = otherIds.length
    ? await prisma.discordExternalGuild.findMany({ where: { guildId: { in: otherIds } }, select: { guildId: true, name: true, icon: true, tag: true } })
    : [];
  const ext = new Map(external.map((e) => [e.guildId, e]));
  const serverLabel = (id: string) => {
    const live = client.guilds.cache.get(id);
    const e = ext.get(id);
    return { guildId: id, name: live?.name ?? e?.name ?? null, iconUrl: live?.iconURL({ size: 64 }) ?? guildIconUrl(id, e?.icon), tag: e?.tag ?? null };
  };

  const declaredIds = new Set(declared.map((d) => d.userId));
  const moderatorIds = moderators.map((m) => m.moderatorUserId).filter((id) => id !== client.user?.id);
  const names = await people(guildId, [
    ...top.map((t) => t.userId),
    ...moderatorIds,
    ...riskSanctions.map((r) => r.targetUserId),
    ...riskToxic.map((r) => r.userId),
  ]);
  const person = (userId: string) => names.get(userId) ?? { userId, name: userId, avatarUrl: null };

  return {
    cohorts: cohorts.map((c) => ({
      month: c.month,
      joined: c.joined,
      stillHere: pct(c.here, c.joined),
      d1: pct(c.s1, c.e1),
      d7: pct(c.s7, c.e7),
      d30: pct(c.s30, c.e30),
    })),
    profile: {
      humans: present.length,
      bots,
      accountAge: { known: agesKnown, buckets: ACCOUNT_AGE_BUCKETS.map((b) => ({ key: b.key, count: ages[b.key] })) },
      locales: locales.map((l) => ({ locale: l.locale!, count: l._count._all })),
      tags: tags.map((t) => ({ ...serverLabel(t.primaryGuildId!), count: t._count._all })),
      roles: roleRows
        .filter((r) => r.roleId !== guildId)
        .map((r) => {
          const role = guild?.roles.cache.get(r.roleId);
          return { roleId: r.roleId, name: role?.name ?? r.roleId, color: role?.hexColor ?? null, count: r.n };
        })
        .slice(0, 10),
    },
    topMembers: top.map((t) => ({ ...person(t.userId), messages: t._sum.messagesCount ?? 0, voiceMinutes: t._sum.voiceMinutes ?? 0, staff: declaredIds.has(t.userId) })),
    staff: {
      declared: declaredIds.size,
      acting: moderatorIds.length,
      moderators: moderators
        .filter((m) => m.moderatorUserId !== client.user?.id)
        .map((m) => ({ ...person(m.moderatorUserId), sanctions: m._count._all, declared: declaredIds.has(m.moderatorUserId) })),
      // Déclarés au staff sans aucune sanction sur 90 jours.
      idleDeclared: [...declaredIds].filter((id) => !moderatorIds.includes(id)).length,
    },
    atRisk: {
      sanctions: riskSanctions.map((r) => ({ ...person(r.targetUserId), count: r._count._all })),
      toxic: riskToxic.map((r) => ({ ...person(r.userId), toxic: r._sum.toxic ?? 0, analyzed: r._sum.analyzed ?? 0 })),
    },
    sources: overview?.sources ?? null,
    newcomers: overview?.newcomers ?? null,
    overlap: overlap.map((o) => ({ ...serverLabel(o.guildId), shared: o.n })),
  };
}

/** Membres communs à deux serveurs, nommément. Console admin uniquement. */
export async function getSharedMembers(guildId: string, otherGuildId: string, limit = 200) {
  const rows = await prisma.$queryRaw<Array<{ userId: string; displayName: string | null; globalName: string | null; username: string | null; avatarUrl: string | null }>>(Prisma.sql`
    SELECT a."userId", a."displayName", a."globalName", a."username", a."avatarUrl"
      FROM "member_profiles" a
      JOIN "member_profiles" b ON b."userId" = a."userId" AND b."guildId" = ${otherGuildId} AND b."guildLeftAt" IS NULL
     WHERE a."guildId" = ${guildId} AND a."guildLeftAt" IS NULL AND a."isBot" = false
     ORDER BY a."messageCount" DESC
     LIMIT ${limit}`);
  return rows.map((r) => ({ userId: r.userId, name: r.displayName ?? r.globalName ?? r.username ?? r.userId, username: r.username, avatarUrl: r.avatarUrl }));
}
