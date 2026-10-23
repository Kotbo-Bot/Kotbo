/**
 * Moteur d'une ascension de la Tour : une machine à états pure.
 *
 * Chaque clic est une action appliquée à l'état stocké avec la partie, qui renvoie l'état
 * suivant. Aucun accès base, aucun collecteur : la partie survit à un redémarrage du bot,
 * et le service n'a qu'à écrire le résultat sous condition de version.
 */

import { computeAttack, damageThrough } from './rpgCombatMath.js';
import {
  ALLY_POWER,
  ALTAR_COST,
  AMBUSH_DAMAGE,
  CAPTIVE_GOLD,
  oraclePrice,
  FOUNTAIN_HEAL,
  fountainDonation,
  fountainDrinkCost,
  BLESSED_HEAL,
  BURN_DAMAGE,
  FIRE_START_DISTANCE,
  FROST_FIRST_HIT,
  MIST_LIFT_ROOMS,
  MIST_CHEST_GOLD,
  MOONLESS_AMBUSH_BOUNTY,
  MOONLESS_WANDERER_STEPS,
  FLOODED_SPEED,
  HEAT_FAMINE_HEAL,
  HEAT_FOE_BOOST,
  HEAT_GREED_PRICE,
  HEAT_SHARD_BONUS,
  MENTOR_OFFERS,
  MIMIC_NAME,
  TRAP_DAMAGE,
  TRAP_DODGE,
  mercenaryPrice,
  mentorPrice,
  BLACKSMITH_BOOST,
  CURSE_ATTACK,
  DISPEL_SKILL_MULTIPLIER,
  EXECUTE_BONUS,
  EXECUTE_THRESHOLD,
  PACT_TREASURES,
  PHASE_BOOST,
  PHASE_HEAL,
  PHASE_THRESHOLD,
  REGENERATION,
  SHARD_SEEKER_BONUS,
  SHIELD_SHARE,
  SPRING_HEAL,
  SUMMON_EVERY,
  SUMMON_MAX,
  SUMMON_POWER,
  THORNY_REFLECT,
  TOWER_BOSS_MECHANICS,
  TOWER_EVENTS,
  TOWER_TRAITS,
  TRAIT_MONSTER_CHANCE,
  TRAIT_MONSTER_LEVEL,
  TRAIT_STATS,
  VAMPIRIC_DRAIN,
  blacksmithPrice,
  type TowerBossMechanic,
  type TowerEventId,
  type TowerHeat,
  type TowerMechanicChoice,
  type TowerRelicPerk,
  type TowerTrait,
} from './rpgTowerContent.js';
import {
  BOSS_VICTORY_HEAL,
  CAMPFIRE_HEAL,
  EMPTY_GEAR,
  FALLBACK_BOSSES,
  FALLBACK_MONSTERS,
  LOOT_CHANCE,
  TOWER_FORTUNE_MAX,
  MAX_POTIONS,
  TOWER_CHARGE_EVERY,
  TOWER_DEFEND_HEAL,
  TOWER_ENRAGE_MULTIPLIER,
  TOWER_ENRAGE_THRESHOLD,
  TOWER_FLEE_GOLD_LOSS,
  TOWER_HEAVY_MULTIPLIER,
  TOWER_MERCHANT_DEFAULTS,
  TOWER_MONSTER_CRIT,
  TOWER_PARRIED_MULTIPLIER,
  TOWER_RIPOSTE_MULTIPLIER,
  TowerRng,
  effectiveCooldown,
  encounterGold,
  findBlessing,
  floorShards,
  isBossFloor,
  rollBlessingChoices,
  rollDoors,
  rollMerchantOffers,
  rescaleTowerGear,
  rollTowerGear,
  scrapValue,
  towerDodgeChance,
  towerEffectiveStats,
  towerMonsterStats,
  towerRerollPrice,
  treasureGold,
  type TowerCoreStats,
  type TowerDoor,
  type TowerEffectiveStats,
  type TowerEncounterKind,
  type TowerFoeName,
  type TowerGear,
  type TowerGearSet,
  type TowerMerchantSettings,
  type TowerOffer,
  type TowerSkill,
} from './rpgTowerPolicy.js';
import {
  TOWER_COLLAPSE_STEPS,
  TOWER_TOLL_GOLD,
  TOWER_TRIAL_WAVES,
  TOWER_WANDER_RADIUS,
  canWanderInto,
  distancesFromStart,
  entryRooms,
  exitLocks,
  exitRoom,
  isEntryRoom,
  isExitRoom,
  occupancy,
  pathBetween,
  roomNeighbors,
  startRoom,
  towerLayoutHasFog,
  towerLayoutKey,
  wanderZone,
  type TowerCaptiveKind,
  type TowerDirection,
  type TowerExitType,
  type TowerFloorModifier,
  type TowerFloorsAfter,
  type TowerLayout,
  type TowerRoom,
  type TowerRoomType,
} from './rpgTowerMap.js';
import { towerFloorLayout } from './rpgTowerGen.js';
import { UserFacingError } from '../../../utils/userFacingError.js';

export type TowerPhase = 'DOORS' | 'COMBAT' | 'LOOT' | 'BLESSING' | 'MERCHANT' | 'EVENT' | 'MERCENARY' | 'MENTOR' | 'ENTRY' | 'TOLL' | 'FOUNTAIN' | 'ORACLE';

export type TowerLogEntry =
  | { k: 'attack'; dmg: number; crit: boolean }
  | { k: 'skill'; name: string; emoji: string; dmg: number; crit: boolean }
  | { k: 'support'; name: string; emoji: string }
  | { k: 'defend'; hp?: number }
  | { k: 'potion'; hp: number }
  | { k: 'heal'; hp: number }
  /** `heavy` : coup puissant annoncé au tour précédent ; `parried` : reçu en garde. */
  | { k: 'monster'; dmg: number; crit: boolean; heavy?: boolean; parried?: boolean }
  | { k: 'evaded' }
  | { k: 'dodged' }
  | { k: 'charge' }
  | { k: 'enrage' }
  | { k: 'thorns'; dmg: number }
  /** Le monstre (trait Rapide) esquive le coup du joueur. */
  | { k: 'foeDodged' }
  | { k: 'shield'; dmg: number }
  | { k: 'shieldBroken' }
  | { k: 'summon'; count: number }
  | { k: 'dispel' }
  | { k: 'phase' }
  | { k: 'regen'; hp: number }
  | { k: 'drain'; hp: number }
  | { k: 'spikes'; dmg: number }
  | { k: 'lastStand' }
  /** Coup du mercenaire. */
  | { k: 'ally'; dmg: number };

export type TowerEncounter = {
  kind: TowerEncounterKind;
  name: string;
  emoji: string;
  health: number;
  maxHealth: number;
  attack: number;
  defense: number;
  speed: number;
  /** Tours restants avant que chaque compétence redevienne disponible. */
  cooldowns: Record<string, number>;
  defenseMultiplier: number;
  evade: boolean;
  log: TowerLogEntry[];
  /** Coups portés par le monstre. Les champs suivants manquent aux parties d'avant leur ajout. */
  turn?: number;
  /** Le prochain coup du monstre est un coup puissant. */
  charging?: boolean;
  enraged?: boolean;
  /** Le joueur s'est défendu : sa prochaine attaque est renforcée. */
  riposte?: boolean;
  traits?: TowerTrait[];
  mechanic?: TowerBossMechanic | null;
  /** Bouclier restant (mécanique SHIELD) : il encaisse avant les PV. */
  shield?: number;
  /** Sbires invoqués (mécanique SUMMONER). */
  minions?: number;
  /** Seconde phase déclenchée (mécanique PHASES). */
  phased?: boolean;
  /** Le joueur a déjà frappé dans ce combat (relique FIRST_STRIKE). */
  opened?: boolean;
  /** Le sursis de la relique LAST_STAND a servi dans ce combat. */
  lastStandUsed?: boolean;
  /** Un coffre qui était une mimique. */
  mimic?: boolean;
  /** Le vaincre ouvre la sortie : gardien d'un péage forcé. */
  opensExit?: boolean;
  /** Monstre errant (sa case de départ) : vaincu, il quitte l'étage. */
  wanderer?: string;
  /** Embuscade : pris au piège, le joueur ne peut pas fuir. */
  ambush?: boolean;
  /** Geôlier d'un prisonnier : le vaincre libère le captif. */
  captive?: TowerCaptiveKind;
  /** Puissance réglée sur la salle (1 : normale). */
  power?: number;
  /** Multiplicateur de l'or et de la chance de butin, quand la salle le fait suivre sa puissance. */
  bounty?: number;
};

/** Étage atteint en montant : son numéro et le nom de sa carte. */
export type TowerClimb = { floor: number; name: string };

/** Ce qui s'est passé à la dernière action, affiché en tête de l'écran suivant. */
export type TowerNotice =
  /** `climbed` : étage atteint quand le gardien d'une carte vient de tomber. */
  | {
    k: 'victory';
    name: string;
    emoji: string;
    gold: number;
    healed: number;
    climbed: TowerClimb | null;
    /** Clé de l'escalier scellé trouvée sur ce monstre, ou sceau allumé en le battant. */
    lock?: TowerLockProgress | null;
    /** Joueur tombé dans cette salle, dont l'équipement vient d'être retrouvé. */
    ghost?: string | null;
    /** Captif libéré en battant son geôlier, et ce qu'il a rendu. */
    captive?: TowerCaptiveGift | null;
  }
  | { k: 'treasure'; gold: number; lock?: TowerLockProgress | null }
  /** Vague suivante d'une épreuve. */
  | { k: 'wave'; wave: number; waves: number; gold: number }
  /** Sortie franchie sans combat : escalier ouvert ou portail. */
  | { k: 'exit'; exit: TowerExitType; climbed: TowerClimb | null; conquered?: boolean }
  /** Piège déclenché, ou évité grâce à la vitesse. */
  | { k: 'trap'; dmg: number; dodged: boolean }
  | { k: 'hired'; gold: number }
  | { k: 'learned'; name: string; emoji: string; gold: number }
  | { k: 'ambush'; dmg: number }
  /** Un monstre errant attaque ; `before` : ce que venait de rapporter la salle, gardé à l'écran. */
  | { k: 'wanderer'; before?: TowerNotice | null }
  | { k: 'oracle'; gold: number; revealed: boolean }
  | { k: 'collapsed' }
  | { k: 'toll_paid'; gold: number; climbed: TowerClimb | null }
  | { k: 'fountain_drink'; hp: number; cost: number }
  | { k: 'fountain_donate'; gold: number }
  | { k: 'mentor_empty' }
  | { k: 'campfire'; hp: number }
  | { k: 'potion'; hp: number }
  | { k: 'equipped'; name: string; emoji: string }
  | { k: 'scrapped'; gold: number }
  | { k: 'blessed'; id: string; rank: number }
  | { k: 'bought'; kind: TowerOffer['kind'] }
  | { k: 'fled'; gold: number }
  | { k: 'rerolled' }
  /** Issue d'un événement : `amount` selon l'événement (PV, or, prix), `won` pour le pari. */
  | { k: 'event'; id: TowerEventId; option: number; amount: number; won?: boolean; item?: string };

/** Progression vers l'ouverture de la sortie, après une clé trouvée ou un sceau allumé. */
export type TowerLockProgress = { kind: 'key' | 'seal'; done: number; needed: number };

/** Ce qu'on sait d'une porte ou d'une salle avant d'y entrer. */
export type TowerRoomInfo = { traits: TowerTrait[]; mechanic: TowerBossMechanic | null; event: TowerEventId | null };

