/**
 * La Tour : accès base du mode roguelite.
 *
 * Le profil Tour est distinct du profil RPG. Une partie vit en base et chaque action est
 * écrite sous condition de version : deux clics sur le même bouton ne jouent qu'un tour, et
 * un vieux message ne peut rien rejouer. Rien de ce que la partie contient (stats, objets,
 * or, bénédictions) ne rejoint le profil RPG ; seuls les éclats restent, et ce qu'ils achètent.
 */

import { EmbedBuilder, type Client } from 'discord.js';
import { Prisma, type RpgTowerReward, type RpgTowerRun } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { upsertRetryingRace } from '../../../utils/upsertRetry.js';
import { logger } from '../../../utils/logger.js';
import { resolveGuildLocale } from '../../../utils/i18n.js';
import { resolveGuildTimezone } from '../../../utils/timezone.js';
import * as m from '../../../lib/paraglide/messages.js';
import { RPG_BONUS_MAX_ENERGY_CAP, checkLevelUp, getOrCreateEconomyConfig, getOrCreateRpgProfile } from '../economyService.js';
import { loadAvailableSkills, loadEffectiveStats, seedDefaultMonsters } from '../combatService.js';
import { getRpgClass } from './rpgClasses.js';
import { MAX_HEALTH_PER_POINT } from './rpgProgressionService.js';
import { nodesForClass } from './rpgSkillTree.js';
import { TOWER_SIM_RUNS_MAX, simulateTowerRuns, type TowerSimResult } from './rpgTowerSim.js';
import { listGuildMonsters } from './rpgBestiaryService.js';
import { assertGuildTitle, grantTitle } from './rpgTitleService.js';
import { assertFirstKillRole, grantRpgRewardRole } from './rpgFirstKillService.js';
import { addInventoryQuantity, lockRpgProfile } from './rpgInventoryWrites.js';
import { awardRpgTeamPoints } from './rpgTeamRewards.js';
import { trackRpgObjective } from './rpgObjectiveTracker.js';
import {
  clansEnabled,
  getClanTowerConfig,
  getClanTowerTotals,
  getOpenClanTowerEvent,
  loadClanTowerRooms,
  recordClanTowerConquests,
  recordClanTowerRooms,
  resolveMemberClan,
} from './rpgClanTowerService.js';
import {
  applyClanTowerBonus,
  clanTowerAttemptKey,
  clanTowerBonus,
  nextClanTowerAttempt,
  type ClanTowerBonus,
} from './rpgClanTowerPolicy.js';
import {
  applyClanConquests,
  applyTowerAction,
  createTowerState,
  isConquerableRoom,
  towerRoomsExplored,
  type TowerAction,
  type TowerActionError,
  TowerActionRefused,
  type TowerFoePool,
  type TowerGhost,
  towerRunFloorLayout,
  type TowerRules,
  type TowerState,
} from './rpgTowerEngine.js';
import {
  STARTING_POTIONS,
  TOWER_DEFAULTS,
  TOWER_RARITIES,
  TOWER_RANGES,
  TOWER_REWARDS_PER_GUILD_MAX,
  applyWeeklyCap,
  computeTowerEntryStats,
  newTowerSeed,
  normalizeTowerReward,
  normalizeTowerSettings,
  parseTowerPurchases,
  parseTowerUpgrades,
  purchasesInPeriod,
  settleShards,
  towerPurchaseKey,
  towerStatGrant,
  towerUpgradeBonus,
  towerDailyChallenge,
  nextTowerDailyStreak,
  towerDailyStreakBonus,
  previousTowerDayKey,
  TOWER_DAILY_PODIUM_SHARDS,
  towerDailySeed,
  towerDayKey,
  towerFoeShape,
  towerSkill,
  towerSkillPrice,
  towerSkillTier,
  towerUpgradeCost,
  towerWeekStart,
  type TowerCoreStats,
  type TowerEntryMode,
  type TowerGear,
  type TowerOutcome,
  type TowerSettings,
  type TowerSkill,
  type TowerRewardLimitPeriod,
  type TowerStatGrant,
  type TowerUpgradeDef,
} from './rpgTowerPolicy.js';
import {
  TOWER_FLOORS_MAX,
  TOWER_HIDDEN_ROOMS,
  TOWER_MAP_ROOMS_MAX,
  TOWER_MAP_SIZE,
  entryRooms,
  exitRoom,
  floorLayout,
  normalizeTowerFloors,
  normalizeTowerLayout,
  readTowerFloorsCached,
  roomNeighbors,
  startRoom,
  towerCardTags,
  towerFloorLabel,
  towerLayoutKey,
  resolveTowerTheme,
  towerLayoutHasFog,
  visibleRooms,
  type TowerHiddenRoom,
  type TowerLayout,
} from './rpgTowerMap.js';
import { heatsFromMask } from './rpgTowerContent.js';
import { renderTowerImage } from './rpgTowerRender.js';

export class TowerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TowerError';
  }
}

export type TowerRefusal =
  | { kind: 'disabled' }
  | { kind: 'active_run' }
  | { kind: 'no_run' }
  | { kind: 'stale' }
  | { kind: 'in_combat' }
  | { kind: 'action'; reason: TowerActionError }
  | { kind: 'shards'; price: number; balance: number }
  | { kind: 'owned' }
  /** Article à quantité limitée déjà acheté autant de fois que permis sur la période. */
  | { kind: 'limit'; max: number; period: TowerRewardLimitPeriod }
  | { kind: 'unavailable' }
  | { kind: 'upgrade_max' }
  | { kind: 'daily_disabled' }
  | { kind: 'daily_done' }
  /** Tour de clan : fermée cette semaine, joueur sans clan, ou tentative du jour déjà jouée. */
  | { kind: 'clan_closed' }
  | { kind: 'clan_none' }
  | { kind: 'clan_done'; next: Date | null };

/** Refus d'une action de joueur, traduit par le panneau dans la langue du joueur. */
export class TowerRefused extends Error {
  constructor(readonly refusal: TowerRefusal) {
    super(`Tour refusée : ${refusal.kind}`);
    this.name = 'TowerRefused';
  }
}

export type TowerConfigView = TowerSettings & {
  seasonStartedAt: Date;
  /** Étages dessinés dans l'ordre de la montée, relus et validés ; vide si aucun ne passe. */
  floors: TowerLayout[];
  /** Réserve d'or de la source commune. */
  fountainGold: number;
};

export type TowerSettlement = {
  outcome: TowerOutcome;
  floorsCleared: number;
  kills: number;
  /** Éclats réellement versés. */
  shards: number;
  /** Éclats perdus à la mort. */
  lostToDeath: number;
  /** Éclats laissés en quittant hors palier sûr. */
  lostToLeave: number;
  /** Éclats retenus par le plafond hebdomadaire. */
  lostToCap: number;
  newBest: boolean;
  milestones: TowerRewardView[];
  /** Vrai quand la partie a été close par inactivité. */
  expired: boolean;
  /** Vrai quand un autre appel l'avait déjà soldée : rien n'a été versé cette fois. */
  alreadySettled?: boolean;
  /** Salles explorées, qui départagent le classement. Absent des bilans d'avant ce champ. */
  roomsExplored?: number;
  /** Monstre qui a fait tomber le joueur. */
  killedBy?: string | null;
  /** Équipement porté à la fin, par nom. */
  gear?: string[];
  /** Ascension du jour. */
  daily?: boolean;
  /** Éclats ajoutés par la série de jours du défi, avant le plafond hebdomadaire. */
  streakBonus?: number;
  /** Ascension de la Tour de clan : ni éclats, ni record, ni paliers. */
  clan?: boolean;
};

export type ActiveTowerRun = { run: RpgTowerRun; state: TowerState };

/** Récompense accompagnée du nom de son titre, pour l'afficher sans autre lecture. */
export type TowerRewardView = RpgTowerReward & { titleName: string | null };

async function withTitleNames(rewards: RpgTowerReward[]): Promise<TowerRewardView[]> {
  const titleIds = [...new Set(rewards.map((reward) => reward.titleId).filter((id): id is string => id !== null))];
  const titles = titleIds.length > 0
    ? await prisma.rpgTitle.findMany({ where: { id: { in: titleIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(titles.map((title) => [title.id, title.name]));
  return rewards.map((reward) => ({ ...reward, titleName: reward.titleId ? nameById.get(reward.titleId) ?? null : null }));
}

// ─────────────────────────────────────────────────────────────
// Lecture
// ─────────────────────────────────────────────────────────────

export async function getTowerConfig(guildId: string): Promise<TowerConfigView> {
  // Sans les étages : ils ne sont relus que s'ils ont changé, voir `readFloors`.
  const row = await prisma.rpgTowerConfig.findUnique({ where: { guildId }, omit: { layouts: true, layout: true } });
  if (!row) return { ...TOWER_DEFAULTS, seasonStartedAt: new Date(0), floors: [], fountainGold: 0 };
  const normalized = normalizeTowerSettings(row as unknown as Record<string, unknown>);
  const settings = normalized.ok ? normalized.value : TOWER_DEFAULTS;
  return {
    ...settings,
    enabled: row.enabled,
    seasonStartedAt: row.seasonStartedAt,
    floors: await readFloors(guildId, row.floorsUpdatedAt),
    fountainGold: row.fountainGold,
  };
}

/**
 * Étages enregistrés. Un étage qui ne passe plus la validation est écarté plutôt que de
 * fermer toute la tour ; l'ancienne carte unique, d'avant les étages, sert de premier étage.
 */
function readFloors(guildId: string, updatedAt: Date): Promise<TowerLayout[]> {
  return readTowerFloorsCached(`tower:${guildId}`, updatedAt, async () => {
    const row = await prisma.rpgTowerConfig.findUnique({ where: { guildId }, select: { layouts: true, layout: true } });
    if (!row) return [];
    return Array.isArray(row.layouts) && row.layouts.length > 0 ? row.layouts : row.layout ? [row.layout] : [];
  });
}



/**
 * Réglages d'une partie selon son mode. Une ascension de la Tour de clan joue les étages de
 * celle-ci, sans éclats ni source commune : rien de ce qu'elle rapporte ne sort de la semaine.
 */
export async function getTowerPlayConfig(guildId: string, mode: string): Promise<TowerConfigView> {
  const settings = await getTowerConfig(guildId);
  if (mode !== 'CLAN') return settings;
  const clan = await getClanTowerConfig(guildId);
  return {
    ...settings,
    name: clan.name,
    floors: clan.floors,
    floorsAfter: clan.floorsAfter,
    generatedFog: clan.generatedFog,
    shardsPerFloor: 0,
    shardsPerRoom: 0,
    fountainGold: 0,
  };
}

/** La Tour n'ouvre que si le module économie, le RPG et la Tour elle-même sont actifs. */
export async function isTowerOpen(guildId: string): Promise<boolean> {
  const [economy, tower] = await Promise.all([getOrCreateEconomyConfig(guildId), getTowerConfig(guildId)]);
  return economy.enabled && economy.rpgEnabled && tower.enabled;
}

export async function getOrCreateTowerProfile(guildId: string, userId: string) {
  return upsertRetryingRace(() => prisma.rpgTowerProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: {},
    create: { guildId, userId },
  }));
}

/** Record de tous les temps du serveur, relu au plus une fois par minute : il s'affiche à chaque pas. */
const RECORD_TTL_MS = 60_000;
const serverRecords = new Map<string, { at: number; record: TowerServerRecord | null }>();
export type TowerServerRecord = { floor: number; userId: string; name: string };

export async function getTowerServerRecord(guildId: string): Promise<TowerServerRecord | null> {
  const cached = serverRecords.get(guildId);
  if (cached && Date.now() - cached.at < RECORD_TTL_MS) return cached.record;
  const best = await prisma.rpgTowerProfile.findFirst({
    where: { guildId, bestFloorAllTime: { gt: 0 } },
    orderBy: [{ bestFloorAllTime: 'desc' }, { createdAt: 'asc' }],
    select: { userId: true, bestFloorAllTime: true },
  });
  let record: TowerServerRecord | null = null;
  if (best) {
    const member = await prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId: best.userId } },
      select: { displayName: true, globalName: true, username: true },
    });
    const name = member?.displayName || member?.globalName || member?.username || '';
    record = { floor: best.bestFloorAllTime, userId: best.userId, name };
  }
  serverRecords.set(guildId, { at: Date.now(), record });
  return record;
}

