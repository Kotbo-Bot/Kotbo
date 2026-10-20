/**
 * Analytics : la page complète, ses sections et les vues détaillées.
 *
 * Formes reprises de `routes/dashboard/analytics.ts` côté bot et de ses
 * services (`contentAnalyticsService`, `advancedAnalyticsService`,
 * `dashboardAnalyticsService`). Les chiffres sortent tous de `demo/activity.ts`.
 */
import { route } from '../backend';
import { demoDb } from '../db';
import {
  channelMessages,
  dateKey,
  interactionEdges,
  memberSeries,
  memberTotals,
  messageCorpus,
  seeded,
  serverSeries,
  voiceChannelMinutes,
} from '../activity';
import { CATEGORIES, CHANNELS, DAY, HOUR, MEMBERS, PEOPLE, ROLES, VOICE_CHANNELS, ago, channelByName, personById, personByName } from '../fixtures';
import { sanctionsSeed } from '../stories';
import { SANCTIONS } from './session';
import { absencesSeed, ABSENCES, meetingsSeed, MEETINGS, staffMembers } from './home';

const DAY_MS = 86_400_000;
const nameOf = (userId: string) => personById(userId)?.displayName ?? 'Inconnu';

/** Les liens d'invitation du serveur. Repris par la page Invitations. */
export const INVITES = [
  { code: 'nova', inviter: 'Arka', uses: 212, maxUses: null, createdMinutesAgo: 600 * DAY, expires: null },
  { code: 'lina-et-cie', inviter: 'Lina', uses: 64, maxUses: null, createdMinutesAgo: 280 * DAY, expires: null },
  { code: 'tiktok-oct', inviter: 'Lena', uses: 41, maxUses: 100, createdMinutesAgo: 40 * DAY, expires: 20 * DAY },
  { code: 'partenaires', inviter: 'Arka', uses: 18, maxUses: null, createdMinutesAgo: 150 * DAY, expires: null },
  { code: 'quiz-mercredi', inviter: 'Noé', uses: 9, maxUses: 25, createdMinutesAgo: 6 * DAY, expires: 1 * DAY },
];

export function inviteOf(userId: string) {
  const index = Number(userId.slice(-3)) % 10;
  const invite = INVITES[index < 5 ? 0 : index < 7 ? 1 : index < 8 ? 2 : index < 9 ? 3 : 4];
  return invite;
}

