/**
 * Clans : quatre clans du serveur, leur saison, les paris entre membres et les
 * dettes de points. Formes de `api/clans.ts` (ClansDataResult, ClanBetEntry).
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { G } from '../crud';
import { DAY, MEMBERS, ago, channelByName } from '../fixtures';

const people = () => MEMBERS.filter((m) => !m.bot);

const CLANS = [
  { id: 'clan-1', name: 'Phénix', description: 'Renaître plus fort à chaque saison.', roleId: '900000000000000231', memberCount: 34, totalXp: 48_200 },
  { id: 'clan-2', name: 'Kraken', description: 'Les profondeurs nous appartiennent.', roleId: '900000000000000232', memberCount: 31, totalXp: 44_900 },
  { id: 'clan-3', name: 'Griffon', description: 'Vigilance et loyauté.', roleId: '900000000000000233', memberCount: 29, totalXp: 39_700 },
  { id: 'clan-4', name: 'Hydre', description: 'Coupe une tête, deux repoussent.', roleId: '900000000000000234', memberCount: 27, totalXp: 36_100 },
];

const configSeed = () => ({
  clansEnabled: true,
  clanAutoAssignOnJoin: true,
  clanWeeklyDigest: true,
  currentClanSeason: 4,
  clanXpFromLevelUp: true,
  clanXpPerLevelUp: 50,
  clanXpLevelUpProportional: true,
  clanXpReferenceLevel: 10,
  clanXpFromBoost: true,
  clanXpPerBoost: 500,
  clanAnnouncementChannelId: channelByName('annonces').id,
  clanPointsFeedChannelId: channelByName('niveaux').id,
  clanRewardGiveaway: true,
  clanRewardXpBoost: true,
  clanRewardXpBoostRate: 1.2,
  clanRewardLeaderRole: true,
  lastWinningClanId: 'clan-2',
  clanSeasonStartsAt: ago(18 * DAY),
  clanSeasonEndsAt: ago(-12 * DAY),
  betsEnabled: true,
  betChannelId: channelByName('général').id,
  betAnnouncementChannelId: channelByName('annonces').id,
  betMinStake: 10,
  betMaxStake: 500,
  betMaxOpenPerMember: 3,
  betAcceptWindowHours: 24,
  betAllowDebt: true,
  betMaxDebt: 300,
  betDebtResetOnSeason: true,
  betResolverRoleIds: [],
  betAllowPool: true,
  betAllowTeams: true,
  betAllowOpen: true,
  betStakeMode: 'FIXED',
  betMaxParticipants: 10,
  betMaxSides: 4,
  betSeasonRewardEnabled: true,
  betSeasonRewardRoleId: null,
  betRewardTop1: 300,
  betRewardTop2: 150,
  betRewardTop3: 75,
  clans: CLANS.map((c) => ({ ...c, generalChannelId: null, leaderRoleId: null })),
  taskInProgress: null,
});

function betsSeed() {
  const p = people();
  const member = (i: number, clan: string, status = 'ACCEPTED', engaged = 100, payout = 0) => ({ userId: p[i].id, displayName: p[i].displayName, clanName: clan, status, engaged, debt: 0, payout });
  return {
    bets: [
      { id: 'bet-1', subject: 'Qui gagne la finale du tournoi ?', stake: 100, stakeMode: 'FIXED', shape: 'DUEL', access: 'OPEN', season: 4, status: 'OPEN', pot: 400, creditUsed: 0, winningSideId: null, resolvedById: null, resolvedAt: null, createdAt: ago(2 * DAY),
        sides: [
          { id: 'side-1', label: 'Les Licornes', capacity: null, won: false, members: [member(6, 'Phénix'), member(7, 'Phénix')] },
          { id: 'side-2', label: 'Team Zen', capacity: null, won: false, members: [member(3, 'Kraken'), member(8, 'Griffon')] },
        ] },
      { id: 'bet-2', subject: 'Phénix finit premier de la saison', stake: 50, stakeMode: 'FIXED', shape: 'DUEL', access: 'OPEN', season: 4, status: 'RESOLVED', pot: 200, creditUsed: 50, winningSideId: 'side-4', resolvedById: p[1].id, resolvedAt: ago(DAY), createdAt: ago(6 * DAY),
        sides: [
          { id: 'side-3', label: 'Oui', capacity: null, won: false, members: [member(9, 'Phénix', 'LOST', 50)] },
          { id: 'side-4', label: 'Non', capacity: null, won: true, members: [member(10, 'Kraken', 'WON', 50, 100), member(11, 'Hydre', 'WON', 50, 100)] },
        ] },
    ],
    debts: [{ userId: p[9].id, displayName: p[9].displayName, amount: 50, engaged: 0, firm: 50, source: 'BET', createdAt: ago(DAY) }],
  };
}

export function registerClanRoutes(): void {
  const config = () => demoDb.get('clans', configSeed);
  const set = (fn: (c: ReturnType<typeof configSeed>) => ReturnType<typeof configSeed>) => demoDb.update('clans', configSeed, fn);
  route('GET', `${G}/clans`, () => config());
  route('PATCH', `${G}/clans`, ({ body }) => ({ success: true, ...set((c) => ({ ...c, ...(body ?? {}), clans: c.clans })) }));
  route('POST', `${G}/clans`, ({ body }) => {
    const clan = { id: demoId(), name: body?.name ?? 'Nouveau clan', description: body?.description ?? null, roleId: body?.roleId ?? demoId(), generalChannelId: null, leaderRoleId: null, memberCount: 0, totalXp: 0 };
    set((c) => ({ ...c, clans: [...c.clans, clan] }));
    return { success: true, clan };
  });
  route('PUT', `${G}/clans/:id`, ({ params, body }) => ({ success: true, ...set((c) => ({ ...c, clans: c.clans.map((k) => (k.id === params.id ? { ...k, ...(body ?? {}) } : k)) })) }));
  route('DELETE', `${G}/clans/:id`, ({ params }) => ({ success: true, ...set((c) => ({ ...c, clans: c.clans.filter((k) => k.id !== params.id) })) }));
  for (const action of ['distribute', 'clear', 'rebalance', 'reset-season', 'reset-all', 'rollback-season', 'points']) {
    route('POST', `${G}/clans/${action}`, () => ({ success: true, processed: people().length, total: people().length }));
  }
  route('POST', `${G}/clans/rebalance/preview`, () => ({
    moves: people().slice(20, 26).map((p, i) => ({ userId: p.id, displayName: p.displayName, fromClanId: 'clan-1', toClanId: CLANS[3 - (i % 2)].id, activity: 120 - i * 10 })),
    excluded: [],
    before: CLANS.map((c) => ({ clanId: c.id, members: c.memberCount })),
    after: CLANS.map((c, i) => ({ clanId: c.id, members: 30 + (i % 2) })),
  }));
  route('GET', `${G}/clans/bets`, () => {
    const data = demoDb.get('clans/bets', betsSeed);
    return { ...data, betCount: data.bets.length, debtCount: data.debts.length };
  });
  route('DELETE', `${G}/clans/bets/debts/:userId`, ({ params }) => {
    demoDb.update('clans/bets', betsSeed, (d) => ({ ...d, debts: d.debts.filter((x) => x.userId !== params.userId) }));
    return { success: true };
  });
}
