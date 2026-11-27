/**
 * Fenêtres de détail et recrutement : détail d'un salon (analytics), détail
 * d'une invitation, candidatures du recrutement. Formes de
 * `channelDetailService.ts`, `inviteDetailService.ts` et `recruitment.ts`.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { CATEGORIES, CHANNELS, DAY, MEMBERS, PEOPLE, VOICE_CHANNELS, ago, avatarOf, personByName, regulationSeed, role } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';
import { staffMembers } from './home';

const crowd = () => MEMBERS.filter((m) => !m.bot);
const dayKey = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

// ── Détail d'un salon ────────────────────────────────────────────────────

function channelDetail(channelId: string, days: number) {
  const known = [...CHANNELS, ...VOICE_CHANNELS].find((c) => c.id === channelId);
  const name = known?.name ?? 'général';
  const voice = known?.type === 'voice';
  const seed = [...channelId].reduce((n, c) => n + c.charCodeAt(0), 0);
  const series = (shift: number) =>
    Array.from({ length: days }, (_, i) => {
      const base = 40 + ((seed + (i + shift) * 17) % 90) + (i % 7 === 5 ? 60 : 0);
      return { dateKey: dayKey(days - 1 - i + shift), messages: voice ? 0 : base, uniqueAuthors: Math.max(2, Math.round(base / 9)), voiceMinutes: voice ? base * 3 : Math.round(base / 6) };
    });
  const daily = series(0);
  const previousDaily = series(days);
  const sum = (list: typeof daily, key: 'messages' | 'voiceMinutes') => list.reduce((n, d) => n + d[key], 0);
  const messages = sum(daily, 'messages');
  const voiceMinutes = sum(daily, 'voiceMinutes');
  const peak = daily.reduce((a, b) => (b.messages > a.messages ? b : a), daily[0]);
  const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : a > 0 ? 100 : null);
  const heat = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => Math.max(0, Math.round(((h >= 18 && h <= 23) ? 40 : h >= 12 ? 18 : 3) * (d >= 5 ? 1.4 : 1)))));
  const flat = heat.flatMap((r, d) => r.map((count, h) => ({ day: d, hour: h, count })));
  const heatPeak = flat.reduce((a, b) => (b.count > a.count ? b : a));
  const people = crowd().slice(0, 8);
  const log = (i: number, minutes: number, text: string, extra: Record<string, unknown> = {}) => {
    const p = people[i % people.length];
    return { messageId: demoId(), authorId: p.id, authorName: p.displayName, authorAvatar: avatarOf(p), content: text, createdAt: ago(minutes), hasAttachment: false, ...extra };
  };

  return {
    channelId,
    period: days,
    timezone: 'Europe/Paris',
    channel: {
      id: channelId, name, type: known?.type ?? 'text', mention: `<#${channelId}>`, topic: voice ? null : 'Discussions libres : jeux, créations et bonne humeur.', nsfw: false,
      rateLimitPerUser: 0, position: 3, createdAt: ago(420 * DAY), categoryId: CATEGORIES[1].id, categoryName: CATEGORIES[1].name,
      bitrate: voice ? 64_000 : null, userLimit: voice ? 10 : null, connectedNow: voice ? 3 : null, defaultAutoArchiveDuration: null, isPrivate: false,
      roleOverwrites: [{ id: DEMO_GUILD_ID, name: '@everyone', color: null, allow: 3, deny: 0, isEveryone: true }, { id: role('Modérateur').id, name: 'Modérateur', color: role('Modérateur').color, allow: 6, deny: 0, isEveryone: false }],
    },
    activity: {
      daily,
      previousDaily,
      totals: { messages, voiceMinutes, activeDays: daily.filter((d) => d.messages > 0 || d.voiceMinutes > 0).length, uniqueAuthorsAvg: 14, avgMessagesPerDay: Math.round((messages / days) * 10) / 10, peakDateKey: peak.messages > 0 ? peak.dateKey : null, peakMessages: peak.messages },
      previous: { messages: sum(previousDaily, 'messages'), voiceMinutes: sum(previousDaily, 'voiceMinutes') },
      change: { messages: pct(messages, sum(previousDaily, 'messages')), voiceMinutes: pct(voiceMinutes, sum(previousDaily, 'voiceMinutes')) },
      share: { messagesPct: 31.4, voicePct: 12.8, rank: 1, channelCount: CHANNELS.length },
    },
    contributors: {
      available: true,
      total: messages,
      items: people.map((p, i) => ({ userId: p.id, userTag: p.username, avatarUrl: avatarOf(p), messages: Math.round(messages * (0.22 - i * 0.02)), lastMessageAt: ago(20 + i * 70), sharePct: Math.round((22 - i * 2) * 10) / 10 })),
    },
    heatmap: { available: true, matrix: heat, peak: heatPeak },
    health: {
      configured: true,
      excluded: false,
      status: 'HEALTHY',
      metrics: { avgMsgPerDay: Math.round((messages / days) * 100) / 100, avgMsgPerHour: Math.round((messages / days / 24) * 100) / 100, uniqueAuthorsAvg: 14 },
      thresholds: { overloadMsgPerHour: 120, overloadUniqueUsers: 40, underusedMsgPerDay: 8, underusedUniqueUsers: 3, deadMsgPerWeek: 5 },
      alerts: [{ id: 'ha-1', type: 'OVERLOADED', status: 'RESOLVED', confidence: 0.82, reason: 'Pic de messages pendant le tournoi.', createdAt: ago(12 * DAY), resolvedAt: ago(11 * DAY), resolvedBy: 'zenox' }],
    },
    moderation: {
      available: true,
      deleted: 17,
      edited: 64,
      topDeleted: people.slice(0, 3).map((p, i) => ({ userId: p.id, userTag: p.username, count: 6 - i * 2 })),
      recentDeleted: [log(0, 95, 'Free nitro ici !!! discord-gift.ru', { deletedAt: ago(90) }), log(2, 5 * 60, 'tu fais quoi de ta vie 😂', { deletedAt: ago(290) })],
    },
    content: {
      logging: { available: true },
      recentMessages: [log(1, 4, 'Quelqu’un pour une partie ce soir ?'), log(3, 9, 'Moi je suis chaud à 21 h'), log(4, 14, 'Je me joins à vous 🎮')],
      counters: { attachments: 128, botMessages: 211, replies: 540 },
      pinned: [{ id: demoId(), authorName: 'Arka', content: 'Bienvenue ! Lis le règlement avant de poster.', createdAt: ago(200 * DAY) }],
      threads: [{ id: demoId(), name: 'Tournoi d’automne', archived: false, locked: false, messageCount: 86, memberCount: 24, createdAt: ago(3 * DAY) }, { id: demoId(), name: 'Idées de soirées', archived: true, locked: false, messageCount: 41, memberCount: 12, createdAt: ago(30 * DAY) }],
      links: [],
    },
    auditTrail: [{ id: 'cd-1', eventType: 'CHANNEL_UPDATE', executorId: PEOPLE[1].id, executorName: 'Arka', changedFields: ['topic'], changes: { topic: { before: null, after: 'Discussions libres' } }, reason: null, createdAt: ago(40 * DAY) }],
  };
}

// ── Détail d'une invitation ──────────────────────────────────────────────

function inviteDetail(code: string, days: number) {
  const invite = row('GuildInvite', { id: `gi-${code}`, guildId: DEMO_GUILD_ID, code, inviterId: personByName('Arka').id, inviterTag: 'arka', sourceLabel: 'Lien officiel', uses: 412, createdAt: ago(300 * DAY) });
  const labels = Array.from({ length: days }, (_, i) => dayKey(days - 1 - i));
  const counts = labels.map((_, i) => 2 + ((i * 7) % 9) + (i % 7 === 5 ? 6 : 0));
  const totalJoined = counts.reduce((a, b) => a + b, 0);
  const totalLeft = Math.round(totalJoined * 0.16);
  const people = crowd().slice(0, 14);
  const joins = people.map((p, i) => ({
    userId: p.id, userTag: p.username, joinedAt: ago((i + 1) * 31 * 60), leftAt: i % 5 === 4 ? ago(i * 20 * 60) : null, avatarUrl: avatarOf(p),
    accountCreatedAt: ago((90 + i * 40) * DAY), messageCount: p.messages % 400, ghostStatus: ['ACTIVE', 'ACTIVE', 'SPECTATOR', 'NEW', 'INACTIVE'][i % 5], isBot: false,
  }));
  const hourly = Array.from({ length: 24 }, (_, h) => (h >= 17 && h <= 23 ? 30 + h : h >= 12 ? 14 : 3));
  const weekday = [38, 41, 44, 52, 69, 88, 80];
  let running = 0;
  return {
    invite,
    defaultInvite: { code, url: `https://discord.gg/${code}`, isThis: true },
    trend: {
      totalJoined, totalLeft, totalStayed: totalJoined - totalLeft, labels, counts,
      departures: counts.map((c) => Math.round(c * 0.15)),
      previousArrivals: counts.map((c) => Math.max(0, c - 2)),
      previousDepartures: counts.map((c) => Math.round(c * 0.2)),
    },
    joins,
    retention: {
      total: totalJoined, stayed: totalJoined - totalLeft, left: totalLeft, retentionPct: Math.round(((totalJoined - totalLeft) / totalJoined) * 1000) / 10,
      survival: {
        d1: { rate: 93, eligible: totalJoined },
        d7: { rate: 84, eligible: Math.max(1, totalJoined - 4) },
        d30: { rate: 76, eligible: Math.max(1, totalJoined - 12) },
      }, avgLifetimeDays: 41.2, medianLifetimeDays: 28, sameDayLeavers: 5, sameDayLeaversPct: 3.2,
    },
    quality: {
      analyzed: 138, avgMessages: 64.2, guildAvgMessages: 48.9, avgLevel: 9.4, guildAvgLevel: 8.1,
      ghost: { ACTIVE: 52, SPECTATOR: 41, INACTIVE: 18, NEW: 21, UNKNOWN: 6 }, bots: 2, youngAccounts: 9, youngAccountsPct: 6.5,
      sanctionedMembers: 4, sanctionsCount: 6, topSanctioned: [{ userId: people[0].id, userTag: people[0].username, count: 2 }], sampled: false,
    },
    timing: {
      hourly, weekday, labels,
      cumulative: counts.map((c) => (running += c)),
      peakHour: hourly.indexOf(Math.max(...hourly)),
      peakWeekday: weekday.indexOf(Math.max(...weekday)),
    },
    ranking: {
      rank: 1, totalCodes: 6, sharePct: 41.6,
      topCodes: [['atelier-nova', 412], ['topgg', 188], ['disboard', 96], ['tiktok-oct', 54], ['k8Rq2Lp', 23]].map(([code, joins]) => ({ code, joins })),
    },
  };
}

// ── Recrutement ──────────────────────────────────────────────────────────

function candidaturesSeed() {
  const people = crowd().slice(10, 20);
  const make = (i: number, status: string, minutes: number, extra: Record<string, unknown> = {}) => {
    const p = people[i];
    return row('RecruitmentCandidature', {
      id: `cand-${i}`, guildId: DEMO_GUILD_ID, discordId: p.id, username: p.username, status, customFormId: 'form-recrutement', createdAt: ago(minutes), updatedAt: ago(minutes),
      data: { age: 17 + i * 2, time: ['3 à 7 h', 'Plus de 7 h', 'Moins de 3 h'][i % 3], why: 'Je suis présent tous les soirs et j’aime aider les nouveaux.', case: 'Je coupe le micro, je parle en privé, puis je fais un rapport.', scale: 2 + (i % 4) },
      ...extra,
    });
  };
  return [
    make(0, 'PENDING', 3 * 60),
    make(1, 'PENDING', 20 * 60),
    make(2, 'ORAL', 2 * DAY, { notes: 'Bon entretien écrit, oral prévu vendredi.' }),
    make(3, 'APPROVED', 6 * DAY, { oralResult: 'PASS', oralNotes: 'Très à l’aise, à l’écoute.', processedByUserId: PEOPLE[1].id }),
    make(4, 'REJECTED', 9 * DAY, { rejectionReason: 'Pas assez d’ancienneté sur le serveur.', reapplyAfter: ago(-20 * DAY), processedByUserId: PEOPLE[2].id }),
    make(5, 'AUTO_REJECTED', 12 * DAY, { autoRejected: true, autoRejectReason: 'Compte Discord trop récent.' }),
  ];
}

export function registerDetailRoutes(): void {
  // Règlement : les articles vivent dans l'état de session (guildState.regulationRules).
  const articles = () => demoDb.get('regulation/rules', regulationSeed);
  const saveArticles = (list: ReturnType<typeof regulationSeed>) => demoDb.set('regulation/rules', list);
  route('POST', `${G}/regulation/articles`, ({ body }) => {
    const now = new Date().toISOString();
    const article = { id: demoId(), title: String(body?.title ?? '').trim(), description: String(body?.description ?? '').trim(), emoji: body?.emoji ?? null, sortOrder: body?.sortOrder ?? articles().length + 1, enabled: true, createdAt: now, updatedAt: now };
    saveArticles([...articles(), article]);
    return { ok: true, articleId: article.id };
  });
  route('PATCH', `${G}/regulation/articles/reorder`, ({ body }) => {
    const ids: string[] = body?.articleIds ?? body?.ids ?? body?.order ?? [];
    if (ids.length) saveArticles(articles().map((a) => ({ ...a, sortOrder: Math.max(0, ids.indexOf(a.id)) + 1 })));
    return { ok: true };
  });
  route('PATCH', `${G}/regulation/articles/:articleId`, ({ params, body }) => {
    saveArticles(articles().map((a) => (a.id === params.articleId ? { ...a, ...(body ?? {}), updatedAt: new Date().toISOString() } : a)));
    return { ok: true };
  });
  route('DELETE', `${G}/regulation/articles/:articleId`, ({ params }) => {
    saveArticles(articles().filter((a) => a.id !== params.articleId));
    return { ok: true };
  });
  route('POST', `${G}/regulation/publish`, () => ({ ok: true, messageId: demoId(), messageIds: [demoId()], message: 'Règlement publié dans le salon de publication (1 message(s)).' }));

  route('GET', `${G}/analytics/channels/:channelId`, ({ params, query }) => channelDetail(params.channelId, Math.max(1, Number(query.get('days')) || 30)));
  route('GET', `${G}/invitations/:code`, ({ params, query }) => inviteDetail(params.code, Math.min(365, Math.max(1, Number(query.get('days')) || 30))));

  const candidatures = () => demoDb.get('recruitment/candidatures', candidaturesSeed);
  route('GET', `${G}/recruitment/candidatures`, () => ({ candidatures: candidatures() }));
  route('PATCH', `${G}/recruitment/candidatures/:id`, ({ params, body }) => {
    const statusByAction: Record<string, string> = { approve: 'APPROVED', reject: 'REJECTED', oral_pass: 'APPROVED', oral_fail: 'REJECTED' };
    demoDb.set('recruitment/candidatures', candidatures().map((c) => {
      if (c.id !== params.id) return c;
      const status = body?.action === 'status_update' ? body.status : statusByAction[body?.action as string] ?? c.status;
      return { ...c, status, rejectionReason: body?.reason ?? body?.rejectionReason ?? c.rejectionReason, oralNotes: body?.notes ?? c.oralNotes, assignedTutorId: body?.tutorId ?? c.assignedTutorId, updatedAt: new Date().toISOString() };
    }));
    return { ok: true };
  });
  route('DELETE', `${G}/recruitment/candidatures/:id`, ({ params }) => {
    demoDb.set('recruitment/candidatures', candidatures().filter((c) => c.id !== params.id));
    return { ok: true };
  });
  route('GET', `${G}/recruitment/tutors`, () => ({ tutors: staffMembers().filter((m) => m.isTutor || m.grade !== 'Helper').map((m) => ({ id: m.id, userId: m.userId, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl, grade: m.grade })) }));
  route('GET', `${G}/recruitment/forms`, () => ({
    forms: [{ id: 'form-recrutement', guildId: DEMO_GUILD_ID, name: 'Candidature modérateur', description: 'Rejoins l’équipe de modération.', isActive: true, isRecruitment: true, requiresDiscordAuth: true, hierarchyId: 'hier-moderation', hierarchy: { id: 'hier-moderation', name: 'Modération', color: '#5865f2', icon: '🛡️' }, _count: { submissions: 6, events: 0 }, createdAt: ago(20 * DAY), updatedAt: ago(2 * DAY) }],
  }));
  route('GET', `${G}/recruitment/forms/templates`, () => ({ templates: [] }));
  route('PATCH', `${G}/recruitment/config`, ({ body }) => ({ ok: true, recruitmentAutoRejectEnabled: body?.recruitmentAutoRejectEnabled ?? true }));
}
