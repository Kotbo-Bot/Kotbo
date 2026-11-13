/**
 * Les pages communautaires : saisons, réputation, marketplace, quêtes.
 *
 * Formes reprises des routes `/seasons`, `/reputation`, `/marketplace` et
 * `/quests` du bot. Les classements viennent des membres de démo : le même
 * Arka, la même Lena que dans le reste du dashboard.
 */
import { route } from '../backend';
import { demoDb } from '../db';
import { DAY, PEOPLE, ago } from '../fixtures';

const members = () => PEOPLE.filter((p) => !p.bot);
const byXp = () => [...members()].sort((a, b) => b.xp - a.xp);

type Quest = {
  id: string;
  name: string;
  description: string;
  type: string;
  frequency: string;
  target: number;
  rewardCoins: number;
  rewardXp: number;
  enabled: boolean;
};

const questsSeed = (): Quest[] => [
  { id: 'quest-1', name: 'Bavard du jour', description: 'Envoie 50 messages aujourd’hui.', type: 'SEND_MESSAGES', frequency: 'DAILY', target: 50, rewardCoins: 100, rewardXp: 50, enabled: true },
  { id: 'quest-2', name: 'Vocaliste', description: 'Passe 30 minutes en vocal.', type: 'VOICE_MINUTES', frequency: 'DAILY', target: 30, rewardCoins: 75, rewardXp: 40, enabled: true },
  { id: 'quest-3', name: 'Champion de la semaine', description: 'Gagne 3 parties.', type: 'WIN_GAME', frequency: 'WEEKLY', target: 3, rewardCoins: 150, rewardXp: 75, enabled: true },
  { id: 'quest-4', name: 'Généreux', description: 'Donne 5 points de réputation.', type: 'GIVE_REP', frequency: 'WEEKLY', target: 5, rewardCoins: 100, rewardXp: 50, enabled: false },
];

const TIERS = [
  { name: 'Diamant', color: '#60a5fa' },
  { name: 'Platine', color: '#2dd4bf' },
  { name: 'Or', color: '#facc15' },
  { name: 'Argent', color: '#9ca3af' },
  { name: 'Bronze', color: '#d97706' },
];

const ITEMS = [
  { itemId: 'iron_sword', item: { name: 'Épée en fer', emoji: '🗡️' }, upgrade: 2 },
  { itemId: 'health_potion', item: { name: 'Potion de soin', emoji: '🧪' }, upgrade: 0 },
  { itemId: 'oak_bow', item: { name: 'Arc en chêne', emoji: '🏹' }, upgrade: 0 },
  { itemId: 'golden_rod', item: { name: 'Canne dorée', emoji: '🎣' }, upgrade: 1 },
];

