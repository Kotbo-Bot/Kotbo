/**
 * Drops et prestige (classement compétitif). Barèmes, paliers et progression
 * viennent de `@kotbo/shared`, les mêmes que côté bot.
 */
import {
  DEFAULT_DROP_GLOBAL_SETTINGS,
  DEFAULT_LADDER_CURVE,
  DEFAULT_RANKED_LADDER,
  DROP_TYPES,
  defaultDropTypeSettings,
  generateRankedLadder,
  normalizeRankedLadder,
  rankedProgress,
  resolveRankedTier,
  streakFlames,
  type DropType,
} from '@kotbo/shared';
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, HOUR, MEMBERS, ago, avatarOf, channelByName, role } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';

const people = () => MEMBERS.filter((m) => !m.bot);

// ── Drops ────────────────────────────────────────────────────────────────

const RESOURCES: Record<DropType, string> = { XP: 'XP', RPG_XP: 'XP RPG', CLAN_POINTS: 'points de clan', COINS: 'pièces', RPG_ITEM: 'objet RPG' };

function dropsSeed() {
  const configs = DROP_TYPES.map((type) => {
    const base = defaultDropTypeSettings(type);
    const on = type !== 'RPG_ITEM';
    return {
      ...base,
      type,
      enabled: on,
      channelId: type === 'COINS' ? channelByName('boutique').id : null,
      intervalMinutes: type === 'XP' ? 180 : base.intervalMinutes,
      items: type === 'RPG_ITEM' ? [{ itemId: 'health_potion', weight: 3 }, { itemId: 'iron_sword', weight: 1 }] : base.items,
      nextDropAt: on ? new Date(Date.now() + (20 + DROP_TYPES.indexOf(type) * 35) * 60_000).toISOString() : null,
    };
  });
  return {
    ...DEFAULT_DROP_GLOBAL_SETTINGS,
    dropsEnabled: true,
    dropChannelId: channelByName('général').id,
    dropMentionRoleId: role('Habitué').id,
    dropMentionJackpotOnly: true,
    dropJackpotEnabled: true,
    configs,
  };
}

function dropHistory() {
  const types: DropType[] = ['XP', 'COINS', 'CLAN_POINTS', 'XP', 'RPG_XP', 'COINS', 'XP', 'CLAN_POINTS'];
  return types.map((type, i) => {
    const createdAt = ago(40 + i * 170);
    const claims = i === 4 ? 0 : 1 + (i % 3);
    return {
      id: `drop-${i}`, type, item: null, mode: ['first', 'race', 'window'][i % 3], channelId: channelByName('général').id,
      amount: [120, 180, 35, 90, 60, 250, 200, 45][i], jackpot: i === 5, maxClaims: i % 3 === 1 ? 3 : 1, claimCount: claims,
      createdAt, expiresAt: ago(i * 170 - 20), closedAt: ago(i * 170 - 10),
    };
  });
}

// ── Prestige ─────────────────────────────────────────────────────────────

const rankedConfigSeed = () => row('RankedConfig', { guildId: DEMO_GUILD_ID, enabled: true, tierRolesEnabled: true, decayEnabled: true, announceChannelId: channelByName('niveaux').id });

function rankedMembers() {
  return people().slice(0, 40).map((p, i) => ({ userId: p.id, rp: Math.max(40, Math.round(p.xp * 0.09) - i * 11), streakDays: Math.max(0, 21 - i * 2), bestStreak: Math.max(3, 30 - i), lastActiveDate: ago(i * 60) }));
}

const ladderOf = (config: ReturnType<typeof rankedConfigSeed>) => (config.ladder ? normalizeRankedLadder(config.ladder) : DEFAULT_RANKED_LADDER);

function leaderboardRows(limit = 25, offset = 0) {
  const ladder = ladderOf(demoDb.get('ranked/config', rankedConfigSeed));
  return rankedMembers().sort((a, b) => b.rp - a.rp).slice(offset, offset + limit).map((m, i) => {
    const p = people().find((x) => x.id === m.userId)!;
    const progress = rankedProgress(m.rp, ladder);
    return { rank: offset + i + 1, userId: m.userId, rp: m.rp, tier: progress.current, streakDays: m.streakDays, flames: streakFlames(m.streakDays), percent: progress.percent, displayName: p.displayName, avatarUrl: avatarOf(p) };
  });
}

