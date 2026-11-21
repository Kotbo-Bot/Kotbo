/**
 * Jeu RPG (sous Économie) : objets, bestiaire, quêtes, pêche, donjons, titres,
 * recettes, raid, joueurs, aventures et guildes. Lignes construites sur les
 * modèles Prisma (`row`), réponses aux formes de `routes/dashboard/economy.ts`.
 * La tour et la tour de clan restent sur le repli sûr de la démo.
 */
import { route } from '../backend';
import { demoDb, demoId } from '../db';
import { row } from '../model';
import { G } from '../crud';
import { DAY, HOUR, MEMBERS, ago, avatarOf, personById } from '../fixtures';
import { DEMO_GUILD_ID } from '../mode';

const E = `${G}/economy`;
const players = () => MEMBERS.filter((m) => !m.bot).slice(0, 14);

const item = (id: string, name: string, emoji: string, type: string, price: number, extra: Record<string, unknown> = {}) =>
  row('RpgItem', { id, guildId: null, name, emoji, type, price, description: '', purchasable: true, ...extra });

const itemsSeed = () => [
  item('health_potion', 'Potion de soin', '🧪', 'CONSUMABLE', 50, { hpRestore: 50, rarity: 'COMMON' }),
  item('energy_drink', 'Boisson énergisante', '⚡', 'CONSUMABLE', 80, { energyRestore: 20, rarity: 'COMMON' }),
  item('wood_sword', 'Épée en bois', '🪵', 'WEAPON', 120, { atkBonus: 3, rarity: 'COMMON' }),
  item('iron_sword', 'Épée en fer', '🗡️', 'WEAPON', 450, { atkBonus: 8, levelRequired: 5, rarity: 'UNCOMMON' }),
  item('dragon_blade', 'Lame du dragon', '🐉', 'WEAPON', 4_800, { atkBonus: 25, levelRequired: 20, rarity: 'LEGENDARY', purchasable: false, blackMarketEligible: true }),
  item('leather_armor', 'Armure de cuir', '🦺', 'ARMOR', 200, { defBonus: 4, rarity: 'COMMON' }),
  item('knight_armor', 'Armure de chevalier', '🛡️', 'ARMOR', 1_400, { defBonus: 14, hpBonus: 30, levelRequired: 12, rarity: 'RARE' }),
  item('swift_ring', 'Anneau de vitesse', '💍', 'ACCESSORY', 900, { spdBonus: 6, rarity: 'RARE' }),
  item('golden_rod', 'Canne dorée', '🎣', 'TOOL', 1_100, { rarity: 'EPIC', guildId: DEMO_GUILD_ID }),
  item('slime_gel', 'Gelée de slime', '🟢', 'MATERIAL', 5, { purchasable: false, rarity: 'COMMON' }),
  item('dragon_scale', 'Écaille de dragon', '🔴', 'MATERIAL', 300, { purchasable: false, rarity: 'EPIC' }),
];

const monster = (id: string, name: string, emoji: string, level: number, extra: Record<string, unknown> = {}) =>
  row('RpgMonster', {
    id, guildId: DEMO_GUILD_ID, name, emoji, level, health: 40 + level * 18, attack: 5 + level * 3, defense: 2 + level * 2, speed: 5 + level,
    xpReward: 10 + level * 6, coinReward: 5 + level * 4, drops: [], enabled: true, ...extra,
  });

function monstersSeed() {
  return [
    monster('mon-1', 'Slime', '🟢', 1, { description: 'Gluant mais inoffensif.', drops: [{ itemName: 'Gelée de slime', chance: 0.6, min: 1, max: 3 }] }),
    monster('mon-2', 'Gobelin', '👺', 4, { description: 'Vole les pièces des imprudents.' }),
    monster('mon-3', 'Loup des ombres', '🐺', 8),
    monster('mon-4', 'Golem de pierre', '🗿', 14, { defense: 60 }),
    monster('mon-5', 'Dragon ancien', '🐉', 25, { isBoss: true, bossRespawnHours: 24, clanPoints: 50, firstKillCoinReward: 5_000, firstKillXpReward: 2_000, drops: [{ itemName: 'Écaille de dragon', chance: 0.4, min: 1, max: 2 }] }),
  ].map((m, i) => ({
    ...m,
    battles: { battles: 420 - i * 70, wins: Math.round((420 - i * 70) * (0.92 - i * 0.12)) },
    offDifficulty: i === 3 ? 'TOO_HARD' : null,
    firstKill: m.isBoss ? { userId: players()[1].id, displayName: players()[1].displayName, killedAt: ago(30 * DAY) } : null,
  }));
}