/**
 * Position sur l'étage en cours. Sa carte est copiée en y arrivant : la modifier ensuite ne
 * touche pas à l'étage où se trouve le joueur, seulement aux étages qu'il n'a pas atteints.
 */
export type TowerMapState = {
  layout: TowerLayout;
  /** Ancien compteur de sections, conservé dans les parties d'avant les étages. */
  section?: number;
  /**
   * Salles résolues depuis l'entrée, plus un : c'est ce qui règle la force des monstres, l'or
   * et le butin, pour que la difficulté monte à chaque salle et pas seulement à chaque étage.
   * Absent des parties d'avant les étages, où le numéro d'étage en tenait lieu.
   */
  depth?: number;
  /**
   * Niveau de difficulté à l'arrivée sur l'étage, et profondeur à ce moment-là. La difficulté
   * ne monte que de `TOWER_FLOOR_DEPTH_MAX` salles par étage : sans ce plafond, explorer une
   * grande carte en entier rendait les étages suivants injouables. Absents des parties d'avant
   * ce plafond, qui gardent la profondeur seule.
   */
  floorBase?: number;
  floorStart?: number;
  /** Salle où se trouve le joueur. */
  pos: string;
  /** Salles déjà résolues sur l'étage en cours ; les retraverser ne coûte rien. */
  cleared: string[];
  /** Salle d'où l'on vient, où ramène une fuite. */
  prev?: string;
  /** Traits, mécaniques et événements des salles, tirés en arrivant sur l'étage. */
  rooms?: Record<string, TowerRoomInfo>;
  /**
   * Fantômes de l'étage : l'équipement laissé par un joueur tombé dans une salle de cette même
   * carte. Chargés par le service à l'arrivée sur l'étage ; le moteur ne fait que les remettre.
   */
  ghosts?: TowerGhost[];
  /** Pas faits sur l'étage : un escalier qui s'effondre les compte. */
  steps?: number;
  /** Entrées entre lesquelles le joueur choisit en arrivant ; vidé une fois le choix fait. */
  entryChoices?: string[];
  /** Monstres errants encore en vie sur l'étage. */
  wanderers?: TowerWanderer[];
  /** Un oracle a révélé l'étage sous le brouillard. */
  revealed?: boolean;
  /** Chemin vers la sortie montré par un oracle, sur un étage sans brouillard. */
  oraclePath?: string[];
  /**
   * Tour de clan : salles déjà conquises par le clan du joueur sur cet étage. Elles restent
   * vaincues, et une sortie conquise se franchit sans rien affronter. Posées par le service.
   */
  conquered?: string[];
  /**
   * Étage en feu : salles qui brûlent. Le feu part d'une salle et gagne une voisine à chaque
   * pas. Absent des étages arrivés avant la propagation : chaque nouvelle salle y brûle.
   */
  fire?: string[];
  /** La brume de l'étage s'est levée. */
  mistLifted?: boolean;
};

export type TowerGhost = { roomId: string; userId: string; runId: string; gear: TowerGear };

/** Monstre errant encore en vie : sa case de départ (ses réglages) et sa position. */
export type TowerWanderer = { spawn: string; pos: string; radius: number };

export type TowerCaptiveGift = { kind: 'GOLD' | 'POTION' | 'ALLY'; amount: number };

/** Salle voisine proposée au joueur. */
export type TowerMove = { roomId: string; type: TowerRoomType; direction: TowerDirection; cleared: boolean };

export type TowerState = {
  v: 1;
  rng: number;
  base: TowerCoreStats;
  hp: number;
  gold: number;
  potions: number;
  gear: TowerGearSet;
  blessings: Record<string, number>;
  skills: TowerSkill[];
  phase: TowerPhase;
  doors: TowerDoor[];
  encounter: TowerEncounter | null;
  pendingLoot: TowerGear | null;
  blessingDue: boolean;
  blessingChoices: string[];
  merchant: TowerOffer[];
  shards: number;
  floorsCleared: number;
  kills: number;
  /** Gardiens parmi `kills`. Absent des parties d'avant ce champ. */
  bossKills?: number;
  /**
   * Porte-bonheur acheté avec des éclats : part d'or et de chance d'objet en plus, en combat
   * et dans les coffres. Absent des parties d'avant ce champ, et des ascensions sans amélioration.
   */
  fortune?: number;
  /**
   * Empreinte de la carte de chaque étage atteint, dans l'ordre (voir `towerLayoutKey`) : les
   * statistiques par carte du dashboard. Absent des parties d'avant ce champ, qui ne comptent pas.
   */
  floorKeys?: string[];
  notice: TowerNotice | null;
  /** Carte dessinée, `null` en mode aléatoire. */
  map: TowerMapState | null;
  moves: TowerMove[];
  /**
   * Règles figées à l'entrée : un réglage changé au dashboard ne touche pas aux parties en
   * cours. Absent des parties lancées avant ce champ, qui suivent les réglages du moment.
   */
  rules?: TowerRules;
  /** Le marchand courant a déjà renouvelé son équipement. */
  merchantRerolled?: boolean;
  /** Palier sûr : un gardien vient de tomber, partir maintenant garde tous les éclats. */
  safeLeave?: boolean;
  /** Graine de la partie : les étages générés en découlent. */
  seed?: number;
  /** Ce que cache chaque porte en mode aléatoire, dans l'ordre des portes. */
  doorInfo?: TowerRoomInfo[];
  /** Événement en cours. */
  event?: { id: TowerEventId } | null;
  /** Malédictions acceptées : chacune renforce l'attaque des monstres. */
  curse?: number;
  /** Épreuve en cours : vague atteinte sur le total. On n'en fuit pas. */
  trial?: {
    wave: number;
    waves: number;
    /** Puissance de la salle, appliquée à chaque vague ; absente des parties d'avant ce réglage. */
    power?: number;
    powerReward?: boolean;
    /** La réussite paie comme un gardien. */
    reward?: boolean;
  } | null;
  /** Mercenaire engagé : il combat jusqu'à la fin de l'étage. */
  ally?: boolean;
  /** Réserve de la source commune du serveur, posée par le service avant chaque action. */
  fountainPool?: number;
  /** Or versé (positif) ou puisé (négatif) dans la source à cette action, que le service reporte. */
  fountainDelta?: number;
  /** Compétences du RPG non achetées au départ, qu'un mentor peut encore enseigner. */
  skillPool?: TowerSkill[];
  /** Compétences proposées par le mentor de la salle en cours (identifiants). */
  mentor?: string[];
  /** Malédictions choisies au départ, chacune contre plus d'éclats. */
  heat?: TowerHeat[];
  /** Ascension dont le fantôme vient d'être retrouvé : le service la marque comme reprise. */
  ghostTaken?: string | null;
  /** PV brûlés à la dernière action, sur un étage en feu. */
  burned?: number;
  /** Changement de temps à la dernière action, montré une seule fois. */
  weather?: 'mist_lifted' | null;
};

export type TowerRules = {
  floorGrowthPercent: number;
  bossEvery: number;
  blessingEvery: number;
  maxBlessings: number;
  shardsPerFloor: number;
  /** Éclats par salle résolue ; absent des parties d'avant ce réglage. */
  shardsPerRoom?: number;
  /** Absent : réglages par défaut du marchand. */
  merchant?: TowerMerchantSettings;
  /** Absent : la tour reprend au premier étage dessiné. */
  floorsAfter?: TowerFloorsAfter;
  /** Absent : les étages générés ont leur brouillard. */
  generatedFog?: boolean;
  /** Défi du jour : ambiance imposée à chaque étage, qui remplace celle de la carte. */
  floorModifier?: TowerFloorModifier;
};

/** Carte de l'étage `floor`, avec l'ambiance imposée par les règles s'il y en a une. */
export function towerRunFloorLayout(floors: readonly TowerLayout[], floor: number, rules: TowerRules, seed: number): TowerLayout {
  const layout = towerFloorLayout(floors, floor, rules.floorsAfter ?? 'LOOP', seed, rules.generatedFog ?? true);
  return rules.floorModifier ? { ...layout, modifier: rules.floorModifier } : layout;
}

function merchantOf(rules: TowerRules): TowerMerchantSettings {
  return rules.merchant ?? TOWER_MERCHANT_DEFAULTS;
}

export type TowerFoePool = {
  monsters: TowerFoeName[];
  bosses: TowerFoeName[];
  /** Tout le bestiaire par nom, désactivés compris, pour les salles qui imposent leur créature. */
  byName: Record<string, TowerFoeName>;
};

export type TowerAction =
  | { type: 'door'; index: number }
  | { type: 'attack' }
  | { type: 'defend' }
  | { type: 'skill'; id: string }
  | { type: 'potion' }
  | { type: 'equip' }
  | { type: 'discard' }
  | { type: 'bless'; index: number }
  | { type: 'buy'; index: number }
  | { type: 'reroll' }
  | { type: 'leave_shop' }
  | { type: 'flee' }
  | { type: 'event'; index: number }
  | { type: 'hire' }
  | { type: 'learn'; index: number }
  /** Péage : payer, ou forcer le passage contre son gardien. */
  | { type: 'pay' }
  | { type: 'force' }
  /** Source commune : boire, ou y verser de l'or. */
  | { type: 'drink' }
  | { type: 'donate' }
  /** Oracle : payer pour voir l'étage. */
  | { type: 'reveal' }
  /** Combat automatique contre un monstre ordinaire. */
  | { type: 'auto' };

export type TowerActionError =
  | 'wrong_phase'
  | 'bad_choice'
  | 'skill_cooldown'
  | 'no_potion'
  | 'hp_full'
  | 'no_gold'
  | 'sold_out'
  | 'potions_full'
  | 'no_flee'
  | 'no_reroll'
  | 'no_gear'
  | 'stairs_locked'
  | 'gate_locked'
  | 'no_auto'
  | 'fountain_dry';

export class TowerActionRefused extends UserFacingError {
  constructor(readonly reason: TowerActionError) {
    super(`Action de Tour refusée : ${reason}`);
    this.name = 'TowerActionRefused';
  }
}

export type TowerStepResult = { state: TowerState; floor: number; dead: boolean };

const LOG_KEPT = 6;

/**
 * Combat automatique : coups enchaînés contre un monstre ordinaire, jamais contre une élite
 * ou un gardien, avec une garde levée devant un coup puissant annoncé. Il lance la plus forte
 * des compétences offensives prêtes, l'attaque de base sinon. Il rend la main sous ce seuil de
 * PV, pour que le joueur boive, se soigne ou fuie à temps.
 */
export const AUTO_STOP_HEALTH = 0.35;
const AUTO_TURNS_MAX = 40;

function autoFight(
  state: TowerState,
  floor: number,
  rules: TowerRules,
  rng: TowerRng,
  floors: readonly TowerLayout[],
  foes: TowerFoePool,
): TowerStepResult {
  const encounter = state.encounter;
  if (!encounter || encounter.kind !== 'COMBAT') throw new TowerActionRefused('no_auto');
  if (state.hp < towerStats(state).maxHealth * AUTO_STOP_HEALTH) throw new TowerActionRefused('no_auto');
  let result: TowerStepResult = { state, floor, dead: false };
  for (let turn = 0; turn < AUTO_TURNS_MAX; turn++) {
    result = combatTurn(state, floor, autoAction(state, encounter), rules, rng, floors, foes);
    // Fin du combat, nouvelle vague d'épreuve ou PV bas : le joueur reprend la main.
    if (result.dead || state.phase !== 'COMBAT' || state.encounter !== encounter) break;
    if (state.hp < towerStats(state).maxHealth * AUTO_STOP_HEALTH) break;
  }
  return result;
}
/**
 * Coup du combat automatique. Seules les compétences qui frappent plus fort qu'une attaque
 * sont lancées : un soin ou une posture défensive resterait sans effet utile ici, puisque le
 * joueur reprend la main dès que ses PV baissent.
 */
