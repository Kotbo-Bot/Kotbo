/**
 * Analytics avancées de la démo : séries enrichies, pas horaire, classements,
 * ventilation par salon, annotations. Formes reprises de
 * `activityInsightsService` côté bot. Déclarées avant `registerAnalyticsRoutes`
 * : la route /activity enrichie passe devant l'ancienne.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { channelMessages, dateKey, memberSeries, memberTotals, serverSeries, voiceChannelMinutes, CHANNEL_SHARE, VOICE_SHARE } from '../activity';
import { CATEGORIES, CHANNELS, MEMBERS, VOICE_CHANNELS, avatarOf, sessionUser } from '../fixtures';
import { CATEGORY_OF, heatmap } from './analytics';

const DAY_MS = 86_400_000;
const sum = <T>(list: T[], pick: (item: T) => number) => list.reduce((s, item) => s + pick(item), 0);

export function periodOf(query: URLSearchParams): number {
  const start = query.get('startDate');
  const end = query.get('endDate');
  if (start) {
    const days = Math.ceil((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / DAY_MS);
    return Math.min(365, Math.max(1, days));
  }
  return Math.min(365, Math.max(1, Number(query.get('period') || query.get('days')) || 30));
}

const range = (days: number) => ({ start: dateKey(days - 1), end: dateKey(0), prevStart: dateKey(days * 2 - 1), prevEnd: dateKey(days), days });

export function bucketize(values: number[], max = 30): number[] {
  if (values.length <= max) return values;
  const size = Math.ceil(values.length / max);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) out.push(sum(values.slice(i, i + size), (v) => v));
  return out;
}

// ── Activité enrichie ──────────────────────────────────────────────────

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function anomalies(days: number) {
  const history = serverSeries(days + 28);
  const out: Array<Record<string, unknown>> = [];
  for (const metric of ['messages', 'voiceMinutes'] as const) {
    for (let i = 28; i < history.length; i += 1) {
      const ref = [7, 14, 21, 28].map((lag) => history[i - lag]![metric]);
      const expected = median(ref);
      const value = history[i]![metric];
      if (value >= expected * 1.45 && value - expected > 40) {
        out.push({
          dateKey: history[i]!.dateKey, metric, value, expected: Math.round(expected), direction: 'up',
          driver: metric === 'messages' ? { channelId: CHANNELS[3]!.id, name: 'général', share: 58.4 } : { channelId: VOICE_CHANNELS[0]!.id, name: 'Squad', share: 81.2 },
        });
      }
    }
  }
  return out.slice(-6);
}

function activity(days: number) {
  const current = serverSeries(days);
  const previous = serverSeries(days, days);
  const totals = memberTotals(days);
  const active = totals.filter((t) => t.activeDays > 0).length;
  return {
    range: range(days),
    voiceAvailable: true,
    joinsFiltered: false,
    kpis: {
      messages: { value: sum(current, (d) => d.messages), previous: sum(previous, (d) => d.messages) },
      activeMembers: { value: active, previous: Math.round(active * 0.92) },
      voiceMinutes: { value: sum(current, (d) => d.voiceMinutes), previous: sum(previous, (d) => d.voiceMinutes) },
      netJoins: { value: sum(current, (d) => d.membersJoined - d.membersLeft), previous: sum(previous, (d) => d.membersJoined - d.membersLeft) },
      joined: sum(current, (d) => d.membersJoined),
      left: sum(current, (d) => d.membersLeft),
      memberCount: MEMBERS.length,
    },
    series: current.map((d, i) => {
      const p = previous[i];
      return {
        dateKey: d.dateKey,
        messages: d.messages,
        voiceMinutes: d.voiceMinutes,
        prevMessages: p?.messages ?? 0,
        prevVoiceMinutes: p?.voiceMinutes ?? 0,
        activeMembers: d.activeMembers,
        prevActiveMembers: p?.activeMembers ?? 0,
        joined: d.membersJoined,
        left: d.membersLeft,
        prevJoined: p?.membersJoined ?? 0,
        prevLeft: p?.membersLeft ?? 0,
      };
    }),
    topChannels: channelMessages(days).map((c) => ({ channelId: c.channel.id, name: c.channel.name, messages: c.messages })),
    anomalies: anomalies(days),
  };
}

/** Forme d'une journée : calme la nuit, pic en soirée. */
const HOUR_SHAPE = [2, 1, 1, 0.5, 0.5, 0.5, 1, 2, 3, 4, 4, 5, 6, 5, 5, 5, 6, 7, 8, 9, 10, 9, 6, 4];
const SHAPE_TOTAL = HOUR_SHAPE.reduce((s, v) => s + v, 0);

function hourly(days: number) {
  if (days > 14) return { available: false, timezone: 'Europe/Paris', points: [], prev: [] };
  const nowHour = new Date().getHours();
  const build = (series: ReturnType<typeof serverSeries>, cut: boolean) =>
    series.flatMap((d, di) =>
      HOUR_SHAPE.map((w, h) => ({
        key: `${d.dateKey} ${String(h).padStart(2, '0')}`,
        messages: Math.round((d.messages * w) / SHAPE_TOTAL),
        voiceMinutes: Math.round((d.voiceMinutes * w) / SHAPE_TOTAL),
        activeMembers: Math.round((d.activeMembers * Math.min(1, w / 6)) * 0.6),
      })).filter((_, h) => !cut || di < series.length - 1 || h <= nowHour),
    );
  const points = build(serverSeries(days), true);
  return { available: true, timezone: 'Europe/Paris', points, prev: build(serverSeries(days, days), false).slice(0, points.length) };
}

// ── Classements ────────────────────────────────────────────────────────