function rulesOf(settings: TowerSettings): TowerRules {
  return {
    floorGrowthPercent: settings.floorGrowthPercent,
    bossEvery: settings.bossEvery,
    blessingEvery: settings.blessingEvery,
    maxBlessings: settings.maxBlessings,
    shardsPerFloor: settings.shardsPerFloor,
    shardsPerRoom: settings.shardsPerRoom,
    merchant: settings.merchant,
    floorsAfter: settings.floorsAfter,
    generatedFog: settings.generatedFog,
  };
}

async function loadFoes(guildId: string): Promise<TowerFoePool> {
  await seedDefaultMonsters();
  // Désactivés compris : une salle peut imposer une créature retirée du bestiaire, comme un
  // donjon réserve ses boss. Le tirage au hasard, lui, ne pioche que dans les actives.
  const monsters = await listGuildMonsters(guildId, { includeDisabled: true });
  const enabled = monsters.filter((monster) => monster.enabled);
  // Chaque créature garde le profil de sa fiche : robuste, rapide ou brutale, à force égale.
  const foe = (monster: (typeof monsters)[number]) => ({ name: monster.name, emoji: monster.emoji, shape: towerFoeShape(monster) });
  return {
    monsters: enabled.filter((monster) => !monster.isBoss).map(foe),
    bosses: enabled.filter((monster) => monster.isBoss).map(foe),
    byName: Object.fromEntries(monsters.map((monster) => [monster.name, foe(monster)])),
  };
}

/** Créatures proposées au dashboard pour les salles qui imposent la leur. */
export async function listTowerFoeChoices(guildId: string) {
  await seedDefaultMonsters();
  const monsters = await listGuildMonsters(guildId, { includeDisabled: true });
  return monsters.map((monster) => ({ name: monster.name, emoji: monster.emoji, isBoss: monster.isBoss, enabled: monster.enabled }));
}

function parseState(value: Prisma.JsonValue): TowerState {
  return value as unknown as TowerState;
}

/** Démarrage du processus : le temps où le bot était coupé ne compte pas comme inactivité. */
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

/**
 * Partie restée inactive au-delà du délai. L'inactivité ne court qu'à partir du démarrage du
 * bot : sans cela, un redémarrage plus long que le délai tuait tous les joueurs en combat.
 */
function isExpired(run: RpgTowerRun, idleTimeoutMinutes: number, now = Date.now()): boolean {
  const since = Math.max(run.lastActionAt.getTime(), PROCESS_STARTED_AT);
  return now - since > idleTimeoutMinutes * 60 * 1000;
}

export type TowerEntryPreview = {
  mode: TowerEntryMode;
  stats: TowerCoreStats;
  /** Stats effectives du RPG, pour montrer ce que la compression en a fait. */
  main: { attack: number; defense: number; speed: number; maxHealth: number };
  /**
   * Compétences du RPG que le joueur peut acheter pour l'ascension, déjà ramenées à la Tour.
   * Vide pour l'ascension du jour, qui se joue sans.
   */
  skills: TowerSkill[];
  potions: number;
  gold: number;
  /** Porte-bonheur des améliorations (0 pour l'ascension du jour et la Tour de clan). */
  fortune: number;
  titleName: string | null;
  className: string | null;
};

/**
 * Ce avec quoi le joueur entrerait dans la Tour : ses stats compressées, les compétences de
 * sa classe et de son arbre qu'il peut acheter, et ses potions de départ.
 */
export async function previewTowerEntry(guildId: string, userId: string, options: { daily?: boolean } = {}): Promise<TowerEntryPreview> {
  const [settings, rpgProfile, towerProfile] = await Promise.all([
    getTowerConfig(guildId),
    getOrCreateRpgProfile(guildId, userId),
    getOrCreateTowerProfile(guildId, userId),
  ]);

  const [main, skills, title] = await Promise.all([
    loadEffectiveStats(rpgProfile),
    loadAvailableSkills(rpgProfile),
    rpgProfile.activeTitleId ? prisma.rpgTitle.findUnique({ where: { id: rpgProfile.activeTitleId } }) : Promise.resolve(null),
  ]);

  const rpgClass = getRpgClass(rpgProfile.className);
  // L'ascension du jour se joue à armes égales : ni héritage du RPG, ni titre, ni amélioration,
  // ni compétence. Seule la classe distingue les joueurs.
  const daily = options.daily === true;
  const bonus = daily ? null : towerUpgradeBonus(settings.upgrades, parseTowerUpgrades(towerProfile.upgrades, settings.upgrades));
  const mode: TowerEntryMode = daily ? 'RESET' : settings.entryMode;

  const stats = computeTowerEntryStats({
    mode,
    inheritCapPercent: settings.inheritCapPercent,
    titleCapPercent: daily ? 0 : settings.titleCapPercent,
    main: { attack: main.attack, defense: main.defense, speed: main.speed, maxHealth: main.maxHealth },
    title: {
      attack: daily ? 0 : title?.attackBonus ?? 0,
      defense: daily ? 0 : title?.defenseBonus ?? 0,
      speed: daily ? 0 : title?.speedBonus ?? 0,
      maxHealth: daily ? 0 : title?.healthBonus ?? 0,
      critPercent: daily ? 0 : title?.critBonus ?? 0,
    },
    classModifiers: rpgClass?.modifiers ?? { attack: 1, defense: 1, speed: 1, maxHealth: 1 },
    classPassive: rpgClass?.passive ?? {},
    upgradeBonus: bonus ?? undefined,
  });

  return {
    mode,
    stats,
    main: { attack: main.attack, defense: main.defense, speed: main.speed, maxHealth: main.maxHealth },
    skills: daily ? [] : skills.map((skill) => towerSkill({
      id: skill.id,
      name: skill.name,
      emoji: skill.emoji,
      cooldownTurns: skill.cooldownTurns,
      effect: skill.effect,
      tier: towerSkillTier(skill),
    })),
    potions: STARTING_POTIONS + (bonus?.potions ?? 0),
    gold: bonus?.gold ?? 0,
    fortune: bonus?.fortune ?? 0,
    titleName: daily ? null : title?.name ?? null,
    className: rpgClass ? `${rpgClass.emoji} ${rpgClass.name}` : null,
  };
}

/**
 * Partie en cours du joueur. Une partie restée inactive trop longtemps est soldée ici :
 * en plein combat comme une mort (sinon fermer Discord suffirait à fuir un combat perdu),
 * ailleurs comme un abandon.
 */
export async function getActiveTowerRun(
  client: Client | null,
  guildId: string,
  userId: string,
): Promise<{ active: ActiveTowerRun | null; expired: TowerSettlement | null }> {
  const run = await prisma.rpgTowerRun.findFirst({
    where: { guildId, userId, status: 'ACTIVE' },
    orderBy: { startedAt: 'desc' },
  });
  if (!run) return { active: null, expired: null };

  const settings = await getTowerPlayConfig(guildId, run.mode);
  const state = parseState(run.state);
  if (!isExpired(run, settings.idleTimeoutMinutes)) return { active: { run, state }, expired: null };

  const settlement = await settleRun(client, run, state, state.phase === 'COMBAT' ? 'DEAD' : 'LEFT', settings, true);
  return { active: null, expired: settlement };
}

// ─────────────────────────────────────────────────────────────
// Partie
// ─────────────────────────────────────────────────────────────

/** Compétences choisies : le bit `i` de `mask` désigne la i-ème compétence de l'aperçu. */
export function pickTowerSkills(skills: readonly TowerSkill[], mask: number): TowerSkill[] {
  return skills.filter((_, index) => (mask & (1 << index)) !== 0);
}

/**
 * Ouvre une ascension. `daily` : le défi du jour, même graine pour tout le serveur et une
 * seule tentative par joueur et par jour, sur des étages toujours générés, avec l'ambiance et
 * la malédiction du jour ; il a son propre classement et ne compte ni pour la saison ni pour
 * les paliers. `skillMask` : compétences achetées pour cette ascension, payées en éclats à
 * l'entrée. `heatMask` : malédictions choisies, chacune contre plus d'éclats ; le défi du jour
 * impose la sienne, pour rester le même pour tous.
 */
