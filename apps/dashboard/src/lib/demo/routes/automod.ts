/**
 * Routes de démo pour le module AutoMod.
 */
import { route } from '../backend';
import { demoDb } from '../db';
import { row, merge } from '../model';

function autoModSeed() {
  return row('AutoModConfig', {
    discordAutoModEnabled: true,
    spamEnabled: true,
    spamLimit: 5,
    spamIntervalSeconds: 5,
    spamAction: 'TIMEOUT',
    linksEnabled: true,
    linksAction: 'DELETE_AND_WARN',
    linksWhitelist: ['youtube.com', 'twitch.tv', 'github.com', 'twitter.com', 'x.com'],
    capsEnabled: true,
    capsThresholdPercent: 75,
    capsMinLength: 10,
    emojisEnabled: false,
    emojisLimit: 8,
    mentionsEnabled: true,
    mentionsLimit: 4,
    ghostPingEnabled: true,
    ghostPingAction: 'ALERT',
    antiEveryoneEnabled: true,
    antiEveryoneAction: 'DELETE_AND_WARN',
  });
}

export function registerAutoModRoutes(): void {
  route('GET', '/api/dashboard/guilds/:id/automod/discord-events', () => {
    const now = Date.now();
    const user = (n: number, name: string) => ({ userId: `demo-user-${n}`, name, avatar: null });
    const events = [
      { ruleName: 'Kotbo AutoMod - Liens', managed: true, action: 'BLOCK', keyword: '*bit.ly/*', u: user(1, 'Lina') },
      { ruleName: 'Règle du serveur - Spoilers', managed: false, action: 'ALERT', keyword: 'spoil', u: user(2, 'Max') },
      { ruleName: 'Kotbo AutoMod - Invitations', managed: true, action: 'BLOCK', keyword: '*discord.gg/*', u: user(1, 'Lina') },
    ].map((e, i) => ({ id: `demo-${i}`, ruleId: e.ruleName, ruleName: e.ruleName, triggerType: 1, action: e.action, channelId: null, keyword: e.keyword, content: null, managed: e.managed, createdAt: new Date(now - i * 3_600_000).toISOString(), user: e.u }));
    return {
      days: 7,
      total: events.length,
      events,
      byRule: events.map((e) => ({ ruleId: e.ruleId, ruleName: e.ruleName, managed: e.managed, count: 1 })),
      topUsers: [{ ...user(1, 'Lina'), count: 2 }, { ...user(2, 'Max'), count: 1 }],
    };
  });

  // GET /api/dashboard/guilds/:id/automod
  route('GET', '/api/dashboard/guilds/:id/automod', () => {
    const config = demoDb.get('automod-config', autoModSeed);
    return { config, isOwner: true };
  });

  // PATCH /api/dashboard/guilds/:id/automod
  route('PATCH', '/api/dashboard/guilds/:id/automod', ({ body }) => {
    const config = demoDb.update('automod-config', autoModSeed, (current) => merge(current, body));
    return { success: true, config };
  });
}