function rankings(days: number, metric: 'messages' | 'voice', dimension: 'members' | 'channels', limit: number) {
  if (dimension === 'members') {
    const field = metric === 'messages' ? 'messages' : 'voiceMinutes';
    const now = memberTotals(days).filter((t) => t[field] > 0).sort((a, b) => b[field] - a[field]);
    const before = new Map(memberTotals(days * 2).map((t) => [t.person.id, t[field]]));
    const total = sum(now, (t) => t[field]);
    const items = now.slice(0, limit).map((t) => ({
      id: t.person.id,
      name: t.person.displayName,
      avatarUrl: avatarOf(t.person),
      value: t[field],
      previous: Math.max(0, (before.get(t.person.id) ?? 0) - t[field]),
      share: total > 0 ? Math.round((t[field] / total) * 1000) / 10 : 0,
      spark: bucketize(memberSeries(t.person, days).map((d) => d[field])),
    }));
    return { available: true, metric, dimension, total, prevTotal: Math.round(total * 0.93), items };
  }
  const rows = metric === 'messages'
    ? channelMessages(days).map((c) => ({ channel: c.channel, value: c.messages, share: CHANNEL_SHARE[c.channel.name] ?? 0 }))
    : voiceChannelMinutes(days).map((c) => ({ channel: c.channel, value: c.minutes, share: VOICE_SHARE[c.channel.name] ?? 0 }));
  const before = metric === 'messages' ? channelMessages(days * 2) : [];
  const total = sum(rows, (r) => r.value);
  const daily = serverSeries(days).map((d) => (metric === 'messages' ? d.messages : d.voiceMinutes));
  const items = rows.filter((r) => r.value > 0).slice(0, limit).map((r) => {
    const prevTotal = metric === 'messages' ? (before.find((b) => b.channel.id === r.channel.id)?.messages ?? 0) - r.value : Math.round(r.value * 0.9);
    return {
      id: r.channel.id,
      name: r.channel.name,
      avatarUrl: null,
      value: r.value,
      previous: Math.max(0, prevTotal),
      share: total > 0 ? Math.round((r.value / total) * 1000) / 10 : 0,
      spark: bucketize(daily.map((v) => Math.round(v * r.share))),
    };
  });
  return { available: true, metric, dimension, total, prevTotal: Math.round(total * 0.93), items };
}

function breakdown(days: number, metric: 'messages' | 'voice', dimension: 'channel' | 'category') {
  const series = serverSeries(days);
  const shares = metric === 'messages' ? CHANNEL_SHARE : VOICE_SHARE;
  const channels = metric === 'messages' ? CHANNELS : VOICE_CHANNELS;
  const daily = series.map((d) => (metric === 'messages' ? d.messages : d.voiceMinutes));
  const groups = new Map<string, { id: string; name: string; values: number[] }>();
  for (const c of channels) {
    const share = shares[c.name] ?? 0;
    if (share <= 0) continue;
    const key = dimension === 'channel' ? c.id : (CATEGORY_OF[c.name] ?? 'none');
    const cat = CATEGORIES.find((x) => x.name === key);
    const group = groups.get(key) ?? { id: dimension === 'channel' ? c.id : (cat?.id ?? key), name: dimension === 'channel' ? c.name : key, values: daily.map(() => 0) };
    daily.forEach((v, i) => { group.values[i] = (group.values[i] ?? 0) + Math.round(v * share); });
    groups.set(key, group);
  }
  const ordered = [...groups.values()].map((g) => ({ ...g, total: sum(g.values, (v) => v) })).sort((a, b) => b.total - a.total);
  const other = daily.map(() => 0);
  for (const g of ordered.slice(5)) g.values.forEach((v, i) => { other[i] = (other[i] ?? 0) + v; });
  return { available: true, dates: series.map((d) => d.dateKey), groups: ordered.slice(0, 5), other };
}


// ── Membres et rétention ───────────────────────────────────────────────

function engagement(days: number) {
  const step = days > 92 ? 7 : 1;
  const point = (daysAgo: number) => {
    const d = serverSeries(1, daysAgo)[0]!;
    const week = sum(serverSeries(7, daysAgo), (x) => x.activeMembers);
    const month = sum(serverSeries(30, daysAgo), (x) => x.activeMembers);
    return { dau: d.activeMembers, wau: Math.round(week * 0.42), mau: Math.round(month * 0.16) };
  };
  const points = [];
  for (let i = days - 1; i >= 0; i -= step) {
    const now = point(i);
    const prev = point(i + days);
    points.push({ dateKey: dateKey(i), ...now, prevDau: prev.dau, prevWau: prev.wau, prevMau: prev.mau });
  }
  return { range: range(days), step, channelIgnored: false, points };
}

function cohorts() {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return {
    weeks: 12,
    channelIgnored: false,
    cohorts: Array.from({ length: 12 }, (_, wi) => {
      const week = new Date(monday.getTime() - (11 - wi) * 7 * DAY_MS).toISOString().slice(0, 10);
      const size = 14 + ((wi * 7) % 11);
      return {
        week,
        size,
        retention: Array.from({ length: 12 }, (_, offset) =>
          offset >= 12 - wi ? null : Math.round((offset === 0 ? 78 : 52 * Math.pow(0.86, offset) + (wi % 3) * 2) * 10) / 10),
      };
    }),
  };
}

function funnelSteps(joined: number, quality: number) {
  return {
    joined,
    stayed: Math.round(joined * (0.7 + quality * 0.2)),
    firstMessage: Math.round(joined * (0.45 + quality * 0.3)),
    eligible7: Math.round(joined * 0.8),
    active7: Math.round(joined * 0.8 * (0.25 + quality * 0.3)),
    eligible30: Math.round(joined * 0.5),
    active30: Math.round(joined * 0.5 * (0.12 + quality * 0.25)),
    medianDaysToFirstMessage: quality > 0.5 ? 0 : 2,
  };
}

function funnel(days: number) {
  const joined = sum(serverSeries(days), (d) => d.membersJoined);
  const parts = [
    { key: 'code:nova', label: 'nova (Arka)', kind: 'code', share: 0.42, quality: 0.7 },
    { key: 'label:TikTok', label: 'TikTok', kind: 'label', share: 0.24, quality: 0.25 },
    { key: 'code:lina-et-cie', label: 'lina-et-cie (Lina)', kind: 'code', share: 0.14, quality: 0.8 },
    { key: 'label:Partenaires', label: 'Partenaires', kind: 'label', share: 0.1, quality: 0.55 },
    { key: 'unknown', label: null, kind: 'unknown', share: 0.1, quality: 0.3 },
  ];
  return {
    range: range(days),
    channelIgnored: false,
    overall: funnelSteps(joined, 0.55),
    bySource: parts.map((p) => ({ key: p.key, label: p.label, kind: p.kind, ...funnelSteps(Math.max(1, Math.round(joined * p.share)), p.quality) })),
  };
}

