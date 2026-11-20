import { DEFAULT_TIMEZONE, toWallClockUtcMs, zonedTimeToInstant } from '@kotbo/contracts';
import { prismaRead as prisma } from '../../utils/db.js';
import { findPresenceOptOuts } from '../core/presencePrivacyService.js';
import { BucketZoner, ZONE_MARGIN_DAYS, shiftKey } from './zonedBuckets.js';

/** Instant reel auquel commence le jour `dateKey` dans un fuseau donne. */
function zonedDayStart(dateKey: string, timezone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const wallClock = toWallClockUtcMs(year, (month ?? 1) - 1, day ?? 1);
  if (wallClock === null) return new Date(`${dateKey}T00:00:00.000Z`);
  return zonedTimeToInstant(wallClock, timezone);
}

/**
 * Get command usage analytics
 */
export const getCommandUsageAnalytics = async (guildId: string, options: { startDate?: string, endDate?: string } = {}) => {
  const gte = options.startDate ? new Date(options.startDate) : undefined;
  const lte = options.endDate ? new Date(options.endDate) : undefined;
  const usages = await prisma.dashboardCommandUsage.findMany({
    where: {
      guildId,
      lastUsedAt: {
        gte,
        lte
      }
    },
    orderBy: { count: 'desc' }
  });

  // Aggregate by command name
  const totals: Record<string, number> = {};
  usages.forEach(u => {
    totals[u.commandName] = (totals[u.commandName] || 0) + u.count;
  });

  return Object.entries(totals)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};

/**
 * Get detailed staff performance metrics
 */
export const getStaffPerformanceAnalytics = async (guildId: string, options: { startDate?: string, endDate?: string } = {}) => {
  const staffMembers = await prisma.staffMember.findMany({
    where: { guildId }
  });

  const gte = options.startDate ? new Date(options.startDate) : undefined;
  const lte = options.endDate ? new Date(options.endDate) : undefined;
  const sanctions = await prisma.sanction.findMany({
    where: {
      guildId,
      createdAt: {
        gte,
        lte
      }
    }
  });

  const reports = await prisma.sanctionReport.findMany({
    where: {
      guildId,
      createdAt: {
        gte,
        lte
      }
    }
  });

  const performance = staffMembers.map(staff => {
    const staffSanctions = sanctions.filter(s => s.moderatorUserId === staff.userId);
    const staffReports = reports.filter(r => r.createdByUserId === staff.userId);
    
    return {
      userId: staff.userId,
      username: staff.username,
      displayName: staff.displayName,
      avatarUrl: staff.avatarUrl,
      sanctionsCount: staffSanctions.length,
      reportsCount: staffReports.length,
      reportRate: staffSanctions.length > 0 ? Math.round((staffReports.length / staffSanctions.length) * 100) : 0,
      warns: staffSanctions.filter(s => s.type === 'WARN').length,
      bans: staffSanctions.filter(s => s.type === 'BAN' || s.type === 'TEMP_BAN').length
    };
  }).sort((a, b) => (b.sanctionsCount + b.reportsCount) - (a.sanctionsCount + a.reportsCount));

  return performance;
};

/**
 * Get activity grouped by channel categories
 */
export const getChannelCategoryActivity = async (guildId: string, options: { startDate?: string, endDate?: string } = {}) => {
  const channelStats = await prisma.channelDailyStat.findMany({
    where: {
      guildId,
      dateKey: {
        gte: options.startDate,
        lte: options.endDate
      }
    }
  });

  // This would ideally require category information from Discord or a mapping
  // For now, we aggregate by channel and the caller can enrich with categories if they have the guild object
  const channelTotals: Record<string, number> = {};
  channelStats.forEach(s => {
    channelTotals[s.channelId] = (channelTotals[s.channelId] || 0) + s.messagesCount;
  });

  return Object.entries(channelTotals).map(([channelId, messages]) => ({ channelId, messages }));
};

function countCalendarDaysPerWeekday(startKey: string, endKey: string): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const cursor = new Date(`${startKey}T12:00:00.000Z`);
  const end = new Date(`${endKey}T12:00:00.000Z`);
  while (cursor <= end) {
    counts[cursor.getUTCDay()]++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return counts;
}

function createEmptyHeatmapGrid() {
  const grid: Record<number, Record<number, { messages: number; voice: number; active: number; joins: number; leaves: number }>> = {};
  for (let dow = 0; dow < 7; dow++) {
    grid[dow] = {};
    for (let hour = 0; hour < 24; hour++) {
      grid[dow][hour] = { messages: 0, voice: 0, active: 0, joins: 0, leaves: 0 };
    }
  }
  return grid;
}

