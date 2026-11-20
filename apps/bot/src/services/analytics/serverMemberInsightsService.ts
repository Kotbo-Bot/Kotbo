/**
 * Fiche d'un serveur externe, côté membres et modération : ce que font chez
 * nous les membres qui portent son tag, comparé au reste du serveur, combien
 * de nos membres y sont aussi (en chiffres seulement), et tout ce que la
 * modération sait de lui (sanctions de ses porteurs, signaux de la flotte,
 * règle de l'automod des tags, journal et vagues).
 */

import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { getFleetTagCounts } from '../moderation/tagAutomod/tagAutomodService.js';

const DAY_MS = 86_400_000;
const MAX_HOLDERS = 5000;

export type GroupStats = {
  members: number;
  /** Membres ayant écrit au moins un message sur 30 jours. */
  active: number;
  messages: number;
  voiceMinutes: number;
  analyzed: number;
  toxic: number;
  sanctions: number;
};

export type ServerMemberInsights = {
  holders: GroupStats;
  others: GroupStats;
  /** Messages des porteurs par jour, 30 jours. */
  activityByDay: Array<{ date: string; holders: number; others: number }>;
  topHolders: Array<{ userId: string; messages: number; voiceMinutes: number }>;
  movement: { joined30d: number; left30d: number; leftTotal: number };
  overlap: { botPresent: boolean; shared: number | null; share: number | null };
  moderation: {
    sanctionsByType: Array<{ type: string; count: number }>;
    recentSanctions: Array<{ id: string; type: string; targetUserId: string; targetTag: string | null; reason: string; createdAt: string }>;
    fleet: { blocks: number; waveReports: number };
    rule: { id: string; name: string; effect: string; action: string; enabled: boolean; expiresAt: string | null } | null;
    events: Array<{ id: string; userId: string; userTag: string | null; trigger: string; action: string; status: string; createdAt: string }>;
    waves: number;
  };
};