export function registerCommunityRoutes(): void {
  route('GET', '/api/dashboard/guilds/:guildId/seasons', () => {
    const ranked = byXp().slice(0, 10);
    return {
      activeSeason: { id: 'season-3', name: 'Saison d’automne', startDate: ago(30 * 24 * 60), endDate: ago(-60 * 24 * 60), status: 'ACTIVE' },
      activeLeaderboard: ranked.map((p, i) => ({
        rank: i + 1,
        userId: p.id,
        displayName: p.displayName,
        avatarUrl: null,
        level: p.level,
        xp: p.xp,
      })),
      activeRankedLeaderboard: ranked.slice(0, 8).map((p, i) => ({
        rank: i + 1,
        userId: p.id,
        displayName: p.displayName,
        avatarUrl: null,
        tier: TIERS[Math.min(TIERS.length - 1, Math.floor(i / 2))],
        rp: 2_400 - i * 260,
      })),
      seasons: [
        { id: 'season-3', number: 3, name: 'Saison d’automne', status: 'ACTIVE', startDate: ago(30 * 24 * 60), endDate: ago(-60 * 24 * 60), _count: { snapshots: members().length } },
        { id: 'season-2', number: 2, name: 'Saison d’été', status: 'ENDED', startDate: ago(120 * 24 * 60), endDate: ago(31 * 24 * 60), _count: { snapshots: members().length - 1 } },
        { id: 'season-1', number: 1, name: 'Lancement', status: 'ARCHIVED', startDate: ago(210 * 24 * 60), endDate: ago(121 * 24 * 60), _count: { snapshots: Math.max(1, members().length - 3) } },
      ],
    };
  });

  route('GET', '/api/dashboard/guilds/:guildId/seasons/:seasonId/leaderboard', () => ({
    leaderboard: byXp().slice(0, 10).map((p, i) => ({ rank: i + 1, userId: p.id, displayName: p.displayName, avatarUrl: null, level: p.level, xp: p.xp })),
  }));

  const repConfig: { dailyLimit: number; announceChannelId: string | null; tiers: Array<{ threshold: number; roleId: string }> } = {
    dailyLimit: 3,
    announceChannelId: null,
    tiers: [],
  };
  const repPool = () => members().slice(0, 8);
  const repVotes = () => {
    const pool = repPool();
    return pool.slice(1, 6).map((receiver, i) => {
      const giver = pool[(i + 3) % pool.length];
      return {
        id: `rep-${i}`,
        giverId: giver.id,
        giverName: giver.displayName,
        giverAvatarUrl: null,
        receiverId: receiver.id,
        receiverName: receiver.displayName,
        receiverAvatarUrl: null,
        reason: ['Merci pour l’aide sur le règlement', 'Super animation hier soir', 'A bien accueilli les nouveaux', 'Partie très fair-play', 'A répondu en 5 minutes'][i],
        channelId: null,
        messageId: null,
        messageUrl: null,
        createdAt: ago(90 * (i + 1)),
      };
    });
  };

  route('GET', '/api/dashboard/guilds/:guildId/reputation', ({ query }) => {
    // Les périodes courtes ne gardent que le haut du classement, pour que le filtre se voie.
    const keep = query.get('period') === 'week' ? 3 : query.get('period') === 'month' ? 5 : 8;
    const entries = repPool().slice(0, keep).map((p, i) => ({ rank: i + 1, userId: p.id, displayName: p.displayName, avatarUrl: null, totalRep: 64 - i * 7 }));
    return {
      config: { ...repConfig },
      leaderboard: { totalVoters: entries.length + 14, entries },
      stats: { totalVotes: 412, votesLast7Days: 23, activeGivers7Days: 11, lastVoteAt: ago(90) },
      announcement: {
        locale: 'fr',
        title: 'Nouveau palier de réputation',
        body: '{user} atteint **{threshold}** points de réputation et reçoit le rôle {role}.',
      },
      unmanageableTierRoleIds: [],
    };
  });

  route('GET', '/api/dashboard/guilds/:guildId/reputation/votes', ({ query }) => {
    const userId = query.get('userId');
    const votes = repVotes().filter((v) => !userId || v.giverId === userId || v.receiverId === userId);
    return { votes, nextCursor: null };
  });

  route('PATCH', '/api/dashboard/guilds/:guildId/reputation/config', ({ body }) => {
    if (typeof body?.dailyLimit === 'number') repConfig.dailyLimit = body.dailyLimit;
    if (body && 'announceChannelId' in body) repConfig.announceChannelId = body.announceChannelId;
    if (Array.isArray(body?.tiers)) repConfig.tiers = [...body.tiers].sort((a, b) => a.threshold - b.threshold);
    return { config: { ...repConfig } };
  });

  route('DELETE', '/api/dashboard/guilds/:guildId/reputation/votes/:voteId', () => ({ deleted: true }));

  route('GET', '/api/dashboard/guilds/:guildId/marketplace', () => {
    const sellers = members().slice(0, 5);
    const memberMap = Object.fromEntries(sellers.map((p) => [p.id, { displayName: p.displayName, avatarUrl: null }]));
    const listings = ITEMS.map((it, i) => ({
      id: `listing-${i}`,
      ...it,
      type: i % 3 === 2 ? 'AUCTION' : 'BUY_NOW',
      status: 'ACTIVE',
      price: [1_200, 350, 800, 2_500][i],
      currentBid: i % 3 === 2 ? 900 : null,
      quantity: i === 1 ? 5 : 1,
      sellerId: sellers[i % sellers.length].id,
      expiresAt: ago(-(3 + i * 5) * 60),
    }));
    const transactions = ITEMS.slice(0, 3).map((it, i) => ({
      id: `tx-${i}`,
      ...it,
      price: [980, 300, 760][i],
      quantity: i === 1 ? 3 : 1,
      sellerId: sellers[i].id,
      buyerId: sellers[(i + 2) % sellers.length].id,
      createdAt: ago((i + 1) * DAY),
    }));
    return {
      activeListings: listings,
      recentTransactions: transactions,
      totalTransactions: 187,
      totalVolume: 94_350,
      members: memberMap,
    };
  });

  route('GET', '/api/dashboard/guilds/:guildId/quests', () => {
    const definitions = demoDb.get<Quest[]>('quests', questsSeed);
    return { definitions, totalClaimed: 1_284 };
  });

  route('POST', '/api/dashboard/guilds/:guildId/quests', ({ body }) => {
    const quest: Quest = { id: `quest-${Date.now()}`, enabled: true, ...(body ?? {}) };
    demoDb.update<Quest[]>('quests', questsSeed, (list) => [...list, quest]);
    return { success: true, quest };
  });

  route('PATCH', '/api/dashboard/guilds/:guildId/quests/:questId', ({ params, body }) => {
    demoDb.update<Quest[]>('quests', questsSeed, (list) => list.map((q) => (q.id === params.questId ? { ...q, ...(body ?? {}) } : q)));
    return { success: true };
  });

  route('DELETE', '/api/dashboard/guilds/:guildId/quests/:questId', ({ params }) => {
    demoDb.update<Quest[]>('quests', questsSeed, (list) => list.filter((q) => q.id !== params.questId));
    return { success: true };
  });
}