function periodOf(query: URLSearchParams): number {
  const start = query.get('startDate');
  const end = query.get('endDate');
  if (start) {
    const days = Math.ceil((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / DAY_MS);
    return Math.min(365, Math.max(1, days));
  }
  return Math.min(365, Math.max(1, Number(query.get('period') || query.get('days')) || 30));
}

function range(days: number) {
  return { start: dateKey(days - 1), end: dateKey(0), prevStart: dateKey(days * 2 - 1), prevEnd: dateKey(days), days };
}

const activeStaff = () => staffMembers().filter((s) => s.blacklistEntries.length === 0);

const sum = <T>(list: T[], pick: (item: T) => number) => list.reduce((s, item) => s + pick(item), 0);

// ── Page principale ────────────────────────────────────────────────────

function sanctionsList() {
  return demoDb.get(SANCTIONS, sanctionsSeed);
}

function staffPerformance() {
  const sanctions = sanctionsList();
  return activeStaff().map((staff, i) => {
    const mine = sanctions.filter((s) => s.moderatorUserId === staff.userId);
    const count = staff.stats.sanctionsIssued + mine.length;
    const reports = Math.round(count * (0.55 + ((i * 13) % 40) / 100));
    return {
      userId: staff.userId,
      username: staff.username,
      displayName: staff.displayName,
      avatarUrl: null,
      sanctionsCount: count,
      reportsCount: reports,
      warns: Math.round(count * 0.62),
      bans: Math.round(count * 0.08),
      reportRate: count > 0 ? Math.round((reports / count) * 100) : 0,
    };
  });
}

const COMMANDS = [
  ['rank', 1_840], ['daily', 1_310], ['play', 980], ['leaderboard', 640], ['profile', 520], ['shop', 410],
  ['ticket', 190], ['warn', 74], ['giveaway', 38], ['rep', 312], ['quest', 286], ['fish', 455],
] as const;

function fullAnalytics(period: number) {
  const days = Math.min(period, 365);
  const series = serverSeries(days);
  const sanctions = sanctionsList();
  const inPeriod = sanctions.filter((s) => Date.now() - new Date(s.createdAt).getTime() <= days * DAY_MS);
  const byType = (type: string) => inPeriod.filter((s) => s.type === type).length;
  const totals = memberTotals(Math.min(days, 90));
  const channels = channelMessages(days);
  const voice = voiceChannelMinutes(days);
  const joins = sum(series, (d) => d.membersJoined);
  const leaves = sum(series, (d) => d.membersLeft);
  const messages = sum(series, (d) => d.messages);
  const voiceMinutes = sum(series, (d) => d.voiceMinutes);
  const half = Math.floor(series.length / 2);
  const recent = sum(series.slice(half), (d) => d.messages);
  const older = sum(series.slice(0, half), (d) => d.messages);
  const online = MEMBERS.filter((m) => m.status === 'online').length;
  const idle = MEMBERS.filter((m) => m.status === 'idle').length;
  const dnd = MEMBERS.filter((m) => m.status === 'dnd').length;
  const staff = activeStaff();
  const absences = demoDb.get(ABSENCES, absencesSeed);
  const meetings = demoDb.get(MEETINGS, meetingsSeed);

  const modCounts = new Map<string, number>();
  for (const s of sanctions) modCounts.set(s.moderatorUserId, (modCounts.get(s.moderatorUserId) ?? 0) + 1);
  for (const st of staff) modCounts.set(st.userId, (modCounts.get(st.userId) ?? 0) + Math.round(st.stats.sanctionsIssued / 2));
  const topModerators = [...modCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([userId, count]) => ({ userId, moderatorTag: personById(userId)?.username ?? 'inconnu', count, avatarUrl: null }));

  const targetCounts = new Map<string, number>();
  for (const s of sanctions) targetCounts.set(s.targetUserId, (targetCounts.get(s.targetUserId) ?? 0) + 1);
  const mostSanctioned = [...targetCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([userId, count]) => ({ userId, targetUserId: userId, targetTag: personById(userId)?.username ?? 'inconnu', count, avatarUrl: null }));

  const recentSanctions = sanctions.slice(0, 10).map((s) => ({
    id: s.id,
    type: s.type,
    targetUserId: s.targetUserId,
    targetTag: s.targetTag,
    targetName: s.targetTag,
    targetAvatarUrl: null,
    moderatorUserId: s.moderatorUserId,
    moderatorTag: s.moderatorTag,
    moderatorName: s.moderatorTag,
    moderatorAvatarUrl: null,
    reason: s.reason,
    createdAt: s.createdAt,
  }));

  const leaderboard = staff
    .map((st) => {
      const t = totals.find((x) => x.person.id === st.userId);
      const msg = t?.messages ?? 0;
      const vm = t?.voiceMinutes ?? 0;
      return { userId: st.userId, messages: msg, voiceMinutes: vm, name: st.displayName, grade: st.grade, avatarUrl: null, score: msg + vm * 2 };
    })
    .sort((a, b) => b.score - a.score);

  const recentJoins = MEMBERS.filter((m) => m.joinedMinutesAgo < days * DAY)
    .sort((a, b) => a.joinedMinutesAgo - b.joinedMinutesAgo)
    .slice(0, 20)
    .map((m) => ({ userId: m.id, name: m.displayName, avatarUrl: null, date: ago(m.joinedMinutesAgo) }));

  const leavers = ['Babette_off', 'Cyril42', 'Dina', 'Gaël07', 'Hugo_fr', 'Iris'].map((name, i) => ({
    userId: `90000000000000${String(9100 + i)}`,
    name,
    avatarUrl: null,
    date: ago((i * 3 + 1) * DAY + i * 97),
  }));

  const roleDistribution = ROLES.filter((r) => !r.managed)
    .map((r) => ({ roleId: r.id, roleName: r.name, color: r.color, count: MEMBERS.filter((m) => m.roles.includes(r.id)).length }))
    .sort((a, b) => b.count - a.count);

  return {
    period: days,
    timezone: 'Europe/Paris',
    clanTag: 'NOVA',
    clanTaggedMembersCount: 37,
    live: {
      totalMembers: MEMBERS.length + 2,
      onlineMembers: online,
      idleMembers: idle,
      dndMembers: dnd,
      offlineMembers: MEMBERS.length - online - idle - dnd,
      voiceConnected: 6,
      botsCount: 2,
      humansCount: MEMBERS.length,
    },
    totals: {
      messages,
      voiceMinutes,
      joins,
      leaves,
      netGrowth: joins - leaves,
      activeDays: series.length,
      sanctions: inPeriod.length + Math.round(days / 4),
      warns: byType('WARN') + Math.round(days / 7),
      kicks: byType('KICK') + Math.round(days / 30),
      bans: byType('BAN') + byType('TEMP_BAN') + Math.round(days / 20),
      timeouts: byType('TIMEOUT') + Math.round(days / 10),
      retentionRate: 81,
      activeAbsences: absences.filter((a) => a.status !== 'PENDING').length,
      totalStaff: staff.length,
      inactiveMembers: 23,
      avgTenureDays: 164,
      algoAvgParticipation: 6.4,
      avgMeetingAttendance: 78,
      messagesTrend: older > 0 ? Math.round(((recent - older) / older) * 100) : 0,
    },
    summary: {
      totalMessages: messages,
      totalVoiceMinutes: voiceMinutes,
      totalJoins: joins,
      totalLeaves: leaves,
      messagesTrend: older > 0 ? Math.round(((recent - older) / older) * 100) : 0,
    },
    dailyTrend: series.map((d) => ({
      dateKey: d.dateKey,
      messages: d.messages,
      voiceMinutes: d.voiceMinutes,
      voiceSessions: d.voiceSessions,
      membersJoined: d.membersJoined,
      membersLeft: d.membersLeft,
      totalMembers: MEMBERS.length - Math.round(d.daysAgo * 0.5),
      onlineMembers: d.onlineMembers,
      peakOnline: d.peakOnline,
      peakVoice: d.peakVoice,
      sanctions: d.sanctions,
      activeMembers: d.activeMembers,
      taggedMembersCount: Math.max(0, 37 - Math.round(d.daysAgo / 4)),
      memberJoins: recentJoins.filter((j) => j.date.slice(0, 10) === d.dateKey).map((j) => ({ userId: j.userId, name: j.name, avatarUrl: null, joinedAt: j.date })),
      memberLeaves: leavers.filter((l) => l.date.slice(0, 10) === d.dateKey).map((l) => ({ userId: l.userId, name: l.name, avatarUrl: null, leftAt: l.date })),
      invites: [],
    })),
    topChannels: channels.map((c) => ({ channelId: c.channel.id, channelName: c.channel.name, messagesCount: c.messages })),
    topVoiceChannels: voice.map((c) => ({ channelId: c.channel.id, channelName: c.channel.name, voiceMinutes: c.minutes })),
    topMessageMembers: totals.slice(0, 100).filter((t) => t.messages > 0).map((t) => ({
      userId: t.person.id,
      name: t.person.displayName,
      username: t.person.username,
      avatarUrl: null,
      messageCount: t.messages,
      lastMessageAt: ago(t.person.status === 'online' ? 4 : 3 * HOUR),
    })),
    topVoiceMembers: [...totals].sort((a, b) => b.voiceMinutes - a.voiceMinutes).filter((t) => t.voiceMinutes > 0).slice(0, 100).map((t) => ({
      userId: t.person.id,
      name: t.person.displayName,
      username: t.person.username,
      avatarUrl: null,
      voiceTimeSeconds: t.voiceMinutes * 60,
      voiceSessionCount: Math.max(1, Math.round(t.voiceMinutes / 50)),
    })),
    topInviters: INVITES.map((inv) => ({ inviterId: personByName(inv.inviter).id, tag: inv.inviter, count: Math.round(inv.uses * Math.min(1, days / 120)) || 1 })),
    topModerators,
    topSanctionedMembers: mostSanctioned,
    recentSanctions,
    moderation: {
      totals: { warns: byType('WARN'), kicks: byType('KICK'), bans: byType('BAN') + byType('TEMP_BAN'), timeouts: byType('TIMEOUT') },
      topModerators,
      topSanctionedMembers: mostSanctioned,
      recentSanctions,
      activeSanctions: sanctions.filter((s) => s.status === 'ACTIVE').length,
    },
    staff: {
      leaderboard,
      activeAbsences: absences.length,
      totalStaff: staff.length,
      meetings: meetings.length + 6,
      avgMeetingAttendance: 78,
    },
    recruitmentPipeline: [
      { status: 'PENDING', count: 4 },
      { status: 'INTERVIEW', count: 2 },
      { status: 'ACCEPTED', count: 3 },
      { status: 'REJECTED', count: 5 },
    ],
    roleDistribution,
    commandUsage: COMMANDS.map(([name, count]) => ({ name, count: Math.round(count * Math.min(1, days / 30)) || 1 })).sort((a, b) => b.count - a.count),
    staffPerformance: staffPerformance(),
    recentJoins,
    recentLeaves: leavers,
  };
}

// ── Sections de la nouvelle page ───────────────────────────────────────

function activity(days: number) {
  const current = serverSeries(days);
  const previous = serverSeries(days, days);
  const totals = memberTotals(days);
  return {
    range: range(days),
    voiceAvailable: true,
    kpis: {
      messages: { value: sum(current, (d) => d.messages), previous: sum(previous, (d) => d.messages) },
      activeMembers: { value: totals.filter((t) => t.activeDays > 0).length, previous: Math.round(totals.filter((t) => t.activeDays > 0).length * 0.92) },
      voiceMinutes: { value: sum(current, (d) => d.voiceMinutes), previous: sum(previous, (d) => d.voiceMinutes) },
      netJoins: {
        value: sum(current, (d) => d.membersJoined - d.membersLeft),
        previous: sum(previous, (d) => d.membersJoined - d.membersLeft),
      },
      joined: sum(current, (d) => d.membersJoined),
      left: sum(current, (d) => d.membersLeft),
      memberCount: MEMBERS.length,
    },
    series: current.map((d, i) => ({
      dateKey: d.dateKey,
      messages: d.messages,
      voiceMinutes: d.voiceMinutes,
      prevMessages: previous[i]?.messages ?? 0,
      prevVoiceMinutes: previous[i]?.voiceMinutes ?? 0,
    })),
    topChannels: channelMessages(days).map((c) => ({ channelId: c.channel.id, name: c.channel.name, messages: c.messages })),
  };
}

const UNICODE_EMOJIS = [['😂', 1_240], ['❤️', 880], ['🔥', 640], ['👍', 590], ['😭', 410], ['🎉', 330], ['👀', 270], ['💀', 220], ['✨', 160], ['🙏', 120]] as const;
const GUILD_EMOJIS = [['nova_gg', 520], ['nova_pog', 310], ['kotbo_wave', 190], ['nova_sad', 95]] as const;

function emojiList(scale: number, reactions = false) {
  return [
    ...UNICODE_EMOJIS.map(([key, count]) => ({ key, origin: 'unicode' as const, count: Math.round(count * scale * (reactions ? 1.6 : 1)), name: null, animated: false, imageUrl: null, sourceName: null })),
    ...GUILD_EMOJIS.map(([name, count], i) => ({
      key: `9200000000000000${10 + i}`,
      origin: 'guild' as const,
      count: Math.round(count * scale * (reactions ? 1.3 : 1)),
      name,
      animated: i === 1,
      imageUrl: null,
      sourceName: 'Atelier Nova',
    })),
    { key: '920000000000000099', origin: 'external' as const, count: Math.round(70 * scale), name: 'pepe_hype', animated: true, imageUrl: null, sourceName: 'Pepe Land' },
  ].sort((a, b) => b.count - a.count);
}

function content(days: number, query: URLSearchParams) {
  const scale = days / 30;
  const messages = sum(serverSeries(days), (d) => d.messages);
  const prev = sum(serverSeries(days, days), (d) => d.messages);
  const totalsFor = (n: number) => {
    const f = n / Math.max(1, messages);
    return {
      messages: n,
      withEmoji: Math.round(n * 0.31),
      withMarkdown: Math.round(n * 0.07),
      reactedMessages: Math.round(n * 0.22),
      withLink: Math.round(n * 0.09),
      withMedia: Math.round(n * 0.12),
      emojiUnicode: Math.round(4_870 * scale * f),
      emojiGuild: Math.round(1_115 * scale * f),
      emojiExternal: Math.round(70 * scale * f),
      emojiAnimated: Math.round(380 * scale * f),
      emojiOnly: Math.round(n * 0.04),
      reactUnicode: Math.round(7_200 * scale * f),
      reactGuild: Math.round(1_450 * scale * f),
      reactExternal: Math.round(120 * scale * f),
      stickerGuild: Math.round(140 * scale * f),
      stickerExternal: Math.round(30 * scale * f),
      stickerStandard: Math.round(55 * scale * f),
      gifTenor: Math.round(n * 0.03),
      gifGiphy: Math.round(n * 0.006),
      gifUpload: Math.round(n * 0.004),
      gifOther: Math.round(n * 0.002),
      typeText: Math.round(n * 0.78),
      typeImage: Math.round(n * 0.07),
      typeVideo: Math.round(n * 0.012),
      typeGif: Math.round(n * 0.042),
      typeLink: Math.round(n * 0.05),
      typeSticker: Math.round(n * 0.011),
      typeFile: Math.round(n * 0.004),
      typeAudio: Math.round(n * 0.002),
      typeVoice: Math.round(n * 0.006),
      typePoll: Math.round(n * 0.001),
      typeForward: Math.round(n * 0.008),
      lenShort: Math.round(n * 0.52),
      lenMedium: Math.round(n * 0.39),
      lenLong: Math.round(n * 0.09),
      mdBold: Math.round(n * 0.02),
      mdItalic: Math.round(n * 0.015),
      mdCodeBlock: Math.round(n * 0.006),
      mdSpoiler: Math.round(n * 0.008),
      mdMaskedLink: Math.round(n * 0.003),
      mdQuote: Math.round(n * 0.01),
    };
  };
  const userId = query.get('userId');
  const channelId = query.get('channel');
  const basis = userId ? 'member' : channelId ? 'channel' : 'server';
  const target = userId
    ? Math.round(messages * ((personById(userId)?.messages ?? 100) / 80_000))
    : channelId
      ? channelMessages(days).find((c) => c.channel.id === channelId)?.messages ?? Math.round(messages / 8)
      : messages;
  const ratio = target / Math.max(1, messages);
  return {
    range: range(days),
    itemBasis: basis,
    totals: totalsFor(target),
    previous: totalsFor(Math.round(prev * ratio)),
    emojis: emojiList(scale * ratio),
    reactions: emojiList(scale * ratio, true),
    emojiServers: [
      { guildId: null, name: 'Atelier Nova', count: Math.round(1_115 * scale * ratio), items: 4 },
      { guildId: '930000000000000001', name: 'Pepe Land', count: Math.round(70 * scale * ratio), items: 1 },
    ],
    reactionServers: [{ guildId: null, name: 'Atelier Nova', count: Math.round(1_450 * scale * ratio), items: 4 }],
    stickers: [
      { key: '940000000000000001', origin: 'guild', count: Math.round(92 * scale * ratio), name: 'Nova qui danse', imageUrl: '', sourceName: 'Atelier Nova' },
      { key: '940000000000000002', origin: 'standard', count: Math.round(55 * scale * ratio), name: 'Wumpus coucou', imageUrl: '', sourceName: null },
      { key: '940000000000000003', origin: 'guild', count: Math.round(48 * scale * ratio), name: 'GG', imageUrl: '', sourceName: 'Atelier Nova' },
    ],
    stickerServers: [{ guildId: null, name: 'Atelier Nova', count: Math.round(140 * scale * ratio), items: 2 }],
    domains: [
      { domain: 'youtube.com', family: 'video', count: Math.round(210 * scale * ratio) },
      { domain: 'tenor.com', family: 'gif', count: Math.round(180 * scale * ratio) },
      { domain: 'twitch.tv', family: 'stream', count: Math.round(95 * scale * ratio) },
      { domain: 'x.com', family: 'social', count: Math.round(60 * scale * ratio) },
      { domain: 'reddit.com', family: 'social', count: Math.round(34 * scale * ratio) },
      { domain: 'github.com', family: 'dev', count: Math.round(12 * scale * ratio) },
    ],
    gifChannels: channelMessages(days).slice(0, 4).map((c) => ({ channelId: c.channel.id, name: c.channel.name, count: Math.round(c.messages * 0.04 * ratio) })),
    backfill: { status: 'COMPLETED', processed: 48_210, total: 48_210 },
  };
}

/** Salon → catégorie, pour la vue en arbre. */
export const CATEGORY_OF: Record<string, string> = {
  bienvenue: 'ACCUEIL', 'règlement': 'ACCUEIL', annonces: 'ACCUEIL',
  'général': 'DISCUSSIONS', 'recherche-de-groupe': 'DISCUSSIONS', niveaux: 'DISCUSSIONS', boutique: 'DISCUSSIONS', suggestions: 'DISCUSSIONS', Squad: 'DISCUSSIONS',
  'ouvrir-un-ticket': 'SUPPORT',
  staff: 'ÉQUIPE', logs: 'ÉQUIPE', 'Réunion staff': 'ÉQUIPE',
};

function treeChannels(days: number) {
  const msgs = channelMessages(days);
  const prevMsgs = channelMessages(days * 2);
  const voice = voiceChannelMinutes(days);
  const text = CHANNELS.map((c) => {
    const m = msgs.find((x) => x.channel.id === c.id)?.messages ?? 0;
    const p = (prevMsgs.find((x) => x.channel.id === c.id)?.messages ?? 0) - m;
    return {
      id: c.id, name: c.name, kind: c.type === 'forum' ? 'forum' : 'text', messages: m, voiceMinutes: 0,
      prevMessages: Math.max(0, p), prevVoiceMinutes: 0, authors: Math.round(Math.sqrt(m) * 1.8), lastActiveDate: m > 0 ? dateKey(0) : dateKey(12),
    };
  });
  const vc = VOICE_CHANNELS.map((c) => {
    const v = voice.find((x) => x.channel.id === c.id)?.minutes ?? 0;
    return { id: c.id, name: c.name, kind: 'voice', messages: 0, voiceMinutes: v, prevMessages: 0, prevVoiceMinutes: Math.round(v * 0.9), authors: Math.round(Math.sqrt(v) / 2), lastActiveDate: dateKey(0) };
  });
  return [...text, ...vc] as Array<{ id: string; name: string; kind: 'text' | 'voice' | 'forum'; messages: number; voiceMinutes: number; prevMessages: number; prevVoiceMinutes: number; authors: number; lastActiveDate: string | null }>;
}

function channelTree(days: number) {
  const channels = treeChannels(days);
  const categories = CATEGORIES.map((cat) => {
    const list = channels.filter((c) => CATEGORY_OF[c.name] === cat.name);
    return {
      id: cat.id,
      name: cat.name,
      messages: sum(list, (c) => c.messages),
      voiceMinutes: sum(list, (c) => c.voiceMinutes),
      prevMessages: sum(list, (c) => c.prevMessages),
      prevVoiceMinutes: sum(list, (c) => c.prevVoiceMinutes),
      authors: sum(list, (c) => c.authors),
      channels: list.sort((a, b) => b.messages + b.voiceMinutes - (a.messages + a.voiceMinutes)),
    };
  });
  return {
    range: range(days),
    totals: { messages: sum(channels, (c) => c.messages), voiceMinutes: sum(channels, (c) => c.voiceMinutes) },
    orphan: null,
    categories,
  };
}

function categoryDetail(categoryId: string, days: number) {
  const tree = channelTree(days);
  const cat = tree.categories.find((c) => c.id === categoryId) ?? tree.categories[1];
  const share = cat.messages / Math.max(1, tree.totals.messages);
  return {
    range: range(days),
    id: cat.id,
    name: cat.name,
    kpis: {
      messages: { value: cat.messages, previous: cat.prevMessages },
      voiceMinutes: { value: cat.voiceMinutes, previous: cat.prevVoiceMinutes },
      activeMembers: Math.round(cat.authors * 0.8),
      messageShare: { value: Math.round(share * 100), previous: Math.round(share * 96) },
      voiceShare: Math.round((cat.voiceMinutes / Math.max(1, tree.totals.voiceMinutes)) * 100),
    },
    daily: serverSeries(days).map((d) => ({
      dateKey: d.dateKey,
      textOnly: Math.round(d.activeMembers * share * 0.7),
      voiceOnly: Math.round(d.peakVoice * 0.6),
      both: Math.round(d.peakVoice * 0.8),
    })),
    voiceHistoryDays: 90,
    channels: cat.channels,
    topMembers: memberTotals(days).slice(0, 8).map((t) => ({
      userId: t.person.id, name: t.person.displayName, avatarUrl: null, messages: Math.round(t.messages * share), voiceMinutes: Math.round(t.voiceMinutes * 0.5),
    })),
  };
}

function filterOptions() {
  const channels = treeChannels(30);
  return {
    categories: CATEGORIES.map((cat) => ({
      id: cat.id,
      name: cat.name,
      channels: channels.filter((c) => CATEGORY_OF[c.name] === cat.name).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    })),
    roles: ROLES.filter((r) => !r.managed).map((r) => ({ id: r.id, name: r.name, color: r.color, members: MEMBERS.filter((m) => m.roles.includes(r.id)).length })),
  };
}

export function heatmap(seed = 31) {
  const out: Record<number, Record<number, { messages: number; voice: number; active: number; joins: number; leaves: number; net: number }>> = {};
  const random = seeded(seed);
  for (let dow = 0; dow < 7; dow++) {
    out[dow] = {};
    const weekend = dow === 0 || dow === 6;
    for (let hour = 0; hour < 24; hour++) {
      const evening = Math.exp(-((hour - 21) ** 2) / 12);
      const afternoon = Math.exp(-((hour - 15) ** 2) / 18) * (weekend ? 0.9 : 0.4);
      const night = hour < 2 ? 0.45 : hour < 7 ? 0.04 : 0;
      const level = evening + afternoon + night + 0.05 + (dow === 3 && hour >= 20 && hour <= 23 ? 0.6 : 0);
      const joins = Math.round(level * (0.5 + random()) * 4) / 10;
      const leaves = Math.round(level * random() * 1.2) / 10;
      out[dow][hour] = {
        messages: Math.round(level * 85 * (0.8 + random() * 0.4)),
        voice: Math.round(level * 140 * (0.7 + random() * 0.6)),
        active: Math.round(level * 26),
        joins,
        leaves,
        net: Math.round((joins - leaves) * 10) / 10,
      };
    }
  }
  return out;
}

function weekly(offset: number, mode: string) {
  const length = mode === 'month' ? 30 : 7;
  const sumPeriod = (start: number) => {
    const s = serverSeries(length, start);
    return {
      messages: sum(s, (d) => d.messages),
      voiceMinutes: sum(s, (d) => d.voiceMinutes),
      joins: sum(s, (d) => d.membersJoined),
      leaves: sum(s, (d) => d.membersLeft),
      sanctions: sum(s, (d) => d.sanctions),
    };
  };
  const thisWeek = sumPeriod(0);
  const lastWeek = sumPeriod(length * Math.max(1, offset));
  const change = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100));
  return {
    thisWeek,
    lastWeek,
    changes: {
      messagesChange: change(thisWeek.messages, lastWeek.messages),
      voiceChange: change(thisWeek.voiceMinutes, lastWeek.voiceMinutes),
      joinsChange: change(thisWeek.joins, lastWeek.joins),
      leavesChange: change(thisWeek.leaves, lastWeek.leaves),
      sanctionsChange: change(thisWeek.sanctions, lastWeek.sanctions),
    },
  };
}