function dateKey(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function emptyGroup(): GroupStats {
  return { members: 0, active: 0, messages: 0, voiceMinutes: 0, analyzed: 0, toxic: 0, sanctions: 0 };
}

export async function getServerMemberInsights(client: Client, guildId: string, targetGuildId: string): Promise<ServerMemberInsights> {
  const since30 = dateKey(30);
  const since90 = new Date(Date.now() - 90 * DAY_MS);
  const join30 = new Date(Date.now() - 30 * DAY_MS);

  const [present, left, totalMembers] = await Promise.all([
    prisma.memberProfile.findMany({
      where: { guildId, primaryGuildId: targetGuildId, guildLeftAt: null, isBot: false },
      select: { userId: true, guildJoinedAt: true },
      take: MAX_HOLDERS,
    }),
    prisma.memberProfile.findMany({
      where: { guildId, primaryGuildId: targetGuildId, guildLeftAt: { not: null }, isBot: false },
      select: { userId: true, guildLeftAt: true },
      take: MAX_HOLDERS,
    }),
    prisma.memberProfile.count({ where: { guildId, guildLeftAt: null, isBot: false } }),
  ]);
  const holderIds = present.map((p) => p.userId);
  const everIds = [...holderIds, ...left.map((l) => l.userId)];

  const inHolders = { in: holderIds };
  const [allDaily, holderDaily, allActive, holderActive, allAegis, holderAegis, allSanctions, holderSanctions, byDayAll, byDayHolders, top] = await Promise.all([
    prisma.memberDailyStat.aggregate({ where: { guildId, dateKey: { gte: since30 } }, _sum: { messagesCount: true, voiceMinutes: true } }),
    prisma.memberDailyStat.aggregate({ where: { guildId, dateKey: { gte: since30 }, userId: inHolders }, _sum: { messagesCount: true, voiceMinutes: true } }),
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(DISTINCT "userId")::int AS n FROM "member_daily_stats"
       WHERE "guildId" = ${guildId} AND "dateKey" >= ${since30} AND "messagesCount" > 0`,
    holderIds.length
      ? prisma.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(DISTINCT "userId")::int AS n FROM "member_daily_stats"
         WHERE "guildId" = ${guildId} AND "dateKey" >= ${since30} AND "messagesCount" > 0 AND "userId" = ANY(${holderIds})`
      : Promise.resolve([{ n: 0 }]),
    prisma.aegisMemberDailyStat.aggregate({ where: { guildId, dateKey: { gte: since30 } }, _sum: { analyzed: true, toxic: true } }).catch(() => null),
    prisma.aegisMemberDailyStat.aggregate({ where: { guildId, dateKey: { gte: since30 }, userId: inHolders }, _sum: { analyzed: true, toxic: true } }).catch(() => null),
    prisma.sanction.count({ where: { guildId, createdAt: { gte: since90 } } }),
    prisma.sanction.count({ where: { guildId, createdAt: { gte: since90 }, targetUserId: inHolders } }),
    prisma.memberDailyStat.groupBy({ by: ['dateKey'], where: { guildId, dateKey: { gte: since30 } }, _sum: { messagesCount: true } }),
    prisma.memberDailyStat.groupBy({ by: ['dateKey'], where: { guildId, dateKey: { gte: since30 }, userId: inHolders }, _sum: { messagesCount: true } }),
    prisma.memberDailyStat.groupBy({
      by: ['userId'],
      where: { guildId, dateKey: { gte: since30 }, userId: inHolders },
      _sum: { messagesCount: true, voiceMinutes: true },
      orderBy: { _sum: { messagesCount: 'desc' } },
      take: 10,
    }),
  ]);

  const holders: GroupStats = {
    members: holderIds.length,
    active: holderActive[0]?.n ?? 0,
    messages: holderDaily._sum.messagesCount ?? 0,
    voiceMinutes: holderDaily._sum.voiceMinutes ?? 0,
    analyzed: holderAegis?._sum.analyzed ?? 0,
    toxic: holderAegis?._sum.toxic ?? 0,
    sanctions: holderSanctions,
  };
  const others: GroupStats = holderIds.length || totalMembers ? {
    members: Math.max(0, totalMembers - holders.members),
    active: Math.max(0, (allActive[0]?.n ?? 0) - holders.active),
    messages: Math.max(0, (allDaily._sum.messagesCount ?? 0) - holders.messages),
    voiceMinutes: Math.max(0, (allDaily._sum.voiceMinutes ?? 0) - holders.voiceMinutes),
    analyzed: Math.max(0, (allAegis?._sum.analyzed ?? 0) - holders.analyzed),
    toxic: Math.max(0, (allAegis?._sum.toxic ?? 0) - holders.toxic),
    sanctions: Math.max(0, allSanctions - holders.sanctions),
  } : emptyGroup();

  const allByDay = new Map(byDayAll.map((r) => [r.dateKey, r._sum.messagesCount ?? 0]));
  const holdersByDay = new Map(byDayHolders.map((r) => [r.dateKey, r._sum.messagesCount ?? 0]));
  const activityByDay: ServerMemberInsights['activityByDay'] = [];
  for (let i = 29; i >= 0; i--) {
    const date = dateKey(i);
    const h = holdersByDay.get(date) ?? 0;
    activityByDay.push({ date, holders: h, others: Math.max(0, (allByDay.get(date) ?? 0) - h) });
  }

  // Recoupement : seulement quand Kotbo voit aussi l'autre serveur, et en nombre.
  const botPresent = client.guilds.cache.has(targetGuildId);
  let shared: number | null = null;
  if (botPresent) {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM "member_profiles" a
        JOIN "member_profiles" b ON b."userId" = a."userId" AND b."guildId" = ${targetGuildId} AND b."guildLeftAt" IS NULL
       WHERE a."guildId" = ${guildId} AND a."guildLeftAt" IS NULL AND a."isBot" = false`.catch(() => [{ n: 0 }]);
    shared = rows[0]?.n ?? 0;
  }

  const [sanctionsByType, recentSanctions, waveReports, rule, events, waves, fleet] = await Promise.all([
    everIds.length
      ? prisma.sanction.groupBy({ by: ['type'], where: { guildId, createdAt: { gte: since90 }, targetUserId: { in: everIds } }, _count: { _all: true } })
      : Promise.resolve([]),
    everIds.length
      ? prisma.sanction.findMany({
        where: { guildId, targetUserId: { in: everIds } },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, type: true, targetUserId: true, targetTag: true, reason: true, createdAt: true },
      })
      : Promise.resolve([]),
    prisma.tagRiskReport.count({ where: { tagGuildId: targetGuildId } }).catch(() => 0),
    prisma.tagAutomodRule.findFirst({
      where: { guildId, targetType: 'SERVER', targetGuildId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, effect: true, action: true, enabled: true, expiresAt: true },
    }).catch(() => null),
    prisma.tagAutomodEvent.findMany({
      where: { guildId, tagGuildId: targetGuildId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, userId: true, userTag: true, trigger: true, action: true, status: true, createdAt: true },
    }).catch(() => []),
    prisma.tagWave.count({ where: { guildId, tagGuildId: targetGuildId } }).catch(() => 0),
    getFleetTagCounts(),
  ]);

  return {
    holders,
    others,
    activityByDay,
    topHolders: top.map((t) => ({ userId: t.userId, messages: t._sum.messagesCount ?? 0, voiceMinutes: t._sum.voiceMinutes ?? 0 })),
    movement: {
      joined30d: present.filter((p) => p.guildJoinedAt && p.guildJoinedAt >= join30).length,
      left30d: left.filter((l) => l.guildLeftAt && l.guildLeftAt >= join30).length,
      leftTotal: left.length,
    },
    overlap: { botPresent, shared, share: shared !== null && totalMembers > 0 ? shared / totalMembers : null },
    moderation: {
      sanctionsByType: sanctionsByType.map((s) => ({ type: s.type, count: s._count._all })).sort((a, b) => b.count - a.count),
      recentSanctions: recentSanctions.map((s) => ({ ...s, type: String(s.type), createdAt: s.createdAt.toISOString() })),
      fleet: { blocks: fleet.get(targetGuildId) ?? 0, waveReports },
      rule: rule ? { ...rule, expiresAt: rule.expiresAt?.toISOString() ?? null } : null,
      events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      waves,
    },
  };
}