function lifecycle(days: number) {
  const humans = MEMBERS.filter((p) => !p.bot);
  const totals = memberTotals(28);
  const segOf = (activeDays: number, i: number) =>
    i % 17 === 0 ? 'new' : i % 13 === 0 ? 'reactivated' : i % 11 === 0 ? 'declining' : activeDays >= 8 ? 'regular' : activeDays >= 1 ? 'casual' : i % 2 ? 'dormant' : 'silent';
  const counts: Record<string, number> = { new: 0, regular: 0, casual: 0, reactivated: 0, declining: 0, dormant: 0, silent: 0 };
  const lists: Record<string, Array<Record<string, unknown>>> = { new: [], reactivated: [], declining: [], dormant: [] };
  humans.forEach((person, i) => {
    const t = totals.find((x) => x.person.id === person.id);
    const seg = segOf(t?.activeDays ?? 0, i);
    counts[seg]! += 1;
    lists[seg]?.push({
      userId: person.id, name: person.displayName, avatarUrl: avatarOf(person),
      lastActive: dateKey(seg === 'dormant' ? 35 + (i % 40) : i % 5),
      recentDays: seg === 'dormant' ? 0 : (t?.activeDays ?? 1),
      previousDays: seg === 'declining' ? 14 + (i % 6) : seg === 'dormant' ? 6 + (i % 9) : 3,
      joinedAt: new Date(Date.now() - (seg === 'new' ? i % 13 : 120 + i) * DAY_MS).toISOString(),
    });
  });
  const prevCounts = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.max(0, v + (k === 'declining' ? -3 : k === 'regular' ? 2 : k === 'new' ? -1 : 0))]));
  return {
    asOf: dateKey(0),
    prevAsOf: dateKey(days),
    channelIgnored: false,
    counts,
    prevCounts,
    transitions: [
      { from: 'regular', to: 'declining', count: 4 },
      { from: 'casual', to: 'regular', count: 3 },
      { from: 'new', to: 'casual', count: 3 },
      { from: 'dormant', to: 'reactivated', count: 2 },
      { from: 'casual', to: 'dormant', count: 2 },
    ],
    lists,
  };
}


// ── Salons et conversation ─────────────────────────────────────────────

function responseSummary(turns: number, medianSec: number, unansweredShare: number) {
  const unanswered = Math.round(turns * unansweredShare);
  const answered = turns - unanswered;
  const split = [0.34, 0.31, 0.16, 0.12, 0.07].map((w) => Math.round(answered * w));
  return {
    turns, answered, unanswered,
    unansweredRate: turns > 0 ? Math.round((unanswered / turns) * 1000) / 10 : null,
    medianSec, avgSec: Math.round(medianSec * 2.4),
    buckets: (['under1m', 'under5m', 'under15m', 'under1h', 'under6h'] as const).map((key, i) => ({ key, count: split[i] ?? 0 })),
  };
}

function responses(days: number) {
  const series = serverSeries(days);
  const turnsOf = (messages: number) => Math.round(messages / 3.1);
  const total = turnsOf(sum(series, (d) => d.messages));
  const channels = channelMessages(days).filter((c) => !['logs', 'règlement'].includes(c.channel.name)).map((c, i) => ({
    channelId: c.channel.id,
    name: c.channel.name,
    ...responseSummary(turnsOf(c.messages), [95, 140, 260, 420, 610, 900, 1500, 2400][i] ?? 1800, [0.08, 0.12, 0.18, 0.22, 0.3, 0.35, 0.42, 0.5][i] ?? 0.5),
  }));
  return {
    range: range(days),
    userIgnored: false,
    total: responseSummary(total, 160, 0.14),
    previous: responseSummary(Math.round(total * 0.94), 185, 0.16),
    daily: series.map((d, i) => ({ dateKey: d.dateKey, medianSec: 120 + ((i * 37) % 90), unansweredRate: 10 + ((i * 13) % 9), turns: turnsOf(d.messages) })),
    channels,
  };
}

function concentrationStats(values: number[]) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => b - a);
  const total = sum(sorted, (v) => v);
  const n = sorted.length;
  const top = (k: number) => (total > 0 ? Math.round((sum(sorted.slice(0, k), (v) => v) / total) * 1000) / 10 : 0);
  let acc = 0;
  let half = 0;
  for (const v of sorted) { acc += v; half += 1; if (acc >= total / 2) break; }
  const asc = [...sorted].reverse();
  const lorenz = [{ members: 0, activity: 0 }];
  for (let step = 1; step <= 20; step += 1) {
    const upto = Math.round((n * step) / 20);
    lorenz.push({ members: step * 5, activity: total > 0 ? Math.round((sum(asc.slice(0, upto), (v) => v) / total) * 1000) / 10 : 0 });
  }
  let weighted = 0;
  asc.forEach((v, i) => { weighted += (i + 1) * v; });
  const g = n > 1 && total > 0 ? Math.round(((2 * weighted) / (n * total) - (n + 1) / n) * 1000) / 1000 : 0;
  return { members: n, total, top1Share: top(Math.max(1, Math.ceil(n * 0.01))), top10Share: top(Math.max(1, Math.ceil(n * 0.1))), top10MembersShare: top(10), membersForHalf: half, gini: g, lorenz };
}

function concentration(days: number, metric: 'messages' | 'voice') {
  const field = metric === 'messages' ? 'messages' : 'voiceMinutes';
  return {
    available: true,
    metric,
    current: concentrationStats(memberTotals(days).map((t) => t[field])),
    previous: concentrationStats(memberTotals(days * 2).map((t) => Math.round(t[field] * 0.5))),
  };
}