const questsSeed = () => [
  row('RpgQuest', { id: 'rq-1', guildId: DEMO_GUILD_ID, name: 'Chasseur de slimes', emoji: '🟢', objective: 'MONSTER_KILLS', target: 20, scope: 'MEMBER', repeatable: true, windowHours: 24, rewardCoins: 150, rewardXp: 80, enabled: true, createdAt: ago(20 * DAY) }),
  row('RpgQuest', { id: 'rq-2', guildId: DEMO_GUILD_ID, name: 'Pêche miraculeuse', emoji: '🎣', objective: 'FISH_CAUGHT', target: 15, scope: 'MEMBER', repeatable: true, windowHours: 168, rewardCoins: 400, rewardXp: 150, enabled: true, createdAt: ago(18 * DAY) }),
  row('RpgQuest', { id: 'rq-3', guildId: DEMO_GUILD_ID, name: 'Assaut collectif', emoji: '⚔️', objective: 'RAID_DAMAGE', target: 50_000, scope: 'TEAM', repeatable: false, windowHours: 168, rewardCoins: 1_000, rewardClanPoints: 100, enabled: true, createdAt: ago(5 * DAY) }),
].map((q) => ({ ...q, windowEndsAt: new Date(Date.now() + q.windowHours * HOUR * 60_000 * 0.4).toISOString() }));

const fishSeed = () => [
  ['Gardon', '🐟', 'COMMON', 5, 3], ['Truite', '🐠', 'UNCOMMON', 20, 8], ['Saumon royal', '🍣', 'RARE', 80, 25], ['Poisson-lune', '🌙', 'EPIC', 300, 70], ['Léviathan doré', '🐋', 'LEGENDARY', 2_000, 400],
].map(([name, emoji, rarity, value, xp], i) => ({ ...row('RpgFish', { id: `fish-${i}`, guildId: DEMO_GUILD_ID, name, emoji, rarity, value, xp, enabled: true }), key: `fish-${i}`, caught: [820, 260, 74, 12, 1][i] }));

const dungeonsSeed = () => [
  row('RpgDungeon', { id: 'dg-1', guildId: DEMO_GUILD_ID, name: 'Grotte des slimes', emoji: '🕳️', description: 'Trois salles et un slime géant.', levelRequired: 3, energyCost: 10, cooldownHours: 6, bossNames: ['Slime', 'Gobelin'], completionCoins: 300, completionXp: 150, enabled: true, firstClearUserId: players()[2].id, firstClearAt: ago(25 * DAY) }),
  row('RpgDungeon', { id: 'dg-2', guildId: DEMO_GUILD_ID, name: 'Repaire du dragon', emoji: '🌋', description: 'Seuls les plus forts en reviennent.', levelRequired: 20, energyCost: 40, cooldownHours: 24, bossNames: ['Golem de pierre', 'Dragon ancien'], completionCoins: 4_000, completionXp: 1_500, completionItemName: 'Écaille de dragon', firstClearCoins: 10_000, enabled: true }),
].map((d, i) => ({
  ...d,
  floors: d.bossNames.map((name: string) => {
    const boss = monstersSeed().find((m) => m.name === name);
    return { bossName: name, found: !!boss, emoji: boss?.emoji ?? null, level: boss?.level ?? null, bossEnabled: boss?.enabled ?? null };
  }),
  runs: [184, 37][i] ?? 0,
  completions: [151, 9][i] ?? 0,
  defeats: [33, 28][i] ?? 0,
  completionTitle: null,
  firstClearTitle: null,
  firstClear: d.firstClearUserId ? { userId: d.firstClearUserId, displayName: personById(d.firstClearUserId)?.displayName ?? null, at: d.firstClearAt } : null,
}));

const titlesSeed = () => [
  { ...row('RpgTitle', { id: 'tt-1', guildId: DEMO_GUILD_ID, name: 'Tueur de dragons', description: 'A vaincu le dragon ancien.', color: '#ef4444', attackBonus: 5 }), owners: [{ userId: players()[1].id, displayName: players()[1].displayName, avatarUrl: avatarOf(players()[1]), obtainedAt: ago(30 * DAY) }] },
  { ...row('RpgTitle', { id: 'tt-2', guildId: DEMO_GUILD_ID, name: 'Pêcheur légendaire', description: 'A pêché un léviathan doré.', color: '#eab308', speedBonus: 3 }), owners: [{ userId: players()[6].id, displayName: players()[6].displayName, avatarUrl: avatarOf(players()[6]), obtainedAt: ago(8 * DAY) }] },
  { ...row('RpgTitle', { id: 'tt-3', guildId: DEMO_GUILD_ID, name: 'Explorateur', description: 'A fini tous les donjons.', color: '#22d3ee', healthBonus: 20 }), owners: [] },
];

