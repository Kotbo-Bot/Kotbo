/**
 * Donjons : édition depuis le dashboard, et parties des joueurs.
 *
 * Une partie vit en base et non dans un collecteur de boutons, pour survivre à un
 * redémarrage du bot. Elle se joue pourtant d'une traite : quitter le donjon la clôt, et
 * une trop longue inactivité compte comme une défaite (`DUNGEON_IDLE_TIMEOUT_MINUTES`).
 * Chaque écriture d'une partie est conditionnée à l'étage attendu : deux clics sur le même
 * bouton ne jouent qu'un combat, et un vieux message ne peut pas rejouer un étage franchi.
 */

import { EmbedBuilder, type Client } from 'discord.js';
import type { Prisma, RpgDungeon, RpgDungeonRun } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS } from '../../../utils/embeds.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';
import { checkLevelUp, getOrCreateEconomyConfig, getOrCreateRpgProfile } from '../economyService.js';
import { loadAvailableSkills, loadEffectiveStats, seedDefaultMonsters } from '../combatService.js';
import { listGuildMonsters, type ResolvedMonster } from './rpgBestiaryService.js';
import { addInventoryQuantity, lockRpgProfile } from './rpgInventoryWrites.js';
import { shouldAnnounceFirstKill } from './rpgBestiaryPolicy.js';
import { assertFirstKillRole, formatFirstKillReward, grantRpgRewardRole, type FirstKillResult } from './rpgFirstKillService.js';
import { assertGuildTitle, grantTitle } from './rpgTitleService.js';
import { pickDuelSkill, rollMonsterLoot, simulateDuel, type DuelResult } from './rpgDuel.js';
import {
  DUNGEON_MIN_HEALTH,
  DUNGEONS_PER_GUILD_MAX,
  dungeonPayout,
  dungeonReadyAt,
  groupDungeonLoot,
  hasFirstClearReward,
  isDungeonRunExpired,
  normalizeDungeonInput,
  parseDungeonLoot,
  type DungeonInput,
  type DungeonLoot,
} from './rpgDungeonPolicy.js';

export class DungeonError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DungeonError';
  }
}

export type DungeonRefusal =
  | { kind: 'not_found' }
  | { kind: 'disabled' }
  | { kind: 'broken' }
  | { kind: 'level'; level: number }
  | { kind: 'cooldown'; readyAt: Date }
  | { kind: 'energy'; energy: number; cost: number }
  | { kind: 'health' }
  | { kind: 'active_run' }
  | { kind: 'expired' }
  | { kind: 'stale' };

/** Refus d'une action de joueur, traduit par le panneau dans la langue du joueur. */
export class DungeonRefused extends Error {
  constructor(readonly refusal: DungeonRefusal) {
    super(`Donjon refusé : ${refusal.kind}`);
    this.name = 'DungeonRefused';
  }
}

export type DungeonFloor = { bossName: string; boss: ResolvedMonster | null };

/**
 * Boss du bestiaire effectif, désactivés compris : un boss retiré de la salle des boss reste
 * jouable en donjon, ce qui permet d'en réserver à un donjon.
 */
async function loadGuildBosses(guildId: string): Promise<Map<string, ResolvedMonster>> {
  await seedDefaultMonsters();
  const bosses = await listGuildMonsters(guildId, { isBoss: true, includeDisabled: true });
  return new Map(bosses.map((boss) => [boss.name, boss]));
}

function floorsOf(source: { bossNames: string[] }, bosses: Map<string, ResolvedMonster>): DungeonFloor[] {
  return source.bossNames.map((bossName) => ({ bossName, boss: bosses.get(bossName) ?? null }));
}