function channelHealthReport(days: number) {
  const msgs = channelMessages(days);
  const rows = CHANNELS.map((c, i) => {
    const messages = msgs.find((x) => x.channel.id === c.id)?.messages ?? 0;
    const prevMessages = c.name === 'boutique' ? Math.round(messages * 2.1) : c.name === 'suggestions' ? Math.round(messages * 0.6) : Math.round(messages * 0.93);
    const status = messages === 0 ? 'dead' : c.name === 'boutique' ? 'declining' : c.name === 'suggestions' ? 'growing' : messages / days < 2 ? 'quiet' : 'healthy';
    const suggestion = status === 'dead' ? 'archive' : status === 'declining' ? 'revive' : status === 'quiet' && messages < 10 ? 'merge' : null;
    return {
      channelId: c.id, name: c.name, categoryId: null, categoryName: CATEGORY_OF[c.name] ?? null,
      messages, prevMessages, authors: Math.round(Math.sqrt(messages) * 1.6), days,
      lastActiveDaysAgo: messages > 0 ? 0 : 40 + i, lastActiveDate: messages > 0 ? dateKey(0) : dateKey(40 + i),
      medianResponseSec: messages > 0 ? 90 + i * 80 : null, unansweredRate: messages > 0 ? 6 + i * 3 : null,
      status, score: status === 'dead' ? 0 : Math.min(96, Math.round(20 + Math.log10(1 + messages / days) * 32 + (status === 'growing' ? 10 : 0))), suggestion,
    };
  });
  return { range: range(days), channels: rows.sort((a, b) => a.score - b.score) };
}

function network(days: number) {
  const people = memberTotals(days).filter((t) => t.messages > 0).slice(0, 40);
  const who = (t: (typeof people)[number]) => ({ userId: t.person.id, name: t.person.displayName, avatarUrl: avatarOf(t.person) });
  const groupA = people.slice(0, 12);
  const groupB = people.slice(12, 22);
  const groupC = people.slice(22, 28);
  return {
    range: range(days),
    channelIgnored: false,
    totals: { members: 28, links: 74, replies: 1_240, mentions: 610, reciprocity: 63.5, activeMembers: people.length, isolatedCount: Math.max(0, people.length - 28) },
    groups: [
      { id: 'g1', size: groupA.length, internalWeight: 1_820, leaders: groupA.slice(0, 5).map(who) },
      { id: 'g2', size: groupB.length, internalWeight: 760, leaders: groupB.slice(0, 5).map(who) },
      { id: 'g3', size: groupC.length, internalWeight: 240, leaders: groupC.slice(0, 5).map(who) },
    ],
    bridges: [people[1], people[13], people[4]].filter(Boolean).map((t, i) => ({ ...who(t!), groups: 3 - Math.min(1, i), outsideWeight: 48 - i * 12 })),
    pairs: people.slice(0, 8).map((t, i) => ({ a: who(t), b: who(people[(i + 3) % people.length]!), replies: 140 - i * 14, mentions: 60 - i * 6, reciprocal: i % 3 !== 2 })),
    isolated: people.slice(28, 40).map((t) => ({ ...who(t), messages: t.messages })),
  };
}


// ── Analyses par section ───────────────────────────────────────────────

function growthInsights(days: number) {
  const series = serverSeries(days);
  const joined = sum(series, (d) => d.membersJoined);
  const left = sum(series, (d) => d.membersLeft);
  const shares = [0.42, 0.24, 0.14, 0.1];
  const labels: Array<[string, 'code' | 'label' | 'vanity' | 'unknown', string | null]> = [
    ['code:nova (Arka)', 'code', 'nova (Arka)'], ['label:TikTok', 'label', 'TikTok'], ['code:lina-et-cie (Lina)', 'code', 'lina-et-cie (Lina)'], ['unknown', 'unknown', null],
  ];
  const groups = labels.map(([key, kind, label], i) => {
    const values = series.map((d) => Math.round(d.membersJoined * shares[i]!));
    return { key, kind, label, total: sum(values, (v) => v), values };
  });
  return {
    range: range(days),
    departures: {
      total: left, unknownTenure: 0, byTenure: [
        { key: 'under1d', count: Math.round(left * 0.22) }, { key: 'under7d', count: Math.round(left * 0.26) },
        { key: 'under30d', count: Math.round(left * 0.21) }, { key: 'under180d', count: Math.round(left * 0.19) }, { key: 'over180d', count: Math.round(left * 0.12) },
      ]
    },
    quickLeave: { joined, left24h: Math.round(joined * 0.09), rate: 9.1, previousRate: 11.4 },
    sources: { dates: series.map((d) => d.dateKey), groups, other: series.map((d) => Math.round(d.membersJoined * 0.1)) },
  };
}

function moderationTrends(days: number) {
  const series = serverSeries(days);
  const types = [['WARN', 0.55], ['TIMEOUT', 0.25], ['KICK', 0.08], ['BAN', 0.12]] as const;
  const mods = MEMBERS.filter((p) => !p.bot).slice(1, 5);
  const total = sum(series, (d) => d.sanctions) * 3;
  return {
    range: range(days),
    total,
    previousTotal: Math.round(total * 1.15),
    byType: {
      dates: series.map((d) => d.dateKey), series: types.map(([type, w]) => {
        const values = series.map((d, i) => Math.round(d.sanctions * 3 * w + ((i * 7) % 3 === 0 ? 1 : 0)));
        return { type, total: sum(values, (v) => v), values };
      })
    },
    moderators: mods.map((p, i) => {
      const count = Math.round(total * [0.42, 0.28, 0.18, 0.12][i]!);
      return { userId: p.id, name: p.displayName, count, previous: Math.round(count * 1.1), types: { WARN: Math.round(count * 0.6), TIMEOUT: Math.round(count * 0.3), BAN: Math.round(count * 0.1) }, share: [42, 28, 18, 12][i]! };
    }),
    recidivism: {
      sanctioned: Math.round(total * 0.7), repeat: Math.round(total * 0.12), rate: 17.1, previousRate: 19.8,
      offenders: MEMBERS.filter((p) => !p.bot).slice(30, 36).map((p, i) => ({ userId: p.id, name: p.displayName, count: 4 - Math.min(2, i), last: dateKey(i * 3) + 'T12:00:00.000Z' })),
    },
    reportDelay: { reports: 18, medianSec: 2_700 },
  };
}