function autoAction(state: TowerState, encounter: TowerEncounter): TowerAction {
  if (encounter.charging) return { type: 'defend' };
  const strongest = state.skills
    .filter((skill) => skill.effect.damageMultiplier > 1 && (encounter.cooldowns[skill.id] ?? 0) === 0)
    .sort((a, b) => b.effect.damageMultiplier - a.effect.damageMultiplier)[0];
  return strongest ? { type: 'skill', id: strongest.id } : { type: 'attack' };
}

/** Chance qu'un coffre mixte (or et objet) contienne vraiment un objet. */
const CHEST_GEAR_CHANCE = 0.2;

export function towerStats(state: TowerState): TowerEffectiveStats {
  return towerEffectiveStats(state.base, state.gear, state.blessings);
}

/** Effet unique de la relique portée. */
export function hasPerk(state: TowerState, perk: TowerRelicPerk): boolean {
  return state.gear.relic?.perk === perk;
}

/** Salles explorées : la profondeur sur une carte, les portes franchies sinon. Départage le classement. */
export function towerRoomsExplored(state: TowerState): number {
  return state.map ? Math.max(0, (state.map.depth ?? 1) - 1) : state.floorsCleared;
}

function clone(state: TowerState): TowerState {
  return structuredClone(state);
}

/** Applique un changement de PV max en gardant les PV cohérents : un gain de PV max soigne d'autant. */
function withMaxHealthChange(state: TowerState, change: () => void): void {
  const before = towerStats(state).maxHealth;
  change();
  const after = towerStats(state).maxHealth;
  state.hp = Math.max(1, Math.min(after, state.hp + Math.max(0, after - before)));
}

/** Ambiance de l'étage en cours ; le mode aléatoire n'en a pas. */
export function floorModifier(state: TowerState) {
  return state.map?.layout.modifier ?? 'NONE';
}

/** Stats de combat : celles de l'équipement et des bénédictions, ralenties sur un étage inondé. */
export function combatStats(state: TowerState): TowerEffectiveStats {
  const stats = towerStats(state);
  return floorModifier(state) === 'FLOODED' ? { ...stats, speed: Math.max(1, Math.round(stats.speed * FLOODED_SPEED)) } : stats;
}

export function hasHeat(state: TowerState, heat: TowerHeat): boolean {
  return state.heat?.includes(heat) === true;
}

/** Éclats en plus pour la chaleur choisie au départ. */
export function heatShardBonus(state: TowerState): number {
  return 1 + HEAT_SHARD_BONUS * (state.heat?.length ?? 0);
}

function heal(state: TowerState, share: number): number {
  const max = towerStats(state).maxHealth;
  const before = state.hp;
  // Sur un étage béni, chaque soin rend davantage ; la famine choisie au départ les réduit.
  const blessed = floorModifier(state) === 'BLESSED' ? share * BLESSED_HEAL : share;
  const boosted = hasHeat(state, 'FAMINE') ? blessed * HEAT_FAMINE_HEAL : blessed;
  state.hp = Math.min(max, state.hp + Math.floor(max * boosted));
  return state.hp - before;
}

/**
 * Niveau de difficulté : l'étage en mode aléatoire, la profondeur en salles sur une carte.
 * Force des monstres, or, butin et prix du marchand le suivent.
 */
export function towerLevel(state: TowerState, floor: number): number {
  return state.map ? mapLevel(state.map, floor) : floor;
}

/**
 * Salles résolues sur un même étage au-delà desquelles la difficulté cesse de monter. Les
 * étages générés en comptent vingt au plus : seules les grandes cartes dessinées sont bornées.
 */
export const TOWER_FLOOR_DEPTH_MAX = 20;

function mapLevel(map: TowerMapState, fallback: number): number {
  const depth = map.depth ?? fallback;
  if (map.floorBase === undefined || map.floorStart === undefined) return depth;
  return map.floorBase + Math.min(Math.max(0, depth - map.floorStart), TOWER_FLOOR_DEPTH_MAX);
}

// ─────────────────────────────────────────────────────────────
// Ce que cachent portes et salles
// ─────────────────────────────────────────────────────────────

function rollTraits(kind: TowerEncounterKind, level: number, rng: TowerRng): TowerTrait[] {
  if (kind === 'COMBAT') return level >= TRAIT_MONSTER_LEVEL && rng.next() < TRAIT_MONSTER_CHANCE ? [rng.pick(TOWER_TRAITS)] : [];
  return [rng.pick(TOWER_TRAITS)];
}

function rollMechanic(choice: TowerMechanicChoice, rng: TowerRng): TowerBossMechanic | null {
  if (choice === 'NONE') return null;
  if (choice === 'RANDOM') return rng.pick(TOWER_BOSS_MECHANICS);
  return choice;
}

const ROOM_KIND: Partial<Record<TowerRoomType, TowerEncounterKind>> = {
  MONSTER: 'COMBAT', ELITE: 'ELITE', BOSS: 'BOSS', SEAL: 'ELITE', MIMIC: 'ELITE', AMBUSH: 'COMBAT', COLLAPSE: 'BOSS', WANDERER: 'ELITE', PRISONER: 'ELITE',
};
/** Vagues d'une épreuve : deux combats ordinaires puis une élite. */
export const TRIAL_WAVES = TOWER_TRIAL_WAVES.default;
const DOOR_KIND: Partial<Record<TowerDoor, TowerEncounterKind>> = { COMBAT: 'COMBAT', ELITE: 'ELITE', BOSS: 'BOSS' };

/**
 * Tire ce que cache chaque salle de l'étage : traits des monstres, mécanique du gardien,
 * événement. Fait en arrivant sur l'étage, pour que le joueur le voie avant d'y entrer.
 */
function prepareFloor(map: TowerMapState, rng: TowerRng): void {
  const level = mapLevel(map, 1);
  const rooms: Record<string, TowerRoomInfo> = {};
  for (const room of map.layout.rooms) {
    const kind = ROOM_KIND[room.type];
    if (kind) {
      rooms[room.id] = {
        traits: room.traits?.length ? [...room.traits] : rollTraits(kind, level, rng),
        mechanic: kind === 'BOSS' ? rollMechanic(room.mechanic ?? 'RANDOM', rng) : null,
        event: null,
      };
    } else if (room.type === 'EVENT') {
      const choice = room.event ?? 'RANDOM';
      rooms[room.id] = { traits: [], mechanic: null, event: choice === 'RANDOM' ? rng.pick(TOWER_EVENTS) : choice };
    }
  }
  map.rooms = rooms;
  map.wanderers = map.layout.rooms
    .filter((room) => room.type === 'WANDERER')
    .map((room) => ({ spawn: room.id, pos: room.id, radius: room.wanderRadius ?? TOWER_WANDER_RADIUS.default }));
  map.revealed = false;
  map.oraclePath = undefined;
  map.mistLifted = undefined;
  // Étage en feu : le feu prend dans une salle assez loin de l'entrée pour laisser partir.
  map.fire = undefined;
  if (map.layout.modifier === 'BURNING') {
    const distances = distancesFromStart(map.layout);
    const far = map.layout.rooms.filter((room) => (distances.get(room.id) ?? 0) >= FIRE_START_DISTANCE && !isEntryRoom(room.type));
    const pool = far.length > 0 ? far : map.layout.rooms.filter((room) => !isEntryRoom(room.type));
    map.fire = pool.length > 0 ? [rng.pick(pool).id] : [];
  }
}

/**
 * Le temps de l'étage change à chaque pas du joueur : le feu gagne une salle voisine, la brume
 * se lève au premier pas après la dernière salle explorée qu'il lui fallait. Ni la salle du
 * joueur ni celle où il va ne s'embrasent sous ses pieds, ni une entrée : il reste toujours un
 * endroit sûr.
 */
function weatherStep(state: TowerState, target: string, rng: TowerRng): void {
  const map = state.map;
  if (!map) return;
  const explored = map.cleared.filter((id) => {
    const room = map.layout.rooms.find((candidate) => candidate.id === id);
    return room !== undefined && !isEntryRoom(room.type);
  }).length;
  if (map.layout.modifier === 'MIST' && explored >= MIST_LIFT_ROOMS) {
    map.layout.modifier = 'NONE';
    map.mistLifted = true;
    state.weather = 'mist_lifted';
  }
  if (map.layout.modifier === 'BURNING' && map.fire && map.fire.length > 0) {
    const burning = new Set(map.fire);
    const cells = occupancy(map.layout);
    const frontier = new Set<string>();
    for (const id of map.fire) {
      for (const { room, direction } of roomNeighbors(map.layout, id, cells)) {
        if (direction === 'WARP' || burning.has(room.id) || isEntryRoom(room.type)) continue;
        if (room.id === map.pos || room.id === target) continue;
        frontier.add(room.id);
      }
    }
    if (frontier.size > 0) map.fire.push(rng.pick([...frontier].sort()));
  }
}

/**
 * Un pas des monstres errants, après celui du joueur : chacun reste ou passe dans une salle
 * voisine de sa zone où il peut aller. S'il entre dans la salle du joueur, il l'attaque.
 */
function moveWanderers(state: TowerState, rng: TowerRng): TowerWanderer | null {
  const map = state.map;
  if (!map?.wanderers?.length) return null;
  let caught: TowerWanderer | null = null;
  // Nuit sans lune : chaque errant fait deux pas, et tout s'arrête dès que l'un tombe sur le joueur.
  const steps = floorModifier(state) === 'MOONLESS' ? MOONLESS_WANDERER_STEPS : 1;
  for (let step = 0; step < steps && !caught; step++) {
    for (const wanderer of map.wanderers) {
      const zone = wanderZone(map.layout, wanderer.spawn, wanderer.radius);
      const options = roomNeighbors(map.layout, wanderer.pos)
        .filter(({ room, direction }) => direction !== 'WARP' && zone.has(room.id)
          && (room.id === map.pos || canWanderInto(room, map.cleared))
          && !map.wanderers!.some((other) => other !== wanderer && other.pos === room.id))
        .map(({ room }) => room.id);
      // Rester sur place est un choix comme un autre : il rôde, il ne fonce pas.
      const next = rng.pick([wanderer.pos, ...options]);
      wanderer.pos = next;
      if (next === map.pos && !caught) caught = wanderer;
    }
  }
  return caught;
}

function startWandererFight(state: TowerState, level: number, rules: TowerRules, foes: TowerFoePool, rng: TowerRng, wanderer: TowerWanderer): void {
  const map = state.map!;
  const spawn = map.layout.rooms.find((room) => room.id === wanderer.spawn);
  startEncounter(state, level, 'ELITE', rules, foes, rng, spawn?.foe ?? null, map.rooms?.[wanderer.spawn] ?? null, spawn ? roomPower(spawn) : undefined);
  state.encounter!.wanderer = wanderer.spawn;
  state.notice = { k: 'wanderer', before: state.notice };
}