const recipesSeed = () => [
  row('RpgRecipe', { id: 'rec-1', guildId: DEMO_GUILD_ID, resultItemId: 'knight_armor', ingredients: [{ itemName: 'Armure de cuir', quantity: 1 }, { itemName: 'Écaille de dragon', quantity: 2 }], coinCost: 500, levelRequired: 12 }),
  row('RpgRecipe', { id: 'rec-2', guildId: DEMO_GUILD_ID, resultItemId: 'health_potion', ingredients: [{ itemName: 'Gelée de slime', quantity: 3 }], coinCost: 10, levelRequired: 1 }),
].map((r) => {
  const result = itemsSeed().find((i) => i.id === r.resultItemId);
  return { ...r, resultItem: result ? { id: result.id, name: result.name, emoji: result.emoji, rarity: result.rarity, type: result.type } : { id: r.resultItemId, name: r.resultItemId, emoji: '📦', rarity: 'COMMON', type: 'MATERIAL' }, editable: true };
});

const raidSeed = () => ({
  bosses: [row('RpgRaidBoss', { id: 'rb-1', guildId: DEMO_GUILD_ID, name: 'Titan de lave', emoji: '🌋', level: 30, attack: 180, defense: 90, speed: 30, spells: [{ id: 'crushing_blow', name: 'Frappe écrasante', emoji: '💥', icon: 'AlertTriangle', description: 'Un coup massif à 190 % de dégâts.' }], enabled: true, description: 'Le boss de raid de la semaine.' })],
  spells: [{ id: 'crushing_blow', name: 'Frappe écrasante', emoji: '💥', icon: 'AlertTriangle', description: 'Un coup massif à 190 % de dégâts.' }],
  state: { enabled: true, teamMode: 'CLANS', nextOpensAt: ago(-2 * DAY), open: null as any, teams: [] as any[] },
  recap: null,
  history: [{
    id: 'raid-old', bossName: 'Titan de lave', bossEmoji: '🌋', opensAt: ago(9 * DAY), resolvedAt: ago(8 * DAY),
    teams: [
      { id: 'rt-1', teamName: 'Kraken', defeated: true, defeatedAt: ago(8 * DAY + 120), remainingHealth: 0, totalHealth: 250_000 },
      { id: 'rt-2', teamName: 'Phénix', defeated: false, defeatedAt: null, remainingHealth: 31_400, totalHealth: 250_000 },
    ],
  }],
});

const eventsSeed = () => [
  row('RpgAdventureEvent', { id: 'ae-1', guildId: DEMO_GUILD_ID, title: 'Un marchand ambulant', emoji: '🧳', description: 'Un vieil homme te propose une potion mystérieuse.', choices: [{ text: 'Acheter (50 pièces)', coins: -50, hp: 40 }, { text: 'Passer ton chemin', coins: 0 }] }),
  row('RpgAdventureEvent', { id: 'ae-2', guildId: DEMO_GUILD_ID, title: 'Un coffre piégé', emoji: '🧰', description: 'Le coffre brille, mais le sol est bizarre…', choices: [{ text: 'L’ouvrir', coins: 200, hp: -20 }, { text: 'Le laisser', coins: 0 }] }),
].map((e) => ({ ...e, enabled: true }));

function playersList() {
  const items = itemsSeed();
  return players().map((p, i) => {
    const weapon = items.find((x) => x.id === ['dragon_blade', 'iron_sword', 'wood_sword'][i % 3]);
    const armor = items.find((x) => x.id === ['knight_armor', 'leather_armor'][i % 2]);
    return {
      ...row('RpgProfile', { id: `rp-${p.id}`, guildId: DEMO_GUILD_ID, userId: p.id, balance: p.coins, level: Math.max(1, 30 - i * 2), xp: p.xp % 5_000, health: 100 + i * 5, maxHealth: 120 + i * 10, energy: 60, className: ['Guerrier', 'Mage', 'Voleur', 'Archer'][i % 4], totalMonstersKilled: 900 - i * 55, totalBossesKilled: Math.max(0, 6 - i), totalFishCaught: 120 - i * 7, weaponId: weapon?.id ?? null, armorId: armor?.id ?? null, rpgGuildId: i < 6 ? 'rg-1' : i < 10 ? 'rg-2' : null }),
      rpgGuild: i < 6 ? { id: 'rg-1', name: 'Les Chevaliers de Nova' } : i < 10 ? { id: 'rg-2', name: 'La Confrérie du Slime' } : null,
      username: p.username,
      displayName: p.displayName,
      avatarUrl: avatarOf(p),
      weapon: weapon ? { name: weapon.name, emoji: weapon.emoji, atkBonus: weapon.atkBonus } : null,
      armor: armor ? { name: armor.name, emoji: armor.emoji, defBonus: armor.defBonus } : null,
      accessories: [],
      bagSize: 12 + i,
    };
  });
}