function staffInsights(days: number) {
  const opened = Math.round(days * 1.8);
  const staff = MEMBERS.filter((p) => !p.bot).slice(1, 6);
  return {
    range: range(days),
    timezone: 'Europe/Paris',
    measuredSince: true,
    tickets: {
      opened, previousOpened: Math.round(opened * 0.9), responded: Math.round(opened * 0.94),
      firstResponseMedianSec: 1_380, previousFirstResponseMedianSec: 1_920, within1h: 71.4,
      resolutionMedianSec: 5 * 3600, previousResolutionMedianSec: 6.5 * 3600, unresolved: 4,
    },
    staff: staff.map((p, i) => ({ userId: p.id, name: p.displayName, claimed: Math.round(opened * [0.34, 0.26, 0.2, 0.12, 0.08][i]!), closed: Math.round(opened * [0.3, 0.27, 0.2, 0.14, 0.09][i]!), firstResponses: Math.round(opened * [0.32, 0.28, 0.2, 0.12, 0.08][i]!), firstResponseMedianSec: [600, 1_100, 1_500, 2_600, 4_100][i]!, share: [34, 26, 20, 12, 8][i]! })),
    coverage: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
      const busy = HOUR_SHAPE[h]! / 10;
      const n = Math.round(busy * (d >= 5 ? 1.6 : 1.1) * (days / 30) * 1.5);
      return { opened: n, medianSec: n === 0 ? null : h < 9 ? 3 * 3600 + h * 600 : h >= 23 ? 2 * 3600 : 900 + ((d * 24 + h) % 5) * 300 };
    })),
  };
}

function risingWords() {
  const w = (word: string, count: number, previous: number) => ({ word, count, previous, change: previous > 0 ? Math.round(((count - previous) / previous) * 1000) / 10 : null });
  return {
    range: range(30),
    enabled: true,
    hasData: true,
    rising: [w('tournoi', 184, 41), w('saison', 122, 50), w('ranked', 96, 44), w('patch', 88, 39), w('équipe', 77, 41), w('stream', 64, 30)],
    fresh: [w('halloween', 58, 0), w('quiz', 33, 0), w('nova-cup', 21, 0)],
    falling: [w('été', 12, 70), w('vacances', 9, 52), w('bug', 31, 74), w('maintenance', 6, 28)],
  };
}


// ── Alertes et rapports ────────────────────────────────────────────────

const ALERTS = 'analytics-alerts';
const REPORTS = 'analytics-reports';
const alertsSeed = () => ({
  rules: [
    { id: '9200000000000000001', name: "Baisse d'activité", metric: 'messages', condition: 'drop_pct', threshold: 30, window: 'day', channelId: null, notifyChannelId: CHANNELS[8]!.id, notifyUserIds: [], enabled: true, cooldownHours: 24, lastTriggeredAt: new Date(Date.now() - 12 * DAY_MS).toISOString(), createdById: MEMBERS[1]!.id, createdAt: new Date(Date.now() - 40 * DAY_MS).toISOString() },
    { id: '9200000000000000002', name: '#général qui s’emballe', metric: 'channelRate', condition: 'above', threshold: 250, window: 'hour', channelId: CHANNELS[3]!.id, notifyChannelId: null, notifyUserIds: [MEMBERS[1]!.id], enabled: true, cooldownHours: 2, lastTriggeredAt: null, createdById: MEMBERS[1]!.id, createdAt: new Date(Date.now() - 10 * DAY_MS).toISOString() },
  ],
  events: [
    { id: '9210000000000000001', ruleId: '9200000000000000001', periodKey: dateKey(12), value: 412, baseline: 760, delivered: true, triggeredAt: new Date(Date.now() - 12 * DAY_MS).toISOString() },
  ],
});
const reportsSeed = () => ({
  schedules: [
    { id: '9220000000000000001', frequency: 'weekly', weekday: 1, monthDay: 1, hour: 9, channelId: CHANNELS[8]!.id, userIds: [], sections: ['overview', 'top_members', 'top_channels', 'anomalies'], enabled: true, nextRunAt: new Date(Date.now() + 2 * DAY_MS).toISOString(), lastSentAt: new Date(Date.now() - 5 * DAY_MS).toISOString() },
  ],
});

const VIEWS = 'analytics-views';
const viewsSeed = () => [
  { id: '9230000000000000001', name: 'Rétention du mois', payload: { tab: 'lifecycle', period: '30', compare: true, channel: null, role: null, excludeStaff: true, includeBots: false }, shared: true, mine: false, createdAt: new Date(Date.now() - 8 * DAY_MS).toISOString() },
];


// ── Membres, heures de pointe, comparaison, commandes ──────────────────

function memberOverview(days: number) {
  const cur = serverSeries(days);
  const prev = serverSeries(days, days);
  let members = MEMBERS.length - sum(cur, (d) => d.membersJoined - d.membersLeft);
  let prevMembers = members - sum(prev, (d) => d.membersJoined - d.membersLeft);
  const series = cur.map((d, i) => {
    const p = prev[i]!;
    members += d.membersJoined - d.membersLeft;
    prevMembers += p.membersJoined - p.membersLeft;
    return {
      dateKey: d.dateKey, members, joined: d.membersJoined, left: d.membersLeft, peakOnline: d.peakOnline, onlineMembers: d.onlineMembers,
      prevMembers, prevJoined: p.membersJoined, prevLeft: p.membersLeft, prevPeakOnline: p.peakOnline, prevOnlineMembers: p.onlineMembers,
    };
  });
  const joined = sum(cur, (d) => d.membersJoined);
  const people = MEMBERS.filter((p) => !p.bot);
  return {
    range: range(days),
    memberCount: MEMBERS.length,
    series,
    sources: {
      tracked: Math.round(joined * 0.9),
      kinds: [
        { kind: 'invite', joined: Math.round(joined * 0.52), retention: 78.4 },
        { kind: 'label', joined: Math.round(joined * 0.24), retention: 51.2 },
        { kind: 'vanity', joined: Math.round(joined * 0.06), retention: 70 },
        { kind: 'unknown', joined: Math.round(joined * 0.08), retention: 44.1 },
      ],
      links: [
        { code: 'nova', label: null, inviterId: people[1]!.id, inviterTag: people[1]!.displayName, joined: Math.round(joined * 0.4), stayed: Math.round(joined * 0.32), retention: 80, isVanity: false },
        { code: 'tiktok-oct', label: 'TikTok', inviterId: people[3]!.id, inviterTag: people[3]!.displayName, joined: Math.round(joined * 0.24), stayed: Math.round(joined * 0.12), retention: 51.2, isVanity: false },
        { code: 'lina-et-cie', label: null, inviterId: people[2]!.id, inviterTag: people[2]!.displayName, joined: Math.round(joined * 0.12), stayed: Math.round(joined * 0.1), retention: 83.3, isVanity: false },
      ],
    },
    inviters: people.slice(1, 7).map((p, i) => ({
      userId: p.id, name: p.displayName, avatarUrl: avatarOf(p),
      joined: Math.max(1, Math.round(joined * [0.38, 0.2, 0.12, 0.08, 0.05, 0.03][i]!)),
      previous: Math.max(0, Math.round(joined * [0.3, 0.22, 0.1, 0.09, 0.02, 0.04][i]!)),
      stayed: 0, retention: [81, 52, 84, 66, 90, 40][i]!, left24h: [1, 4, 0, 1, 0, 2][i]!,
    })),
    newcomers: {
      joined,
      accountAge: {
        known: joined, buckets: [
          { key: 'under1d', count: Math.round(joined * 0.04) }, { key: 'under7d', count: Math.round(joined * 0.07) },
          { key: 'under30d', count: Math.round(joined * 0.12) }, { key: 'under365d', count: Math.round(joined * 0.27) }, { key: 'over365d', count: Math.round(joined * 0.5) },
        ]
      },
      onboarding: { completed: Math.round(joined * 0.83), rate: 83 },
      left24h: { count: Math.round(joined * 0.09), rate: 9.1 },
    },
  };
}