/** Le captif libéré rend ce qu'on attend de lui, ou de l'or quand ce n'est plus possible. */
function freeCaptive(state: TowerState, kind: TowerCaptiveKind, level: number, rng: TowerRng): TowerCaptiveGift {
  const wanted = kind === 'RANDOM' ? rng.pick(['GOLD', 'POTION', 'ALLY'] as const) : kind;
  if (wanted === 'ALLY' && !state.ally) {
    state.ally = true;
    return { kind: 'ALLY', amount: 0 };
  }
  if (wanted === 'POTION' && state.potions < MAX_POTIONS) {
    state.potions += 1;
    return { kind: 'POTION', amount: 1 };
  }
  const gold = treasureGold(level, rng) * CAPTIVE_GOLD;
  state.gold += gold;
  return { kind: 'GOLD', amount: gold };
}

function rollDoorInfo(doors: TowerDoor[], level: number, rng: TowerRng): TowerRoomInfo[] {
  return doors.map((door) => {
    const kind = DOOR_KIND[door];
    if (kind) return { traits: rollTraits(kind, level, rng), mechanic: kind === 'BOSS' ? rng.pick(TOWER_BOSS_MECHANICS) : null, event: null };
    if (door === 'EVENT') return { traits: [], mechanic: null, event: rng.pick(TOWER_EVENTS) };
    return { traits: [], mechanic: null, event: null };
  });
}

function setDoors(state: TowerState, floor: number, rules: TowerRules, rng: TowerRng): void {
  state.doors = rollDoors(floor, rules.bossEvery, rng);
  state.doorInfo = rollDoorInfo(state.doors, floor, rng);
}

export function createTowerState(input: {
  base: TowerCoreStats;
  skills: TowerSkill[];
  /** Compétences laissées au départ, qu'un mentor peut enseigner en cours de route. */
  skillPool?: TowerSkill[];
  heat?: TowerHeat[];
  potions: number;
  /** Or de départ, offert par les améliorations. */
  gold?: number;
  /** Porte-bonheur des améliorations, voir `TowerState.fortune`. */
  fortune?: number;
  seed: number;
  /**
   * Graine du hasard de la partie (combats, butin, traits), quand elle doit différer de celle
   * des étages. Par défaut, la même.
   */
  rngSeed?: number;
  rules: TowerRules;
  layout?: TowerLayout | null;
}): TowerState {
  const rng = new TowerRng(input.rngSeed ?? input.seed);
  const start = input.layout ? startRoom(input.layout) : null;
  const map: TowerMapState | null = input.layout && start
    ? { layout: structuredClone(input.layout), depth: 1, floorBase: 1, floorStart: 1, pos: start.id, cleared: [start.id] }
    : null;
  if (map) arrive(map, rng);
  const state: TowerState = {
    v: 1,
    rng: rng.state,
    base: input.base,
    hp: input.base.maxHealth,
    gold: Math.max(0, Math.trunc(input.gold ?? 0)),
    potions: input.heat?.includes('DRY') ? 0 : Math.min(MAX_POTIONS, input.potions),
    gear: { ...EMPTY_GEAR },
    blessings: {},
    skills: input.skills,
    skillPool: input.skillPool ?? [],
    heat: input.heat ?? [],
    phase: 'DOORS',
    doors: [],
    encounter: null,
    pendingLoot: null,
    blessingDue: false,
    blessingChoices: [],
    merchant: [],
    shards: 0,
    floorsCleared: 0,
    kills: 0,
    bossKills: 0,
    ...(input.fortune && input.fortune > 0 ? { fortune: Math.min(TOWER_FORTUNE_MAX, input.fortune) } : {}),
    floorKeys: map ? [towerLayoutKey(map.layout)] : [],
    notice: null,
    map,
    moves: [],
    rules: structuredClone(input.rules),
    seed: input.seed,
  };
  if (map) {
    prepareFloor(map, rng);
    if (map.entryChoices?.length) state.phase = 'ENTRY';
    else state.moves = computeMoves(state);
  } else {
    setDoors(state, 1, input.rules, rng);
  }
  state.rng = rng.state;
  return state;
}

/**
 * Arrivée sur un étage : au départ s'il y en a un, dans un puits tiré au hasard, ou devant
 * les entrées au choix, sans encore y être entré.
 */
function arrive(map: TowerMapState, rng: TowerRng): void {
  const entries = entryRooms(map.layout);
  const choices = entries.filter((room) => room.type === 'ENTRANCE');
  map.steps = 0;
  if (choices.length > 0) {
    map.pos = choices[0].id;
    map.cleared = [];
    map.entryChoices = choices.map((room) => room.id);
    return;
  }
  const wells = entries.filter((room) => room.type === 'WELL');
  const room = entries.find((candidate) => candidate.type === 'START') ?? (wells.length > 0 ? rng.pick(wells) : entries[0]);
  if (!room) return;
  map.pos = room.id;
  map.cleared = [room.id];
  map.entryChoices = undefined;
}

function computeMoves(state: TowerState): TowerMove[] {
  const map = state.map;
  if (!map) return [];
  return roomNeighbors(map.layout, map.pos).map(({ room, direction }) => ({
    roomId: room.id,
    type: room.type,
    direction,
    cleared: map.cleared.includes(room.id),
  }));
}

/**
 * Salles conquises par le clan sur l'étage où arrive le joueur : les salles d'adversaire se
 * traversent comme déjà faites (une clé ou un sceau y compte déjà), la sortie reste à franchir
 * mais s'ouvre sans combat ni condition.
 */
export function applyClanConquests(state: TowerState, roomIds: readonly string[]): void {
  const map = state.map;
  if (!map) return;
  const ids = new Set(map.layout.rooms.map((room) => room.id));
  map.conquered = roomIds.filter((id) => ids.has(id));
  for (const id of map.conquered) {
    const room = map.layout.rooms.find((candidate) => candidate.id === id)!;
    if (!isExitRoom(room.type) && !map.cleared.includes(id)) map.cleared.push(id);
  }
  // Les portes proposées disent maintenant ce qui est déjà vaincu.
  if (!map.entryChoices?.length) state.moves = computeMoves(state);
}

/** Salles que le clan conquiert en les résolvant : celles qui opposent un adversaire. */
export function isConquerableRoom(type: TowerRoomType): boolean {
  return type === 'ELITE' || type === 'TRIAL' || type === 'SEAL' || type === 'PRISONER' || isExitRoom(type);
}

function markRoomCleared(state: TowerState): void {
  const map = state.map;
  if (map && !map.cleared.includes(map.pos)) map.cleared.push(map.pos);
}

/**
 * Gardien abattu : on monte à l'étage `floor`. Sa carte suit l'ordre de la tour, puis selon
 * les réglages reprend au premier étage dessiné ou est générée ; à défaut, la carte en cours
 * recommence.
 */
function climb(state: TowerState, floor: number, rules: TowerRules, floors: readonly TowerLayout[], rng: TowerRng): TowerClimb | null {
  const map = state.map;
  if (!map) return null;
  const next = towerRunFloorLayout(floors, floor, rules, state.seed ?? 0);
  if (!startRoom(next)) return null;
  // Le nouvel étage part du niveau atteint, plafond compris : la difficulté ne saute pas.
  map.floorBase = mapLevel(map, floor);
  map.floorStart = map.depth ?? floor;
  map.layout = structuredClone(next);
  map.prev = undefined;
  state.floorKeys?.push(towerLayoutKey(next));
  arrive(map, rng);
  // Les fantômes appartiennent à une carte : ceux du nouvel étage sont chargés par le service.
  map.ghosts = [];
  // Le mercenaire ne suit pas l'escalier : il est engagé pour un étage.
  state.ally = false;
  prepareFloor(map, rng);
  return { floor, name: next.name };
}

/** Un étage de boss en mode aléatoire, une salle de boss sur une carte. */
function isBossStep(state: TowerState, floor: number, rules: TowerRules, kind?: TowerEncounterKind): boolean {
  return state.map ? kind === 'BOSS' : isBossFloor(floor, rules.bossEvery);
}

/** Écran suivant, par ordre de priorité : butin, marchand encore ouvert, bénédiction, portes. */
function advance(state: TowerState, floor: number, rules: TowerRules, rng: TowerRng): void {
  state.encounter = null;
  if (state.pendingLoot) {
    state.phase = 'LOOT';
    return;
  }
  if (state.merchant.length > 0) {
    state.phase = 'MERCHANT';
    return;
  }
  if (state.blessingDue) {
    const choices = rollBlessingChoices(state.blessings, rules.maxBlessings, rng);
    if (choices.length > 0) {
      state.phase = 'BLESSING';
      state.blessingChoices = choices;
      return;
    }
    state.blessingDue = false;
  }
  if (state.map?.entryChoices?.length) {
    state.phase = 'ENTRY';
    state.moves = [];
    return;
  }
  state.phase = 'DOORS';
  if (state.map) {
    state.doors = [];
    state.moves = computeMoves(state);
  } else {
    setDoors(state, floor, rules, rng);
    state.moves = [];
  }
}

/**
 * Étape franchie, renvoie l'étage où se trouve désormais le joueur.
 *
 * En mode aléatoire, chaque porte est un étage : éclats, compteur, et une bénédiction sur
 * les étages ronds. Sur une carte, chaque salle rapporte ses éclats et approfondit la
 * difficulté, mais seul le gardien fait monter d'un étage ; une bénédiction tombe tous les
 * `blessingEvery` étages gravis, en plus de celles des autels.
 */
function progress(state: TowerState, floor: number, rules: TowerRules, boss: boolean, guardian = false): number {
  const bonus = (hasPerk(state, 'SHARD_SEEKER') ? 1 + SHARD_SEEKER_BONUS : 1) * heatShardBonus(state);
  const map = state.map;
  if (!map) {
    state.shards += Math.round(floorShards(floor, rules.shardsPerFloor, boss) * bonus);
    state.floorsCleared += 1;
    if (rules.blessingEvery > 0 && floor % rules.blessingEvery === 0) state.blessingDue = true;
    return floor + 1;
  }
  // Chaque salle résolue approfondit la difficulté ; les éclats, eux, ne tombent qu'à l'étage
  // gravi, doublés quand un gardien le fermait.
  const depth = map.depth ?? floor;
  map.depth = depth + 1;
  if (!boss) {
    // L'exploration peut rapporter aussi, si le serveur le règle : chaque salle résolue.
    if ((rules.shardsPerRoom ?? 0) > 0) state.shards += Math.round(rules.shardsPerRoom! * bonus);
    return floor;
  }
  state.shards += Math.round(floorShards(floor, rules.shardsPerFloor, guardian) * bonus);
  state.floorsCleared += 1;
  if (rules.blessingEvery > 0 && state.floorsCleared % rules.blessingEvery === 0) state.blessingDue = true;
  return floor + 1;
}

// ─────────────────────────────────────────────────────────────
// Combat
// ─────────────────────────────────────────────────────────────

const NEUTRAL_SHAPE = { health: 1, attack: 1, defense: 1, speed: 1 };

type RoomPower = { factor: number; reward: boolean };
const NORMAL_POWER: RoomPower = { factor: 1, reward: false };

/** Les parties commencées avant ce réglage n'ont pas de puissance sur leurs salles. */
function roomPower(room: TowerRoom): RoomPower {
  return { factor: (room.powerPercent ?? 100) / 100, reward: room.powerReward === true };
}