const eventsSeed = () => [
  row('RankedEvent', { id: 're-1', guildId: DEMO_GUILD_ID, type: 'VOCAL_TIME', name: 'Week-end vocal', multiplier: 2, startsAt: ago(-2 * DAY), endsAt: ago(-4 * DAY), status: 'SCHEDULED' }),
  row('RankedEvent', { id: 're-2', guildId: DEMO_GUILD_ID, type: 'MESSAGE_RUSH', name: 'Rush du mercredi', multiplier: 1.5, startsAt: ago(3 * HOUR), endsAt: ago(-3 * HOUR), status: 'ACTIVE', participants: 23, bonusRpGranted: 1_840 }),
  row('RankedEvent', { id: 're-3', guildId: DEMO_GUILD_ID, type: 'REACTION_STORM', name: 'Tempête de réactions', multiplier: 2, startsAt: ago(9 * DAY), endsAt: ago(8 * DAY), status: 'ENDED', participants: 41, bonusRpGranted: 3_210 }),
];

function impact(ladder: ReturnType<typeof normalizeRankedLadder>) {
  const members = rankedMembers();
  const distribution = ladder.map((tier, i) => {
    const next = ladder[i + 1];
    return members.filter((m) => (i === 0 || m.rp >= tier.minRp) && (!next || m.rp < next.minRp)).length;
  });
  return { ladder, total: members.length, changed: Math.round(members.length * 0.15), distribution };
}