export async function startTowerRun(
  client: Client | null,
  guildId: string,
  userId: string,
  options: { daily?: boolean; clan?: boolean; skillMask?: number; heatMask?: number } = {},
): Promise<ActiveTowerRun> {
  if (!(await isTowerOpen(guildId))) throw new TowerRefused({ kind: 'disabled' });
  const clanRun = options.clan === true;
  // La Tour de clan se joue à égalité, comme l'ascension du jour : sans héritage ni compétence.
  const daily = options.daily === true || clanRun;

  const { active } = await getActiveTowerRun(client, guildId, userId);
  if (active) throw new TowerRefused({ kind: 'active_run' });

  const clanEntry = clanRun ? await clanTowerEntry(client, guildId, userId) : null;
  const [settings, preview, towerProfile] = await Promise.all([
    getTowerPlayConfig(guildId, clanRun ? 'CLAN' : 'CLASSIC'),
    previewTowerEntry(guildId, userId, { daily }),
    getOrCreateTowerProfile(guildId, userId),
  ]);
  if (!clanRun && daily && !settings.dailyEnabled) throw new TowerRefused({ kind: 'daily_disabled' });

  const dayKey = clanEntry ? clanEntry.attemptKey : await currentTowerDay(guildId);
  const seed = clanEntry ? clanEntry.event.seed : daily ? towerDailySeed(guildId, dayKey) : newTowerSeed();
  // Tour de clan : les étages suivent la graine de la semaine, pour que les conquêtes du clan
  // tombent sur les mêmes cartes ; le hasard des combats change chaque jour et pour chacun.
  // Sinon, refaire les mêmes choix redonnait exactement les mêmes combats d'un jour à l'autre.
  const rngSeed = clanEntry ? towerDailySeed(`${clanEntry.event.seed}:${userId}`, dayKey) : undefined;
  // Défi du jour : la Tour de clan joue aussi à armes égales, mais sans cette contrainte.
  const challenge = daily && !clanRun ? towerDailyChallenge(guildId, dayKey) : null;
  // Le défi se joue toujours sur des étages générés : une carte neuve chaque jour, la même pour tous.
  const rules: TowerRules = challenge
    ? { ...rulesOf(settings), floorsAfter: 'GENERATE', generatedFog: true, floorModifier: challenge.modifier }
    : rulesOf(settings);
  const floors = challenge ? [] : settings.floors;
  const skills = pickTowerSkills(preview.skills, options.skillMask ?? 0);
  const skillCost = skills.reduce((sum, skill) => sum + towerSkillPrice(settings.skillPrice, skill), 0);
  const state = createTowerState({
    // Tour de clan : les paliers déjà franchis par le clan renforcent l'entrée.
    base: clanEntry ? applyClanTowerBonus(preview.stats, clanEntry.bonus) : preview.stats,
    skills,
    // Les compétences laissées au départ restent à la portée d'un mentor, contre de l'or.
    skillPool: preview.skills.filter((skill) => !skills.includes(skill)),
    heat: challenge ? [challenge.heat] : daily ? [] : heatsFromMask(options.heatMask ?? 0),
    potions: preview.potions + (clanEntry?.bonus.potions ?? 0),
    gold: preview.gold,
    fortune: preview.fortune,
    seed,
    rngSeed,
    rules,
    // Toujours un étage : les étages dessinés d'abord, générés ensuite ou à défaut.
    layout: towerRunFloorLayout(floors, 1, rules, seed),
  });
  await attachGhosts(guildId, userId, state, daily);
  if (clanEntry) await attachClanConquests(clanEntry.event.id, clanEntry.clanId, 1, state);

  const mode = clanRun ? 'CLAN' : daily ? 'DAILY' : 'CLASSIC';
  return prisma.$transaction(async (tx) => {
    // Le verrou du profil Tour sérialise deux clics « Entrer » : sans lui, les deux passaient
    // le contrôle de partie active et ouvraient chacun une ascension.
    await tx.$queryRaw`SELECT 1 FROM "rpg_tower_profiles" WHERE "id" = ${towerProfile.id} FOR UPDATE`;
    const running = await tx.rpgTowerRun.count({ where: { profileId: towerProfile.id, status: 'ACTIVE' } });
    if (running > 0) throw new TowerRefused({ kind: 'active_run' });
    if (daily) {
      const played = await tx.rpgTowerRun.count({ where: { profileId: towerProfile.id, mode, dailyKey: dayKey } });
      if (played > 0) throw clanEntry ? new TowerRefused({ kind: 'clan_done', next: clanEntry.next }) : new TowerRefused({ kind: 'daily_done' });
    }
    if (skillCost > 0) {
      const fresh = await tx.rpgTowerProfile.findUniqueOrThrow({ where: { id: towerProfile.id }, select: { shards: true } });
      if (fresh.shards < skillCost) throw new TowerRefused({ kind: 'shards', price: skillCost, balance: fresh.shards });
    }

    const run = await tx.rpgTowerRun.create({
      data: {
        profileId: towerProfile.id,
        guildId,
        userId,
        state: state as unknown as Prisma.InputJsonValue,
        mode,
        dailyKey: daily ? dayKey : null,
        clanEventId: clanEntry?.event.id ?? null,
        clanId: clanEntry?.clanId ?? null,
      },
    });
    // Défi du jour : la série se compte au départ, relue sous le verrou.
    const streak = challenge
      ? await tx.rpgTowerProfile.findUniqueOrThrow({ where: { id: towerProfile.id }, select: { dailyStreak: true, dailyLastKey: true } })
      : null;
    await tx.rpgTowerProfile.update({
      where: { id: towerProfile.id },
      data: {
        totalRuns: { increment: 1 },
        ...(skillCost > 0 ? { shards: { decrement: skillCost } } : {}),
        ...(streak ? { dailyStreak: nextTowerDailyStreak(streak.dailyStreak, streak.dailyLastKey, dayKey), dailyLastKey: dayKey } : {}),
      },
    });
    return { run, state };
  });
}

/**
 * Ce qu'il faut pour entrer dans la Tour de clan : un événement ouvert, les clans du serveur
 * actifs, un clan au joueur et sa tentative du jour encore libre.
 */
async function clanTowerEntry(client: Client | null, guildId: string, userId: string) {
  const [settings, clans, event] = await Promise.all([getClanTowerConfig(guildId), clansEnabled(guildId), getOpenClanTowerEvent(guildId)]);
  if (!settings.enabled || !clans || !event || !client) throw new TowerRefused({ kind: 'clan_closed' });
  const clan = await resolveMemberClan(client, guildId, userId);
  if (!clan) throw new TowerRefused({ kind: 'clan_none' });
  const now = new Date();
  const totals = await getClanTowerTotals(event.id);
  return {
    event,
    clanId: clan.id,
    attemptKey: clanTowerAttemptKey(event.id, event.startsAt, now),
    next: nextClanTowerAttempt(event.startsAt, event.endsAt, now),
    bonus: clanTowerBonus(totals.get(clan.id) ?? 0, settings.milestones),
  };
}

type LoadedRun = { kind: 'expired'; settlement: TowerSettlement } | { kind: 'active'; active: ActiveTowerRun };

async function loadRunForAction(client: Client | null, guildId: string, userId: string, version: number): Promise<LoadedRun> {
  const { active, expired } = await getActiveTowerRun(client, guildId, userId);
  if (expired) return { kind: 'expired', settlement: expired };
  if (!active) throw new TowerRefused({ kind: 'no_run' });
  if (active.run.version !== version) throw new TowerRefused({ kind: 'stale' });
  return { kind: 'active', active };
}

export type TowerActResult = {
  active: ActiveTowerRun | null;
  settlement: TowerSettlement | null;
  /** Salles piégées que le joueur vient de rencontrer pour la première fois. */
  discovered?: TowerHiddenRoom[];
};

export async function actTowerRun(
  client: Client | null,
  guildId: string,
  userId: string,
  version: number,
  action: TowerAction,
): Promise<TowerActResult> {
  const loaded = await loadRunForAction(client, guildId, userId, version);
  if (loaded.kind === 'expired') return { active: null, settlement: loaded.settlement };
  const { run, state } = loaded.active;

  const [settings, foes] = await Promise.all([getTowerPlayConfig(guildId, run.mode), loadFoes(guildId)]);
  const clanRun = run.mode === 'CLAN';
  // La semaine est finie : l'ascension de clan se termine là, sans plus rien conquérir.
  if (clanRun && await clanEventOver(run.clanEventId)) {
    return { active: null, settlement: await settleRun(client, run, state, 'LEFT', settings, false) };
  }

  // La source commune se lit au moment de l'action : d'autres joueurs y puisent et y versent.
  // La Tour de clan n'y a pas accès : rien n'en sort, rien n'y entre.
  state.fountainPool = settings.fountainGold;
  // Verser dans une source fermée retirait l'or du joueur sans le mettre nulle part.
  if (clanRun && action.type === 'donate') throw new TowerRefused({ kind: 'action', reason: 'wrong_phase' });
  let step: ReturnType<typeof applyTowerAction>;
  try {
    // Le défi du jour ne monte que sur des étages générés : ses règles, gardées dans la partie,
    // imposent l'ambiance du jour.
    step = applyTowerAction(state, run.floor, action, rulesOf(settings), foes, run.mode === 'DAILY' ? [] : settings.floors);
  } catch (err) {
    if (err instanceof TowerActionRefused) throw new TowerRefused({ kind: 'action', reason: err.reason });
    throw err;
  }
  // Nouvel étage : on y pose les fantômes des joueurs tombés sur la même carte.
  if (step.state.map && (!state.map || towerLayoutKey(step.state.map.layout) !== towerLayoutKey(state.map.layout))) {
    await attachGhosts(guildId, userId, step.state, run.mode !== 'CLASSIC');
  }
  // Tour de clan : sur le nouvel étage, ce que le clan y a déjà conquis reste vaincu.
  if (clanRun && run.clanEventId && run.clanId && step.floor !== run.floor) {
    await attachClanConquests(run.clanEventId, run.clanId, step.floor, step.state);
  }
  const ghostTaken = step.state.ghostTaken ?? null;
  step.state.ghostTaken = null;
  const fountainDelta = step.state.fountainDelta ?? 0;
  step.state.fountainDelta = 0;

  // L'action et la source commune s'écrivent ensemble : quand un autre joueur vient de vider
  // la source, la gorgée est refusée au lieu d'être offerte.
  await prisma.$transaction(async (tx) => {
    const written = await tx.rpgTowerRun.updateMany({
      where: { id: run.id, status: 'ACTIVE', version: run.version },
      data: {
        state: step.state as unknown as Prisma.InputJsonValue,
        floor: step.floor,
        version: { increment: 1 },
        lastActionAt: new Date(),
        shardsEarned: step.state.shards,
      },
    });
    if (written.count === 0) throw new TowerRefused({ kind: 'stale' });
    if (fountainDelta !== 0 && !clanRun && !(await moveFountainGold(tx, guildId, fountainDelta))) {
      throw new TowerRefused({ kind: 'action', reason: 'fountain_dry' });
    }
  });
  if (ghostTaken) await claimGhost(ghostTaken, userId).catch((err) => logger.warn('RpgTower', `Fantôme ${ghostTaken} non marqué comme repris :`, err));
  const climbed = step.state.floorsCleared - state.floorsCleared;
  if (clanRun && run.clanEventId && run.clanId) {
    const eventId = run.clanEventId;
    // Le premier du clan à franchir un étage le conquiert pour lui.
    if (climbed > 0) {
      await recordClanTowerConquests(eventId, run.clanId, userId, { from: state.floorsCleared, to: step.state.floorsCleared })
        .catch((err) => logger.warn('RpgTower', `Conquête de la Tour de clan non enregistrée (${eventId}) :`, err));
    }
    // Les salles vaincues le restent pour tout le clan.
    const won = conqueredRooms(state, step.state, climbed > 0);
    if (won.length > 0 && state.map) {
      await recordClanTowerRooms(eventId, run.clanId, userId, run.floor, towerLayoutKey(state.map.layout), won)
        .catch((err) => logger.warn('RpgTower', `Salles de la Tour de clan non enregistrées (${eventId}) :`, err));
    }
  }
  // Quêtes de la Tour : étages franchis, monstres et gardiens vaincus, à part de ceux du RPG.
  if (client) {
    const bosses = (step.state.bossKills ?? 0) - (state.bossKills ?? 0);
    const monsters = step.state.kills - state.kills - bosses;
    if (climbed > 0) await trackRpgObjective(client, guildId, userId, 'TOWER_FLOORS', climbed);
    if (monsters > 0) await trackRpgObjective(client, guildId, userId, 'TOWER_MONSTER_KILLS', monsters);
    if (bosses > 0) await trackRpgObjective(client, guildId, userId, 'TOWER_BOSS_KILLS', bosses);
  }

  // Guide des salles : une salle piégée rencontrée y est dévoilée pour de bon.
  const met = hiddenRoomsMet(state, step.state);
  const discovered = met.length > 0
    ? await recordDiscoveries(run.profileId, met).catch((err) => {
      logger.warn('RpgTower', `Découverte de salle non enregistrée pour ${userId} :`, err);
      return [];
    })
    : [];

  const updated: RpgTowerRun = {
    ...run,
    state: step.state as unknown as Prisma.JsonValue,
    floor: step.floor,
    version: run.version + 1,
    lastActionAt: new Date(),
    shardsEarned: step.state.shards,
  };

  if (step.dead) {
    const settlement = await settleRun(client, updated, step.state, 'DEAD', settings, false);
    return { active: null, settlement, discovered };
  }
  return { active: { run: updated, state: step.state }, settlement: null, discovered };
}

/** Salles piégées sur lesquelles l'action vient de faire tomber le joueur. */
function hiddenRoomsMet(before: TowerState, after: TowerState): TowerHiddenRoom[] {
  const met: TowerHiddenRoom[] = [];
  if (after.encounter?.mimic && !before.encounter?.mimic) met.push('MIMIC');
  if (after.notice?.k === 'ambush') met.push('AMBUSH');
  if (after.notice?.k === 'wanderer') met.push('WANDERER');
  return met;
}