function startEncounter(
  state: TowerState,
  level: number,
  kind: TowerEncounterKind,
  rules: TowerRules,
  foes: TowerFoePool,
  rng: TowerRng,
  imposed: string | null = null,
  info: TowerRoomInfo | null = null,
  /** Puissance réglée sur la salle : la force suit toujours la profondeur, puis ce facteur. */
  power: RoomPower = NORMAL_POWER,
): void {
  const pool = kind === 'BOSS'
    ? (foes.bosses.length > 0 ? foes.bosses : FALLBACK_BOSSES)
    : (foes.monsters.length > 0 ? foes.monsters : FALLBACK_MONSTERS);
  // Une créature imposée retirée du bestiaire depuis retombe sur le tirage habituel.
  const foe = (imposed ? foes.byName?.[imposed] : undefined) ?? rng.pick(pool);
  const traits = info?.traits ?? rollTraits(kind, level, rng);
  const mechanic = kind === 'BOSS' ? (info ? info.mechanic : rng.pick(TOWER_BOSS_MECHANICS)) : null;

  const base = towerMonsterStats(level, rules.floorGrowthPercent, kind);
  const shape = foe.shape ?? NEUTRAL_SHAPE;
  const ferocity = hasHeat(state, 'FEROCIOUS') ? HEAT_FOE_BOOST : 1;
  const mult = {
    health: shape.health * power.factor * ferocity,
    attack: shape.attack * power.factor * ferocity * (1 + CURSE_ATTACK * (state.curse ?? 0)),
    defense: shape.defense * power.factor,
    speed: shape.speed,
  };
  for (const trait of traits) {
    const effect = TRAIT_STATS[trait];
    mult.health *= effect.health ?? 1;
    mult.attack *= effect.attack ?? 1;
    mult.defense *= effect.defense ?? 1;
    mult.speed *= effect.speed ?? 1;
  }
  const health = Math.max(1, Math.round(base.health * mult.health));
  const shield = mechanic === 'SHIELD' ? Math.round(health * SHIELD_SHARE) : 0;

  state.encounter = {
    kind,
    name: foe.name,
    emoji: foe.emoji,
    health,
    maxHealth: health,
    attack: Math.max(1, Math.round(base.attack * mult.attack)),
    defense: Math.max(0, Math.round(base.defense * mult.defense)),
    speed: Math.max(1, Math.round(base.speed * mult.speed)),
    cooldowns: Object.fromEntries(state.skills.map((skill) => [skill.id, 0])),
    defenseMultiplier: 1,
    evade: false,
    log: [],
    traits,
    mechanic,
    shield,
    minions: 0,
    ...(power.factor !== 1 ? { power: power.factor, bounty: power.reward ? power.factor : 1 } : {}),
  };
  state.phase = 'COMBAT';
}

/** Dégâts au joueur, avec le sursis de la relique LAST_STAND une fois par combat. */
function hurtPlayer(state: TowerState, encounter: TowerEncounter, amount: number, log: TowerLogEntry[]): void {
  if (state.hp - amount <= 0 && hasPerk(state, 'LAST_STAND') && !encounter.lastStandUsed) {
    encounter.lastStandUsed = true;
    state.hp = 1;
    log.push({ k: 'lastStand' });
    return;
  }
  state.hp = Math.max(0, state.hp - amount);
}

/** Dégâts au monstre : son bouclier encaisse d'abord. */
function hurtFoe(encounter: TowerEncounter, amount: number, log: TowerLogEntry[]): void {
  let rest = amount;
  const shield = encounter.shield ?? 0;
  if (shield > 0 && rest > 0) {
    const absorbed = Math.min(shield, rest);
    encounter.shield = shield - absorbed;
    rest -= absorbed;
    log.push({ k: 'shield', dmg: absorbed });
    if (encounter.shield === 0) log.push({ k: 'shieldBroken' });
  }
  encounter.health = Math.max(0, encounter.health - rest);
}

/**
 * Coup du monstre. Une élite ou un boss annonce un coup puissant un tour à l'avance : se
 * mettre en garde à ce moment-là le pare. La vitesse du joueur lui donne une chance d'esquive.
 */
function monsterStrike(state: TowerState, encounter: TowerEncounter, stats: TowerEffectiveStats, rng: TowerRng, log: TowerLogEntry[]): void {
  const heavy = encounter.charging === true;
  encounter.charging = false;

  if (encounter.evade) {
    encounter.evade = false;
    log.push({ k: 'evaded' });
  } else if (rng.next() < towerDodgeChance(stats.speed, encounter.speed)) {
    log.push({ k: 'dodged' });
  } else {
    const guarded = encounter.defenseMultiplier > 1;
    const power = heavy ? (guarded ? TOWER_PARRIED_MULTIPLIER : TOWER_HEAVY_MULTIPLIER) : 1;
    const hit = computeAttack({
      attack: encounter.attack,
      targetDefense: stats.defense,
      speed: encounter.speed,
      critChance: TOWER_MONSTER_CRIT,
      skillMultiplier: power
        * (encounter.enraged ? TOWER_ENRAGE_MULTIPLIER : 1)
        * (1 + SUMMON_POWER * (encounter.minions ?? 0))
        // Étage gelé : le premier coup du monstre est amorti.
        * (floorModifier(state) === 'FROST' && (encounter.turn ?? 0) === 0 ? FROST_FIRST_HIT : 1),
      targetDefenseMultiplier: encounter.defenseMultiplier,
      targetDamageReduction: stats.damageReduction,
      targetThorns: stats.thorns,
      random: () => rng.next(),
    });
    log.push({ k: 'monster', dmg: hit.damage, crit: hit.critical, heavy, parried: heavy && guarded });
    hurtPlayer(state, encounter, hit.damage, log);
    if (encounter.traits?.includes('VAMPIRIC')) {
      const drained = Math.min(encounter.maxHealth - encounter.health, Math.floor(hit.damage * VAMPIRIC_DRAIN));
      if (drained > 0) {
        encounter.health += drained;
        log.push({ k: 'drain', hp: drained });
      }
    }
    if (hit.reflected > 0) {
      log.push({ k: 'thorns', dmg: hit.reflected });
      hurtFoe(encounter, hit.reflected, log);
    }
  }

  encounter.turn = (encounter.turn ?? 0) + 1;
  if (encounter.health <= 0) return;

  const every = TOWER_CHARGE_EVERY[encounter.kind];
  if (every > 0 && encounter.turn % every === 0) {
    encounter.charging = true;
    log.push({ k: 'charge' });
  }
  if (encounter.mechanic === 'SUMMONER' && encounter.turn % SUMMON_EVERY === 0 && (encounter.minions ?? 0) < SUMMON_MAX) {
    encounter.minions = (encounter.minions ?? 0) + 1;
    log.push({ k: 'summon', count: encounter.minions });
  }
  if (encounter.traits?.includes('REGENERATING') && encounter.health < encounter.maxHealth) {
    const regen = Math.min(encounter.maxHealth - encounter.health, Math.max(1, Math.round(encounter.maxHealth * REGENERATION)));
    encounter.health += regen;
    log.push({ k: 'regen', hp: regen });
  }
}

/** Coup du joueur, attaque ou compétence : il écrit lui-même ses lignes dans le journal. */
function playerStrike(
  state: TowerState,
  encounter: TowerEncounter,
  stats: TowerEffectiveStats,
  skill: TowerSkill | null,
  rng: TowerRng,
  log: TowerLogEntry[],
): void {
  // Un monstre Rapide peut esquiver, comme le joueur : la riposte préparée est perdue.
  if (encounter.traits?.includes('SWIFT') && rng.next() < towerDodgeChance(encounter.speed, stats.speed)) {
    encounter.riposte = false;
    encounter.opened = true;
    log.push({ k: 'foeDodged' });
    return;
  }

  const firstStrike = hasPerk(state, 'FIRST_STRIKE') && !encounter.opened;
  const execute = hasPerk(state, 'EXECUTE') && encounter.health <= encounter.maxHealth * EXECUTE_THRESHOLD;
  const hit = computeAttack({
    attack: stats.attack,
    targetDefense: encounter.defense,
    speed: stats.speed,
    critChance: firstStrike ? 1 : stats.critChance,
    armorPiercing: Math.max(stats.armorPiercing, skill?.effect.armorPiercing ?? 0),
    skillMultiplier: (skill?.effect.damageMultiplier ?? 1)
      * (encounter.riposte ? TOWER_RIPOSTE_MULTIPLIER : 1)
      * (execute ? EXECUTE_BONUS : 1)
      // Étage gelé : le premier coup du joueur aussi.
      * (floorModifier(state) === 'FROST' && !encounter.opened ? FROST_FIRST_HIT : 1),
    lifesteal: stats.lifesteal + (skill?.effect.lifesteal ?? 0),
    random: () => rng.next(),
  });
  encounter.riposte = false;
  encounter.opened = true;
  log.push(skill
    ? { k: 'skill', name: skill.name, emoji: skill.emoji, dmg: hit.damage, crit: hit.critical }
    : { k: 'attack', dmg: hit.damage, crit: hit.critical });
  hurtFoe(encounter, hit.damage, log);
  if (hit.healed > 0) state.hp = Math.min(stats.maxHealth, state.hp + hit.healed);

  if (encounter.traits?.includes('THORNY')) {
    const spikes = Math.floor(hit.damage * THORNY_REFLECT);
    if (spikes > 0) {
      log.push({ k: 'spikes', dmg: spikes });
      hurtPlayer(state, encounter, spikes, log);
    }
  }
  if (skill && skill.effect.damageMultiplier >= DISPEL_SKILL_MULTIPLIER && (encounter.minions ?? 0) > 0) {
    encounter.minions = 0;
    log.push({ k: 'dispel' });
  }
}

/**
 * Salle du joueur qui vient d'être résolue : si elle gardait une clé de l'escalier ou un
 * sceau du portail, où en est l'ouverture de la sortie.
 */
function lockProgress(state: TowerState): TowerLockProgress | null {
  const map = state.map;
  const room = map?.layout.rooms.find((candidate) => candidate.id === map.pos);
  if (!map || !room) return null;
  const locks = exitLocks(map.layout, map.cleared);
  if (room.key) return { kind: 'key', done: locks.keysFound, needed: locks.keysNeeded };
  if (room.type === 'SEAL') return { kind: 'seal', done: locks.sealsLit, needed: locks.sealsNeeded };
  return null;
}

/**
 * Sortie franchie : l'étage est gravi, la carte suivante chargée et le palier est sûr.
 * Sert au gardien, à l'escalier et au portail (et à l'épreuve des étages d'avant).
 */
function exitFloor(
  state: TowerState,
  floor: number,
  rules: TowerRules,
  floors: readonly TowerLayout[],
  rng: TowerRng,
  /** L'étage se ferme sur un gardien vaincu : ses éclats sont doublés. */
  guardian = false,
): { next: number; climbed: TowerClimb | null } {
  const next = progress(state, floor, rules, true, guardian);
  markRoomCleared(state);
  const climbed = state.map ? climb(state, next, rules, floors, rng) : null;
  state.safeLeave = true;
  return { next, climbed };
}

/** Retire le fantôme de la salle en cours, et note l'ascension d'où il vient pour le service. */
function takeGhost(state: TowerState): TowerGhost | null {
  const map = state.map;
  const ghost = map?.ghosts?.find((candidate) => candidate.roomId === map.pos) ?? null;
  if (!map || !ghost) return null;
  map.ghosts = map.ghosts!.filter((candidate) => candidate !== ghost);
  state.ghostTaken = ghost.runId;
  return ghost;
}

/** Porte-bonheur de la partie, borné : un état modifié à la main ne débride rien. */
function fortuneOf(state: TowerState): number {
  const fortune = Number(state.fortune ?? 0);
  return Number.isFinite(fortune) ? Math.min(TOWER_FORTUNE_MAX, Math.max(0, fortune)) : 0;
}