function growth(days: number) {
  const series = serverSeries(days);
  let cumulative = 0;
  const total = MEMBERS.length;
  return {
    growthTrend: series.map((d) => {
      cumulative += d.membersJoined - d.membersLeft;
      const totalMembers = total - Math.round(d.daysAgo * 0.5);
      return {
        dateKey: d.dateKey,
        netGrowth: d.membersJoined - d.membersLeft,
        cumulativeGrowth: cumulative,
        activeMembers: d.activeMembers,
        totalMembers,
        retentionRate: Math.round((d.activeMembers / totalMembers) * 100),
      };
    }),
    metrics: {
      totalJoins: sum(series, (d) => d.membersJoined),
      totalLeaves: sum(series, (d) => d.membersLeft),
      netGrowth: sum(series, (d) => d.membersJoined - d.membersLeft),
      avgActiveMembers: Math.round(sum(series, (d) => d.activeMembers) / series.length),
      currentRetention: 61,
    },
  };
}

function dailyAlgo(days: number) {
  const performers = ['Noé', 'Lina', 'Yanis', 'Inès', 'Maëlle'].map((name, i) => {
    const p = personByName(name);
    return { userId: p.id, name: p.displayName, submissions: 18 - i * 3, validated: 15 - i * 3, avgScore: 92 - i * 6, scores: [] };
  });
  return {
    metrics: {
      totalRuns: Math.round(days * 0.9),
      totalSubmissions: Math.round(days * 6.4),
      completedSubmissions: Math.round(days * 4.9),
      completionRate: 77,
      avgSubmissionsPerRun: 6.4,
    },
    trend: serverSeries(Math.min(days, 30)).map((d, i) => ({ dateKey: d.dateKey, count: 3 + ((i * 7) % 6), submissions: 3 + ((i * 7) % 6) })),
    topPerformers: performers,
    difficultyDistribution: [
      { difficulty: 'EASY', count: Math.round(days * 0.4) },
      { difficulty: 'MEDIUM', count: Math.round(days * 0.35) },
      { difficulty: 'HARD', count: Math.round(days * 0.15) },
    ],
  };
}