function guildsList() {
  const list = playersList();
  const guild = (id: string, name: string, emoji: string, level: number, treasury: number) => {
    const members = list.filter((p) => p.rpgGuildId === id);
    return { ...row('RpgGuild', { id, guildId: DEMO_GUILD_ID, name, emoji, level, treasury, ownerId: members[0]?.userId ?? '', description: 'Guilde du serveur de démo.' }), ownerName: members[0]?.displayName ?? null, members: members.map((m, i) => ({ userId: m.userId, role: i === 0 ? 'OWNER' : 'MEMBER', joinedAt: ago((20 - i) * DAY), displayName: m.displayName })) };
  };
  return [guild('rg-1', 'Les Chevaliers de Nova', '🛡️', 7, 18_400), guild('rg-2', 'La Confrérie du Slime', '🟢', 4, 6_200)];
}

/** Liste modifiable en mémoire : GET rend `{ [key]: liste }`, POST/PATCH/DELETE la modifient. */
function editable<T extends { id: string }>(path: string, key: string, seed: () => T[], extra: () => Record<string, unknown> = () => ({})) {
  const all = () => demoDb.get(`rpg/${key}`, seed);
  route('GET', `${E}/${path}`, () => ({ [key]: all(), ...extra() }));
  route('POST', `${E}/${path}`, ({ body }) => {
    const created = { ...(seed()[0] ?? {}), ...(body ?? {}), id: body?.id ?? demoId() } as T;
    demoDb.set(`rpg/${key}`, [...all(), created]);
    return { success: true, [key.replace(/s$/, '')]: created };
  });
  route('PATCH', `${E}/${path}/:id`, ({ params, body }) => {
    demoDb.set(`rpg/${key}`, all().map((x) => (x.id === params.id ? { ...x, ...(body ?? {}) } : x)));
    return { success: true };
  });
  route('DELETE', `${E}/${path}/:id`, ({ params }) => {
    demoDb.set(`rpg/${key}`, all().filter((x) => x.id !== params.id));
    return { success: true };
  });
}