function heatmapComparison(days: number) {
  return {
    current: heatmap(31),
    previous: heatmap(47),
    timezone: 'Europe/Paris',
    range: { start: dateKey(days - 1), end: dateKey(0), prevStart: dateKey(days * 2 - 1), prevEnd: dateKey(days) },
  };
}

function periodComparison(offset: number, mode: string) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const keyAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let curStart: number;
  let curEnd: number;
  let prevStart: number;
  let prevEnd: number;
  if (mode === 'month') {
    curStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    curEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
    prevStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1);
    prevEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 0);
  } else {
    curStart = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
    curEnd = curStart + 6 * DAY_MS;
    prevStart = curStart - 7 * offset * DAY_MS;
    prevEnd = prevStart + 6 * DAY_MS;
  }
  const elapsed = Math.round((today - curStart) / DAY_MS) + 1;
  const length = Math.max(Math.round((curEnd - curStart) / DAY_MS), Math.round((prevEnd - prevStart) / DAY_MS)) + 1;
  const dayOf = (ms: number) => {
    const daysAgo = Math.round((today - ms) / DAY_MS);
    const d = serverSeries(1, daysAgo)[0]!;
    return { messages: d.messages, voiceMinutes: d.voiceMinutes, joins: d.membersJoined, leaves: d.membersLeft, sanctions: d.sanctions, activeMembers: d.activeMembers, peakOnline: d.peakOnline };
  };
  const daily = Array.from({ length }, (_, i) => {
    const c = curStart + i * DAY_MS;
    const p = prevStart + i * DAY_MS;
    return {
      index: i,
      currentKey: c <= curEnd ? keyAt(c) : null,
      previousKey: p <= prevEnd ? keyAt(p) : null,
      current: c <= curEnd && c <= today ? dayOf(c) : null,
      previous: p <= prevEnd ? dayOf(p) : null,
    };
  });
  type Day = ReturnType<typeof dayOf>;
  const total = (pick: (d: (typeof daily)[number]) => Day | null, limit = length) => {
    const t = { messages: 0, voiceMinutes: 0, joins: 0, leaves: 0, sanctions: 0 };
    daily.slice(0, limit).forEach((d) => {
      const v = pick(d);
      if (!v) return;
      t.messages += v.messages;
      t.voiceMinutes += v.voiceMinutes;
      t.joins += v.joins;
      t.leaves += v.leaves;
      t.sanctions += v.sanctions;
    });
    return t;
  };
  const thisWeek = total((d) => d.current);
  const lastWeek = total((d) => d.previous);
  const lastWeekToDate = total((d) => d.previous, elapsed);
  const change = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100));
  const changes = (a: typeof thisWeek, b: typeof thisWeek) => ({
    messagesChange: change(a.messages, b.messages),
    voiceChange: change(a.voiceMinutes, b.voiceMinutes),
    joinsChange: change(a.joins, b.joins),
    leavesChange: change(a.leaves, b.leaves),
    sanctionsChange: change(a.sanctions, b.sanctions),
  });
  return {
    mode,
    offset,
    ranges: {
      current: { start: keyAt(curStart), end: keyAt(curEnd), elapsedDays: elapsed },
      previous: { start: keyAt(prevStart), end: keyAt(prevEnd), toDateEnd: keyAt(prevStart + (elapsed - 1) * DAY_MS) },
    },
    thisWeek,
    lastWeek,
    lastWeekToDate,
    activeMembers: { current: Math.round(thisWeek.messages / 9), previousToDate: Math.round(lastWeekToDate.messages / 9.4) },
    changes: changes(thisWeek, lastWeek),
    changesToDate: changes(thisWeek, lastWeekToDate),
    daily,
  };
}

const DEMO_COMMANDS: Array<[string, number]> = [
  ['rank', 0.24], ['daily', 0.18], ['rpg profil', 0.12], ['rpg combat', 0.1], ['ticket ouvrir', 0.06], ['leaderboard', 0.08],
  ['shop acheter', 0.07], ['giveaway participer', 0.05], ['quiz', 0.04], ['sanction warn', 0.03], ['help', 0.03],
];

