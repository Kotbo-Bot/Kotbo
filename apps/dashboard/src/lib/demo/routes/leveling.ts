/**
 * Routes de démo pour le module Leveling / Classement.
 */
import { route } from '../backend';
import { demoDb } from '../db';
import { MEMBERS, role } from '../fixtures';
import { row, merge } from '../model';

function levelingConfigSeed() {
  return row('LevelConfig', {
    enabled: true,
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    voiceXpEnabled: true,
    voiceXpRate: 10,
    voiceXpIntervalMinutes: 5,
    messageChannelId: '900000000000000315',
    messageType: 'EMBED',
    customMessage: 'Bravo {user}, tu viens de passer au niveau {level} ! 🎉',
    curveBaseXp: 100,
    curveLinearXp: 200,
    curveExponent: 2,
    maxLevel: 100,
  });
}

function levelingRewardsSeed() {
  return [
    {
      id: 'reward-1',
      guildId: '900000000000000001',
      level: 10,
      roleId: role('Habitué').id,
    },
    {
      id: 'reward-2',
      guildId: '900000000000000001',
      level: 25,
      roleId: role('Habitué').id,
    },
  ];
}

export function registerLevelingRoutes(): void {
  // GET /api/dashboard/guilds/:id/leveling
  route('GET', '/api/dashboard/guilds/:id/leveling', () => {
    const config = demoDb.get('leveling-config', levelingConfigSeed);
    const rewards = demoDb.get('leveling-rewards', levelingRewardsSeed);
    const totalXp = MEMBERS.reduce((sum, m) => sum + m.xp, 0);
    const maxLevel = Math.max(...MEMBERS.map((m) => m.level));
    const avgLevel = Math.round(MEMBERS.reduce((sum, m) => sum + m.level, 0) / MEMBERS.length);

    return {
      config,
      rewards,
      stats: {
        memberCount: MEMBERS.length,
        totalXp,
        avgLevel,
        maxLevel,
      },
    };
  });

  // PATCH /api/dashboard/guilds/:id/leveling
  route('PATCH', '/api/dashboard/guilds/:id/leveling', ({ body }) => {
    const config = demoDb.update('leveling-config', levelingConfigSeed, (current) => merge(current, body));
    return { success: true, config };
  });

  // GET /api/dashboard/guilds/:id/leveling/leaderboard
  route('GET', '/api/dashboard/guilds/:id/leveling/leaderboard', ({ query }) => {
    const search = (query.get('search') ?? '').trim().toLowerCase();
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    const pageSize = 20;

    let sorted = [...MEMBERS].sort((a, b) => b.xp - a.xp);
    if (search) {
      sorted = sorted.filter((m) => m.username.toLowerCase().includes(search) || m.displayName.toLowerCase().includes(search));
    }

    const total = sorted.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const paged = sorted.slice(offset, offset + pageSize);

    const rows = paged.map((m, idx) => ({
      userId: m.id,
      username: m.username,
      displayName: m.displayName,
      avatarUrl: null,
      level: m.level,
      xp: m.xp,
      messages: m.messages,
      voiceMinutes: m.voiceMinutes,
      rank: offset + idx + 1,
    }));

    return {
      rows,
      total,
      page,
      pageCount,
      pageSize,
      searchLimited: false,
    };
  });

  // GET /api/dashboard/guilds/:id/leveling/curve-impact
  route('GET', '/api/dashboard/guilds/:id/leveling/curve-impact', () => {
    return { changed: 0, lowered: 0, total: MEMBERS.length };
  });

  // POST /api/dashboard/guilds/:id/leveling/rewards
  route('POST', '/api/dashboard/guilds/:id/leveling/rewards', ({ body }) => {
    const newReward = {
      id: `reward-${Date.now()}`,
      guildId: '900000000000000001',
      level: body?.level ?? 1,
      roleId: body?.roleId ?? '',
    };
    demoDb.update('leveling-rewards', levelingRewardsSeed, (list) => [...list, newReward]);
    return { success: true, reward: newReward };
  });

  // DELETE /api/dashboard/guilds/:id/leveling/rewards/:rewardId
  route('DELETE', '/api/dashboard/guilds/:id/leveling/rewards/:rewardId', ({ params }) => {
    demoDb.update('leveling-rewards', levelingRewardsSeed, (list) => list.filter((r) => r.id !== params.rewardId));
    return { success: true };
  });

  // GET /api/dashboard/guilds/:id/leveling/role-resync
  route('GET', '/api/dashboard/guilds/:id/leveling/role-resync', () => ({
    running: false,
    total: 0,
    processed: 0,
    errors: 0,
  }));

  // GET /api/dashboard/guilds/:id/clans
  route('GET', '/api/dashboard/guilds/:id/clans', () => ({
    clansEnabled: false,
    clans: [],
    currentClanSeason: 1,
    betsEnabled: false,
  }));

  // POST /api/dashboard/guilds/:id/leveling/role-resync
  route('POST', '/api/dashboard/guilds/:id/leveling/role-resync', () => ({
    started: true,
    pending: 0,
    running: false,
  }));
}