function interactions() {
  const edges = interactionEdges().filter((e) => e.count >= 2);
  const activity = new Map<string, number>();
  for (const e of edges) {
    activity.set(e.from, (activity.get(e.from) ?? 0) + e.count);
    activity.set(e.to, (activity.get(e.to) ?? 0) + e.count);
  }
  const top = [...activity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id]) => id);
  const keep = new Set(top);
  return {
    nodes: top.map((id) => {
      const p = personById(id)!;
      return { id, label: p.displayName, avatar: null, activityCount: activity.get(id) ?? 0, status: p.status };
    }),
    edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    hiddenMembersCount: Math.max(0, activity.size - top.length),
    totalActiveMembers: activity.size,
  };
}

function advanced(section: string) {
  const series = serverSeries(30);
  const prev = serverSeries(30, 30);
  const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : 0);
  const cmp = (a: number, b: number) => ({ current: a, previous: b, changePct: pct(a, b) });
  switch (section) {
    case 'retention':
      return {
        cohorts: Array.from({ length: 12 }, (_, i) => {
          const weeksAgo = 11 - i;
          const joined = 9 + ((i * 5) % 9);
          return {
            week: dateKey(weeksAgo * 7 + 3),
            joined,
            d1: 88 - (i % 4) * 3,
            d7: weeksAgo >= 1 ? 71 - (i % 5) * 4 : null,
            d30: weeksAgo >= 5 ? 58 - (i % 3) * 5 : null,
          };
        }),
        returningMembers: 7,
        retentionBySource: INVITES.map((inv, i) => ({
          inviteCode: inv.code,
          inviterTag: personByName(inv.inviter).username,
          joined: Math.max(3, Math.round(inv.uses / 6)),
          retentionRate: [84, 77, 41, 69, 90][i],
        })),
      };
    case 'activity': {
      const totals = memberTotals(30);
      const mau = totals.filter((t) => t.activeDays > 0).length;
      return {
        dau: Math.round(mau * 0.36),
        wau: Math.round(mau * 0.71),
        mau,
        stickiness: 36,
        engagement: { messagesPerActive: Math.round(sum(series, (d) => d.messages) / mau), voiceShare: 38 },
        comparison: {
          messages: cmp(sum(series, (d) => d.messages), sum(prev, (d) => d.messages)),
          voiceMinutes: cmp(sum(series, (d) => d.voiceMinutes), sum(prev, (d) => d.voiceMinutes)),
          joins: cmp(sum(series, (d) => d.membersJoined), sum(prev, (d) => d.membersJoined)),
          leaves: cmp(sum(series, (d) => d.membersLeft), sum(prev, (d) => d.membersLeft)),
          reactions: cmp(sum(series, (d) => d.reactions), sum(prev, (d) => d.reactions)),
          avgActiveMembers: cmp(Math.round(sum(series, (d) => d.activeMembers) / 30), Math.round(sum(prev, (d) => d.activeMembers) / 30)),
        },
        records: {
          messages: { date: dateKey(46), value: 2_314 },
          peakVoice: { date: dateKey(18), value: 17 },
          peakOnline: { date: dateKey(46), value: 103 },
        },
      };
    }
    case 'churn':
      return {
        churnByTenure: { '<7j': 6, '7-30j': 4, '30-90j': 3, '90j+': 2 },
        atRisk: ['Kyzo', 'Yanis', 'Sacha', 'Maëlle'].map((name, i) => {
          const p = personByName(name);
          return { userId: p.id, name: p.displayName, avatarUrl: null, activeDays30: 14 - i * 2, lastActive: dateKey(8 + i * 2) };
        }),
        onboarding: { medianFirstMessageHours: 3, joined30d: 41, completed30d: 33, completionRate: 80 },
      };
    case 'channels': {
      const names = ['général', 'recherche-de-groupe', 'niveaux', 'boutique', 'suggestions'];
      const ids = names.map((n) => channelByName(n).id);
      const trend = [
        { channelId: channelByName('recherche-de-groupe').id, recent: 2_840, previous: 2_010, changePct: 41 },
        { channelId: channelByName('suggestions').id, recent: 610, previous: 470, changePct: 30 },
        { channelId: channelByName('général').id, recent: 6_920, previous: 6_400, changePct: 8 },
        { channelId: channelByName('niveaux').id, recent: 1_190, previous: 1_250, changePct: -5 },
        { channelId: channelByName('boutique').id, recent: 880, previous: 1_160, changePct: -24 },
        { channelId: channelByName('annonces').id, recent: 22, previous: 41, changePct: -46 },
      ];
      return {
        trends: { rising: trend.slice(0, 3), falling: trend.slice(-3).reverse() },
        coActivation: {
          available: true,
          channels: ids,
          matrix: [
            [0, 48, 31, 22, 17],
            [48, 0, 19, 9, 6],
            [31, 19, 0, 14, 5],
            [22, 9, 14, 0, 4],
            [17, 6, 5, 4, 0],
          ],
        },
      };
    }
    case 'social': {
      const received = new Map<string, { replies: number; mentions: number }>();
      for (const e of interactionEdges()) {
        const r = received.get(e.to) ?? { replies: 0, mentions: 0 };
        if (e.type === 'reply') r.replies += e.count;
        else r.mentions += e.count;
        received.set(e.to, r);
      }
      return {
        available: true,
        centrality: [...received.entries()]
          .sort((a, b) => b[1].replies + b[1].mentions - (a[1].replies + a[1].mentions))
          .slice(0, 10)
          .map(([userId, r]) => ({ userId, name: nameOf(userId), avatarUrl: null, repliesReceived: r.replies, mentionsReceived: r.mentions })),
        pingReaction: { medianSeconds: 94, samples: 1_284 },
      };
    }
    case 'words':
      return {
        enabled: true,
        messageLoggingEnabled: true,
        backfill: { status: 'COMPLETED', processedMessages: 48_210, totalMessages: 48_210, error: null },
        topWords: [
          ['partie', 412], ['ce soir', 388], ['merci', 351], ['ranked', 297], ['quiz', 254], ['niveau', 231], ['vocal', 219], ['tournoi', 187],
          ['patch', 164], ['squad', 158], ['boutique', 121], ['week-end', 117], ['rôle', 104], ['ticket', 93], ['stream', 88], ['playlist', 71],
        ].map(([word, count]) => ({ word, count })),
      };
    case 'moderation': {
      const sanctions = sanctionsList();
      return {
        pressure: Array.from({ length: 12 }, (_, i) => {
          const s = 2 + ((i * 3) % 5);
          return { week: dateKey((11 - i) * 7), per1000: Math.round((s / 5_600) * 100_000) / 100, sanctions: s };
        }),
        recidivism: { firstWarned: 11, recidivists: 3, rate: 27, avgDaysToNext: 9 },
        moderatorLoad: ['Zenox', 'Aiden', 'Lena', 'Arka', 'Kylian'].map((name, i) => ({ userId: personByName(name).id, tag: personByName(name).username, count: [19, 15, 11, 6, 3][i] })),
        hotHours: [
          { dow: 6, hour: 23, count: 6 }, { dow: 5, hour: 22, count: 5 }, { dow: 0, hour: 0, count: 4 },
          { dow: 3, hour: 21, count: 4 }, { dow: 6, hour: 1, count: 3 }, { dow: 2, hour: 18, count: 2 },
        ],
        accountAgeBuckets: { '<30j': 7, '30-180j': 5, '180j-1an': 3, '1an+': Math.max(2, sanctions.length) },
        toxicSources: [
          { inviteCode: 'tiktok-oct', invited: 41, sanctioned: 6, ratePct: 15 },
          { inviteCode: 'nova', invited: 58, sanctioned: 3, ratePct: 5 },
          { inviteCode: 'lina-et-cie', invited: 12, sanctioned: 0, ratePct: 0 },
        ],
        cleanableBans: 4,
      };
    }
    default:
      return {};
  }
}