function commandStats(days: number) {
  const cur = serverSeries(days);
  const prev = serverSeries(days, days);
  const daily = cur.map((d, i) => ({ dateKey: d.dateKey, uses: Math.round(d.messages * 0.21), previous: Math.round((prev[i]?.messages ?? 0) * 0.19) }));
  const uses = sum(daily, (d) => d.uses);
  const people = MEMBERS.filter((p) => !p.bot);
  return {
    range: range(days),
    totals: { uses, previousUses: sum(daily, (d) => d.previous), users: Math.round(people.length * 0.55), previousUsers: Math.round(people.length * 0.5), commands: DEMO_COMMANDS.length, errorRate: 1.4, avgMs: 420 },
    daily,
    commands: DEMO_COMMANDS.map(([name, share], i) => ({
      name,
      uses: Math.round(uses * share),
      previous: Math.round(uses * share * (i % 3 === 0 ? 0.8 : 1.1)),
      users: Math.round(people.length * share * 2.2) + 1,
      share: Math.round(share * 1000) / 10,
      errorRate: name === 'ticket ouvrir' ? 6.2 : 0.8 + (i % 4) * 0.3,
      avgMs: 180 + i * 90,
      spark: bucketize(daily.map((d) => Math.round(d.uses * share))),
    })),
    topUsers: people.slice(0, 8).map((p, i) => ({ userId: p.id, name: p.displayName, avatarUrl: avatarOf(p), uses: Math.round((uses * 0.08) / (i + 1)) + 4, commands: 6 - Math.min(5, i) })),
    unused: ['ancien-sondage', 'event inscrire'],
    allTime: null,
  };
}

// ── Annotations ────────────────────────────────────────────────────────

const ANNOTATIONS = 'analytics-annotations';
const annotationsSeed = () => [
  { id: '9100000000000000001', dateKey: dateKey(9), label: 'Tournoi inter-serveurs', authorId: MEMBERS[1]!.id, authorName: MEMBERS[1]!.displayName, createdAt: new Date(Date.now() - 9 * DAY_MS).toISOString() },
  { id: '9100000000000000002', dateKey: dateKey(21), label: 'Partenariat avec un serveur voisin', authorId: MEMBERS[2]!.id, authorName: MEMBERS[2]!.displayName, createdAt: new Date(Date.now() - 21 * DAY_MS).toISOString() },
];