/** Inscrit les salles piégées rencontrées ; renvoie celles qui étaient encore inconnues. */
async function recordDiscoveries(profileId: string, met: readonly TowerHiddenRoom[]): Promise<TowerHiddenRoom[]> {
  const profile = await prisma.rpgTowerProfile.findUnique({ where: { id: profileId }, select: { discoveredRooms: true } });
  const known = new Set(profile?.discoveredRooms ?? []);
  const fresh = met.filter((room) => !known.has(room));
  if (fresh.length > 0) {
    await prisma.rpgTowerProfile.update({ where: { id: profileId }, data: { discoveredRooms: { push: fresh } } });
  }
  return fresh;
}

/** Salles piégées déjà rencontrées par le joueur, pour son guide des salles. */
export async function getTowerDiscoveries(guildId: string, userId: string): Promise<TowerHiddenRoom[]> {
  const profile = await prisma.rpgTowerProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { discoveredRooms: true },
  });
  return (profile?.discoveredRooms ?? []).filter((room): room is TowerHiddenRoom => (TOWER_HIDDEN_ROOMS as readonly string[]).includes(room));
}

/** Quitter la Tour garde tous les éclats. Impossible en plein combat : on ne fuit pas un étage. */
export async function abandonTowerRun(client: Client | null, guildId: string, userId: string, version: number): Promise<TowerSettlement> {
  const loaded = await loadRunForAction(client, guildId, userId, version);
  if (loaded.kind === 'expired') return loaded.settlement;
  const { run, state } = loaded.active;
  if (state.phase === 'COMBAT') throw new TowerRefused({ kind: 'in_combat' });
  return settleRun(client, run, state, 'LEFT', await getTowerPlayConfig(guildId, run.mode), false);
}

export type ClanTowerStatus = {
  name: string;
  endsAt: Date;
  eventId: string;
  clan: { id: string; name: string } | null;
  /** Tentative du jour déjà jouée. */
  played: boolean;
  /** Prochaine tentative, `null` si l'événement ferme avant. */
  next: Date | null;
  /** Étages gravis au total par le clan du joueur, et ce que ses paliers lui valent. */
  totalFloors: number;
  bonus: ClanTowerBonus;
};

/** Tour de clan vue par un joueur, pour le bouton de `/tour` : `null` hors de la semaine. */
export async function getClanTowerStatus(client: Client | null, guildId: string, userId: string): Promise<ClanTowerStatus | null> {
  const [settings, clans, event] = await Promise.all([getClanTowerConfig(guildId), clansEnabled(guildId), getOpenClanTowerEvent(guildId)]);
  if (!settings.enabled || !clans || !event) return null;
  const now = new Date();
  const [clan, played, totals] = await Promise.all([
    client ? resolveMemberClan(client, guildId, userId) : Promise.resolve(null),
    prisma.rpgTowerRun.count({ where: { guildId, userId, mode: 'CLAN', dailyKey: clanTowerAttemptKey(event.id, event.startsAt, now) } }),
    getClanTowerTotals(event.id),
  ]);
  const totalFloors = clan ? totals.get(clan.id) ?? 0 : 0;
  return {
    totalFloors,
    bonus: clanTowerBonus(totalFloors, settings.milestones),
    name: settings.name,
    endsAt: event.endsAt,
    eventId: event.id,
    clan,
    played: played > 0,
    next: nextClanTowerAttempt(event.startsAt, event.endsAt, now),
  };
}

/** Pose sur l'étage `floor` de la partie les salles que le clan y a déjà conquises. */
async function attachClanConquests(eventId: string, clanId: string, floor: number, state: TowerState): Promise<void> {
  const map = state.map;
  if (!map) return;
  const rooms = await loadClanTowerRooms(eventId, clanId, floor, towerLayoutKey(map.layout)).catch((err) => {
    logger.warn('RpgTower', `Salles conquises de la Tour de clan non chargées (${eventId}) :`, err);
    return [];
  });
  if (rooms.length > 0) applyClanConquests(state, rooms);
}

/**
 * Salles de l'étage de départ que l'action vient de vaincre : un adversaire battu sur place,
 * ou la sortie quand l'action a fait monter (elle est alors la dernière salle résolue).
 */
function conqueredRooms(before: TowerState, after: TowerState, climbed: boolean): string[] {
  const map = before.map;
  if (!map) return [];
  const type = (id: string) => map.layout.rooms.find((room) => room.id === id)?.type;
  if (climbed) {
    const exit = exitRoom(map.layout);
    return exit && !map.conquered?.includes(exit.id) ? [exit.id] : [];
  }
  const cleared = after.map?.cleared ?? [];
  return cleared.filter((id) => !map.cleared.includes(id) && isConquerableRoom(type(id) ?? 'EMPTY'));
}

async function clanEventOver(eventId: string | null): Promise<boolean> {
  if (!eventId) return true;
  const event = await prisma.rpgClanTowerEvent.findUnique({ where: { id: eventId }, select: { status: true, endsAt: true } });
  return !event || event.status !== 'OPEN' || event.endsAt.getTime() <= Date.now();
}

/** Objet du catalogue désigné par son nom : celui du serveur l'emporte sur le livré du même nom. */
async function findGuildItem(client: Prisma.TransactionClient, guildId: string, name: string) {
  const items = await client.rpgItem.findMany({
    where: { name, OR: [{ guildId: null }, { guildId }] },
    select: { id: true, emoji: true, guildId: true },
  });
  return items.find((candidate) => candidate.guildId !== null) ?? items[0] ?? null;
}

/**
 * Verse une récompense de Tour au profil RPG. Chaque versement est isolé : un incident sur
 * le rôle ou les points de clan ne prive pas le joueur du reste, qu'il ne pourra plus réclamer.
 */
async function grantRewardToPlayer(client: Client | null, guildId: string, userId: string, reward: RpgTowerReward, reason: string): Promise<TowerStatGrant | null> {
  const settle = <T>(step: string, run: () => Promise<T>): Promise<T | null> => run().catch((err) => {
    logger.warn('RpgTower', `${step} de « ${reward.name} » non versé à ${userId} sur ${guildId} :`, err);
    return null;
  });

  const itemName = reward.itemName;
  // Une récompense aléatoire tire sa stat à chaque versement.
  const statGrant = towerStatGrant(reward.stat, reward.statAmount, Math.random(), MAX_HEALTH_PER_POINT);
  let paid: boolean | null = null;
  const energy = reward.maxEnergy > 0;
  const vouchers = reward.reclassVouchers > 0;
  if (reward.coins > 0 || reward.xp > 0 || reward.titleId || itemName || statGrant || energy || vouchers) {
    const rpgProfile = await getOrCreateRpgProfile(guildId, userId);
    if (reward.coins > 0 || reward.xp > 0 || itemName || statGrant || energy || vouchers) {
      paid = await settle('Pièces, XP, statistiques, énergie, bons et objet', () => prisma.$transaction(async (tx) => {
        await lockRpgProfile(tx, rpgProfile.id);
        if (reward.coins > 0 || reward.xp > 0 || statGrant || vouchers) {
          await tx.rpgProfile.update({
            where: { id: rpgProfile.id },
            data: {
              balance: { increment: reward.coins },
              xp: { increment: reward.xp },
              reclassVouchers: { increment: reward.reclassVouchers },
              ...(statGrant ? { [statGrant.field]: { increment: statGrant.gain } } : {}),
              // Comme à la répartition : un gain de vitalité soigne d'autant, sinon il resterait
              // invisible jusqu'au prochain repos.
              ...(statGrant?.field === 'maxHealth' ? { health: { increment: statGrant.gain } } : {}),
            },
          });
        }
        if (energy) {
          // Relu sous le verrou : le bonus s'arrête au plafond, sans jamais le dépasser.
          const { bonusMaxEnergy } = await tx.rpgProfile.findUniqueOrThrow({ where: { id: rpgProfile.id }, select: { bonusMaxEnergy: true } });
          const gain = Math.max(0, Math.min(reward.maxEnergy, RPG_BONUS_MAX_ENERGY_CAP - bonusMaxEnergy));
          if (gain > 0) {
            // Comme la vitalité : la réserve gagnée est remplie aussitôt.
            await tx.rpgProfile.update({
              where: { id: rpgProfile.id },
              data: { bonusMaxEnergy: { increment: gain }, energy: { increment: gain } },
            });
          }
        }
        if (itemName) {
          const item = await findGuildItem(tx, guildId, itemName);
          if (item) await addInventoryQuantity(tx, rpgProfile.id, item.id, 1);
          else logger.warn('RpgTower', `Objet « ${itemName} » introuvable pour la récompense ${reward.id} sur ${guildId}.`);
        }
        return true;
      }));
      if (reward.xp > 0) await settle('Passage de niveau', () => checkLevelUp(guildId, userId));
    }
    const titleId = reward.titleId;
    if (titleId) await settle('Titre', () => grantTitle(rpgProfile.id, titleId));
  }

  // La stat versée, pour que la boutique dise laquelle le hasard a tirée.
  const granted = paid ? statGrant : null;
  if (!client) return granted;
  const discord = client;
  if (reward.clanPoints > 0) {
    await settle('Points de clan', () => awardRpgTeamPoints({
      client: discord,
      guildId,
      userId,
      amount: reward.clanPoints,
      source: 'RPG_TOWER',
      reason,
    }));
  }
  const roleId = reward.roleId;
  if (roleId) await settle('Rôle', () => grantRpgRewardRole(discord, guildId, userId, roleId, reason));
  return granted;
}

/**
 * Solde une partie : éclats (moins la pénalité de mort et le plafond hebdomadaire), record
 * de la saison et paliers atteints. La partie est close en premier, sous condition de statut :
 * une partie ne peut être soldée qu'une fois, même si l'expiration et un clic se croisent.
 * Une partie commencée avant l'ouverture de la saison ne compte pas pour son classement.
 */