export function registerProgressionRoutes(): void {
  const drops = () => demoDb.get('drops', dropsSeed);
  route('GET', `${G}/drops`, () => {
    const history = dropHistory();
    return {
      ...drops(),
      weeklyOutcomes: Object.fromEntries(DROP_TYPES.map((t) => [t, { closed: t === 'RPG_ITEM' ? 0 : 14, unclaimed: t === 'CLAN_POINTS' ? 4 : 1 }])),
      abandonedClaims: 0,
      announcement: {
        locale: 'fr',
        title: '🎁 Un drop vient de tomber !',
        jackpotTitle: '💰 JACKPOT !',
        claimButton: 'Ramasser',
        first: 'Le premier qui clique gagne **{amount} {resource}**.',
        race: 'Les {winners} premiers gagnent **{amount} {resource}**.',
        window: 'Tous ceux qui cliquent avant {closes} gagnent **{amount} {resource}**.',
        resources: RESOURCES,
      },
      recentDrops: history,
      recentDropsHasMore: false,
    };
  });
  route('PUT', `${G}/drops`, ({ body }) => ({ success: true, ...demoDb.update('drops', dropsSeed, (d) => ({ ...d, ...(body ?? {}), configs: d.configs })) }));
  route('PUT', `${G}/drops/:type`, ({ params, body }) => {
    const next = demoDb.update('drops', dropsSeed, (d) => ({ ...d, configs: d.configs.map((c) => (c.type === params.type ? { ...c, ...(body ?? {}) } : c)) }));
    return { success: true, config: next.configs.find((c) => c.type === params.type) };
  });
  route('GET', `${G}/drops/history`, ({ query }) => {
    const type = query.get('type');
    return { drops: dropHistory().filter((d) => !type || d.type === type), hasMore: false };
  });
  route('GET', `${G}/drops/history/:dropId`, ({ params }) => {
    const drop = dropHistory().find((d) => d.id === params.dropId);
    return {
      winners: people().slice(6, 6 + (drop?.claimCount ?? 0)).map((p, i) => ({ userId: p.id, name: p.displayName, avatarUrl: avatarOf(p), amount: drop?.amount ?? 0, claimedAt: ago(40 + i), status: 'paid' })),
    };
  });

  const config = () => demoDb.get('ranked/config', rankedConfigSeed);
  route('GET', `${G}/ranked`, () => {
    const ladder = ladderOf(config());
    const members = rankedMembers();
    const top = [...members].sort((a, b) => b.rp - a.rp)[0];
    return {
      config: config(),
      ladder,
      defaultLadder: DEFAULT_RANKED_LADDER,
      defaultLadderCurve: DEFAULT_LADDER_CURVE,
      tierRoles: ladder.slice(-4).map((tier, i) => row('RankedTierRole', { id: `rtr-${i}`, guildId: DEMO_GUILD_ID, tierKey: tier.key, roleId: role('Habitué').id })),
      tierRoleSync: { pending: 0, done: 0, updated: 0, running: false },
      stats: {
        rankedMembers: members.length,
        activeStreaks: members.filter((m) => m.streakDays >= 2).length,
        totalRp: members.reduce((s, m) => s + m.rp, 0),
        averageRp: Math.round(members.reduce((s, m) => s + m.rp, 0) / members.length),
        bestStreak: Math.max(...members.map((m) => m.bestStreak)),
        top: top ? { userId: top.userId, rp: top.rp, tier: resolveRankedTier(top.rp, ladder) } : null,
      },
      leaderboard: leaderboardRows(25),
      streaks: [...members].sort((a, b) => b.streakDays - a.streakDays).slice(0, 10).map((m, i) => {
        const p = people().find((x) => x.id === m.userId)!;
        return { rank: i + 1, userId: m.userId, streakDays: m.streakDays, bestStreak: m.bestStreak, flames: streakFlames(m.streakDays), lastActiveDate: m.lastActiveDate, displayName: p.displayName, avatarUrl: avatarOf(p) };
      }),
      events: demoDb.get('ranked/events', eventsSeed),
    };
  });
  route('PATCH', `${G}/ranked/config`, ({ body }) => {
    const next = demoDb.update('ranked/config', rankedConfigSeed, (c) => ({ ...c, ...(body ?? {}) }));
    return { config: next, ladder: ladderOf(next), retiered: 0 };
  });
  route('POST', `${G}/ranked/ladder/impact`, ({ body }) => {
    const ladder = body?.ladder ? normalizeRankedLadder(body.ladder) : body?.curve ? generateRankedLadder(body.curve) : ladderOf(config());
    return impact(ladder);
  });
  route('GET', `${G}/ranked/leaderboard`, ({ query }) => {
    const page = Math.max(1, Number(query.get('page')) || 1);
    const search = (query.get('search') ?? '').toLowerCase();
    const all = leaderboardRows(100).filter((r) => !search || r.displayName.toLowerCase().includes(search));
    return { rows: all.slice((page - 1) * 25, page * 25), total: all.length, page, pageCount: Math.max(1, Math.ceil(all.length / 25)), searchLimited: false };
  });
  route('GET', `${G}/ranked/global`, () => ({ rows: leaderboardRows(25).map((r) => ({ rank: r.rank, userId: r.userId, rp: r.rp * 3, guilds: 2 + (r.rank % 3), displayName: r.displayName, avatarUrl: r.avatarUrl })) }));
  route('GET', `${G}/ranked/members/:userId`, ({ params }) => {
    const m = rankedMembers().find((x) => x.userId === params.userId);
    const ladder = ladderOf(config());
    return { member: m ? { ...m, progress: rankedProgress(m.rp, ladder), history: [] } : null };
  });
  route('POST', `${G}/ranked/members/:userId/adjust`, () => ({ success: true }));
  route('PUT', `${G}/ranked/tier-roles/:tierKey`, () => ({ success: true }));
  route('DELETE', `${G}/ranked/tier-roles/:tierKey`, () => ({ success: true }));
  route('DELETE', `${G}/ranked/tier-roles`, () => ({ success: true }));
  route('POST', `${G}/ranked/tier-roles/provision`, () => ({ success: true, created: 4 }));
  route('GET', `${G}/ranked/tier-roles/sync`, () => ({ pending: 0, done: 40, updated: 6, running: false }));
  route('POST', `${G}/ranked/tier-roles/sync`, () => ({ pending: 0, done: 40, updated: 6, running: false }));
  route('POST', `${G}/ranked/announce-channel`, () => ({ channelId: channelByName('niveaux').id }));
  route('POST', `${G}/ranked/events`, ({ body }) => {
    const event = row('RankedEvent', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID, status: 'SCHEDULED' });
    demoDb.update('ranked/events', eventsSeed, (list) => [event, ...list]);
    return { event };
  });
  route('DELETE', `${G}/ranked/events/:eventId`, ({ params }) => {
    demoDb.update('ranked/events', eventsSeed, (list) => list.filter((e) => e.id !== params.eventId));
    return { success: true };
  });
  route('GET', `${G}/ranked/decay/preview`, () => ({ affected: 6, totalRp: 450, members: [] }));
  route('POST', `${G}/ranked/decay/run`, () => ({ affected: 6, totalRp: 450 }));
}