export function registerAnalyticsInsightsRoutes(): void {
  const base = '/api/dashboard/guilds/:guildId/analytics';
  const metricOf = (q: URLSearchParams) => (q.get('metric') === 'voice' ? 'voice' : 'messages');
  route('GET', `${base}/activity`, ({ query }) => activity(periodOf(query)));
  route('GET', `${base}/activity/hourly`, ({ query }) => hourly(periodOf(query)));
  route('GET', `${base}/activity/rankings`, ({ query }) =>
    rankings(periodOf(query), metricOf(query), query.get('dimension') === 'channels' ? 'channels' : 'members', Math.min(500, Number(query.get('limit')) || 10)));
  route('GET', `${base}/activity/breakdown`, ({ query }) =>
    breakdown(periodOf(query), metricOf(query), query.get('dimension') === 'category' ? 'category' : 'channel'));
  route('GET', `${base}/audience/engagement`, ({ query }) => engagement(periodOf(query)));
  route('GET', `${base}/audience/cohorts`, () => cohorts());
  route('GET', `${base}/audience/funnel`, ({ query }) => funnel(periodOf(query)));
  route('GET', `${base}/audience/lifecycle`, ({ query }) => lifecycle(periodOf(query)));
  route('GET', `${base}/conversation/responses`, ({ query }) => responses(periodOf(query)));
  route('GET', `${base}/conversation/concentration`, ({ query }) => concentration(periodOf(query), metricOf(query)));
  route('GET', `${base}/conversation/channel-health`, ({ query }) => channelHealthReport(periodOf(query)));
  route('GET', `${base}/conversation/network`, ({ query }) => network(periodOf(query)));
  route('GET', `${base}/insights/growth`, ({ query }) => growthInsights(periodOf(query)));
  route('GET', `${base}/insights/moderation`, ({ query }) => moderationTrends(periodOf(query)));
  route('GET', `${base}/insights/staff`, ({ query }) => staffInsights(periodOf(query)));
  route('GET', `${base}/insights/words`, () => risingWords());
  route('GET', `${base}/alerts`, () => demoDb.get(ALERTS, alertsSeed));
  route('POST', `${base}/alerts`, ({ body }) => {
    const rule = { ...body, id: demoId(), lastTriggeredAt: null, createdById: sessionUser().id, createdAt: new Date().toISOString() };
    demoDb.update(ALERTS, alertsSeed, (cur) => ({ ...cur, rules: [...cur.rules, rule] }));
    return rule;
  });
  route('PUT', `${base}/alerts/:id`, ({ params, body }) => {
    demoDb.update(ALERTS, alertsSeed, (cur) => ({ ...cur, rules: cur.rules.map((r) => (r.id === params.id ? { ...r, ...body } : r)) }));
    return { ok: true };
  });
  route('DELETE', `${base}/alerts/:id`, ({ params }) => {
    demoDb.update(ALERTS, alertsSeed, (cur) => ({ ...cur, rules: cur.rules.filter((r) => r.id !== params.id) }));
    return { ok: true };
  });
  route('GET', `${base}/reports`, () => demoDb.get(REPORTS, reportsSeed));
  route('POST', `${base}/reports/:id/test`, () => ({ ok: true }));
  route('POST', `${base}/reports`, ({ body }) => {
    const schedule = { ...body, id: demoId(), nextRunAt: new Date(Date.now() + 3 * DAY_MS).toISOString(), lastSentAt: null };
    demoDb.update(REPORTS, reportsSeed, (cur) => ({ schedules: [...cur.schedules, schedule] }));
    return schedule;
  });
  route('PUT', `${base}/reports/:id`, ({ params, body }) => {
    demoDb.update(REPORTS, reportsSeed, (cur) => ({ schedules: cur.schedules.map((r) => (r.id === params.id ? { ...r, ...body } : r)) }));
    return { ok: true };
  });
  route('DELETE', `${base}/reports/:id`, ({ params }) => {
    demoDb.update(REPORTS, reportsSeed, (cur) => ({ schedules: cur.schedules.filter((r) => r.id !== params.id) }));
    return { ok: true };
  });
  route('GET', `${base}/views`, () => demoDb.get(VIEWS, viewsSeed));
  route('POST', `${base}/views`, ({ body }) => {
    const view = { id: demoId(), name: String(body?.name ?? '').slice(0, 60), payload: body?.payload ?? {}, shared: body?.shared === true, mine: true, createdAt: new Date().toISOString() };
    demoDb.update(VIEWS, viewsSeed, (list) => [...list, view]);
    return view;
  });
  route('DELETE', `${base}/views/:id`, ({ params }) => {
    demoDb.update(VIEWS, viewsSeed, (list) => list.filter((v) => v.id !== params.id));
    return { ok: true };
  });
  route('GET', `${base}/members/overview`, ({ query }) => memberOverview(periodOf(query)));
  route('GET', `${base}/commands/stats`, ({ query }) => commandStats(periodOf(query)));
  route('GET', `${base}/heatmap`, ({ query }) => (query.get('compare') === '1' ? heatmapComparison(periodOf(query)) : heatmap()));
  route('GET', `${base}/weekly-comparison`, ({ query }) => periodComparison(Math.max(1, Number(query.get('offset')) || 1), query.get('mode') === 'month' ? 'month' : 'week'));
  route('GET', `${base}/annotations`, ({ query }) => {
    const start = range(periodOf(query)).start;
    return demoDb.get(ANNOTATIONS, annotationsSeed).filter((a) => a.dateKey >= start);
  });
  route('POST', `${base}/annotations`, ({ body }) => {
    const me = sessionUser();
    const id = demoId();
    demoDb.update(ANNOTATIONS, annotationsSeed, (list) => [
      ...list,
      { id, dateKey: String(body?.dateKey ?? dateKey(0)), label: String(body?.label ?? '').slice(0, 80), authorId: me.id, authorName: me.username, createdAt: new Date().toISOString() },
    ]);
    return { id };
  });
  route('DELETE', `${base}/annotations/:id`, ({ params }) => {
    demoDb.update(ANNOTATIONS, annotationsSeed, (list) => list.filter((a) => a.id !== params.id));
    return { ok: true };
  });

  const demoTagServers = [
    {
      guildId: '930000000000000001',
      name: 'Kotbo Community',
      iconUrl: null,
      tag: 'KTBO',
      badgeUrl: null,
      memberCount: 14,
      isOwnGuild: true,
      botPresent: true,
      description: 'Serveur principal de démonstration Kotbo.',
      onlineCount: 42,
    },
    {
      guildId: '930000000000000011',
      name: 'DevHub Community',
      iconUrl: null,
      tag: 'DEVH',
      badgeUrl: null,
      memberCount: 6,
      isOwnGuild: false,
      botPresent: false,
      description: 'Communauté de développeurs TypeScript, Svelte et Discord.',
      onlineCount: 128,
    },
    {
      guildId: '930000000000000012',
      name: 'Koda',
      iconUrl: null,
      tag: 'KODA',
      badgeUrl: null,
      memberCount: 4,
      isOwnGuild: false,
      botPresent: false,
      description: 'Serveur créatif et gaming.',
      onlineCount: 84,
    },
  ];

  const demoTagMembers = [
    { userId: MEMBERS[0]?.id ?? '1', name: MEMBERS[0]?.username ?? 'vantar', username: MEMBERS[0]?.username ?? 'vantar', avatarUrl: null, tag: 'DEVH', badgeUrl: null, serverId: '930000000000000011', serverName: 'DevHub Community', isOwnGuild: false, updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() },
    { userId: MEMBERS[1]?.id ?? '2', name: MEMBERS[1]?.username ?? 'kyzo', username: MEMBERS[1]?.username ?? 'kyzo', avatarUrl: null, tag: 'KTBO', badgeUrl: null, serverId: '930000000000000001', serverName: 'Kotbo Community', isOwnGuild: true, updatedAt: new Date(Date.now() - 4 * DAY_MS).toISOString() },
    { userId: MEMBERS[2]?.id ?? '3', name: MEMBERS[2]?.username ?? 'tom', username: MEMBERS[2]?.username ?? 'tom', avatarUrl: null, tag: 'KODA', badgeUrl: null, serverId: '930000000000000012', serverName: 'Koda', isOwnGuild: false, updatedAt: new Date(Date.now() - 6 * DAY_MS).toISOString() },
  ];

  route('GET', `${base}/server-tags`, () => ({
    totalMembers: MEMBERS.length,
    taggedMembers: 24,
    ownGuildTagged: 14,
    externalTagged: 10,
    untaggedMembers: Math.max(0, MEMBERS.length - 24),
    serverCount: demoTagServers.length,
    ownGuild: {
      guildId: '930000000000000001',
      name: 'Kotbo Community',
      iconUrl: null,
      tag: 'KTBO',
      badgeUrl: null,
      count: 14,
    },
    servers: demoTagServers.map((s) => ({
      guildId: s.guildId,
      name: s.name,
      iconUrl: s.iconUrl,
      tag: s.tag,
      badgeUrl: s.badgeUrl,
      memberCount: s.memberCount,
      isOwnGuild: s.isOwnGuild,
      botPresent: s.botPresent,
    })),
    members: demoTagMembers,
  }));

  route('GET', `${base}/servers/:targetGuildId`, ({ params }) => {
    const srv = demoTagServers.find((s) => s.guildId === params.targetGuildId) ?? {
      guildId: params.targetGuildId,
      name: `Serveur ${params.targetGuildId}`,
      iconUrl: null,
      tag: null,
      badgeUrl: null,
      memberCount: 0,
      isOwnGuild: false,
      botPresent: false,
      description: null,
      onlineCount: null,
    };
    const holders = demoTagMembers
      .filter((m) => m.serverId === srv.guildId)
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        username: m.username,
        avatarUrl: m.avatarUrl,
        tag: m.tag,
        badgeUrl: m.badgeUrl,
        updatedAt: m.updatedAt,
      }));
    return {
      server: {
        guildId: srv.guildId,
        name: srv.name,
        iconUrl: srv.iconUrl,
        bannerUrl: null,
        description: srv.description,
        memberCount: srv.memberCount,
        onlineCount: srv.onlineCount,
        tag: srv.tag,
        badgeUrl: srv.badgeUrl,
        isOwnGuild: srv.isOwnGuild,
        botPresent: srv.botPresent,
        source: 'demo',
      },
      tagHolders: {
        count: holders.length,
        members: holders,
      },
      assets: {
        emojis: [],
        stickers: [],
        totalUses: 0,
      },
    };
  });
}