async function settleRun(
  client: Client | null,
  run: RpgTowerRun,
  state: TowerState,
  outcome: TowerOutcome,
  settings: TowerConfigView,
  expired: boolean,
): Promise<TowerSettlement> {
  if (run.mode === 'CLAN') return settleClanRun(run, state, outcome, expired);
  const kept = settleShards(state.shards, outcome, settings.deathShardPercent, settings.leaveShardPercent, state.safeLeave === true);
  const now = new Date();
  const weekStart = towerWeekStart(now);
  const daily = run.mode === 'DAILY';
  const rooms = towerRoomsExplored(state);
  const killedBy = outcome === 'DEAD' ? state.encounter?.name ?? null : null;
  const ghostGear = bestGhostGear(state);
  const death = outcome === 'DEAD' && state.map
    ? {
      deathRoom: state.map.pos,
      deathFloorKey: towerLayoutKey(state.map.layout),
      ...(ghostGear ? { ghostGear: ghostGear as unknown as Prisma.InputJsonValue } : {}),
    }
    : {};
  const gear = (['weapon', 'armor', 'relic'] as const)
    .map((slot) => state.gear[slot]?.name)
    .filter((name): name is string => Boolean(name));

  const result = await prisma.$transaction(async (tx) => {
    const closed = await tx.rpgTowerRun.updateMany({
      where: { id: run.id, status: 'ACTIVE' },
      data: {
        status: outcome,
        endedAt: now,
        shardsEarned: kept,
        floorsCleared: state.floorsCleared,
        roomsExplored: rooms,
        killedBy,
        floorKeys: state.floorKeys ?? [],
        ...death,
      },
    });
    if (closed.count === 0) return null;

    await tx.$queryRaw`SELECT 1 FROM "rpg_tower_profiles" WHERE "id" = ${run.profileId} FOR UPDATE`;
    const profile = await tx.rpgTowerProfile.findUniqueOrThrow({ where: { id: run.profileId } });
    const sameWeek = profile.weekStart !== null && profile.weekStart.getTime() === weekStart.getTime();
    const weekSoFar = sameWeek ? profile.weekShards : 0;
    // Défi du jour : la série de jours joués d'affilée ajoute sa part aux éclats gardés.
    const streakBonus = daily ? Math.round(kept * towerDailyStreakBonus(profile.dailyStreak)) : 0;
    const granted = applyWeeklyCap(kept + streakBonus, weekSoFar, settings.weeklyShardCap);
    // L'ascension du jour, à stats égales, a son propre classement : elle ne touche ni à la
    // saison, ni aux records, ni aux paliers.
    const inSeason = !daily && run.startedAt.getTime() >= settings.seasonStartedAt.getTime();
    // À étages égaux, les salles explorées départagent : sur carte, les égalités sont fréquentes.
    const newBest = inSeason && (state.floorsCleared > profile.bestFloor
      || (state.floorsCleared === profile.bestFloor && state.floorsCleared > 0 && rooms > profile.bestRooms));
    const top = newBest
      ? await tx.rpgTowerProfile.aggregate({ where: { guildId: run.guildId, id: { not: profile.id } }, _max: { bestFloor: true } })
      : null;
    const serverRecord = newBest && state.floorsCleared > (top?._max.bestFloor ?? 0);

    // Une ascension commencée avant la saison ne rouvre pas les paliers que la nouvelle saison
    // vient de remettre à zéro : elle ne compte pas plus pour eux que pour le record.
    const milestones = !inSeason ? [] : await tx.rpgTowerReward.findMany({
      where: {
        guildId: run.guildId,
        kind: 'MILESTONE',
        enabled: true,
        floor: { lte: state.floorsCleared },
        id: { notIn: profile.claimedRewardIds },
      },
      orderBy: { floor: 'asc' },
    });
    const milestoneShards = milestones.reduce((sum, reward) => sum + reward.shards, 0);

    await tx.rpgTowerProfile.update({
      where: { id: profile.id },
      data: {
        shards: { increment: granted + milestoneShards },
        lifetimeShards: { increment: granted + milestoneShards },
        weekShards: weekSoFar + granted,
        weekStart,
        ...(newBest ? { bestFloor: state.floorsCleared, bestRooms: rooms, bestFloorAt: now } : {}),
        ...(!daily && state.floorsCleared > profile.bestFloorAllTime ? { bestFloorAllTime: state.floorsCleared } : {}),
        ...(milestones.length > 0 ? { claimedRewardIds: { push: milestones.map((reward) => reward.id) } } : {}),
      },
    });

    return { granted, newBest, serverRecord, milestones, streakBonus };
  });

  if (!result) {
    // Déjà soldée par un appel concurrent : on relit ce qui a été versé, sans rien reverser.
    const done = await prisma.rpgTowerRun.findUnique({ where: { id: run.id } });
    return {
      outcome: (done?.status as TowerOutcome) ?? outcome,
      floorsCleared: state.floorsCleared,
      kills: state.kills,
      shards: done?.shardsEarned ?? 0,
      lostToDeath: 0,
      lostToLeave: 0,
      lostToCap: 0,
      newBest: false,
      milestones: [],
      expired,
      alreadySettled: true,
      roomsExplored: rooms,
      killedBy,
      gear,
      daily,
    };
  }

  if (result.serverRecord && client && settings.announceChannelId) {
    await announceRecord(client, run.guildId, settings, run.userId, state.floorsCleared).catch((err) => {
      logger.warn('RpgTower', `Annonce du record non envoyée sur ${run.guildId} :`, err);
    });
  }

  for (const reward of result.milestones) {
    await grantRewardToPlayer(client, run.guildId, run.userId, reward, `Tour : palier ${reward.floor}`).catch((err) => {
      logger.error('RpgTower', `Palier ${reward.id} non versé à ${run.userId} :`, err);
    });
  }

  return {
    outcome,
    floorsCleared: state.floorsCleared,
    kills: state.kills,
    shards: result.granted,
    lostToDeath: outcome === 'DEAD' ? state.shards - kept : 0,
    lostToLeave: outcome === 'LEFT' ? state.shards - kept : 0,
    lostToCap: kept + result.streakBonus - result.granted,
    streakBonus: result.streakBonus,
    newBest: result.newBest,
    milestones: await withTitleNames(result.milestones),
    expired,
    roomsExplored: rooms,
    killedBy,
    gear,
    daily,
  };
}

/**
 * Clôt une ascension de la Tour de clan. Rien n'en sort : ni éclats, ni record, ni paliers,
 * ni fantôme. Ce qu'elle a rapporté, les étages conquis, est déjà inscrit pour le clan.
 */
async function settleClanRun(run: RpgTowerRun, state: TowerState, outcome: TowerOutcome, expired: boolean): Promise<TowerSettlement> {
  const rooms = towerRoomsExplored(state);
  const killedBy = outcome === 'DEAD' ? state.encounter?.name ?? null : null;
  const closed = await prisma.rpgTowerRun.updateMany({
    where: { id: run.id, status: 'ACTIVE' },
    data: {
      status: outcome,
      endedAt: new Date(),
      shardsEarned: 0,
      floorsCleared: state.floorsCleared,
      roomsExplored: rooms,
      killedBy,
      floorKeys: state.floorKeys ?? [],
    },
  });
  return {
    outcome,
    floorsCleared: state.floorsCleared,
    kills: state.kills,
    shards: 0,
    lostToDeath: 0,
    lostToLeave: 0,
    lostToCap: 0,
    newBest: false,
    milestones: [],
    expired,
    ...(closed.count === 0 ? { alreadySettled: true } : {}),
    roomsExplored: rooms,
    killedBy,
    clan: true,
  };
}

/** Nouveau record de la saison sur le serveur : annoncé dans le salon choisi, sans notifier personne. */
async function announceRecord(client: Client, guildId: string, settings: TowerConfigView, userId: string, floors: number): Promise<void> {
  const channel = await client.channels.fetch(settings.announceChannelId!).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('RpgTower', `Salon d'annonce de la Tour injoignable pour ${guildId}.`);
    return;
  }
  const locale = await resolveGuildLocale(guildId);
  const image = await renderTowerImage({
    kind: 'shaft',
    title: settings.name,
    floor: Math.max(1, floors),
    bossEvery: settings.bossEvery,
    floorLabel: (value) => m.tower_floor({ floor: value }, { locale }),
  });
  const embed = new EmbedBuilder()
    .setTitle(m.tower_announce_title({ name: settings.name }, { locale }))
    .setDescription(m.tower_announce_desc({ user: `<@${userId}>`, floors }, { locale }))
    .setColor(0x8b5cf6);
  if (image) embed.setImage('attachment://tour.png');
  await channel.send({
    embeds: [embed],
    files: image ? [{ attachment: image, name: 'tour.png' }] : [],
    allowedMentions: { parse: [] },
  });
}

const IDLE_SWEEP_BATCH = 200;

/**
 * Solde les parties restées inactives au-delà du délai de leur serveur. Sans ce balayage,
 * une partie n'était close qu'à la réouverture de la Tour : celle d'un joueur qui ne revenait
 * pas restait en cours pour toujours, sans record ni paliers versés.
 */
export async function expireIdleTowerRuns(client: Client | null): Promise<number> {
  const now = Date.now();
  const candidates = await prisma.rpgTowerRun.findMany({
    where: {
      status: 'ACTIVE',
      lastActionAt: { lt: new Date(now - TOWER_RANGES.idleTimeoutMinutes.min * 60 * 1000) },
    },
    orderBy: { lastActionAt: 'asc' },
    take: IDLE_SWEEP_BATCH,
  });

  const configs = new Map<string, TowerConfigView>();
  let closed = 0;
  for (const run of candidates) {
    const configKey = `${run.guildId}:${run.mode === 'CLAN' ? 'CLAN' : 'TOWER'}`;
    let settings = configs.get(configKey);
    if (!settings) {
      settings = await getTowerPlayConfig(run.guildId, run.mode);
      configs.set(configKey, settings);
    }
    if (!isExpired(run, settings.idleTimeoutMinutes, now)) continue;
    const state = parseState(run.state);
    try {
      const settlement = await settleRun(client, run, state, state.phase === 'COMBAT' ? 'DEAD' : 'LEFT', settings, true);
      // Soldée entre-temps par le joueur lui-même : il a déjà vu son bilan.
      if (settlement.alreadySettled) continue;
      // Le joueur n'était pas là : son bilan l'attend à sa prochaine visite.
      await prisma.rpgTowerProfile.update({
        where: { id: run.profileId },
        // Aller-retour JSON : les dates des récompenses deviennent du texte, comme à la relecture.
        data: { pendingSettlement: JSON.parse(JSON.stringify(settlement)) as Prisma.InputJsonValue },
      });
      closed += 1;
    } catch (err) {
      logger.error('RpgTower', `Partie ${run.id} expirée non soldée :`, err);
    }
  }
  if (closed > 0) logger.info('RpgTower', `${closed} ascension(s) inactive(s) soldée(s).`);
  return closed;
}

/**
 * Bilan d'une partie close par le balayage, rendu une seule fois : la lecture l'efface sous
 * condition, si bien que deux écrans ouverts en même temps ne l'affichent pas deux fois.
 */
export async function takePendingTowerSettlement(guildId: string, userId: string): Promise<TowerSettlement | null> {
  const profile = await prisma.rpgTowerProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { id: true, pendingSettlement: true },
  });
  if (!profile?.pendingSettlement) return null;
  const taken = await prisma.rpgTowerProfile.updateMany({
    where: { id: profile.id, pendingSettlement: { not: Prisma.DbNull } },
    data: { pendingSettlement: Prisma.DbNull },
  });
  return taken.count > 0 ? (profile.pendingSettlement as unknown as TowerSettlement) : null;
}

// ─────────────────────────────────────────────────────────────
// Boutique, améliorations, classement
// ─────────────────────────────────────────────────────────────

export async function getTowerShop(guildId: string, userId: string) {
  const [settings, profile, rewards, milestones, timeZone] = await Promise.all([
    getTowerConfig(guildId),
    getOrCreateTowerProfile(guildId, userId),
    prisma.rpgTowerReward.findMany({ where: { guildId, kind: 'SHOP', enabled: true }, orderBy: [{ price: 'asc' }, { name: 'asc' }] }),
    prisma.rpgTowerReward.findMany({ where: { guildId, kind: 'MILESTONE', enabled: true }, orderBy: { floor: 'asc' } }),
    resolveGuildTimezone(guildId),
  ]);
  const stored = parseTowerPurchases(profile.purchases);
  const now = new Date();
  return {
    profile,
    rewards: await withTitleNames(rewards),
    milestones: await withTitleNames(milestones),
    upgrades: settings.upgrades.filter((upgrade) => upgrade.enabled),
    levels: parseTowerUpgrades(profile.upgrades, settings.upgrades),
    /** Achats du joueur par article sur la période en cours de sa limite. */
    purchases: Object.fromEntries(rewards.map((reward) => [
      reward.id,
      purchasesInPeriod(stored[reward.id], towerPurchaseKey(reward.limitPeriod, now, timeZone)),
    ])) as Record<string, number>,
  };
}