function winEncounter(
  state: TowerState,
  floor: number,
  rules: TowerRules,
  rng: TowerRng,
  floors: readonly TowerLayout[],
  foes: TowerFoePool,
): number {
  const encounter = state.encounter!;
  const stats = towerStats(state);
  const level = towerLevel(state, floor);
  const bounty = encounter.bounty ?? 1;
  const luck = 1 + fortuneOf(state);
  const gold = Math.round(encounterGold(level, encounter.kind, stats.goldPercent, rng) * bounty * luck);
  state.gold += gold;
  state.kills += 1;
  if (encounter.kind === 'BOSS') state.bossKills = (state.bossKills ?? 0) + 1;

  // Épreuve : tant qu'il reste des vagues, la suivante arrive aussitôt, sans butin ni répit.
  const trial = state.trial;
  if (trial && trial.wave < trial.waves) {
    trial.wave += 1;
    state.notice = { k: 'wave', wave: trial.wave, waves: trial.waves, gold };
    const power = { factor: trial.power ?? 1, reward: trial.powerReward === true };
    startEncounter(state, level, trial.wave === trial.waves ? 'ELITE' : 'COMBAT', rules, foes, rng, null, null, power);
    return floor;
  }

  // Une mimique paie le risque : son butin est garanti. Une épreuve réglée pour payer comme un
  // gardien en reprend la chance d'objet.
  const trialPaid = trial?.reward === true;
  const lootChance = trialPaid ? LOOT_CHANCE.BOSS : LOOT_CHANCE[encounter.kind];
  if (encounter.mimic || rng.next() < Math.min(1, lootChance * bounty * luck)) state.pendingLoot = rollTowerGear(level, encounter.kind, rng);
  // Un monstre errant vaincu quitte l'étage ; un geôlier vaincu libère son captif.
  if (encounter.wanderer && state.map?.wanderers) {
    state.map.wanderers = state.map.wanderers.filter((wanderer) => wanderer.spawn !== encounter.wanderer);
  }
  const captive = encounter.captive ? freeCaptive(state, encounter.captive, level, rng) : null;
  // Un joueur est tombé ici : son équipement l'emporte sur le butin du monstre.
  const ghost = takeGhost(state);
  if (ghost) state.pendingLoot = rescaleTowerGear(ghost.gear, level);

  let healed = heal(state, stats.healAfterCombat);
  if (trialPaid) healed += heal(state, BOSS_VICTORY_HEAL);
  if (encounter.kind === 'BOSS') {
    healed += heal(state, BOSS_VICTORY_HEAL);
    if (hasPerk(state, 'GUARDIAN_POTION')) state.potions = Math.min(MAX_POTIONS, state.potions + 1);
  }

  // Le gardien ferme l'étage. Une épreuve ne le ferme que sur les étages d'avant, où elle était
  // encore une sortie : leur carte, copiée dans la partie, n'a pas d'autre sortie.
  const legacyTrialExit = Boolean(trial && state.map && !exitRoom(state.map.layout));
  const closesFloor = state.map
    ? (encounter.kind === 'BOSS' || legacyTrialExit || encounter.opensExit === true)
    : isBossStep(state, floor, rules, encounter.kind);
  state.trial = null;
  if (closesFloor && state.map) {
    const { next, climbed } = exitFloor(state, floor, rules, floors, rng, encounter.kind === 'BOSS');
    state.notice = { k: 'victory', name: encounter.name, emoji: encounter.emoji, gold, healed, climbed, ghost: ghost?.userId ?? null, captive };
    advance(state, next, rules, rng);
    return next;
  }

  const next = progress(state, floor, rules, closesFloor);
  markRoomCleared(state);
  if (closesFloor) state.safeLeave = true;
  state.notice = { k: 'victory', name: encounter.name, emoji: encounter.emoji, gold, healed, climbed: null, lock: lockProgress(state), ghost: ghost?.userId ?? null, captive };
  advance(state, next, rules, rng);
  return next;
}

/** Un combat se fuit, sauf un gardien, une épreuve ou une embuscade. */
export function canFlee(state: TowerState, encounter: TowerEncounter): boolean {
  return encounter.kind !== 'BOSS' && !state.trial && encounter.ambush !== true;
}

/** Fuite : retour à la salle d'où l'on vient sur une carte, de nouvelles portes au même étage sinon. */
function retreat(state: TowerState): void {
  const map = state.map;
  if (!map) return;
  const back = map.prev && map.layout.rooms.some((room) => room.id === map.prev) ? map.prev : startRoom(map.layout)?.id;
  if (back) map.pos = back;
}

function combatTurn(
  state: TowerState,
  floor: number,
  action: TowerAction,
  rules: TowerRules,
  rng: TowerRng,
  floors: readonly TowerLayout[],
  foes: TowerFoePool,
): TowerStepResult {
  const encounter = state.encounter;
  if (!encounter) throw new TowerActionRefused('wrong_phase');
  const stats = combatStats(state);
  const log: TowerLogEntry[] = [];

  // Les postures ne durent qu'un tour ennemi.
  encounter.defenseMultiplier = 1;

  // On ne fuit ni un boss, ni une épreuve, ni une embuscade. Fuir laisse au monstre un dernier
  // coup et coûte une part de l'or.
  if (action.type === 'flee') {
    if (!canFlee(state, encounter)) throw new TowerActionRefused('no_flee');
    monsterStrike(state, encounter, stats, rng, log);
    encounter.log = [...encounter.log, ...log].slice(-LOG_KEPT);
    if (state.hp <= 0) return { state, floor, dead: true };
    if (encounter.health <= 0) return { state, floor: winEncounter(state, floor, rules, rng, floors, foes), dead: false };
    const lost = Math.floor(state.gold * TOWER_FLEE_GOLD_LOSS);
    state.gold -= lost;
    retreat(state);
    state.notice = { k: 'fled', gold: lost };
    advance(state, floor, rules, rng);
    return { state, floor, dead: false };
  }

  switch (action.type) {
    case 'attack': {
      playerStrike(state, encounter, stats, null, rng, log);
      break;
    }
    case 'defend': {
      encounter.defenseMultiplier = 2;
      encounter.riposte = true;
      log.push({ k: 'defend', hp: heal(state, TOWER_DEFEND_HEAL) });
      break;
    }
    case 'potion': {
      if (state.potions <= 0) throw new TowerActionRefused('no_potion');
      if (state.hp >= stats.maxHealth) throw new TowerActionRefused('hp_full');
      state.potions -= 1;
      log.push({ k: 'potion', hp: heal(state, merchantOf(rules).potionHealPercent / 100) });
      break;
    }
    case 'skill': {
      const skill = state.skills.find((candidate) => candidate.id === action.id);
      if (!skill) throw new TowerActionRefused('bad_choice');
      if ((encounter.cooldowns[skill.id] ?? 0) > 0) throw new TowerActionRefused('skill_cooldown');
      encounter.cooldowns[skill.id] = effectiveCooldown(skill.cooldownTurns, stats.cooldownReduction);
      if (skill.effect.defenseMultiplier) encounter.defenseMultiplier = skill.effect.defenseMultiplier;
      if (skill.effect.evadeNextAttack) encounter.evade = true;
      if (skill.effect.healPercent) {
        const healed = heal(state, skill.effect.healPercent);
        if (healed > 0) log.push({ k: 'heal', hp: healed });
      }
      if (skill.effect.damageMultiplier > 0) {
        playerStrike(state, encounter, stats, skill, rng, log);
      } else {
        log.push({ k: 'support', name: skill.name, emoji: skill.emoji });
      }
      break;
    }
    default:
      throw new TowerActionRefused('wrong_phase');
  }

  // Comme en combat classique : chaque action du joueur fait avancer toutes les recharges.
  for (const id of Object.keys(encounter.cooldowns)) {
    if (encounter.cooldowns[id] > 0) encounter.cooldowns[id] -= 1;
  }

  if (encounter.mechanic === 'PHASES' && !encounter.phased && encounter.health > 0
    && encounter.health <= encounter.maxHealth * PHASE_THRESHOLD) {
    encounter.phased = true;
    encounter.health = Math.min(encounter.maxHealth, encounter.health + Math.round(encounter.maxHealth * PHASE_HEAL));
    encounter.attack = Math.round(encounter.attack * PHASE_BOOST);
    encounter.defense = Math.round(encounter.defense * PHASE_BOOST);
    log.push({ k: 'phase' });
  }
  if (encounter.kind === 'BOSS' && !encounter.enraged && encounter.health > 0
    && encounter.health <= encounter.maxHealth * TOWER_ENRAGE_THRESHOLD) {
    encounter.enraged = true;
    log.push({ k: 'enrage' });
  }

  // Le mercenaire frappe après le joueur, avant la riposte du monstre.
  if (state.ally && encounter.health > 0) {
    const dmg = Math.max(1, Math.round(stats.attack * ALLY_POWER * damageThrough(encounter.defense)));
    log.push({ k: 'ally', dmg });
    hurtFoe(encounter, dmg, log);
  }

  if (encounter.health > 0 && state.hp > 0) monsterStrike(state, encounter, stats, rng, log);
  encounter.log = [...encounter.log, ...log].slice(-LOG_KEPT);

  // La mort passe avant la victoire : un monstre tué par les épines de son dernier coup
  // n'empêche pas le joueur de tomber, sans quoi il repartait à 0 PV.
  if (state.hp <= 0) {
    return { state, floor, dead: true };
  }
  if (encounter.health <= 0) {
    return { state, floor: winEncounter(state, floor, rules, rng, floors, foes), dead: false };
  }
  return { state, floor, dead: false };
}

// ─────────────────────────────────────────────────────────────
// Événements
// ─────────────────────────────────────────────────────────────

/**
 * Résout le choix fait devant un événement. L'option 1 est toujours sans risque (partir, ou
 * pour la source remplir une fiole) ; l'option 0 est le pari de l'événement.
 */
function resolveEvent(state: TowerState, id: TowerEventId, option: number, level: number, rng: TowerRng): TowerNotice {
  const leave: TowerNotice = { k: 'event', id, option, amount: 0 };
  switch (id) {
    case 'BLOOD_ALTAR': {
      if (option !== 0) return leave;
      const cost = Math.floor(towerStats(state).maxHealth * ALTAR_COST);
      state.hp = Math.max(1, state.hp - cost);
      state.blessingDue = true;
      return { k: 'event', id, option, amount: cost };
    }
    case 'GAMBLER': {
      if (option !== 0) return leave;
      const stake = Math.floor(state.gold / 2);
      if (stake <= 0) throw new TowerActionRefused('no_gold');
      const won = rng.next() < 0.5;
      state.gold += won ? stake : -stake;
      return { k: 'event', id, option, amount: stake, won };
    }
    case 'SPRING': {
      if (option === 0) return { k: 'event', id, option, amount: heal(state, SPRING_HEAL) };
      if (state.potions >= MAX_POTIONS) throw new TowerActionRefused('potions_full');
      state.potions += 1;
      return { k: 'event', id, option, amount: 1 };
    }
    case 'BLACKSMITH': {
      if (option !== 0) return leave;
      const price = blacksmithPrice(level);
      if (state.gold < price) throw new TowerActionRefused('no_gold');
      const slots = (['weapon', 'armor'] as const).filter((slot) => state.gear[slot] !== null);
      if (slots.length === 0) throw new TowerActionRefused('no_gear');
      const slot = rng.pick(slots);
      const piece = state.gear[slot]!;
      const boost = (value: number) => (value > 0 ? Math.max(value + 1, Math.round(value * BLACKSMITH_BOOST)) : 0);
      withMaxHealthChange(state, () => {
        state.gear[slot] = {
          ...piece,
          attack: boost(piece.attack),
          defense: boost(piece.defense),
          speed: boost(piece.speed),
          maxHealth: boost(piece.maxHealth),
        };
      });
      state.gold -= price;
      return { k: 'event', id, option, amount: price, item: piece.name };
    }
    case 'CURSED_PACT': {
      if (option !== 0) return leave;
      const gold = treasureGold(level, rng) * PACT_TREASURES;
      state.gold += gold;
      state.curse = (state.curse ?? 0) + 1;
      return { k: 'event', id, option, amount: gold };
    }
  }
}