function isPlayable(floors: DungeonFloor[]): boolean {
  return floors.length > 0 && floors.every((floor) => floor.boss !== null);
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────

const DUNGEON_TITLES_INCLUDE = {
  completionTitle: { select: { name: true } },
  firstClearTitle: { select: { name: true } },
} as const satisfies Prisma.RpgDungeonInclude;

export type DungeonWithTitles = Prisma.RpgDungeonGetPayload<{ include: typeof DUNGEON_TITLES_INCLUDE }>;

export async function listDungeonBossChoices(guildId: string) {
  const bosses = await loadGuildBosses(guildId);
  return [...bosses.values()].map((boss) => ({
    name: boss.name,
    emoji: boss.emoji,
    level: boss.level,
    health: boss.health,
    attack: boss.attack,
    defense: boss.defense,
    speed: boss.speed,
    xpReward: boss.xpReward,
    coinReward: boss.coinReward,
    enabled: boss.enabled,
  }));
}

export async function listGuildDungeons(guildId: string) {
  const [dungeons, bosses, runs] = await Promise.all([
    prisma.rpgDungeon.findMany({
      where: { guildId },
      orderBy: [{ levelRequired: 'asc' }, { name: 'asc' }],
      include: DUNGEON_TITLES_INCLUDE,
    }),
    loadGuildBosses(guildId),
    prisma.rpgDungeonRun.groupBy({ by: ['dungeonId', 'status'], where: { guildId }, _count: { _all: true } }),
  ]);

  const countOf = (dungeonId: string, status?: string) => runs
    .filter((row) => row.dungeonId === dungeonId && (status === undefined || row.status === status))
    .reduce((sum, row) => sum + row._count._all, 0);

  return dungeons.map((dungeon) => ({
    ...dungeon,
    floors: floorsOf(dungeon, bosses).map(({ bossName, boss }) => ({
      bossName,
      found: boss !== null,
      emoji: boss?.emoji ?? null,
      level: boss?.level ?? null,
      bossEnabled: boss?.enabled ?? null,
    })),
    runs: countOf(dungeon.id),
    completions: countOf(dungeon.id, 'COMPLETED'),
    defeats: countOf(dungeon.id, 'DEFEATED'),
  }));
}

async function findGuildItem(client: Prisma.TransactionClient, guildId: string, name: string) {
  // L'objet du serveur l'emporte sur le livré du même nom, comme pour les butins.
  const items = await client.rpgItem.findMany({
    where: { name, OR: [{ guildId: null }, { guildId }] },
    select: { id: true, emoji: true, guildId: true },
  });
  return items.find((candidate) => candidate.guildId !== null) ?? items[0] ?? null;
}

async function findOwnedDungeon(guildId: string, dungeonId: string): Promise<RpgDungeon> {
  const dungeon = await prisma.rpgDungeon.findUnique({ where: { id: dungeonId } });
  if (!dungeon) throw new DungeonError('Donjon introuvable.', 404);
  if (dungeon.guildId !== guildId) throw new DungeonError('Ce donjon appartient à un autre serveur.', 403);
  return dungeon;
}

export async function saveGuildDungeon(
  client: Client,
  guildId: string,
  input: DungeonInput,
  dungeonId?: string,
): Promise<{ dungeon: RpgDungeon; created: boolean }> {
  const normalized = normalizeDungeonInput(input);
  if (!normalized.ok) throw new DungeonError(normalized.error, 400);
  const data = normalized.value;

  const bosses = await loadGuildBosses(guildId);
  const unknown = data.bossNames.find((bossName) => !bosses.has(bossName));
  if (unknown) throw new DungeonError(`« ${unknown} » n'est pas un boss du bestiaire de ce serveur.`, 400);

  for (const itemName of [data.completionItemName, data.firstClearItemName]) {
    if (itemName && !(await findGuildItem(prisma, guildId, itemName))) {
      throw new DungeonError(`L'objet « ${itemName} » n'existe pas dans le catalogue.`, 400);
    }
  }
  for (const titleId of [data.completionTitleId, data.firstClearTitleId]) {
    await assertGuildTitle(guildId, titleId).catch((err: Error) => {
      throw new DungeonError(err.message, 400);
    });
  }
  for (const roleId of [data.completionRoleId, data.firstClearRoleId]) {
    await assertFirstKillRole(client, guildId, roleId).catch((err: Error) => {
      throw new DungeonError(err.message, 400);
    });
  }

  const twin = await prisma.rpgDungeon.findUnique({ where: { guildId_name: { guildId, name: data.name } }, select: { id: true } });
  if (twin && twin.id !== dungeonId) throw new DungeonError(`Un donjon de ce serveur se nomme déjà « ${data.name} ».`, 409);

  if (!dungeonId) {
    const count = await prisma.rpgDungeon.count({ where: { guildId } });
    if (count >= DUNGEONS_PER_GUILD_MAX) {
      throw new DungeonError(`Un serveur ne peut pas avoir plus de ${DUNGEONS_PER_GUILD_MAX} donjons.`, 400);
    }
    return { dungeon: await prisma.rpgDungeon.create({ data: { guildId, ...data } }), created: true };
  }

  await findOwnedDungeon(guildId, dungeonId);
  return { dungeon: await prisma.rpgDungeon.update({ where: { id: dungeonId }, data }), created: false };
}

export async function setGuildDungeonEnabled(guildId: string, dungeonId: string, enabled: boolean): Promise<RpgDungeon> {
  await findOwnedDungeon(guildId, dungeonId);
  return prisma.rpgDungeon.update({ where: { id: dungeonId }, data: { enabled } });
}

/**
 * Efface le premier vainqueur : le prochain joueur à terminer le donjon touche la prime.
 * Ce que l'ancien vainqueur a reçu lui reste acquis.
 */
export async function clearDungeonFirstClear(guildId: string, dungeonId: string): Promise<RpgDungeon> {
  await findOwnedDungeon(guildId, dungeonId);
  return prisma.rpgDungeon.update({ where: { id: dungeonId }, data: { firstClearUserId: null, firstClearAt: null } });
}

/**
 * Supprime un donjon. Les parties en cours sont d'abord soldées comme une sortie volontaire :
 * la cascade les effacerait, et avec elles le butin que les joueurs avaient déjà gagné. Une
 * partie déjà expirée reste perdue, comme partout ailleurs.
 */
export async function deleteGuildDungeon(guildId: string, dungeonId: string): Promise<{ dungeon: RpgDungeon; settledRuns: number }> {
  const dungeon = await findOwnedDungeon(guildId, dungeonId);
  const active = await prisma.rpgDungeonRun.findMany({ where: { dungeonId, status: 'ACTIVE' }, select: { id: true, userId: true } });

  let settledRuns = 0;
  for (const run of active) {
    const settled = await leaveDungeon(guildId, run.userId, run.id).catch(() => null);
    if (settled) settledRuns += 1;
  }

  await prisma.rpgDungeon.delete({ where: { id: dungeonId } });
  return { dungeon, settledRuns };
}

// ─────────────────────────────────────────────────────────────
// Parties
// ─────────────────────────────────────────────────────────────

export type DungeonRunState = {
  run: RpgDungeonRun;
  dungeon: RpgDungeon;
  /** Étages de la partie, figés à l'entrée. */
  floors: DungeonFloor[];
  loot: DungeonLoot[];
  /** Vrai quand la partie a dépassé le délai d'inactivité : elle ne se joue plus. */
  expired: boolean;
};

export type DungeonHallEntry = {
  dungeon: DungeonWithTitles;
  floors: DungeonFloor[];
  playable: boolean;
  readyAt: Date | null;
  clears: number;
};

export async function getActiveDungeonRun(guildId: string, userId: string): Promise<DungeonRunState | null> {
  const run = await prisma.rpgDungeonRun.findFirst({
    where: { guildId, userId, status: 'ACTIVE' },
    include: { dungeon: true },
    orderBy: { startedAt: 'desc' },
  });
  if (!run) return null;

  const { dungeon, ...rest } = run;
  const bosses = await loadGuildBosses(guildId);
  return {
    run: rest,
    dungeon,
    floors: floorsOf(run, bosses),
    loot: parseDungeonLoot(run.loot),
    expired: isDungeonRunExpired(run.lastActionAt),
  };
}

/** Clôt une partie restée inactive trop longtemps, sans rien verser. */
async function expireDungeonRun(tx: Prisma.TransactionClient, runId: string): Promise<void> {
  await tx.rpgDungeonRun.updateMany({
    where: { id: runId, status: 'ACTIVE' },
    data: { status: 'DEFEATED', endedAt: new Date() },
  });
}

export async function getDungeonHall(guildId: string, userId: string): Promise<DungeonHallEntry[]> {
  const [dungeons, bosses, lastRuns, clears] = await Promise.all([
    prisma.rpgDungeon.findMany({
      where: { guildId, enabled: true },
      orderBy: [{ levelRequired: 'asc' }, { name: 'asc' }],
      include: DUNGEON_TITLES_INCLUDE,
    }),
    loadGuildBosses(guildId),
    prisma.rpgDungeonRun.groupBy({ by: ['dungeonId'], where: { guildId, userId }, _max: { startedAt: true } }),
    prisma.rpgDungeonRun.groupBy({ by: ['dungeonId'], where: { guildId, userId, status: 'COMPLETED' }, _count: { _all: true } }),
  ]);
  const lastStart = new Map(lastRuns.map((row) => [row.dungeonId, row._max.startedAt]));
  const clearCount = new Map(clears.map((row) => [row.dungeonId, row._count._all]));

  return dungeons.map((dungeon) => {
    const floors = floorsOf(dungeon, bosses);
    return {
      dungeon,
      floors,
      playable: isPlayable(floors),
      readyAt: dungeonReadyAt(lastStart.get(dungeon.id), dungeon.cooldownHours),
      clears: clearCount.get(dungeon.id) ?? 0,
    };
  });
}

export async function enterDungeon(guildId: string, userId: string, dungeonId: string): Promise<RpgDungeonRun> {
  const dungeon = await prisma.rpgDungeon.findUnique({ where: { id: dungeonId } });
  if (!dungeon || dungeon.guildId !== guildId) throw new DungeonRefused({ kind: 'not_found' });
  if (!dungeon.enabled) throw new DungeonRefused({ kind: 'disabled' });
  if (!isPlayable(floorsOf(dungeon, await loadGuildBosses(guildId)))) throw new DungeonRefused({ kind: 'broken' });

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (profile.level < dungeon.levelRequired) throw new DungeonRefused({ kind: 'level', level: dungeon.levelRequired });

  const last = await prisma.rpgDungeonRun.findFirst({
    where: { dungeonId, userId },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  const readyAt = dungeonReadyAt(last?.startedAt, dungeon.cooldownHours);
  if (readyAt) throw new DungeonRefused({ kind: 'cooldown', readyAt });
  if (profile.energy < dungeon.energyCost) throw new DungeonRefused({ kind: 'energy', energy: profile.energy, cost: dungeon.energyCost });
  if (profile.health <= DUNGEON_MIN_HEALTH) throw new DungeonRefused({ kind: 'health' });

  // Le verrou du profil sérialise deux entrées simultanées : la seconde voit la partie
  // ouverte par la première et s'arrête là, sans débiter une deuxième fois l'énergie.
  return prisma.$transaction(async (tx) => {
    await lockRpgProfile(tx, profile.id);
    const active = await tx.rpgDungeonRun.findFirst({
      where: { guildId, userId, status: 'ACTIVE' },
      select: { id: true, lastActionAt: true },
    });
    if (active && !isDungeonRunExpired(active.lastActionAt)) throw new DungeonRefused({ kind: 'active_run' });
    if (active) await expireDungeonRun(tx, active.id);

    const spent = await tx.rpgProfile.updateMany({
      where: { id: profile.id, energy: { gte: dungeon.energyCost } },
      data: { energy: { decrement: dungeon.energyCost } },
    });
    if (spent.count === 0) throw new DungeonRefused({ kind: 'energy', energy: profile.energy, cost: dungeon.energyCost });

    return tx.rpgDungeonRun.create({ data: { guildId, userId, dungeonId, bossNames: dungeon.bossNames } });
  });
}

export type DungeonSettlement = {
  outcome: 'COMPLETED' | 'LEFT' | 'DEFEATED';
  dungeon: RpgDungeon;
  floorsCleared: number;
  totalFloors: number;
  coins: number;
  xp: number;
  /** `granted` est faux pour un objet retiré du catalogue depuis qu'il est tombé. */
  items: Array<DungeonLoot & { quantity: number; granted: boolean }>;
  /** Titre du coffre, s'il vient d'être obtenu. */
  chestTitleName: string | null;
  /** Rôle du coffre, s'il a bien été attribué. */
  chestRoleId: string | null;
  /** Prime du premier vainqueur, si ce joueur est le premier du serveur à terminer. */
  firstClear: FirstKillResult | null;
  levelUp: number | null;
};

type DungeonClearExtras = Pick<DungeonSettlement, 'chestTitleName' | 'chestRoleId' | 'firstClear'>;

const NO_CLEAR_EXTRAS: DungeonClearExtras = { chestTitleName: null, chestRoleId: null, firstClear: null };

/** Verse ce que la sortie rapporte. À appeler dans la transaction qui clôt la partie. */
async function payDungeonRun(
  tx: Prisma.TransactionClient,
  guildId: string,
  profileId: string,
  run: { xpEarned: number; coinsEarned: number; loot: unknown },
  dungeon: RpgDungeon,
  outcome: 'COMPLETED' | 'LEFT' | 'DEFEATED',
): Promise<Pick<DungeonSettlement, 'coins' | 'xp' | 'items'>> {
  const payout = dungeonPayout({ ...run, loot: parseDungeonLoot(run.loot) }, outcome, dungeon);

  if (payout.coins > 0 || payout.xp > 0) {
    await tx.rpgProfile.update({
      where: { id: profileId },
      data: { balance: { increment: payout.coins }, xp: { increment: payout.xp } },
    });
  }

  const items: DungeonSettlement['items'] = [];
  for (const entry of groupDungeonLoot(payout.items)) {
    const item = await findGuildItem(tx, guildId, entry.itemName);
    if (item) await addInventoryQuantity(tx, profileId, item.id, entry.quantity);
    items.push({ ...entry, emoji: entry.emoji ?? item?.emoji ?? null, granted: item !== null });
  }

  return { coins: payout.coins, xp: payout.xp, items };
}

async function levelUpAfter(guildId: string, userId: string, levelBefore: number): Promise<number | null> {
  await checkLevelUp(guildId, userId);
  const after = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { level: true } });
  return after && after.level > levelBefore ? after.level : null;
}

/**
 * Sortie avec le butin. C'est aussi ce qui arrive à une partie quand le joueur quitte le
 * donjon par un autre chemin que ce bouton : elle ne se reprend pas.
 */
export async function leaveDungeon(guildId: string, userId: string, runId: string): Promise<DungeonSettlement> {
  const profile = await getOrCreateRpgProfile(guildId, userId);

  const settled = await prisma.$transaction(async (tx) => {
    await lockRpgProfile(tx, profile.id);
    const run = await tx.rpgDungeonRun.findUnique({ where: { id: runId }, include: { dungeon: true } });
    if (!run || run.guildId !== guildId || run.userId !== userId) throw new DungeonRefused({ kind: 'not_found' });
    if (run.status === 'ACTIVE' && isDungeonRunExpired(run.lastActionAt)) {
      await expireDungeonRun(tx, run.id);
      return null;
    }

    const claimed = await tx.rpgDungeonRun.updateMany({
      where: { id: runId, status: 'ACTIVE' },
      data: { status: 'LEFT', endedAt: new Date() },
    });
    if (claimed.count === 0) throw new DungeonRefused({ kind: 'stale' });

    const paid = await payDungeonRun(tx, guildId, profile.id, run, run.dungeon, 'LEFT');
    return { ...paid, dungeon: run.dungeon, floorsCleared: run.floorsCleared, totalFloors: run.bossNames.length };
  });
  // Levé hors de la transaction : à l'intérieur, il annulerait la clôture de la partie expirée.
  if (!settled) throw new DungeonRefused({ kind: 'expired' });

  const levelUp = settled.xp > 0 ? await levelUpAfter(guildId, userId, profile.level) : null;
  return { outcome: 'LEFT', ...settled, ...NO_CLEAR_EXTRAS, levelUp };
}

export type DungeonFloorResult = {
  floorIndex: number;
  boss: ResolvedMonster;
  duel: DuelResult;
  maxHealth: number;
  /** Gains de l'étage, mis en attente sur la partie. `null` en cas de défaite. */
  gains: { xp: number; coins: number; drop: DungeonLoot | null } | null;
  /** Renseigné quand l'étage a clos la partie : dernier étage franchi, ou défaite. */
  settlement: DungeonSettlement | null;
};

export async function fightDungeonFloor(
  client: Client,
  guildId: string,
  userId: string,
  runId: string,
  expectedFloor: number,
): Promise<DungeonFloorResult> {
  const run = await prisma.rpgDungeonRun.findUnique({ where: { id: runId }, include: { dungeon: true } });
  if (!run || run.guildId !== guildId || run.userId !== userId) throw new DungeonRefused({ kind: 'not_found' });
  if (run.status !== 'ACTIVE' || run.floorsCleared !== expectedFloor) throw new DungeonRefused({ kind: 'stale' });
  if (isDungeonRunExpired(run.lastActionAt)) {
    await expireDungeonRun(prisma, run.id);
    throw new DungeonRefused({ kind: 'expired' });
  }

  // Un donjon fermé en cours de partie laisse finir celles déjà lancées : leurs étages
  // sont figés depuis l'entrée, et le joueur a payé son énergie.
  const floors = floorsOf(run, await loadGuildBosses(guildId));
  const boss = floors[expectedFloor]?.boss;
  if (!boss) throw new DungeonRefused({ kind: 'broken' });

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (profile.health <= DUNGEON_MIN_HEALTH) throw new DungeonRefused({ kind: 'health' });

  const stats = await loadEffectiveStats(profile);
  const startHp = Math.min(profile.health, stats.maxHealth);
  const duel = simulateDuel({
    stats,
    skill: pickDuelSkill(await loadAvailableSkills(profile)),
    playerHp: startHp,
    monster: boss,
  });

  const loot = duel.won ? rollMonsterLoot(boss) : null;
  const drop: DungeonLoot | null = loot?.drop ? { itemName: loot.drop.itemName, emoji: loot.drop.emoji ?? null } : null;
  const lastFloor = expectedFloor + 1 >= floors.length;
  const outcome = !duel.won ? 'DEFEATED' : lastFloor ? 'COMPLETED' : null;

  const paid = await prisma.$transaction(async (tx) => {
    await lockRpgProfile(tx, profile.id);

    const pendingLoot = drop ? [...parseDungeonLoot(run.loot), drop] : parseDungeonLoot(run.loot);
    const claimed = await tx.rpgDungeonRun.updateMany({
      where: { id: runId, status: 'ACTIVE', floorsCleared: expectedFloor },
      data: loot
        ? {
          floorsCleared: { increment: 1 },
          xpEarned: { increment: loot.xp },
          coinsEarned: { increment: loot.coins },
          loot: pendingLoot,
          lastActionAt: new Date(),
          ...(outcome ? { status: outcome, endedAt: new Date() } : {}),
        }
        : { status: 'DEFEATED', endedAt: new Date() },
    });
    if (claimed.count === 0) throw new DungeonRefused({ kind: 'stale' });

    // Les PV s'écrivent en écart et non en valeur : une potion bue pendant le combat, dans
    // une autre fenêtre, ne doit pas être effacée par le résultat de l'étage.
    await tx.$executeRaw`
      UPDATE "rpg_profiles"
      SET "health" = GREATEST(1, LEAST(GREATEST("health", ${stats.maxHealth}), "health" + ${duel.playerHp - startHp}))
      WHERE "id" = ${profile.id}
    `;
    if (duel.won) {
      await tx.rpgProfile.update({ where: { id: profile.id }, data: { totalBossesKilled: { increment: 1 } } });
    }

    if (!outcome) return null;
    const closed = await tx.rpgDungeonRun.findUniqueOrThrow({ where: { id: runId } });
    return {
      ...(await payDungeonRun(tx, guildId, profile.id, closed, run.dungeon, outcome)),
      floorsCleared: closed.floorsCleared,
      totalFloors: floors.length,
    };
  });

  let settlement: DungeonSettlement | null = null;
  if (outcome && paid) {
    // Titre, rôle et prime du premier vainqueur viennent après la clôture : ils touchent
    // Discord ou d'autres tables, et un incident sur l'un ne doit pas annuler le coffre.
    const extras = outcome === 'COMPLETED'
      ? await settleDungeonClear(client, guildId, userId, profile.id, run.dungeon)
      : NO_CLEAR_EXTRAS;
    const gainedXp = paid.xp + (extras.firstClear?.xp ?? 0);
    const levelUp = gainedXp > 0 ? await levelUpAfter(guildId, userId, profile.level) : null;
    settlement = { outcome, dungeon: run.dungeon, ...paid, ...extras, levelUp };
  }

  return {
    floorIndex: expectedFloor,
    boss,
    duel,
    maxHealth: stats.maxHealth,
    gains: loot ? { xp: loot.xp, coins: loot.coins, drop } : null,
    settlement,
  };
}

/** Versements d'un donjon terminé qui ne tiennent pas dans la transaction de clôture. */
async function settleDungeonClear(
  client: Client,
  guildId: string,
  userId: string,
  profileId: string,
  dungeon: RpgDungeon,
): Promise<DungeonClearExtras> {
  const settle = <T>(step: string, run: () => Promise<T>): Promise<T | null> => run().catch((err) => {
    logger.warn('RpgDungeon', `${step} en échec pour ${userId} dans ${dungeon.name} :`, err);
    return null;
  });

  const { completionTitleId, completionRoleId } = dungeon;
  const chestTitle = completionTitleId ? await settle('Titre du coffre', () => grantTitle(profileId, completionTitleId)) : null;
  const chestRoleId = completionRoleId
    ? await settle('Rôle du coffre', () => grantRpgRewardRole(client, guildId, userId, completionRoleId, `Donjon terminé : ${dungeon.name}`))
    : null;
  const firstClear = await settle('Premier vainqueur', () => claimDungeonFirstClear(client, guildId, userId, profileId, dungeon));

  return { chestTitleName: chestTitle?.name ?? null, chestRoleId, firstClear };
}

/**
 * Inscrit le joueur comme premier vainqueur du donjon et lui verse la prime.
 *
 * Renvoie `null` si quelqu'un l'a devancé : la condition sur `firstClearUserId` tranche entre
 * deux fins simultanées, et seule la première paie. Le record s'écrit même sans prime, pour
 * que le dashboard et la salle disent qui a ouvert la voie.
 */
async function claimDungeonFirstClear(
  client: Client,
  guildId: string,
  userId: string,
  profileId: string,
  dungeon: RpgDungeon,
): Promise<FirstKillResult | null> {
  if (dungeon.firstClearUserId) return null;

  const item = dungeon.firstClearItemName ? await findGuildItem(prisma, guildId, dungeon.firstClearItemName) : null;

  // Le record et la prime s'écrivent ensemble : un record inscrit sans sa prime la ferait
  // perdre pour de bon, puisque plus personne ne pourrait la réclamer.
  const claimed = await prisma.$transaction(async (tx) => {
    const won = await tx.rpgDungeon.updateMany({
      where: { id: dungeon.id, firstClearUserId: null },
      data: { firstClearUserId: userId, firstClearAt: new Date() },
    });
    if (won.count === 0) return false;

    if (dungeon.firstClearCoins > 0 || dungeon.firstClearXp > 0) {
      await tx.rpgProfile.update({
        where: { id: profileId },
        data: { balance: { increment: dungeon.firstClearCoins }, xp: { increment: dungeon.firstClearXp } },
      });
    }
    if (item) await addInventoryQuantity(tx, profileId, item.id, 1);
    return true;
  });
  if (!claimed) return null;

  const result: FirstKillResult = {
    coins: dungeon.firstClearCoins,
    xp: dungeon.firstClearXp,
    itemName: item ? dungeon.firstClearItemName : null,
    itemEmoji: item?.emoji ?? null,
    teamPoints: 0,
    toGuild: false,
    roleId: null,
    titleName: null,
  };

  const settle = <T>(step: string, run: () => Promise<T>): Promise<T | null> => run().catch((err) => {
    logger.warn('RpgDungeon', `${step} du premier vainqueur en échec pour ${dungeon.name} :`, err);
    return null;
  });

  const { firstClearTitleId, firstClearRoleId } = dungeon;
  if (firstClearTitleId) {
    const title = await settle('Titre', () => grantTitle(profileId, firstClearTitleId));
    result.titleName = title?.name ?? null;
  }
  if (firstClearRoleId) {
    result.roleId = await settle('Rôle', () => grantRpgRewardRole(client, guildId, userId, firstClearRoleId, `Premier vainqueur du donjon : ${dungeon.name}`));
  }

  await announceDungeonFirstClear(client, guildId, userId, dungeon, result).catch((err) => {
    logger.error('RpgDungeon', `Annonce du premier vainqueur impossible pour ${guildId}:`, err);
  });

  return result;
}

/**
 * Annonce dans le salon des premiers vainqueurs du bestiaire, quand le donjon a une prime.
 * Un donjon se range avec les boss : annoncé en mode « boss seulement » comme en mode « tout ».
 */
async function announceDungeonFirstClear(
  client: Client,
  guildId: string,
  userId: string,
  dungeon: RpgDungeon,
  result: FirstKillResult,
): Promise<void> {
  // Comme pour le bestiaire : sans prime réellement versée, le record s'inscrit sans annonce.
  if (!hasFirstClearReward(dungeon)) return;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.firstKillChannelId || !shouldAnnounceFirstKill(config.firstKillAnnounce, true)) return;

  const locale = await resolveGuildLocale(guildId);
  const reward = formatFirstKillReward(result, config.currencyEmoji, locale);
  if (!reward) return;

  const channel = await client.channels.fetch(config.firstKillChannelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('RpgDungeon', `Salon d'annonce du premier vainqueur injoignable pour ${guildId}.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_dungeon_first_clear_announce_title({}, { locale }))
    .setDescription(m.rpg_dungeon_first_clear_announce_desc({ user: `<@${userId}>`, dungeon: `${dungeon.emoji} ${dungeon.name}` }, { locale }))
    .setColor(COLORS.warning)
    .addFields({ name: m.rpg_first_kill_field_reward({}, { locale }), value: reward });

  // Le vainqueur est nommé, pas notifié : une annonce ne doit sonner chez personne.
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}