export async function buyTowerReward(
  client: Client | null,
  guildId: string,
  userId: string,
  rewardId: string,
): Promise<{ reward: RpgTowerReward; stat: TowerStatGrant | null }> {
  const reward = await prisma.rpgTowerReward.findUnique({ where: { id: rewardId } });
  if (!reward || reward.guildId !== guildId || reward.kind !== 'SHOP' || !reward.enabled) {
    throw new TowerRefused({ kind: 'unavailable' });
  }
  // Ce que la récompense donne doit encore exister avant de débiter : un objet retiré du
  // catalogue, un titre ou un rôle supprimé faisaient payer le joueur pour rien.
  if (!(await rewardStillGrantable(client, guildId, reward))) throw new TowerRefused({ kind: 'unavailable' });
  // Au plafond d'énergie max, un article d'énergie ne rapporterait plus rien.
  if (reward.maxEnergy > 0) {
    const rpg = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } }, select: { bonusMaxEnergy: true } });
    if ((rpg?.bonusMaxEnergy ?? 0) >= RPG_BONUS_MAX_ENERGY_CAP) throw new TowerRefused({ kind: 'unavailable' });
  }
  const profile = await getOrCreateTowerProfile(guildId, userId);
  // Période en cours de la limite : le compteur d'un autre jour ou d'une autre semaine repart à zéro.
  const periodKey = towerPurchaseKey(reward.limitPeriod, new Date(), await resolveGuildTimezone(guildId));

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "rpg_tower_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
    const fresh = await tx.rpgTowerProfile.findUniqueOrThrow({ where: { id: profile.id } });
    if (!reward.repeatable && fresh.claimedRewardIds.includes(reward.id)) throw new TowerRefused({ kind: 'owned' });
    // Relu sous le verrou : deux clics sur le dernier exemplaire n'en achètent qu'un.
    const purchases = parseTowerPurchases(fresh.purchases);
    const bought = purchasesInPeriod(purchases[reward.id], periodKey);
    if (reward.maxPurchases > 0 && bought >= reward.maxPurchases) {
      throw new TowerRefused({ kind: 'limit', max: reward.maxPurchases, period: reward.limitPeriod as TowerRewardLimitPeriod });
    }
    if (fresh.shards < reward.price) throw new TowerRefused({ kind: 'shards', price: reward.price, balance: fresh.shards });
    await tx.rpgTowerProfile.update({
      where: { id: profile.id },
      data: {
        shards: { decrement: reward.price },
        purchases: { ...purchases, [reward.id]: { count: bought + 1, key: periodKey } },
        ...(reward.repeatable ? {} : { claimedRewardIds: { push: reward.id } }),
      },
    });
  });

  const stat = await grantRewardToPlayer(client, guildId, userId, reward, `Tour : achat de ${reward.name}`);
  return { reward, stat };
}

/** Objet, titre et rôle de la récompense sont-ils toujours là ? */
async function rewardStillGrantable(client: Client | null, guildId: string, reward: RpgTowerReward): Promise<boolean> {
  if (reward.itemName && !(await findGuildItem(prisma, guildId, reward.itemName))) return false;
  if (reward.titleId && !(await assertGuildTitle(guildId, reward.titleId).then(() => true, () => false))) return false;
  if (reward.roleId && client && !(await assertFirstKillRole(client, guildId, reward.roleId).then(() => true, () => false))) return false;
  return true;
}

export async function buyTowerUpgrade(guildId: string, userId: string, id: string): Promise<{ upgrade: TowerUpgradeDef; level: number }> {
  const settings = await getTowerConfig(guildId);
  const upgrade = settings.upgrades.find((candidate) => candidate.id === id && candidate.enabled);
  if (!upgrade) throw new TowerRefused({ kind: 'unavailable' });
  const profile = await getOrCreateTowerProfile(guildId, userId);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "rpg_tower_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
    const fresh = await tx.rpgTowerProfile.findUniqueOrThrow({ where: { id: profile.id } });
    const stored = fresh.upgrades && typeof fresh.upgrades === 'object' ? (fresh.upgrades as Record<string, unknown>) : {};
    const level = parseTowerUpgrades(stored, [upgrade])[upgrade.id];
    if (level >= upgrade.maxLevel) throw new TowerRefused({ kind: 'upgrade_max' });
    const cost = towerUpgradeCost(upgrade, level);
    if (fresh.shards < cost) throw new TowerRefused({ kind: 'shards', price: cost, balance: fresh.shards });
    await tx.rpgTowerProfile.update({
      where: { id: profile.id },
      data: {
        shards: { decrement: cost },
        // Les niveaux des améliorations supprimées restent en base : les rétablir sous le
        // même identifiant rendrait ce que le joueur avait payé.
        upgrades: { ...stored, [upgrade.id]: level + 1 } as Prisma.InputJsonValue,
      },
    });
    return { upgrade, level: level + 1 };
  });
}

export async function getTowerLeaderboard(guildId: string, limit = 10) {
  return prisma.rpgTowerProfile.findMany({
    where: { guildId, bestFloor: { gt: 0 } },
    orderBy: [{ bestFloor: 'desc' }, { bestRooms: 'desc' }, { bestFloorAt: 'asc' }],
    take: limit,
    select: { userId: true, bestFloor: true, bestRooms: true, bestFloorAt: true, totalRuns: true },
  });
}

/** Jour en cours de l'ascension du jour, dans le fuseau du serveur. */
export async function currentTowerDay(guildId: string, now = new Date()): Promise<string> {
  return towerDayKey(now, await resolveGuildTimezone(guildId));
}

/**
 * Podium du défi : les trois premiers de la veille reçoivent leurs éclats, une seule fois par
 * jour et par serveur, dès que plus aucune ascension de la veille n'est en cours. Un podium de
 * l'avant-veille resté impayé est rattrapé sans attendre. Appelé par une tâche planifiée.
 */
export async function payTowerDailyPodiums(now = new Date()): Promise<number> {
  const configs = await prisma.rpgTowerConfig.findMany({
    where: { dailyEnabled: true, enabled: true },
    select: { guildId: true, dailyPaidKey: true },
  });
  let paid = 0;
  for (const config of configs) {
    try {
      const yesterday = previousTowerDayKey(await currentTowerDay(config.guildId, now));
      if (!yesterday) continue;
      // L'avant-veille d'abord : une ascension de la veille gardée ouverte toute une journée ne
      // doit pas priver son podium de paiement. Les clés AAAA-MM-JJ se comparent comme du texte.
      for (const day of [previousTowerDayKey(yesterday), yesterday]) {
        if (!day || (config.dailyPaidKey !== null && config.dailyPaidKey >= day)) continue;
        // La veille : on attend que ses dernières ascensions soient closes, le classement ne
        // bougera plus. L'avant-veille se paie sans attendre, sur ce qui est fini.
        if (day === yesterday) {
          const running = await prisma.rpgTowerRun.count({ where: { guildId: config.guildId, mode: 'DAILY', dailyKey: day, status: 'ACTIVE' } });
          if (running > 0) break;
        }
        paid += await payTowerDailyPodium(config.guildId, day);
        config.dailyPaidKey = day;
      }
    } catch (err) {
      logger.error('RpgTower', `Podium du défi non versé sur ${config.guildId} :`, err);
    }
  }
  if (paid > 0) logger.info('RpgTower', `${paid} place(s) de podium du défi payée(s).`);
  return paid;
}

/** Paie le podium du défi du jour `day`, s'il ne l'a pas déjà été ; renvoie les places payées. */
async function payTowerDailyPodium(guildId: string, day: string): Promise<number> {
  const podium = (await getTowerDailyLeaderboard(guildId, day, TOWER_DAILY_PODIUM_SHARDS.length))
    .filter((entry) => entry.floorsCleared > 0);
  return prisma.$transaction(async (tx) => {
    // Réservé d'abord : deux passages simultanés ne paient pas deux fois.
    const claimed = await tx.rpgTowerConfig.updateMany({
      where: { guildId, OR: [{ dailyPaidKey: null }, { dailyPaidKey: { lt: day } }] },
      data: { dailyPaidKey: day },
    });
    if (claimed.count === 0) return 0;
    for (const [index, entry] of podium.entries()) {
      const shards = TOWER_DAILY_PODIUM_SHARDS[index];
      await tx.rpgTowerProfile.update({
        where: { guildId_userId: { guildId, userId: entry.userId } },
        data: { shards: { increment: shards }, lifetimeShards: { increment: shards } },
      });
    }
    return podium.length;
  });
}

/** Classement de l'ascension du jour : étages, puis salles explorées, puis le plus tôt fini. */
export async function getTowerDailyLeaderboard(guildId: string, dayKey?: string, limit = 10) {
  return prisma.rpgTowerRun.findMany({
    where: { guildId, mode: 'DAILY', dailyKey: dayKey ?? await currentTowerDay(guildId), status: { not: 'ACTIVE' } },
    orderBy: [{ floorsCleared: 'desc' }, { roomsExplored: 'desc' }, { endedAt: 'asc' }],
    take: limit,
    select: { userId: true, floorsCleared: true, roomsExplored: true, status: true, endedAt: true },
  });
}

/** Le joueur a-t-il déjà joué l'ascension du jour ? */
export async function hasPlayedDaily(guildId: string, userId: string, dayKey?: string): Promise<boolean> {
  const key = dayKey ?? await currentTowerDay(guildId);
  return (await prisma.rpgTowerRun.count({ where: { guildId, userId, mode: 'DAILY', dailyKey: key } })) > 0;
}

/**
 * Ce que disent les parties terminées : étage moyen, part des morts, monstres qui tuent le
 * plus et étage où l'on tombe le plus. De quoi repérer un étage ou un monstre mal réglé.
 * Un étage à variantes est départagé par variante (« 3-E ») : la carte de la mort est
 * reconnue à son empreinte, tant qu'elle n'a pas été redessinée depuis.
 */
export async function getTowerInsights(guildId: string, floors: readonly TowerLayout[]) {
  const finished = { guildId, mode: 'CLASSIC', status: { in: ['DEAD', 'LEFT'] } };
  const [totals, deaths, killers, deathRows] = await Promise.all([
    prisma.rpgTowerRun.aggregate({ where: finished, _avg: { floorsCleared: true }, _count: { _all: true } }),
    prisma.rpgTowerRun.count({ where: { guildId, mode: 'CLASSIC', status: 'DEAD' } }),
    prisma.rpgTowerRun.groupBy({
      by: ['killedBy'],
      where: { guildId, mode: 'CLASSIC', status: 'DEAD', killedBy: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { killedBy: 'desc' } },
      take: 3,
    }),
    prisma.rpgTowerRun.groupBy({
      by: ['floor', 'deathFloorKey'],
      where: { guildId, mode: 'CLASSIC', status: 'DEAD' },
      _count: { _all: true },
    }),
  ]);
  const count = totals._count._all;

  const tags = towerCardTags(floors);
  const cardByKey = new Map(floors.map((layout, index) => [towerLayoutKey(layout), index]));
  const byLabel = new Map<string, { floor: number; variant: string; label: string; name: string; deaths: number }>();
  for (const row of deathRows) {
    const card = row.deathFloorKey ? cardByKey.get(row.deathFloorKey) : undefined;
    const variant = card === undefined ? '' : tags[card].variant;
    const label = towerFloorLabel(row.floor, variant);
    const entry = byLabel.get(label) ?? { floor: row.floor, variant, label, name: card === undefined ? '' : floors[card].name, deaths: 0 };
    entry.deaths += row._count._all;
    byLabel.set(label, entry);
  }
  const deadliest = [...byLabel.values()].sort((a, b) => b.deaths - a.deaths || a.floor - b.floor)[0] ?? null;
  const cards = await getTowerCardStats(guildId, floors);
  return {
    finishedRuns: count,
    averageFloor: Math.round((totals._avg.floorsCleared ?? 0) * 10) / 10,
    deathRate: count > 0 ? Math.round((deaths / count) * 100) : 0,
    topKillers: killers.map((row) => ({ name: row.killedBy ?? '', deaths: row._count._all })),
    deadliestFloor: deadliest,
    cards,
  };
}