/**
 * Get hourly heatmap data (for visualization)
 *
 * `timezone` est le fuseau de lecture : les creneaux sont stockes en UTC, mais
 * une grille jour x heure ne veut rien dire tant qu'elle n'est pas ramenee a
 * l'heure murale de celui qui la regarde.
 */
export const getHourlyHeatmapData = async (guildId: string, options: { days?: number, startDate?: string|null, endDate?: string|null, timezone?: string } = {}) => {
  const days = options.days || 30;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  const finalEndKey = endKey.split('T')[0];
  if (!startKey) {
    const startDate = new Date(finalEndKey);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }
  const finalStartKey = startKey.split('T')[0];
  const zoner = new BucketZoner(options.timezone ?? DEFAULT_TIMEZONE);
  // Bornes de la plage **locale**, converties en instants reels : a Paris, le
  // 1er mars commence a 23h UTC le 28 fevrier.
  const rangeStart = zonedDayStart(finalStartKey, zoner.timezone);
  const rangeEnd = new Date(zonedDayStart(shiftKey(finalEndKey, 1), zoner.timezone).getTime() - 1);
  const daysPerWeekday = countCalendarDaysPerWeekday(finalStartKey, finalEndKey);

  const hourlyStats = await prisma.guildHourlyStat.findMany({
    where: {
      guildId,
      // Elargi d'un jour de chaque cote : le decalage fait entrer dans la
      // plage locale des creneaux UTC de la veille ou du lendemain. Le tri
      // final se fait sur les cles converties.
      dateKey: {
        gte: shiftKey(finalStartKey, -ZONE_MARGIN_DAYS),
        lte: shiftKey(finalEndKey, ZONE_MARGIN_DAYS)
      }
    },
    orderBy: [{ dateKey: 'asc' }, { hour: 'asc' }]
  });

  /** Creneaux ramenes au fuseau de lecture, hors plage exclus. */
  const zonedStats = hourlyStats.flatMap(stat => {
    const bucket = zoner.fromKeyHour(stat.dateKey, stat.hour);
    if (bucket.dateKey < finalStartKey || bucket.dateKey > finalEndKey) return [];
    return [{ stat, bucket }];
  });

  const heatmapData = createEmptyHeatmapGrid();

  zonedStats.forEach(({ stat, bucket }) => {
    heatmapData[bucket.weekday][bucket.hour].messages += stat.messagesCount;
    heatmapData[bucket.weekday][bucket.hour].voice += stat.voiceMinutes;
    heatmapData[bucket.weekday][bucket.hour].active += stat.activeMembers;
  });

  const [joinProfiles, leaveProfiles] = await Promise.all([
    prisma.memberProfile.findMany({
      where: {
        guildId,
        isBot: false,
        guildJoinedAt: { gte: rangeStart, lte: rangeEnd },
      },
      select: { guildJoinedAt: true },
    }),
    prisma.memberProfile.findMany({
      where: {
        guildId,
        isBot: false,
        guildLeftAt: { gte: rangeStart, lte: rangeEnd },
      },
      select: { guildLeftAt: true },
    }),
  ]);

  let fluxEvents = joinProfiles.length + leaveProfiles.length;

  if (fluxEvents > 0) {
    for (const profile of joinProfiles) {
      if (!profile.guildJoinedAt) continue;
      const { weekday, hour } = zoner.fromDate(profile.guildJoinedAt);
      heatmapData[weekday][hour].joins += 1;
    }

    for (const profile of leaveProfiles) {
      if (!profile.guildLeftAt) continue;
      const { weekday, hour } = zoner.fromDate(profile.guildLeftAt);
      heatmapData[weekday][hour].leaves += 1;
    }
  } else {
    zonedStats.forEach(({ stat, bucket }) => {
      heatmapData[bucket.weekday][bucket.hour].joins += stat.joinsCount;
      heatmapData[bucket.weekday][bucket.hour].leaves += stat.leavesCount;
    });
    fluxEvents = zonedStats.reduce((sum, { stat }) => sum + stat.joinsCount + stat.leavesCount, 0);
  }

  // Dernier recours : stats journalières membersJoined / membersLeft réparties sur la journée
  if (fluxEvents === 0) {
    const dailyStats = await prisma.guildDailyStat.findMany({
      where: {
        guildId,
        dateKey: { gte: finalStartKey, lte: finalEndKey },
        OR: [{ membersJoined: { gt: 0 } }, { membersLeft: { gt: 0 } }],
      },
      select: { dateKey: true, membersJoined: true, membersLeft: true },
    });

    for (const day of dailyStats) {
      const date = new Date(day.dateKey + 'T00:00:00Z');
      const dow = date.getUTCDay();
      const joinsPerHour = day.membersJoined / 24;
      const leavesPerHour = day.membersLeft / 24;
      for (let hour = 0; hour < 24; hour++) {
        heatmapData[dow][hour].joins += joinsPerHour;
        heatmapData[dow][hour].leaves += leavesPerHour;
      }
    }
  }

  const normalized: Record<number, Record<number, { messages: number; voice: number; active: number; joins: number; leaves: number; net: number }>> = {};
  for (let dow = 0; dow < 7; dow++) {
    normalized[dow] = {};
    const weekdayCount = daysPerWeekday[dow] || 1;
    for (let hour = 0; hour < 24; hour++) {
      const joins = Math.round((heatmapData[dow][hour].joins / weekdayCount) * 10) / 10;
      const leaves = Math.round((heatmapData[dow][hour].leaves / weekdayCount) * 10) / 10;
      normalized[dow][hour] = {
        messages: Math.round(heatmapData[dow][hour].messages / weekdayCount),
        voice: Math.round(heatmapData[dow][hour].voice / weekdayCount),
        active: Math.round(heatmapData[dow][hour].active / weekdayCount),
        joins,
        leaves,
        net: Math.round((joins - leaves) * 10) / 10,
      };
    }
  }

  return normalized;
};