/**
 * Entre dans une salle voisine de la carte et la résout. Une salle déjà résolue se traverse
 * sans rien déclencher : c'est ainsi qu'on ressort d'un cul-de-sac.
 */
function enterRoom(
  state: TowerState,
  floor: number,
  move: TowerMove,
  rules: TowerRules,
  foes: TowerFoePool,
  rng: TowerRng,
  floors: readonly TowerLayout[],
): number {
  const level = towerLevel(state, floor);
  const map = state.map!;
  const room = map.layout.rooms.find((candidate) => candidate.id === move.roomId);
  if (!room) throw new TowerActionRefused('bad_choice');

  // Sortie conquise par le clan : ni verrou, ni gardien, ni péage, on monte.
  const conqueredExit = isExitRoom(room.type) && map.conquered?.includes(room.id) === true;
  // Une sortie scellée se refuse avant d'y mettre les pieds : le joueur reste où il est.
  const locks = exitLocks(map.layout, map.cleared);
  if (!conqueredExit && room.type === 'STAIRS' && locks.keysFound < locks.keysNeeded) throw new TowerActionRefused('stairs_locked');
  if (!conqueredExit && room.type === 'GATE' && locks.sealsLit < locks.sealsNeeded) throw new TowerActionRefused('gate_locked');

  map.prev = map.pos;
  map.pos = room.id;

  if (conqueredExit) {
    const { next, climbed } = exitFloor(state, floor, rules, floors, rng);
    state.notice = { k: 'exit', exit: room.type as TowerExitType, climbed, conquered: true };
    advance(state, next, rules, rng);
    return next;
  }

  // Étage en feu : entrer dans une salle qui brûle coûte un peu, sans jamais achever le joueur.
  // Sur un étage arrivé avant la propagation, c'est chaque nouvelle salle qui brûle.
  const burning = floorModifier(state) === 'BURNING'
    && (map.fire ? map.fire.includes(room.id) : !map.cleared.includes(room.id));
  if (burning) {
    const burn = Math.max(1, Math.floor(towerStats(state).maxHealth * BURN_DAMAGE));
    const before = state.hp;
    state.hp = Math.max(1, state.hp - burn);
    state.burned = before - state.hp;
  }

  if (map.cleared.includes(room.id)) {
    advance(state, floor, rules, rng);
    return floor;
  }

  const info = map.rooms?.[room.id] ?? null;
  switch (room.type) {
    case 'MONSTER':
      startEncounter(state, level, 'COMBAT', rules, foes, rng, room.foe, info, roomPower(room));
      return floor;
    case 'ELITE':
      startEncounter(state, level, 'ELITE', rules, foes, rng, room.foe, info, roomPower(room));
      return floor;
    case 'BOSS':
      startEncounter(state, level, 'BOSS', rules, foes, rng, room.foe, info, roomPower(room));
      return floor;
    case 'SEAL':
      // Chaque sceau est gardé par une élite : l'abattre l'allume.
      startEncounter(state, level, 'ELITE', rules, foes, rng, room.foe, info);
      return floor;
    case 'MIMIC':
      // Le coffre ouvert se révèle : une élite sous un autre nom, au butin garanti.
      startEncounter(state, level, 'ELITE', rules, foes, rng, null, info);
      state.encounter!.name = MIMIC_NAME;
      state.encounter!.emoji = '';
      state.encounter!.mimic = true;
      return floor;
    case 'MERCENARY':
      state.phase = 'MERCENARY';
      return floor;
    case 'MENTOR': {
      const pool = state.skillPool ?? [];
      if (pool.length === 0) {
        // Rien à apprendre : tout a été acheté au départ, ou déjà enseigné.
        state.notice = { k: 'mentor_empty' };
        markRoomCleared(state);
        const next = progress(state, floor, rules, false);
        advance(state, next, rules, rng);
        return next;
      }
      const offered = [...pool];
      state.mentor = [];
      while (state.mentor.length < MENTOR_OFFERS && offered.length > 0) {
        state.mentor.push(offered.splice(rng.int(offered.length), 1)[0].id);
      }
      state.phase = 'MENTOR';
      return floor;
    }
    case 'TRAP': {
      // La vitesse fait éviter le piège : une fois sur deux à vitesse égale au mécanisme, un peu
      // moins à vitesse égale aux monstres de l'étage (le mécanisme est 20 % plus vif).
      const trapSpeed = towerMonsterStats(level, rules.floorGrowthPercent, 'COMBAT').speed * 1.2;
      const dodge = Math.min(TRAP_DODGE.max, Math.max(TRAP_DODGE.min, combatStats(state).speed / (trapSpeed * 2)));
      if (rng.next() < dodge) {
        state.notice = { k: 'trap', dmg: 0, dodged: true };
      } else {
        const dmg = Math.max(1, Math.floor(towerStats(state).maxHealth * TRAP_DAMAGE));
        const before = state.hp;
        state.hp = Math.max(1, state.hp - dmg);
        state.notice = { k: 'trap', dmg: before - state.hp, dodged: false };
      }
      break;
    }
    case 'AMBUSH': {
      // Le couloir n'était pas vide : le monstre frappe d'abord, puis le combat s'engage.
      const dmg = Math.max(1, Math.floor(towerStats(state).maxHealth * AMBUSH_DAMAGE));
      const before = state.hp;
      state.hp = Math.max(1, state.hp - dmg);
      startEncounter(state, level, 'COMBAT', rules, foes, rng, null, info, roomPower(room));
      // Pris au piège : pas de fuite, sans quoi revenir rejouait le coup d'entrée à l'infini.
      state.encounter!.ambush = true;
      // Nuit sans lune : l'embuscade est plus dangereuse à repérer, elle paie d'autant.
      if (floorModifier(state) === 'MOONLESS') state.encounter!.bounty = (state.encounter!.bounty ?? 1) * MOONLESS_AMBUSH_BOUNTY;
      state.notice = { k: 'ambush', dmg: before - state.hp };
      return floor;
    }
    case 'COLLAPSE': {
      // Tant qu'il tient, l'escalier fait monter ; effondré, un gardien garde le passage.
      if ((map.steps ?? 0) <= (room.collapseSteps ?? TOWER_COLLAPSE_STEPS.default)) {
        const { next, climbed } = exitFloor(state, floor, rules, floors, rng);
        state.notice = { k: 'exit', exit: room.type, climbed };
        advance(state, next, rules, rng);
        return next;
      }
      startEncounter(state, level, 'BOSS', rules, foes, rng, room.foe, info, roomPower(room));
      state.notice = { k: 'collapsed' };
      return floor;
    }
    case 'TOLL':
      state.phase = 'TOLL';
      return floor;
    case 'PRISONER':
      startEncounter(state, level, 'ELITE', rules, foes, rng, room.foe, info, roomPower(room));
      state.encounter!.captive = room.captive ?? 'RANDOM';
      return floor;
    case 'ORACLE':
      state.phase = 'ORACLE';
      return floor;
    case 'FOUNTAIN':
      state.phase = 'FOUNTAIN';
      return floor;
    case 'TRIAL': {
      const power = roomPower(room);
      state.trial = { wave: 1, waves: room.waves ?? TRIAL_WAVES, power: power.factor, powerReward: power.reward, reward: room.trialReward === true };
      startEncounter(state, level, 'COMBAT', rules, foes, rng, null, null, power);
      return floor;
    }
    case 'STAIRS':
    case 'GATE':
    case 'EXIT': {
      const { next, climbed } = exitFloor(state, floor, rules, floors, rng);
      state.notice = { k: 'exit', exit: room.type, climbed };
      advance(state, next, rules, rng);
      return next;
    }
    case 'MERCHANT':
      state.merchant = rollMerchantOffers(level, rng, room.offers, room.pricePercent * (hasHeat(state, 'GREED') ? HEAT_GREED_PRICE : 1), merchantOf(rules));
      state.merchantRerolled = false;
      state.phase = 'MERCHANT';
      return floor;
    case 'EVENT':
      state.event = { id: info?.event ?? rng.pick(TOWER_EVENTS) };
      state.phase = 'EVENT';
      return floor;
    case 'CHEST': {
      const luck = 1 + fortuneOf(state);
      const mist = floorModifier(state) === 'MIST' ? MIST_CHEST_GOLD : 1;
      const gold = room.chest === 'GEAR' ? 0 : Math.round(treasureGold(level, rng) * luck * mist);
      state.gold += gold;
      // Un coffre mixte ne donne un objet qu'une fois sur cinq ; un coffre à équipement, toujours.
      if (room.chest === 'GEAR' || (room.chest === 'BOTH' && rng.next() < CHEST_GEAR_CHANCE * luck)) {
        state.pendingLoot = rollTowerGear(level, 'TREASURE', rng);
      }
      state.notice = { k: 'treasure', gold };
      break;
    }
    case 'CAMPFIRE':
      state.notice = { k: 'campfire', hp: heal(state, room.healPercent / 100) };
      break;
    case 'SHRINE':
      state.blessingDue = true;
      break;
    default:
      // Départ et couloir : on les traverse sans rien résoudre.
      markRoomCleared(state);
      advance(state, floor, rules, rng);
      return floor;
  }

  markRoomCleared(state);
  if (state.notice?.k === 'treasure') state.notice.lock = lockProgress(state);
  const next = progress(state, floor, rules, false);
  advance(state, next, rules, rng);
  return next;
}

/**
 * Applique une action du joueur. L'état d'entrée n'est jamais modifié. Les règles figées dans
 * la partie l'emportent sur `liveRules`, qui ne sert qu'aux parties d'avant ce gel.
 * Lève `TowerActionRefused` si l'action n'a pas de sens dans la phase en cours.
 */