function memberDetailed(userId: string, period: number) {
  const person = personById(userId) ?? PEOPLE[0];
  const series = memberSeries(person, Math.min(90, Math.max(7, period)));
  return {
    userId,
    period,
    totalMessages: sum(series, (d) => d.messages),
    totalVoiceMinutes: sum(series, (d) => d.voiceMinutes),
    activeDays: series.filter((d) => d.messages || d.voiceMinutes).length,
    dailyTrend: series,
  };
}

function inviteAnalytics() {
  return INVITES.map((inv) => {
    const inviter = personByName(inv.inviter);
    const random = seeded(inv.uses);
    const labels = Array.from({ length: 14 }, (_, i) => dateKey(13 - i));
    const counts = labels.map(() => Math.round(random() * Math.max(1, inv.uses / 40)));
    return {
      code: inv.code,
      inviterId: inviter.id,
      inviterTag: inviter.username,
      inviterAvatarUrl: null,
      createdBy: inviter.displayName,
      uses: inv.uses,
      maxUses: inv.maxUses,
      expiresAt: inv.expires ? new Date(Date.now() + inv.expires * 60_000).toISOString() : null,
      createdAt: ago(inv.createdMinutesAgo),
      trend: { labels, counts, totalJoined: counts.reduce((a, b) => a + b, 0) },
    };
  });
}

