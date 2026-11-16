/**
 * Les pages communautaires : saisons, réputation, suggestions, marketplace, quêtes.
 *
 * Formes reprises des routes `/seasons`, `/reputation`, `/suggestions`,
 * `/marketplace` et `/quests` du bot. Les classements viennent des membres de démo : le même
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
    // XP gagnée depuis l'ouverture de la saison, pas l'XP totale.
    const ranked = byXp().slice(0, 10).map((p, i) => ({ ...p, seasonXp: Math.max(40, Math.round(p.xp * 0.18) - i * 35) }));
    const active = {
      id: 'season-3',
      number: 3,
      name: 'Saison d’automne',
      startDate: ago(30 * 24 * 60),
      endDate: ago(-60 * 24 * 60),
      status: 'ACTIVE',
      rewards: [{ rank: 1, roleId: null, coins: 5_000 }, { rank: 2, roleId: null, coins: 2_500 }, { rank: 3, roleId: null, coins: 1_000 }],
      topRoleId: null,
      autoRenew: true,
      remindBeforeEnd: false,
      grantedRewards: [],
      _count: { snapshots: 0 },
    };
    return {
      activeSeason: active,
      activeLeaderboard: ranked.map((p, i) => ({
        rank: i + 1,
        userId: p.id,
        displayName: p.displayName,
        avatarUrl: null,
        level: p.level,
        xp: p.seasonXp,
        messagesCount: 420 - i * 31,
        voiceMinutes: 260 - i * 18,
      })),
      activeTotals: { participants: members().length, totalXp: ranked.reduce((sum, p) => sum + p.seasonXp, 0) },
      announcement: {
        locale: 'fr',
        startTitle: 'Saison #{number} · {name} ouverte',
        startBody: 'Le classement compte l’XP gagnée à partir de maintenant, jusqu’au {date}. Les niveaux ne sont pas remis à zéro.',
        rewardsHeading: 'Récompenses',
        topRoleLine: 'Premier · {role}',
        rewardCoins: '{coins} pièces',
        endTitle: 'Saison #{number} · {name} terminée',
        endLine: '**#{rank}** {user} · +{xp} XP',
        endEmpty: 'Personne n’a gagné d’XP pendant cette saison.',
        rewardsGivenHeading: 'Récompenses distribuées',
        reminderTitle: 'Saison #{number} · {name} : dernières 24 h',
        reminderBody: 'La saison se termine {date} : chaque XP compte encore.',
        tiersHeading: 'Paliers',
        tierLine: 'Dès {xp} XP · {reward}',
        tierReachedLine: '{xp} XP · {count} membre(s)',
      },
      botRoleAccess: { canManageRoles: true, topPosition: 100 },
      activeRankedLeaderboard: ranked.slice(0, 8).map((p, i) => ({
        rank: i + 1,
        userId: p.id,
        displayName: p.displayName,
        avatarUrl: null,
        tier: TIERS[Math.min(TIERS.length - 1, Math.floor(i / 2))],
        rp: 2_400 - i * 260,
      })),
      seasons: [
        active,
        { id: 'season-2', number: 2, name: 'Saison d’été', status: 'ENDED', startDate: ago(120 * 24 * 60), endDate: ago(31 * 24 * 60), rewards: [{ rank: 1, roleId: null, coins: 3_000 }], topRoleId: null, grantedRewards: [{ userId: byXp()[0]?.id ?? '1', rank: 1, roleId: null, coins: 3_000, roleStatus: null, coinsStatus: 'given' }], stats: { participants: Math.max(1, members().length - 1), totalXp: 41_200, topXp: 3_850 }, _count: { snapshots: members().length - 1 } },
        { id: 'season-1', number: 1, name: 'Lancement', status: 'ENDED', startDate: ago(210 * 24 * 60), endDate: ago(121 * 24 * 60), rewards: [], topRoleId: null, grantedRewards: [], stats: { participants: Math.max(1, members().length - 3), totalXp: 28_900, topXp: 2_640 }, _count: { snapshots: Math.max(1, members().length - 3) } },
      ],
    };
  });

  route('GET', '/api/dashboard/guilds/:guildId/seasons/:seasonId/leaderboard', () => ({
    leaderboard: byXp().slice(0, 10).map((p, i) => ({
      rank: i + 1,
      userId: p.id,
      displayName: p.displayName,
      avatarUrl: null,
      level: p.level,
      xp: Math.max(40, Math.round(p.xp * 0.2) - i * 30),
      messagesCount: 380 - i * 27,
      voiceMinutes: 210 - i * 15,
    })),
  }));

  const repConfig: {
    dailyLimit: number;
    reactionEnabled: boolean;
    reactionEmoji: string | null;
    xpPerRep: number;
    coinsPerRep: number;
    announceChannelId: string | null;
    minAccountAgeDays: number;
    minMemberDays: number;
    sameMemberCooldownDays: number;
    excludedRoleIds: string[];
    excludedChannelIds: string[];
    tiers: Array<{ threshold: number; roleId: string }>;
  } = {
    dailyLimit: 3,
    reactionEnabled: false,
    reactionEmoji: null,
    xpPerRep: 0,
    coinsPerRep: 0,
    announceChannelId: null,
    minAccountAgeDays: 0,
    minMemberDays: 0,
    sameMemberCooldownDays: 1,
    excludedRoleIds: [],
    excludedChannelIds: [],
    tiers: [],
  };
  const repPool = () => members().slice(0, 8);
  const repVotes = () => {
    const pool = repPool();
    return pool.slice(1, 6).map((receiver, i) => {
      const giver = pool[(i + 3) % pool.length];
      return {
        id: `rep-${i}`,
        kind: 'VOTE' as const,
        value: 1,
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
    for (const key of ['dailyLimit', 'xpPerRep', 'coinsPerRep', 'minAccountAgeDays', 'minMemberDays', 'sameMemberCooldownDays'] as const) {
      if (typeof body?.[key] === 'number') repConfig[key] = body[key];
    }
    for (const key of ['excludedRoleIds', 'excludedChannelIds'] as const) {
      if (Array.isArray(body?.[key])) repConfig[key] = [...body[key]];
    }
    if (typeof body?.reactionEnabled === 'boolean') repConfig.reactionEnabled = body.reactionEnabled;
    if (body && 'reactionEmoji' in body) repConfig.reactionEmoji = body.reactionEmoji;
    if (body && 'announceChannelId' in body) repConfig.announceChannelId = body.announceChannelId;
    if (Array.isArray(body?.tiers)) repConfig.tiers = [...body.tiers].sort((a, b) => a.threshold - b.threshold);
    return { config: { ...repConfig } };
  });

  route('DELETE', '/api/dashboard/guilds/:guildId/reputation/votes/:voteId', () => ({ deleted: true }));

  route('GET', '/api/dashboard/guilds/:guildId/reputation/members/:userId', ({ params }) => {
    const received = repVotes().filter((v) => v.receiverId === params.userId);
    return {
      totalRep: 12 + received.length,
      rank: 4,
      receivedVotes: 12 + received.length,
      givenVotes: 7,
      receivedLast7Days: received.length,
      recent: received.map((v) => ({ id: v.id, kind: v.kind, value: v.value, giverId: v.giverId, giverName: v.giverName, reason: v.reason, createdAt: v.createdAt })),
    };
  });

  route('POST', '/api/dashboard/guilds/:guildId/reputation/adjustments', ({ body }) => {
    const amount = typeof body?.amount === 'number' ? body.amount : 0;
    return { before: 12, after: Math.max(0, 12 + amount) };
  });

  route('POST', '/api/dashboard/guilds/:guildId/reputation/reset', ({ body }) => (
    body?.scope === 'guild' ? { removed: 412, members: 37 } : { removed: 12 }
  ));

  // ── Suggestions ────────────────────────────────────────────────────────────
  // Une file avec une suggestion en souffrance, pour que le conseil se voie.
  const suggestionConfig = {
    channelId: '900000000000000320',
    requireComment: true,
    voteWhileApproved: false,
    allowedRoleIds: [] as string[],
    cooldownMinutes: 30,
    minAccountAgeDays: 0,
    minMemberDays: 0,
    notifyAuthor: true,
    createThread: true,
    voteThreshold: 10 as number | null,
    pinAtThreshold: false,
    rewardXp: 200,
    rewardCoins: 500,
    categories: ['Événements', 'Salons', 'Bot'],
    showVoters: true,
  };
  const suggestionSeed: Array<[string | null, string | null, string, string, number, number, string, string | null]> = [
    ['Soirée film mensuelle', 'Événements', 'Une soirée film par mois dans le salon vocal.', 'PENDING', 14, 2, ago(3 * 60), null],
    [null, 'Salons', 'Un salon dédié aux memes, pour aérer le général.', 'PENDING', 9, 4, ago(10 * DAY), null],
    ['Bot musique', 'Bot', 'Ajouter un bot musique pour les soirées.', 'PENDING', 3, 6, ago(26 * 60), null],
    ['Rôles de couleur', null, 'Des rôles de couleur à débloquer avec les niveaux.', 'IMPLEMENTED', 22, 1, ago(18 * DAY), 'C’est en place : rendez-vous dans le salon des rôles.'],
    [null, 'Événements', 'Un tournoi mensuel avec des récompenses.', 'IN_PROGRESS', 17, 3, ago(9 * DAY), 'Bonne idée, on prépare le premier pour la fin du mois.'],
    [null, 'Salons', 'Supprimer le mode lent du salon général.', 'REJECTED', 5, 11, ago(6 * DAY), 'Le mode lent reste : il limite le spam aux heures de pointe.'],
  ];
  const acceptedStatuses = ['APPROVED', 'IN_PROGRESS', 'IMPLEMENTED'];
  let suggestions = suggestionSeed.map(([title, category, content, status, upvotes, downvotes, createdAt, responseText], i) => {
    const author = members()[(i * 3 + 1) % members().length];
    const decided = status !== 'PENDING';
    return {
      id: `demo-suggestion-${i + 1}`,
      userId: author.id,
      username: author.displayName,
      avatarUrl: null,
      title,
      category,
      content,
      status,
      responseText,
      respondedById: decided ? members()[1].id : null,
      respondedByName: decided ? members()[1].displayName : null,
      respondedAt: decided ? new Date(Date.parse(createdAt) + 2 * DAY * 60_000).toISOString() : null,
      upvotes,
      downvotes,
      createdAt,
      messageUrl: null,
      threadUrl: null,
      thresholdReachedAt: upvotes >= 10 ? createdAt : null,
      rewarded: acceptedStatuses.includes(status) ? { xp: 200, coins: 500 } : { xp: 0, coins: 0 },
    };
  });

  const categoryStats = () => {
    const byCategory = new Map<string | null, { category: string | null; total: number; pending: number; accepted: number }>();
    for (const s of suggestions) {
      const entry = byCategory.get(s.category) ?? { category: s.category, total: 0, pending: 0, accepted: 0 };
      entry.total += 1;
      if (s.status === 'PENDING') entry.pending += 1;
      else if (acceptedStatuses.includes(s.status)) entry.accepted += 1;
      byCategory.set(s.category, entry);
    }
    return [...byCategory.values()].sort((a, b) => b.total - a.total);
  };

  route('GET', '/api/dashboard/guilds/:guildId/suggestions', () => {
    const pending = suggestions.filter((s) => s.status === 'PENDING');
    return {
      config: { ...suggestionConfig, allowedRoleIds: [...suggestionConfig.allowedRoleIds], categories: [...suggestionConfig.categories] },
      stats: { pending: pending.length, stalePending: 1, createdRecent: 11, resolvedRecent: 8, acceptanceRate: 0.63, avgResponseHours: 31, lastCreatedAt: ago(3 * 60) },
      queue: [...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
      queueTruncated: false,
      categoryStats: categoryStats(),
      messageLabels: {
        locale: 'fr',
        title: 'Nouvelle suggestion',
        statusField: 'Statut',
        votesField: 'Votes',
        finalVotesField: 'Votes finaux',
        votesValue: 'Pour : `{up}` | Contre : `{down}`',
        responseField: 'Réponse de la modération',
        noResponse: 'Aucun commentaire.',
        categoryField: 'Catégorie',
        voteUp: 'Pour',
        voteDown: 'Contre',
        footer: 'ID de la suggestion : {id}',
        status: { PENDING: 'En cours d’évaluation', APPROVED: 'Approuvée par le staff', IN_PROGRESS: 'En cours de réalisation', REJECTED: 'Refusée par le staff', IMPLEMENTED: 'Mise en place' },
      },
    };
  });

  route('GET', '/api/dashboard/guilds/:guildId/suggestions/list', ({ query }) => {
    const status = query.get('status');
    const userId = query.get('userId');
    const category = query.get('category');
    const list = suggestions
      .filter((s) => (!status || s.status === status) && (!userId || s.userId === userId))
      .filter((s) => !category || (category === 'none' ? s.category === null : s.category === category))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { suggestions: list, nextCursor: null };
  });

  route('PATCH', '/api/dashboard/guilds/:guildId/suggestions/config', ({ body }) => {
    if (body && 'channelId' in body) suggestionConfig.channelId = body.channelId;
    for (const key of ['requireComment', 'voteWhileApproved', 'notifyAuthor', 'createThread', 'pinAtThreshold', 'showVoters'] as const) {
      if (typeof body?.[key] === 'boolean') suggestionConfig[key] = body[key];
    }
    if (Array.isArray(body?.categories)) suggestionConfig.categories = [...body.categories];
    for (const key of ['cooldownMinutes', 'minAccountAgeDays', 'minMemberDays', 'rewardXp', 'rewardCoins'] as const) {
      if (typeof body?.[key] === 'number') suggestionConfig[key] = body[key];
    }
    if (body && 'voteThreshold' in body) suggestionConfig.voteThreshold = body.voteThreshold;
    if (Array.isArray(body?.allowedRoleIds)) suggestionConfig.allowedRoleIds = [...body.allowedRoleIds];
    return { config: { ...suggestionConfig, allowedRoleIds: [...suggestionConfig.allowedRoleIds], categories: [...suggestionConfig.categories] } };
  });

  route('POST', '/api/dashboard/guilds/:guildId/suggestions/:suggestionId/resolve', ({ params, body }) => {
    const suggestion = suggestions.find((s) => s.id === params.suggestionId);
    if (!suggestion) return { error: 'Suggestion introuvable' };
    const reopen = body?.status === 'PENDING';
    Object.assign(suggestion, {
      status: body?.status ?? suggestion.status,
      responseText: reopen ? null : body?.responseText ?? null,
      respondedById: reopen ? null : PEOPLE[0].id,
      respondedByName: reopen ? null : PEOPLE[0].displayName,
      respondedAt: reopen ? null : new Date().toISOString(),
    });
    return { suggestion: { ...suggestion } };
  });

  route('DELETE', '/api/dashboard/guilds/:guildId/suggestions/:suggestionId', ({ params }) => {
    suggestions = suggestions.filter((s) => s.id !== params.suggestionId);
    return { deleted: true };
  });

  route('GET', '/api/dashboard/guilds/:guildId/suggestions/:suggestionId/voters', ({ params }) => {
    const suggestion = suggestions.find((s) => s.id === params.suggestionId);
    const pool = members();
    const voter = (p: (typeof pool)[number]) => ({ userId: p.id, name: p.displayName, avatarUrl: null });
    return {
      up: pool.slice(0, suggestion?.upvotes ?? 0).map(voter),
      // Les derniers membres de la liste, pour ne pas recroiser les votes pour.
      down: pool.slice(pool.length - Math.min(suggestion?.downvotes ?? 0, pool.length)).map(voter),
    };
  });

  route('POST', '/api/dashboard/guilds/:guildId/suggestions/refresh', () => ({
    total: suggestions.length,
  }));

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