export function registerRpgRoutes(): void {
  editable('items', 'items', itemsSeed);
  editable('monsters', 'monsters', monstersSeed, () => ({
    battleStatsDays: 30,
    samples: { boss: 12, monster: 1_284 },
    recommendations: { boss: null, monster: null },
  }));
  editable('quests', 'quests', questsSeed, () => ({
    objectives: ['MONSTER_KILLS', 'BOSS_KILLS', 'RAID_ASSAULTS', 'RAID_DAMAGE', 'ITEMS_LOOTED', 'FISH_CAUGHT', 'ITEMS_CRAFTED', 'UPGRADES_SUCCEEDED', 'SHOP_PURCHASES', 'BLACK_MARKET_PURCHASES', 'COINS_SPENT', 'ADVENTURES_COMPLETED', 'DAILY_CLAIMS', 'TOWER_FLOORS', 'TOWER_MONSTER_KILLS', 'TOWER_BOSS_KILLS'],
    scopes: ['MEMBER', 'TEAM'],
  }));
  route('GET', `${E}/fish`, () => ({ rarityWeights: { COMMON: 60, UNCOMMON: 25, RARE: 10, EPIC: 4, LEGENDARY: 1 }, species: demoDb.get('rpg/fish', fishSeed), rewards: [{ tier: 5, coins: 500, itemName: null }, { tier: 10, coins: 2_000, itemName: 'Canne dorée' }] }));
  route('POST', `${E}/fish`, ({ body }) => {
    const fish = { ...fishSeed()[0], ...(body ?? {}), id: demoId(), key: demoId(), caught: 0 };
    demoDb.update('rpg/fish', fishSeed, (list) => [...list, fish]);
    return { success: true, fish };
  });
  route('PATCH', `${E}/fish/:key`, ({ params, body }) => {
    demoDb.update('rpg/fish', fishSeed, (list) => list.map((f) => (f.key === params.key ? { ...f, ...(body ?? {}) } : f)));
    return { success: true };
  });
  route('DELETE', `${E}/fish/:key`, ({ params }) => {
    demoDb.update('rpg/fish', fishSeed, (list) => list.filter((f) => f.key !== params.key));
    return { success: true };
  });
  editable('dungeons', 'dungeons', dungeonsSeed, () => ({
    bosses: monstersSeed().map((m) => ({ name: m.name, emoji: m.emoji, level: m.level, health: m.health, attack: m.attack, defense: m.defense, speed: m.speed, xpReward: m.xpReward, coinReward: m.coinReward, enabled: m.enabled })),
    limits: { floorsMax: 10, dungeonsMax: 20 },
  }));
  route('DELETE', `${E}/dungeons/:id/first-clear`, () => ({ success: true }));
  editable('titles', 'titles', titlesSeed);
  route('POST', `${E}/titles/:id/owners`, () => ({ success: true }));
  route('DELETE', `${E}/titles/:id/owners/:userId`, () => ({ success: true }));
  editable('recipes', 'recipes', recipesSeed);
  route('GET', `${E}/raid`, () => demoDb.get('rpg/raid', raidSeed));
  route('POST', `${E}/raid/start`, () => {
    const next = demoDb.update('rpg/raid', raidSeed, (r) => ({ ...r, state: { ...r.state, open: { id: demoId(), bossId: 'rb-1', startedAt: new Date().toISOString(), endsAt: ago(-2 * HOUR), damage: 0, health: 250_000 }, teams: [] } }));
    return { success: true, ...next };
  });
  route('POST', `${E}/raid/seed`, () => ({ success: true }));
  route('POST', `${E}/raid/bosses`, ({ body }) => {
    demoDb.update('rpg/raid', raidSeed, (r) => ({ ...r, bosses: [...r.bosses, row('RpgRaidBoss', { ...(body ?? {}), id: demoId(), guildId: DEMO_GUILD_ID })] }));
    return { success: true };
  });
  route('DELETE', `${E}/raid/bosses/:id`, ({ params }) => {
    demoDb.update('rpg/raid', raidSeed, (r) => ({ ...r, bosses: r.bosses.filter((b) => b.id !== params.id) }));
    return { success: true };
  });
  route('GET', `${E}/players`, () => ({ players: playersList() }));
  route('PATCH', `${E}/players/:userId`, () => ({ success: true }));
  route('GET', `${E}/players/:userId/inventory`, () => ({
    inventory: itemsSeed().slice(0, 5).map((it, i) => ({ id: `inv-${i}`, itemId: it.id, quantity: [5, 2, 1, 1, 12][i], item: it })),
  }));
  route('POST', `${E}/players/:userId/inventory`, () => ({ success: true }));
  route('DELETE', `${E}/players/:userId/inventory/:itemId`, () => ({ success: true }));
  editable('events', 'events', eventsSeed, () => ({ limits: { titleMax: 80, descriptionMax: 500, choicesMax: 4, choiceTextMax: 80 } }));
  route('GET', `${E}/guilds`, () => ({ guilds: guildsList() }));
  route('PATCH', `${E}/guilds/:id`, () => ({ success: true }));
  route('DELETE', `${E}/guilds/:id/members/:userId`, () => ({ success: true }));
  route('DELETE', `${E}/guilds/:id`, () => ({ success: true }));
  route('POST', `${E}/monsters/difficulty`, () => ({ success: true, updated: 3 }));
  route('POST', `${E}/items/difficulty`, () => ({ success: true, updated: 4 }));
  route('POST', `${E}/reset`, () => ({ success: true }));
  // Tour : réglages d'usine de la page (elle comble ce qui manque), aucune course jouée.
  route('GET', `${E}/tower`, () => ({ settings: {}, rewards: [], leaderboard: [], foes: [], deathMap: {}, insights: null, daily: { leaderboard: [] } }));
  route('GET', `${E}/tower/clan`, () => ({ clansEnabled: true, settings: {}, current: null, last: null, nextOpensAt: null, items: itemsSeed(), titles: titlesSeed() }));
  for (const path of ['tower', 'tower/layout', 'tower/clan', 'tower/clan/layout', 'tower/rewards', 'tower/reset', 'tower/season']) route('POST', `${E}/${path}`, () => ({ success: true }));
  route('POST', `${E}/tower/preview`, () => ({ rows: [] }));
}