function channelDetail(channelId: string, days: number) {
  const channel = [...CHANNELS, ...VOICE_CHANNELS].find((c) => c.id === channelId) ?? CHANNELS[3];
  const isVoice = channel.type === 'voice';
  const share = channelMessages(days).find((c) => c.channel.id === channel.id)?.messages ?? 0;
  const series = serverSeries(days);
  const total = sum(series, (d) => d.messages) || 1;
  const authors = messageCorpus().filter((m) => m.channelId === channel.id);
  const counts = new Map<string, number>();
  for (const m of authors) counts.set(m.authorId, (counts.get(m.authorId) ?? 0) + 1);
  return {
    channel: { id: channel.id, name: channel.name, type: channel.type, topic: null, createdAt: ago(500 * DAY), categoryName: CATEGORY_OF[channel.name] ?? null },
    period: days,
    totals: { messages: share, voiceMinutes: isVoice ? Math.round(total * 0.4) : 0, activeMembers: counts.size, avgPerDay: Math.round(share / days) },
    dailyTrend: series.map((d) => ({ dateKey: d.dateKey, messages: Math.round((d.messages * share) / total), voiceMinutes: isVoice ? Math.round(d.voiceMinutes * 0.7) : 0 })),
    topMembers: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([userId, count]) => ({
      userId, name: nameOf(userId), avatarUrl: null, messages: Math.round(count * (share / Math.max(1, authors.length))), voiceMinutes: 0,
    })),
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, messages: Math.round(Math.exp(-((hour - 21) ** 2) / 14) * share / 60) })),
    recentMessages: authors.slice(0, 8).map((m) => ({ id: m.id, authorId: m.authorId, authorName: m.author.displayName, content: m.content, createdAt: m.createdAt })),
  };
}