/** Bilan d'une carte dessinée sur les vraies parties, variantes à part. */
export type TowerCardStats = {
  index: number;
  floor: number;
  variant: string;
  /** Chance d'être tirée entre les variantes de son étage, en pourcentage. */
  chance: number;
  name: string;
  arrivals: number;
  cleared: number;
  deaths: number;
  left: number;
};

/**
 * Arrivées, passages, morts et départs sur chaque carte dessinée, tirés des parties closes de
 * la Tour classique. Une carte se reconnaît à son empreinte : redessinée, elle repart de zéro,
 * comme la carte des morts. L'étage où une partie s'arrête est le dernier de sa liste.
 */
async function getTowerCardStats(guildId: string, floors: readonly TowerLayout[]): Promise<TowerCardStats[]> {
  if (floors.length === 0) return [];
  const keys = [...new Set(floors.map((layout) => towerLayoutKey(layout)))];
  const [arrivals, endings] = await Promise.all([
    prisma.$queryRaw<{ key: string; runs: number }[]>`
      SELECT k AS "key", COUNT(*)::int AS "runs"
      FROM "rpg_tower_runs", unnest("floorKeys") AS k
      WHERE "guildId" = ${guildId} AND "mode" = 'CLASSIC' AND "status" IN ('DEAD', 'LEFT') AND k = ANY(${keys})
      GROUP BY k`,
    prisma.$queryRaw<{ key: string; status: string; runs: number }[]>`
      SELECT "floorKeys"[cardinality("floorKeys")] AS "key", "status", COUNT(*)::int AS "runs"
      FROM "rpg_tower_runs"
      WHERE "guildId" = ${guildId} AND "mode" = 'CLASSIC' AND "status" IN ('DEAD', 'LEFT')
        AND cardinality("floorKeys") > 0 AND "floorKeys"[cardinality("floorKeys")] = ANY(${keys})
      GROUP BY 1, 2`,
  ]);
  const arrived = new Map(arrivals.map((row) => [row.key, row.runs]));
  const ended = (key: string, status: string) => endings.find((row) => row.key === key && row.status === status)?.runs ?? 0;
  const tags = towerCardTags(floors);
  return floors.map((layout, index) => {
    const key = towerLayoutKey(layout);
    const total = arrived.get(key) ?? 0;
    const deaths = ended(key, 'DEAD');
    const left = ended(key, 'LEFT');
    return { index, ...tags[index], name: layout.name, arrivals: total, cleared: Math.max(0, total - deaths - left), deaths, left };
  });
}

// ─────────────────────────────────────────────────────────────
// Fantômes
// ─────────────────────────────────────────────────────────────

/** Un fantôme ne reste que ce temps : au-delà, l'étage a trop changé de visiteurs. */
const GHOST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Fantômes au plus par étage, pour qu'ils restent une surprise. */
const GHOSTS_PER_FLOOR = 2;

/** La meilleure pièce portée : rareté d'abord, puis la somme des stats. */
function bestGhostGear(state: TowerState): TowerGear | null {
  const pieces = Object.values(state.gear).filter((gear): gear is TowerGear => Boolean(gear));
  const weight = (gear: TowerGear) => TOWER_RARITIES.indexOf(gear.rarity) * 10_000 + gear.attack + gear.defense + gear.speed + gear.maxHealth;
  return pieces.sort((a, b) => weight(b) - weight(a))[0] ?? null;
}

/**
 * Pose sur l'étage en cours les fantômes d'autres joueurs tombés sur la même carte : leur
 * équipement attend le premier qui remportera la salle. L'ascension du jour, à armes égales,
 * n'en reçoit ni n'en laisse.
 */
async function attachGhosts(guildId: string, userId: string, state: TowerState, daily: boolean): Promise<void> {
  const map = state.map;
  if (!map || daily) return;
  const rows = await prisma.rpgTowerRun.findMany({
    where: {
      guildId,
      mode: 'CLASSIC',
      status: 'DEAD',
      deathFloorKey: towerLayoutKey(map.layout),
      ghostClaimedBy: null,
      ghostGear: { not: Prisma.DbNull },
      userId: { not: userId },
      endedAt: { gte: new Date(Date.now() - GHOST_TTL_MS) },
    },
    orderBy: { endedAt: 'desc' },
    take: 10,
    select: { id: true, userId: true, deathRoom: true, ghostGear: true },
  });
  const ghosts: TowerGhost[] = [];
  for (const row of rows) {
    if (ghosts.length >= GHOSTS_PER_FLOOR) break;
    if (!row.deathRoom || map.cleared.includes(row.deathRoom) || ghosts.some((ghost) => ghost.roomId === row.deathRoom)) continue;
    if (!map.layout.rooms.some((room) => room.id === row.deathRoom)) continue;
    ghosts.push({ roomId: row.deathRoom, userId: row.userId, runId: row.id, gear: row.ghostGear as unknown as TowerGear });
  }
  map.ghosts = ghosts;
}

/**
 * Verse dans la source commune ou y puise. Un retrait ne descend jamais sous zéro : deux
 * joueurs qui boivent au même instant ne creusent pas la réserve. Renvoie `false` quand la
 * réserve ne suffit plus, pour que l'appelant annule la gorgée.
 */
async function moveFountainGold(tx: Prisma.TransactionClient, guildId: string, delta: number): Promise<boolean> {
  if (delta > 0) {
    await tx.rpgTowerConfig.upsert({
      where: { guildId },
      update: { fountainGold: { increment: delta } },
      create: { guildId, fountainGold: delta },
    });
    return true;
  }
  const taken = await tx.rpgTowerConfig.updateMany({ where: { guildId, fountainGold: { gte: -delta } }, data: { fountainGold: { decrement: -delta } } });
  return taken.count > 0;
}

/** Marque un fantôme comme repris : un seul joueur récupère son équipement. */
async function claimGhost(runId: string, userId: string): Promise<void> {
  await prisma.rpgTowerRun.updateMany({ where: { id: runId, ghostClaimedBy: null }, data: { ghostClaimedBy: userId } });
}

/**
 * Carte des morts : pour chaque étage dessiné, par son empreinte, le nombre de morts par salle.
 * Seules comptent les morts d'un étage identique à celui enregistré.
 */
export async function getTowerDeathMap(guildId: string, floors: readonly TowerLayout[]): Promise<Record<string, Record<string, number>>> {
  const keys = [...new Set(floors.map((floor) => towerLayoutKey(floor)))];
  if (keys.length === 0) return {};
  const rows = await prisma.rpgTowerRun.groupBy({
    by: ['deathFloorKey', 'deathRoom'],
    where: { guildId, status: 'DEAD', deathFloorKey: { in: keys }, deathRoom: { not: null } },
    _count: { _all: true },
  });
  const map: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    if (!row.deathFloorKey || !row.deathRoom) continue;
    (map[row.deathFloorKey] ??= {})[row.deathRoom] = row._count._all;
  }
  return map;
}

/**
 * Garde-fous de la simulation : elle ne touche pas la base, mais occupe le processeur du bot.
 * Une seule à la fois par serveur, un délai entre deux, et deux au plus sur tout le bot.
 */
const SIM_COOLDOWN_MS = 30_000;
const SIM_CONCURRENT_MAX = 2;
const simRunning = new Set<string>();
const simLastStart = new Map<string, number>();

/**
 * Simulation d'équilibrage pour le dashboard : un joueur automatique de la classe donnée, aux
 * stats d'entrée sans héritage du RPG ni amélioration (comme l'ascension du jour), joue
 * `runs` ascensions sur la Tour telle qu'enregistrée. `skills` : il emporte toutes les
 * compétences de sa classe et de son arbre, ramenées à la Tour.
 */
export async function simulateTower(guildId: string, input: { className?: unknown; runs?: unknown; skills?: unknown; heatMask?: unknown }): Promise<TowerSimResult> {
  if (simRunning.has(guildId)) throw new TowerError('Une simulation est déjà en cours pour ce serveur.', 429);
  const wait = (simLastStart.get(guildId) ?? 0) + SIM_COOLDOWN_MS - Date.now();
  if (wait > 0) throw new TowerError(`Patientez ${Math.ceil(wait / 1000)} s avant une nouvelle simulation.`, 429);
  if (simRunning.size >= SIM_CONCURRENT_MAX) throw new TowerError('Le bot fait déjà tourner des simulations : réessayez dans un instant.', 429);
  simRunning.add(guildId);
  simLastStart.set(guildId, Date.now());
  try {
    return await runSimulation(guildId, input);
  } finally {
    simRunning.delete(guildId);
  }
}