export function applyTowerAction(
  input: TowerState,
  floor: number,
  action: TowerAction,
  liveRules: TowerRules,
  foes: TowerFoePool,
  /** Étages dessinés, dans l'ordre de la montée ; vide en mode aléatoire. */
  floors: readonly TowerLayout[] = [],
): TowerStepResult {
  const rules = input.rules ?? liveRules;
  const state = clone(input);
  const rng = new TowerRng(state.rng);
  const level = towerLevel(state, floor);
  state.notice = null;
  state.burned = 0;
  state.weather = null;
  state.ghostTaken = null;
  state.fountainDelta = 0;

  const done = (nextFloor: number, dead = false): TowerStepResult => {
    state.rng = rng.state;
    return { state, floor: nextFloor, dead };
  };

  if (state.phase === 'COMBAT') {
    const result = action.type === 'auto'
      ? autoFight(state, floor, rules, rng, floors, foes)
      : combatTurn(state, floor, action, rules, rng, floors, foes);
    state.rng = rng.state;
    return result;
  }

  // Une potion se boit aussi entre deux combats, sans passer son tour.
  if (action.type === 'potion') {
    if (state.potions <= 0) throw new TowerActionRefused('no_potion');
    if (state.hp >= towerStats(state).maxHealth) throw new TowerActionRefused('hp_full');
    state.potions -= 1;
    state.notice = { k: 'potion', hp: heal(state, merchantOf(rules).potionHealPercent / 100) };
    return done(floor);
  }

  switch (state.phase) {
    case 'DOORS': {
      if (action.type !== 'door') throw new TowerActionRefused('wrong_phase');
      // Le palier sûr ne dure que jusqu'au pas suivant.
      state.safeLeave = false;
      if (state.map) {
        const move = state.moves[action.index];
        if (!move) throw new TowerActionRefused('bad_choice');
        state.map.steps = (state.map.steps ?? 0) + 1;
        weatherStep(state, move.roomId, rng);
        // Un monstre errant rôde dans la salle visée : c'est lui qu'on trouve.
        const lurking = state.map.wanderers?.find((wanderer) => wanderer.pos === move.roomId);
        if (lurking) {
          state.map.prev = state.map.pos;
          state.map.pos = move.roomId;
          startWandererFight(state, level, rules, foes, rng, lurking);
          return done(floor);
        }
        const next = enterRoom(state, floor, move, rules, foes, rng, floors);
        // Rien ne retient le joueur : les errants font leur pas, et peuvent tomber sur lui.
        if (state.phase === 'DOORS' && next === floor) {
          const caught = moveWanderers(state, rng);
          if (caught) startWandererFight(state, level, rules, foes, rng, caught);
          else state.moves = computeMoves(state);
        }
        return done(next);
      }
      const door = state.doors[action.index];
      if (!door) throw new TowerActionRefused('bad_choice');
      const info = state.doorInfo?.[action.index] ?? null;
      state.doors = [];
      state.doorInfo = [];

      if (door === 'COMBAT' || door === 'ELITE' || door === 'BOSS') {
        startEncounter(state, floor, door, rules, foes, rng, null, info);
        return done(floor);
      }
      if (door === 'TREASURE') {
        const gold = treasureGold(floor, rng);
        state.gold += gold;
        state.pendingLoot = rollTowerGear(floor, 'TREASURE', rng);
        state.notice = { k: 'treasure', gold };
        const next = progress(state, floor, rules, false);
        advance(state, next, rules, rng);
        return done(next);
      }
      if (door === 'CAMPFIRE') {
        state.notice = { k: 'campfire', hp: heal(state, CAMPFIRE_HEAL) };
        const next = progress(state, floor, rules, false);
        advance(state, next, rules, rng);
        return done(next);
      }
      if (door === 'EVENT') {
        state.event = { id: info?.event ?? rng.pick(TOWER_EVENTS) };
        state.phase = 'EVENT';
        return done(floor);
      }
      state.merchant = rollMerchantOffers(floor, rng, merchantOf(rules).offers, hasHeat(state, 'GREED') ? 100 * HEAT_GREED_PRICE : 100, merchantOf(rules));
      state.merchantRerolled = false;
      state.phase = 'MERCHANT';
      return done(floor);
    }

    case 'EVENT': {
      if (action.type !== 'event') throw new TowerActionRefused('wrong_phase');
      const event = state.event;
      if (!event) throw new TowerActionRefused('wrong_phase');
      if (action.index !== 0 && action.index !== 1) throw new TowerActionRefused('bad_choice');
      state.notice = resolveEvent(state, event.id, action.index, level, rng);
      state.event = null;
      markRoomCleared(state);
      const next = progress(state, floor, rules, false);
      advance(state, next, rules, rng);
      return done(next);
    }

    case 'MERCENARY': {
      if (action.type === 'hire') {
        // Un seul mercenaire à la fois : en payer un second ne servirait à rien.
        if (state.ally) throw new TowerActionRefused('bad_choice');
        const price = mercenaryPrice(level);
        if (state.gold < price) throw new TowerActionRefused('no_gold');
        state.gold -= price;
        state.ally = true;
        state.notice = { k: 'hired', gold: price };
      } else if (action.type !== 'leave_shop') {
        throw new TowerActionRefused('wrong_phase');
      }
      markRoomCleared(state);
      const next = progress(state, floor, rules, false);
      advance(state, next, rules, rng);
      return done(next);
    }

    case 'ENTRY': {
      const map = state.map;
      if (action.type !== 'door' || !map) throw new TowerActionRefused('wrong_phase');
      const id = map.entryChoices?.[action.index];
      if (!id) throw new TowerActionRefused('bad_choice');
      map.pos = id;
      map.cleared = [id];
      map.entryChoices = undefined;
      advance(state, floor, rules, rng);
      return done(floor);
    }

    case 'TOLL': {
      const map = state.map!;
      const room = map.layout.rooms.find((candidate) => candidate.id === map.pos);
      const price = room?.tollGold ?? TOWER_TOLL_GOLD.default;
      if (action.type === 'pay') {
        if (state.gold < price) throw new TowerActionRefused('no_gold');
        state.gold -= price;
        const { next, climbed } = exitFloor(state, floor, rules, floors, rng);
        state.notice = { k: 'toll_paid', gold: price, climbed };
        advance(state, next, rules, rng);
        return done(next);
      }
      if (action.type === 'force') {
        // Le gardien du péage : le vaincre ouvre le passage sans rien payer.
        startEncounter(state, level, 'ELITE', rules, foes, rng, null, map.rooms?.[map.pos] ?? null, room ? roomPower(room) : undefined);
        state.encounter!.opensExit = true;
        return done(floor);
      }
      if (action.type !== 'leave_shop') throw new TowerActionRefused('wrong_phase');
      // Demi-tour : le péage reste là, à payer ou forcer plus tard.
      retreat(state);
      advance(state, floor, rules, rng);
      return done(floor);
    }

    case 'ORACLE': {
      const map = state.map!;
      if (action.type === 'reveal') {
        const price = oraclePrice(level);
        if (state.gold < price) throw new TowerActionRefused('no_gold');
        state.gold -= price;
        // Sous le brouillard, tout l'étage apparaît ; sans brouillard, le chemin de la sortie.
        const fog = towerLayoutHasFog(map.layout);
        if (fog) {
          map.revealed = true;
        } else {
          const exit = exitRoom(map.layout);
          map.oraclePath = exit ? pathBetween(map.layout, map.pos, exit.id) ?? undefined : undefined;
        }
        state.notice = { k: 'oracle', gold: price, revealed: fog };
      } else if (action.type !== 'leave_shop') {
        throw new TowerActionRefused('wrong_phase');
      }
      markRoomCleared(state);
      const next = progress(state, floor, rules, false);
      advance(state, next, rules, rng);
      return done(next);
    }

    case 'FOUNTAIN': {
      const pool = state.fountainPool ?? 0;
      if (action.type === 'drink') {
        const cost = fountainDrinkCost(level);
        if (pool < cost) throw new TowerActionRefused('fountain_dry');
        if (state.hp >= towerStats(state).maxHealth) throw new TowerActionRefused('hp_full');
        state.fountainDelta = -cost;
        state.notice = { k: 'fountain_drink', hp: heal(state, FOUNTAIN_HEAL), cost };
      } else if (action.type === 'donate') {
        const gift = fountainDonation(level);
        if (state.gold < gift) throw new TowerActionRefused('no_gold');
        state.gold -= gift;
        state.fountainDelta = gift;
        state.notice = { k: 'fountain_donate', gold: gift };
      } else if (action.type !== 'leave_shop') {
        throw new TowerActionRefused('wrong_phase');
      }
      markRoomCleared(state);
      const next = progress(state, floor, rules, false);
      advance(state, next, rules, rng);
      return done(next);
    }

    case 'MENTOR': {
      if (action.type === 'learn') {
        const id = state.mentor?.[action.index];
        const skill = id ? (state.skillPool ?? []).find((candidate) => candidate.id === id) : undefined;
        if (!skill) throw new TowerActionRefused('bad_choice');
        const price = mentorPrice(level);
        if (state.gold < price) throw new TowerActionRefused('no_gold');
        state.gold -= price;
        state.skills = [...state.skills, skill];
        state.skillPool = (state.skillPool ?? []).filter((candidate) => candidate.id !== skill.id);
        state.notice = { k: 'learned', name: skill.name, emoji: skill.emoji, gold: price };
      } else if (action.type !== 'leave_shop') {
        throw new TowerActionRefused('wrong_phase');
      }
      state.mentor = [];
      markRoomCleared(state);
      const next = progress(state, floor, rules, false);
      advance(state, next, rules, rng);
      return done(next);
    }

    case 'LOOT': {
      const loot = state.pendingLoot;
      if (!loot) throw new TowerActionRefused('wrong_phase');
      if (action.type === 'equip') {
        withMaxHealthChange(state, () => { state.gear[loot.slot] = loot; });
        state.notice = { k: 'equipped', name: loot.name, emoji: loot.emoji };
      } else if (action.type === 'discard') {
        const gold = scrapValue(level);
        state.gold += gold;
        state.notice = { k: 'scrapped', gold };
      } else {
        throw new TowerActionRefused('wrong_phase');
      }
      state.pendingLoot = null;
      advance(state, floor, rules, rng);
      return done(floor);
    }

    case 'BLESSING': {
      if (action.type !== 'bless') throw new TowerActionRefused('wrong_phase');
      const id = state.blessingChoices[action.index];
      const blessing = id ? findBlessing(id) : null;
      if (!blessing) throw new TowerActionRefused('bad_choice');
      withMaxHealthChange(state, () => {
        state.blessings[blessing.id] = Math.min(blessing.maxRank, (state.blessings[blessing.id] ?? 0) + 1);
      });
      state.notice = { k: 'blessed', id: blessing.id, rank: state.blessings[blessing.id] };
      state.blessingDue = false;
      state.blessingChoices = [];
      advance(state, floor, rules, rng);
      return done(floor);
    }

    case 'MERCHANT': {
      if (action.type === 'leave_shop') {
        state.merchant = [];
        state.merchantRerolled = false;
        markRoomCleared(state);
        const next = progress(state, floor, rules, false);
        advance(state, next, rules, rng);
        return done(next);
      }
      if (action.type === 'reroll') {
        if (state.merchantRerolled) throw new TowerActionRefused('no_reroll');
        const gear = state.merchant.filter((offer): offer is Extract<TowerOffer, { kind: 'GEAR' }> => offer.kind === 'GEAR' && !offer.sold);
        if (gear.length === 0) throw new TowerActionRefused('no_reroll');
        const price = towerRerollPrice(level, merchantOf(rules));
        if (state.gold < price) throw new TowerActionRefused('no_gold');
        state.gold -= price;
        for (const offer of gear) offer.gear = rollTowerGear(level, 'MERCHANT', rng);
        state.merchantRerolled = true;
        state.notice = { k: 'rerolled' };
        return done(floor);
      }
      if (action.type !== 'buy') throw new TowerActionRefused('wrong_phase');
      const offer = state.merchant[action.index];
      if (!offer) throw new TowerActionRefused('bad_choice');
      if (offer.sold) throw new TowerActionRefused('sold_out');
      if (state.gold < offer.price) throw new TowerActionRefused('no_gold');

      if (offer.kind === 'POTION') {
        if (state.potions >= MAX_POTIONS) throw new TowerActionRefused('potions_full');
        state.potions += 1;
      } else if (offer.kind === 'HEAL') {
        if (state.hp >= towerStats(state).maxHealth) throw new TowerActionRefused('hp_full');
        heal(state, merchantOf(rules).healPercent / 100);
      } else {
        state.pendingLoot = offer.gear;
      }
      state.gold -= offer.price;
      offer.sold = true;
      state.notice = { k: 'bought', kind: offer.kind };
      advance(state, floor, rules, rng);
      return done(floor);
    }

    default:
      throw new TowerActionRefused('wrong_phase');
  }
}