export function registerAnalyticsRoutes(): void {
  const base = '/api/dashboard/guilds/:guildId/analytics';
  route('GET', base, ({ query }) => fullAnalytics(periodOf(query)));
  route('GET', `${base}/activity`, ({ query }) => activity(periodOf(query)));
  route('GET', `${base}/content`, ({ query }) => content(periodOf(query), query));
  route('GET', `${base}/channel-tree`, ({ query }) => channelTree(periodOf(query)));
  route('GET', `${base}/categories/:categoryId`, ({ params, query }) => categoryDetail(params.categoryId, periodOf(query)));
  route('GET', `${base}/filters`, () => filterOptions());
  route('GET', `${base}/heatmap`, () => heatmap());
  route('GET', `${base}/weekly-comparison`, ({ query }) => weekly(Number(query.get('offset')) || 1, query.get('mode') ?? 'week'));
  route('GET', `${base}/growth-retention`, ({ query }) => growth(periodOf(query)));
  route('GET', `${base}/daily-algo`, ({ query }) => dailyAlgo(periodOf(query)));
  route('GET', `${base}/interactions`, () => interactions());
  route('GET', `${base}/advanced`, ({ query }) => advanced(query.get('section') ?? ''));
  route('GET', `${base}/members`, ({ query }) => memberDetailed(query.get('userId') ?? '', Number(query.get('period')) || 30));
  route('GET', `${base}/invites`, () => inviteAnalytics());
  route('GET', `${base}/channels/:channelId`, ({ params, query }) => channelDetail(params.channelId, Number(query.get('days')) || 30));
  route('GET', `${base}/correlation`, () => ({
    data: memberTotals(30).filter((t) => t.messages || t.voiceMinutes).map((t) => ({ userId: t.person.id, messages: t.messages, voice: t.voiceMinutes })),
  }));
  route('POST', `${base}/rescan-members`, () => ({ success: true, started: true, status: 'IN_PROGRESS' }));

}