async function runSimulation(guildId: string, input: { className?: unknown; runs?: unknown; skills?: unknown; heatMask?: unknown }): Promise<TowerSimResult> {
  const rpgClass = getRpgClass(typeof input.className === 'string' ? input.className : null);
  const [settings, foes] = await Promise.all([getTowerConfig(guildId), loadFoes(guildId)]);
  const stats = computeTowerEntryStats({
    mode: 'RESET',
    inheritCapPercent: 0,
    titleCapPercent: 0,
    main: { attack: 0, defense: 0, speed: 0, maxHealth: 0 },
    title: { attack: 0, defense: 0, speed: 0, maxHealth: 0, critPercent: 0 },
    classModifiers: rpgClass?.modifiers ?? { attack: 1, defense: 1, speed: 1, maxHealth: 1 },
    classPassive: rpgClass?.passive ?? {},
  });
  const rpgSkills = input.skills === true && rpgClass
    ? [...rpgClass.skills, ...nodesForClass(rpgClass.id).flatMap((node) => (node.grantsSkill ? [node.grantsSkill] : []))]
    : [];
  const skills = rpgSkills.map((skill) => towerSkill({
    id: skill.id,
    name: skill.name,
    emoji: skill.emoji,
    cooldownTurns: skill.cooldownTurns,
    effect: skill.effect,
    tier: towerSkillTier(skill),
  }));
  const runs = Math.min(TOWER_SIM_RUNS_MAX, Math.max(1, Math.trunc(Number(input.runs) || 50)));
  return simulateTowerRuns({
    base: stats,
    skills,
    potions: STARTING_POTIONS,
    rules: rulesOf(settings),
    foes,
    floors: settings.floors,
    floorsAfter: settings.floorsAfter,
    generatedFog: settings.generatedFog,
    heat: heatsFromMask(Math.trunc(Number(input.heatMask) || 0)),
    deathShardPercent: settings.deathShardPercent,
    runs,
    seed: newTowerSeed(),
  });
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────

export async function getTowerDashboard(guildId: string) {
  const [settings, rewards, players, runs, activeRuns, leaderboard, foes, daily] = await Promise.all([
    getTowerConfig(guildId),
    prisma.rpgTowerReward.findMany({ where: { guildId }, orderBy: [{ kind: 'asc' }, { floor: 'asc' }, { price: 'asc' }] }),
    prisma.rpgTowerProfile.count({ where: { guildId } }),
    prisma.rpgTowerRun.count({ where: { guildId } }),
    prisma.rpgTowerRun.count({ where: { guildId, status: 'ACTIVE' } }),
    getTowerLeaderboard(guildId, 10),
    listTowerFoeChoices(guildId),
    getTowerDailyLeaderboard(guildId),
  ]);
  const [deathMap, insights] = await Promise.all([getTowerDeathMap(guildId, settings.floors), getTowerInsights(guildId, settings.floors)]);
  return {
    settings,
    deathMap,
    rewards,
    foes,
    stats: { players, runs, activeRuns, bestFloor: leaderboard[0]?.bestFloor ?? 0 },
    insights,
    leaderboard,
    daily: { dayKey: await currentTowerDay(guildId), leaderboard: daily },
    limits: { rewardsMax: TOWER_REWARDS_PER_GUILD_MAX, mapSize: TOWER_MAP_SIZE, mapRoomsMax: TOWER_MAP_ROOMS_MAX, floorsMax: TOWER_FLOORS_MAX },
  };
}

export async function saveTowerSettings(guildId: string, input: Record<string, unknown>): Promise<TowerConfigView> {
  const normalized = normalizeTowerSettings(input);
  if (!normalized.ok) throw new TowerError(normalized.error, 400);
  const data = {
    ...normalized.value,
    upgrades: normalized.value.upgrades as unknown as Prisma.InputJsonValue,
    merchant: normalized.value.merchant as unknown as Prisma.InputJsonValue,
  };
  await prisma.rpgTowerConfig.upsert({
    where: { guildId },
    update: data,
    create: { guildId, ...data },
  });
  return getTowerConfig(guildId);
}

export async function saveTowerReward(
  client: Client,
  guildId: string,
  input: Record<string, unknown>,
  rewardId?: string,
): Promise<{ reward: RpgTowerReward; created: boolean }> {
  const normalized = normalizeTowerReward(input);
  if (!normalized.ok) throw new TowerError(normalized.error, 400);
  const data = normalized.value;

  await assertGuildTitle(guildId, data.titleId).catch((err: Error) => {
    throw new TowerError(err.message, 400);
  });
  await assertFirstKillRole(client, guildId, data.roleId).catch((err: Error) => {
    throw new TowerError(err.message, 400);
  });
  if (data.itemName && !(await findGuildItem(prisma, guildId, data.itemName))) {
    throw new TowerError(`L'objet « ${data.itemName} » n'existe pas dans le catalogue.`, 400);
  }

  if (!rewardId) {
    const count = await prisma.rpgTowerReward.count({ where: { guildId } });
    if (count >= TOWER_REWARDS_PER_GUILD_MAX) {
      throw new TowerError(`Un serveur ne peut pas avoir plus de ${TOWER_REWARDS_PER_GUILD_MAX} récompenses de Tour.`, 400);
    }
    return { reward: await prisma.rpgTowerReward.create({ data: { guildId, ...data } }), created: true };
  }

  const existing = await prisma.rpgTowerReward.findUnique({ where: { id: rewardId } });
  if (!existing || existing.guildId !== guildId) throw new TowerError('Récompense introuvable.', 404);
  return { reward: await prisma.rpgTowerReward.update({ where: { id: rewardId }, data }), created: false };
}

/**
 * Enregistre les étages dessinés, dans l'ordre de la montée. Un étage invalide fait refuser
 * le tout. Aucun étage : la Tour génère les siens. `layout` seul (une carte) reste accepté.
 * L'étage où se trouve un joueur garde sa carte ; les étages qu'il n'a pas atteints suivent
 * la tour enregistrée.
 */
export async function saveTowerFloors(guildId: string, input: { floors?: unknown; layout?: unknown }): Promise<TowerConfigView> {
  const raw = Array.isArray(input.floors)
    ? input.floors
    : input.layout !== null && input.layout !== undefined ? [input.layout] : [];
  const normalized = normalizeTowerFloors(raw);
  if (!normalized.ok) throw new TowerError(normalized.error, 400);

  const data = {
    // Les étages se jouent toujours : l'ancien interrupteur « carte jouée » n'a plus d'effet.
    layoutEnabled: true,
    layouts: normalized.value as unknown as Prisma.InputJsonValue,
    // L'ancienne carte unique ne sert plus qu'à relire les tours d'avant les étages.
    layout: Prisma.DbNull,
    floorsUpdatedAt: new Date(),
  };
  await prisma.rpgTowerConfig.upsert({ where: { guildId }, update: data, create: { guildId, ...data } });
  return getTowerConfig(guildId);
}

/**
 * Aperçu de l'image que verront les joueurs en arrivant sur un étage, pour l'éditeur du
 * dashboard. La carte envoyée n'a pas besoin d'être enregistrée ; elle doit être valide.
 */
export async function previewTowerFloor(guildId: string, input: { layout?: unknown; floor?: unknown }): Promise<string> {
  const normalized = normalizeTowerLayout(input.layout);
  if (!normalized.ok) throw new TowerError(normalized.error, 400);
  const layout = normalized.value;
  const floor = Math.max(1, Math.trunc(Number(input.floor) || 1));
  const [settings, locale] = await Promise.all([getTowerConfig(guildId), resolveGuildLocale(guildId)]);
  // Départ, ou la première entrée d'un étage à puits ou à entrées au choix.
  const start = startRoom(layout)!;
  const title = (n: number, name: string) => (name ? m.tower_floor_named({ floor: n, name }, { locale }) : m.tower_floor({ floor: n }, { locale }));
  const layoutOf = (n: number) => (n === floor ? layout : floorLayout(settings.floors, n));
  const ladder = [];
  for (let n = floor + 2; n >= Math.max(1, floor - 2); n--) {
    const at = layoutOf(n);
    ladder.push({
      label: title(n, at?.name ?? ''),
      status: n === floor ? 'current' as const : n > floor ? 'next' as const : 'done' as const,
      theme: resolveTowerTheme(at?.theme, n),
    });
  }
  // Ce que voit le joueur en arrivant : sous le brouillard, seulement l'entrée et ses voisines ;
  // devant des entrées au choix, seulement ces entrées, sans y être encore.
  const choices = entryRooms(layout).filter((room) => room.type === 'ENTRANCE').map((room) => room.id);
  const cleared = choices.length > 0 ? [] : [start.id];
  const visible = !towerLayoutHasFog(layout) ? null : choices.length > 0 ? new Set(choices) : visibleRooms(layout, start.id, cleared);
  const targets = choices.length > 0 ? choices : roomNeighbors(layout, start.id).map(({ room }) => room.id);
  const image = await renderTowerImage({
    kind: 'map',
    title: title(floor, layout.name),
    floor,
    layout,
    pos: start.id,
    cleared,
    targets,
    ladder,
    visible: visible ? [...visible] : null,
  });
  if (!image) throw new TowerError('Le rendu de l\'aperçu a échoué.', 500);
  return `data:image/png;base64,${image.toString('base64')}`;
}

export async function deleteTowerReward(guildId: string, rewardId: string): Promise<RpgTowerReward> {
  const existing = await prisma.rpgTowerReward.findUnique({ where: { id: rewardId } });
  if (!existing || existing.guildId !== guildId) throw new TowerError('Récompense introuvable.', 404);
  return prisma.rpgTowerReward.delete({ where: { id: rewardId } });
}

/**
 * Ouvre une nouvelle saison : le classement repart de zéro. Les éclats, les améliorations et
 * le record de tous les temps sont conservés, et les parties en cours continuent sans compter
 * pour la nouvelle saison. Avec `resetMilestones`, les paliers se regagnent : les articles
 * uniques déjà achetés, eux, restent acquis.
 */
export async function startTowerSeason(guildId: string, options: { resetMilestones?: boolean } = {}): Promise<number> {
  const now = new Date();
  await prisma.rpgTowerConfig.upsert({
    where: { guildId },
    update: { seasonStartedAt: now },
    create: { guildId, seasonStartedAt: now },
  });
  const reset = await prisma.rpgTowerProfile.updateMany({ where: { guildId }, data: { bestFloor: 0, bestRooms: 0, bestFloorAt: null } });

  if (options.resetMilestones !== false) {
    const milestones = await prisma.rpgTowerReward.findMany({ where: { guildId, kind: 'MILESTONE' }, select: { id: true } });
    const ids = milestones.map((reward) => reward.id);
    if (ids.length > 0) {
      await prisma.$executeRaw`
        UPDATE "rpg_tower_profiles"
        SET "claimedRewardIds" = ARRAY(SELECT id FROM unnest("claimedRewardIds") AS id WHERE NOT (id = ANY(${ids}::text[])))
        WHERE "guildId" = ${guildId} AND "claimedRewardIds" && ${ids}::text[]`;
    }
  }
  return reset.count;
}

/**
 * Remet la Tour à zéro. Toujours : parties en cours et terminées, éclats, améliorations,
 * records et paliers obtenus de tous les joueurs. Avec `everything`, aussi les réglages, les
 * étages dessinés et les récompenses. Ce qui a déjà été versé au profil RPG (pièces, XP,
 * objets, titres, rôles) n'est pas repris.
 */
export async function resetTower(guildId: string, options: { everything?: boolean } = {}) {
  return prisma.$transaction(async (tx) => {
    const runs = await tx.rpgTowerRun.deleteMany({ where: { guildId } });
    const profiles = await tx.rpgTowerProfile.deleteMany({ where: { guildId } });
    let rewards = 0;
    if (options.everything) {
      rewards = (await tx.rpgTowerReward.deleteMany({ where: { guildId } })).count;
      await tx.rpgTowerConfig.deleteMany({ where: { guildId } });
    }
    return { runs: runs.count, profiles: profiles.count, rewards };
  });
}

/** Fiche Tour d'un joueur, pour les administrateurs. Lecture seule : une partie expirée n'est pas soldée ici. */
export async function getTowerPlayerSummary(guildId: string, userId: string) {
  const [settings, profile, run] = await Promise.all([
    getTowerConfig(guildId),
    prisma.rpgTowerProfile.findUnique({ where: { guildId_userId: { guildId, userId } } }),
    prisma.rpgTowerRun.findFirst({ where: { guildId, userId, status: 'ACTIVE' }, orderBy: { startedAt: 'desc' } }),
  ]);
  const state = run ? parseState(run.state) : null;
  return {
    profile: profile
      ? {
        shards: profile.shards,
        lifetimeShards: profile.lifetimeShards,
        bestFloor: profile.bestFloor,
        bestFloorAllTime: profile.bestFloorAllTime,
        totalRuns: profile.totalRuns,
        weekShards: profile.weekShards,
        upgrades: parseTowerUpgrades(profile.upgrades, settings.upgrades),
        claimedRewardIds: profile.claimedRewardIds,
      }
      : null,
    activeRun: run && state
      ? {
        floor: run.floor,
        phase: state.phase,
        hp: state.hp,
        gold: state.gold,
        potions: state.potions,
        shardsAtStake: state.shards,
        floorsCleared: state.floorsCleared,
        lastActionAt: run.lastActionAt,
      }
      : null,
  };
}

/** Ajoute ou retire des éclats à un joueur. Le solde ne descend jamais sous zéro. */
export async function adjustTowerShards(guildId: string, userId: string, delta: number): Promise<number> {
  if (!Number.isInteger(delta) || delta === 0) throw new TowerError('Le montant doit être un entier non nul.', 400);
  const profile = await getOrCreateTowerProfile(guildId, userId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "rpg_tower_profiles" WHERE "id" = ${profile.id} FOR UPDATE`;
    const fresh = await tx.rpgTowerProfile.findUniqueOrThrow({ where: { id: profile.id } });
    const shards = Math.max(0, fresh.shards + delta);
    await tx.rpgTowerProfile.update({ where: { id: profile.id }, data: { shards } });
    return shards;
  });
}