/**
 * Comparaison d'une semaine (du lundi au dimanche, UTC) ou d'un mois civil
 * avec une période de référence `offset` crans plus tôt.
 *
 * La période en cours n'est pas finie : la comparer à une période entière
 * donnait toujours une « baisse » en début de semaine. `toDate` compare donc
 * aussi les mêmes jours écoulés de part et d'autre (lundi→mercredi contre
 * lundi→mercredi), et `daily` aligne les deux périodes jour par jour.
 */
export const getWeekOverWeekComparison = async (guildId: string, options: { offset?: number, mode?: 'week' | 'month' } = {}, now = new Date()) => {
  const { offset = 1, mode = 'week' } = options;
  const keyOf = (d: Date) => d.toISOString().split('T')[0]!;
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

  let currentStart: Date;
  let currentEnd: Date;
  let previousStart: Date;
  let previousEnd: Date;
  if (mode === 'month') {
    currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    currentEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    previousEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 0));
  } else {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    currentStart = addDays(today, -((today.getUTCDay() + 6) % 7));
    currentEnd = addDays(currentStart, 6);
    previousStart = addDays(currentStart, -7 * offset);
    previousEnd = addDays(previousStart, 6);
  }
  const todayKey = keyOf(now);
  const elapsedDays = Math.min(
    Math.round((Date.parse(`${keyOf(currentEnd)}T00:00:00Z`) - Date.parse(`${keyOf(currentStart)}T00:00:00Z`)) / 86_400_000) + 1,
    Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${keyOf(currentStart)}T00:00:00Z`)) / 86_400_000) + 1,
  );

  const [currentStats, previousStats, activeRows] = await Promise.all([
    prisma.guildDailyStat.findMany({ where: { guildId, dateKey: { gte: keyOf(currentStart), lte: keyOf(currentEnd) } } }),
    prisma.guildDailyStat.findMany({ where: { guildId, dateKey: { gte: keyOf(previousStart), lte: keyOf(previousEnd) } } }),
    prisma.$queryRaw<Array<{ period: string; v: number }>>`
      SELECT CASE WHEN "dateKey" >= ${keyOf(currentStart)} THEN 'current'
                  WHEN "dateKey" <= ${keyOf(addDays(previousStart, elapsedDays - 1))} THEN 'previousToDate'
                  ELSE 'previousRest' END AS period,
             COUNT(DISTINCT "userId")::int AS v
      FROM "member_daily_stats"
      WHERE "guildId" = ${guildId} AND ("messagesCount" > 0 OR "voiceMinutes" > 0)
        AND (("dateKey" >= ${keyOf(currentStart)} AND "dateKey" <= ${keyOf(currentEnd)})
          OR ("dateKey" >= ${keyOf(previousStart)} AND "dateKey" <= ${keyOf(previousEnd)}))
      GROUP BY 1
    `,
  ]);

  type Totals = { messages: number; voiceMinutes: number; joins: number; leaves: number; sanctions: number };
  const sumStats = (stats: typeof currentStats): Totals => ({
    messages: stats.reduce((sum, st) => sum + st.messagesCount, 0),
    voiceMinutes: stats.reduce((sum, st) => sum + st.voiceMinutes, 0),
    joins: stats.reduce((sum, st) => sum + st.membersJoined, 0),
    leaves: stats.reduce((sum, st) => sum + st.membersLeft, 0),
    sanctions: stats.reduce((sum, st) => sum + (st.sanctionsCount || 0), 0),
  });
  const getChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  };
  const changesOf = (a: Totals, b: Totals) => ({
    messagesChange: getChange(a.messages, b.messages),
    voiceChange: getChange(a.voiceMinutes, b.voiceMinutes),
    joinsChange: getChange(a.joins, b.joins),
    leavesChange: getChange(a.leaves, b.leaves),
    sanctionsChange: getChange(a.sanctions, b.sanctions),
  });

  const previousToDateEnd = keyOf(addDays(previousStart, elapsedDays - 1));
  const thisPeriod = sumStats(currentStats);
  const lastPeriod = sumStats(previousStats);
  const lastPeriodToDate = sumStats(previousStats.filter((st) => st.dateKey <= previousToDateEnd));
  const active = Object.fromEntries(activeRows.map((r) => [r.period, r.v]));

  const length = Math.max(
    Math.round((currentEnd.getTime() - currentStart.getTime()) / 86_400_000) + 1,
    Math.round((previousEnd.getTime() - previousStart.getTime()) / 86_400_000) + 1,
  );
  const byKey = (stats: typeof currentStats) => new Map(stats.map((st) => [st.dateKey, st]));
  const cur = byKey(currentStats);
  const prev = byKey(previousStats);
  const day = (st: (typeof currentStats)[number] | undefined) => ({
    messages: st?.messagesCount ?? 0,
    voiceMinutes: st?.voiceMinutes ?? 0,
    joins: st?.membersJoined ?? 0,
    leaves: st?.membersLeft ?? 0,
    sanctions: st?.sanctionsCount ?? 0,
    activeMembers: st?.activeMembers ?? 0,
    peakOnline: st?.peakOnline ?? 0,
  });
  const daily = Array.from({ length }, (_, i) => {
    const ck = keyOf(addDays(currentStart, i));
    const pk = keyOf(addDays(previousStart, i));
    return {
      index: i,
      currentKey: ck <= keyOf(currentEnd) ? ck : null,
      previousKey: pk <= keyOf(previousEnd) ? pk : null,
      current: ck <= todayKey && ck <= keyOf(currentEnd) ? day(cur.get(ck)) : null,
      previous: pk <= keyOf(previousEnd) ? day(prev.get(pk)) : null,
    };
  });

  return {
    mode,
    offset,
    ranges: {
      current: { start: keyOf(currentStart), end: keyOf(currentEnd), elapsedDays },
      previous: { start: keyOf(previousStart), end: keyOf(previousEnd), toDateEnd: previousToDateEnd },
    },
    thisWeek: thisPeriod,
    lastWeek: lastPeriod,
    lastWeekToDate: lastPeriodToDate,
    activeMembers: { current: active.current ?? 0, previousToDate: active.previousToDate ?? 0 },
    changes: changesOf(thisPeriod, lastPeriod),
    changesToDate: changesOf(thisPeriod, lastPeriodToDate),
    daily,
  };
};

/**
 * Get growth and retention metrics
 */
export const getGrowthAndRetention = async (guildId: string, options: { days?: number, startDate?: string | null, endDate?: string | null } = {}) => {
  const days = options.days || 90;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  if (!startKey) {
    const startDate = new Date(endKey);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }

  const dailyStats = await prisma.guildDailyStat.findMany({
    where: {
      guildId,
      dateKey: { gte: startKey, lte: endKey }
    },
    orderBy: { dateKey: 'asc' }
  });

  // Calculate cumulative net growth (joins - leaves)
  let cumulativeMembers = 0;
  const growthTrend = dailyStats.map(stat => {
    cumulativeMembers += stat.membersJoined - stat.membersLeft;
    return {
      dateKey: stat.dateKey,
      netGrowth: stat.membersJoined - stat.membersLeft,
      cumulativeGrowth: cumulativeMembers,
      activeMembers: stat.activeMembers,
      totalMembers: stat.totalMembers,
      retentionRate: stat.totalMembers > 0 ? Math.round((stat.activeMembers / stat.totalMembers) * 100) : 0
    };
  });

  // Get overall metrics
  const totalJoins = dailyStats.reduce((sum, s) => sum + s.membersJoined, 0);
  const totalLeaves = dailyStats.reduce((sum, s) => sum + s.membersLeft, 0);
  const avgActiveMembers = Math.round(
    dailyStats.reduce((sum, s) => sum + s.activeMembers, 0) / (dailyStats.length || 1)
  );
  const lastDayStats = dailyStats[dailyStats.length - 1];
  const currentRetention = lastDayStats 
    ? Math.round((lastDayStats.activeMembers / (lastDayStats.totalMembers || 1)) * 100)
    : 0;

  return {
    growthTrend,
    metrics: {
      totalJoins,
      totalLeaves,
      netGrowth: totalJoins - totalLeaves,
      avgActiveMembers,
      currentRetention
    }
  };
};

/**
 * Get global member-to-member interaction graph
 */
export const getGlobalInteractions = async (client: any, guildId: string, options: { days?: number, startDate?: string, endDate?: string } = {}) => {
  const days = options.days || 30;
  const endKey = options.endDate || new Date().toISOString().split('T')[0];
  let startKey = options.startDate;

  const endKeyOnly = endKey.split('T')[0];
  if (!startKey) {
    const startDate = new Date(endKeyOnly);
    startDate.setDate(startDate.getDate() - days);
    startKey = startDate.toISOString().split('T')[0];
  }
  const startKeyOnly = startKey.split('T')[0];

  const finalEndKey = new Date(endKeyOnly + 'T23:59:59.999Z');
  const finalStartKey = new Date(startKeyOnly + 'T00:00:00.000Z');

  // Fetch audit logs in the timeframe
  const logs = await prisma.dashboardAuditLog.findMany({
    where: {
      guildId,
      dateIso: {
        gte: finalStartKey,
        lte: finalEndKey
      },
      module: { in: ['Messages', 'Interactions'] },
      action: { in: ['Message envoyé', 'Réaction ajoutée'] }
    },
    select: {
      user: true,
      action: true,
      details: true
    }
  });

  const extractIdFromUserStr = (str: string | null | undefined): string | null => {
    if (!str) return null;
    const match = str.match(/\(<@(\d+)>\)/);
    if (match) return match[1];
    const rawIdMatch = str.match(/^(\d+)$/);
    return rawIdMatch ? rawIdMatch[1] : null;
  };

  // Maps to aggregate counts
  const userActivity = new Map<string, number>();
  const edgeMap = new Map<string, { from: string; to: string; mention: number; reply: number; reaction: number }>();

  const addEdge = (from: string, to: string, type: 'mention' | 'reply' | 'reaction', count = 1) => {
    if (from === to) return; // ignore self-interactions
    const key = from < to ? `${from}-${to}` : `${to}-${from}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, to, mention: 0, reply: 0, reaction: 0 };
      edgeMap.set(key, edge);
    }
    edge[type] += count;

    userActivity.set(from, (userActivity.get(from) || 0) + count);
    userActivity.set(to, (userActivity.get(to) || 0) + count);
  };

  // Réponses et mentions : la table d'interactions les compte pour tous les
  // serveurs qui collectent, sans dépendre du journal. Quand elle a des lignes
  // sur la période, on ne relit plus le journal que pour les réactions, sinon
  // les mêmes réponses compteraient deux fois.
  const statRows = await prisma.memberInteractionDailyStat.findMany({
    where: { guildId, dateKey: { gte: startKeyOnly, lte: endKeyOnly } },
    select: { userId: true, targetUserId: true, replies: true, mentions: true },
  });
  const fromStats = statRows.length > 0;
  for (const row of statRows) {
    if (row.replies > 0) addEdge(row.userId, row.targetUserId, 'reply', row.replies);
    if (row.mentions > 0) addEdge(row.userId, row.targetUserId, 'mention', row.mentions);
  }

  for (const log of logs) {
    const logUserId = extractIdFromUserStr(log.user);
    if (!logUserId) continue;

    if (log.action === 'Message envoyé') {
      if (fromStats) continue;
      const details = log.details || '';
      
      // Parse mentions
      const mentionRegex = /<@!?(\d+)>/g;
      let match;
      const processedMentions = new Set<string>();
      while ((match = mentionRegex.exec(details)) !== null) {
        const targetId = match[1];
        if (processedMentions.has(targetId)) continue;
        processedMentions.add(targetId);
        addEdge(logUserId, targetId, 'mention');
      }

      // Parse replies
      const replyMatch = details.match(/Réponse à:\s*<@!?(\d+)>/i);
      if (replyMatch) {
        const targetId = replyMatch[1];
        addEdge(logUserId, targetId, 'reply');
      }
    } else if (log.action === 'Réaction ajoutée') {
      const details = log.details || '';
      const targetMatch = details.match(/Cible:\s*.*?\(<@!?(\d+)>\)/i);
      if (targetMatch) {
        const targetId = targetMatch[1];
        addEdge(logUserId, targetId, 'reaction');
      }
    }
  }

  // Au-dela de cette taille le graphe n'est plus lisible et sa simulation de
  // forces, quadratique, sature le navigateur : on ne renvoie que les membres
  // les plus actifs et le client affiche le reste sous forme de compteur.
  const MAX_GRAPH_NODES = 300;

  const rankedUsers = [...userActivity.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  // On elargit la fenetre avant filtrage des bots pour ne pas descendre sous le plafond
  const candidates = rankedUsers.slice(0, MAX_GRAPH_NODES * 2);

  const candidateProfiles = await prisma.memberProfile.findMany({
    where: {
      guildId,
      userId: { in: candidates }
    },
    select: {
      userId: true,
      displayName: true,
      username: true,
      globalName: true,
      avatarUrl: true,
      isBot: true
    }
  });

  const profileMap = new Map(candidateProfiles.map(p => [p.userId, p]));

  const humanCandidates = candidates.filter(userId => {
    const p = profileMap.get(userId);
    return p ? !p.isBot : true; // filter out bots
  });

  const topUsers = humanCandidates.slice(0, MAX_GRAPH_NODES);
  const topUserSet = new Set(topUsers);

  const knownBots = candidates.length - humanCandidates.length;
  const hiddenMembersCount = Math.max(0, rankedUsers.length - knownBots - topUsers.length);

  // Filter edges to only include top users
  const filteredEdges: unknown[] = [];
  for (const edge of edgeMap.values()) {
    if (topUserSet.has(edge.from) && topUserSet.has(edge.to)) {
      if (edge.mention > 0) {
        filteredEdges.push({ from: edge.from, to: edge.to, type: 'mention', count: edge.mention });
      }
      if (edge.reply > 0) {
        filteredEdges.push({ from: edge.from, to: edge.to, type: 'reply', count: edge.reply });
      }
      if (edge.reaction > 0) {
        filteredEdges.push({ from: edge.from, to: edge.to, type: 'reaction', count: edge.reaction });
      }
    }
  }

  // Fetch member presences from Discord
  const statusMap = new Map<string, string>();
  const guild = client?.guilds?.cache?.get(guildId);
  if (guild && topUsers.length > 0) {
    // Un membre ayant coupé le suivi de sa présence reste dans le graphe, mais
    // son statut n'y est plus lisible : il est rendu comme hors-ligne.
    const presenceOptOuts = await findPresenceOptOuts(guildId, topUsers);
    const resolveStatus = (userId: string, status: string | undefined | null): string =>
      presenceOptOuts.has(userId) ? 'offline' : status || 'offline';

    try {
      const memberList = await guild.members.fetch({
        user: topUsers,
        withPresences: true
      });
      memberList.forEach((member: any) => {
        statusMap.set(member.id, resolveStatus(member.id, member.presence?.status));
      });
    } catch (fetchErr) {
      for (const userId of topUsers) {
        const member = guild.members.cache.get(userId);
        statusMap.set(userId, resolveStatus(userId, member?.presence?.status));
      }
    }
  } else {
    for (const userId of topUsers) {
      statusMap.set(userId, 'offline');
    }
  }

  const nodes = topUsers.map(userId => {
    const p = profileMap.get(userId);
    return {
      id: userId,
      label: p?.displayName || p?.globalName || p?.username || `User ${userId}`,
      avatar: p?.avatarUrl || null,
      activityCount: userActivity.get(userId) || 0,
      status: statusMap.get(userId) || 'offline'
    };
  });

  return { nodes, edges: filteredEdges, hiddenMembersCount, totalActiveMembers: userActivity.size };
};
