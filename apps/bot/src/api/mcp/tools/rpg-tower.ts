/**
 * Outils MCP de la Tour : réglages, récompenses, saisons et profils des joueurs.
 *
 * Comme les autres outils RPG, ils passent par le service utilisé par le dashboard. Lecture
 * sous READ_ECONOMY, écriture sous WRITE_MEMBERS.
 */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember, toolError } from '../toolkit.js';
import {
  adjustTowerShards,
  deleteTowerReward,
  getTowerConfig,
  currentTowerDay,
  getTowerDailyLeaderboard,
  getTowerDashboard,
  getTowerPlayerSummary,
  resetTower,
  saveTowerFloors,
  saveTowerReward,
  saveTowerSettings,
  startTowerSeason,
} from '../../../services/features/rpg/rpgTowerService.js';
import {
  TOWER_BLESSINGS,
  TOWER_DAILY_PODIUM_SHARDS,
  TOWER_ENTRY_MODES,
  TOWER_RANGES,
  TOWER_MERCHANT_RANGES,
  TOWER_REWARD_KINDS,
  TOWER_REWARD_LIMIT_PERIODS,
  TOWER_REWARD_STATS,
  TOWER_UPGRADES_MAX,
  TOWER_UPGRADE_EFFECTS,
  TOWER_UPGRADE_PER_LEVEL_RANGES,
  TOWER_UPGRADE_RANGES,
  towerDailyChallenge,
} from '../../../services/features/rpg/rpgTowerPolicy.js';
import {
  TOWER_BOSS_MECHANICS,
  TOWER_EVENTS,
  TOWER_EVENT_CHOICES,
  TOWER_MECHANIC_CHOICES,
  TOWER_RELIC_PERKS,
  TOWER_ROOM_TRAITS_MAX,
  TOWER_TRAITS,
} from '../../../services/features/rpg/rpgTowerContent.js';
import {
  TOWER_CAPTIVE_KINDS,
  TOWER_CHEST_KINDS,
  TOWER_COLLAPSE_STEPS,
  TOWER_TOLL_GOLD,
  TOWER_WANDER_RADIUS,
  TOWER_FLOORS_AFTER,
  TOWER_FLOOR_MODIFIERS,
  TOWER_FLOOR_THEMES,
  TOWER_FLOORS_MAX,
  TOWER_FLOOR_NAME_MAX,
  TOWER_MAP_ROOMS_MAX,
  TOWER_MAP_SIZE,
  TOWER_OFFER_KINDS,
  TOWER_POWER_PERCENT_RANGE,
  TOWER_TRIAL_WAVES,
  TOWER_ROOM_TYPES,
  TOWER_VARIANT_WEIGHT,
  defaultTowerLayout,
  newTowerRoom,
  towerFloorCount,
  type TowerLayout,
  type TowerRoom,
} from '../../../services/features/rpg/rpgTowerMap.js';

export const roomSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  type: z.enum(TOWER_ROOM_TYPES).describe("Entrée, d'une seule sorte par étage : START (départ unique), WELL (puits, 2 à 4 : le joueur tombe dans l'un au hasard) ou ENTRANCE (2 à 3 entrées entre lesquelles il choisit). Sorties, exactement une par étage : BOSS (gardien, salle 2×2 ancrée en haut à gauche), STAIRS (escalier scellé, ouvert par les clés), GATE (porte scellée, ouverte par les sceaux), EXIT (escalier ouvert, sans condition), COLLAPSE (escalier qui s'effondre après collapseSteps pas sur l'étage : un gardien garde alors le passage), TOLL (péage : payer tollGold pièces, ou forcer le passage contre une élite). SEAL (sceau gardé par une élite, seulement avec GATE). Autres : MONSTER, ELITE, AMBUSH (se présente comme un couloir, cache un monstre qui frappe en premier), WANDERER (repaire d'un monstre errant plus fort : il se déplace d'une salle à chaque pas du joueur dans un rayon wanderRadius, seulement par les couloirs et les salles de combat déjà faites), PRISONER (un geôlier élite garde un captif qui, libéré, rend de l'or, une potion ou un allié : captive), TRIAL (épreuve : plusieurs vagues d'affilée sans fuite, la dernière est une élite ; ne fait pas monter), CHEST, MIMIC (se présente comme un coffre, cache une élite au butin garanti), CAMPFIRE, MERCHANT, MERCENARY (allié payant qui frappe à chaque tour jusqu'à la fin de l'étage), MENTOR (enseigne contre de l'or une compétence du RPG non achetée au départ), ORACLE (contre de l'or, révèle tout l'étage sous le brouillard, ou le chemin de la sortie sans brouillard), FOUNTAIN (source commune du serveur : on y verse de l'or, on y boit un soin), SHRINE (bénédiction), EVENT (choix narratif), TRAP (dégâts à l'entrée, évités selon la vitesse), WARP_A et WARP_B (paire de portails liés : entrer dans l'un permet de passer dans l'autre ; une seule paire par étage, A et B ensemble), EMPTY (couloir)"),
  foe: z.string().nullable().optional().describe('MONSTER/ELITE/BOSS/COLLAPSE/WANDERER/PRISONER : créature imposée (pour COLLAPSE, le gardien qui garde l\'escalier effondré) (nom exact du bestiaire), sinon tirée au hasard'),
  traits: z.array(z.enum(TOWER_TRAITS)).max(TOWER_ROOM_TRAITS_MAX).optional().describe('MONSTER/ELITE/BOSS/COLLAPSE/AMBUSH : traits imposés (vide : tirés au hasard ; une élite et un gardien en ont un)'),
  powerPercent: z.number().int().min(TOWER_POWER_PERCENT_RANGE.min).max(TOWER_POWER_PERCENT_RANGE.max).optional().describe('MONSTER/ELITE/BOSS/TRIAL : puissance en % de la force normale à cette profondeur (100 par défaut ; pour une épreuve, chaque vague). La force suit toujours la montée ; ce réglage la multiplie'),
  powerReward: z.boolean().optional().describe("MONSTER/ELITE/BOSS/TRIAL : l'or et la chance de butin suivent aussi la puissance (false par défaut : une salle renforcée ne rapporte pas plus)"),
  collapseSteps: z.number().int().min(TOWER_COLLAPSE_STEPS.min).max(TOWER_COLLAPSE_STEPS.max).optional().describe("COLLAPSE : pas permis sur l'étage avant l'effondrement (10 par défaut)"),
  tollGold: z.number().int().min(TOWER_TOLL_GOLD.min).max(TOWER_TOLL_GOLD.max).optional().describe('TOLL : prix du passage en pièces (60 par défaut)'),
  wanderRadius: z.number().int().min(TOWER_WANDER_RADIUS.min).max(TOWER_WANDER_RADIUS.max).optional().describe('WANDERER : rayon de patrouille en salles depuis son repaire (3 par défaut)'),
  captive: z.enum(TOWER_CAPTIVE_KINDS).optional().describe('PRISONER : ce que rend le captif libéré (RANDOM par défaut, GOLD, POTION ou ALLY)'),
  waves: z.number().int().min(TOWER_TRIAL_WAVES.min).max(TOWER_TRIAL_WAVES.max).optional().describe('TRIAL : nombre de vagues (3 par défaut), la dernière est une élite'),
  trialReward: z.boolean().optional().describe("TRIAL : la réussite paie comme un gardien, soin de victoire et chance d'objet du gardien (true par défaut ; false : l'épreuve ne rapporte que ses combats)"),
  mechanic: z.enum(TOWER_MECHANIC_CHOICES).optional().describe('BOSS/COLLAPSE : mécanique du gardien (RANDOM par défaut, NONE pour aucune)'),
  event: z.enum(TOWER_EVENT_CHOICES).optional().describe('EVENT : événement imposé (RANDOM par défaut)'),
  key: z.boolean().optional().describe('ELITE/CHEST/TRIAL : garde une clé de l\'escalier scellé (seulement avec STAIRS, au moins une clé requise)'),
  chest: z.enum(TOWER_CHEST_KINDS).optional().describe('CHEST : contenu'),
  healPercent: z.number().int().min(5).max(100).optional().describe('CAMPFIRE : soin en % des PV max'),
  offers: z.array(z.enum(TOWER_OFFER_KINDS)).max(4).optional().describe('MERCHANT : articles vendus'),
  pricePercent: z.number().int().min(10).max(500).optional().describe('MERCHANT : prix en % du prix normal'),
});

export const floorSchema = z.object({
  name: z.string().max(TOWER_FLOOR_NAME_MAX).optional().describe("Nom de l'étage (« Caserne », « Crypte »…)"),
  fog: z.boolean().optional().describe('Brouillard de guerre : seules les salles visitées et leurs voisines se voient'),
  modifier: z.enum(TOWER_FLOOR_MODIFIERS).optional().describe('Ambiance : NONE, FLOODED (vitesse -20 %), BURNING (le feu part d\'une salle et gagne une voisine à chaque pas ; entrer dans une salle en feu brûle 3 % des PV), BLESSED (soins +25 %), MIST (brouillard forcé et coffres +25 % d\'or, jusqu\'à ce que la brume se lève après 8 salles explorées), FROST (premier coup de chaque combat -50 %, des deux côtés), MOONLESS (errants deux fois plus rapides, embuscades +50 %)'),
  theme: z.enum(TOWER_FLOOR_THEMES).optional().describe('Décor de l\'étage, sans effet sur le jeu : AUTO (suit la hauteur : pierre, mousse, crypte, glace, forge, arcanes, abîme), STONE, MOSS, CRYPT, ICE, FORGE, ARCANE ou ABYSS'),
  variant: z.boolean().optional().describe("Variante de la carte précédente : les deux forment un même étage et l'une est tirée au sort à chaque montée. Ignoré sur la première carte."),
  weight: z.number().int().min(TOWER_VARIANT_WEIGHT.min).max(TOWER_VARIANT_WEIGHT.max).optional().describe(`Poids de la carte au tirage entre les variantes de son étage (${TOWER_VARIANT_WEIGHT.min} à ${TOWER_VARIANT_WEIGHT.max}, défaut ${TOWER_VARIANT_WEIGHT.default}) : 1 face à 9, elle sort une fois sur dix.`),
  width: z.number().int().min(TOWER_MAP_SIZE.min).max(TOWER_MAP_SIZE.max),
  height: z.number().int().min(TOWER_MAP_SIZE.min).max(TOWER_MAP_SIZE.max),
  rooms: z.array(roomSchema).max(TOWER_MAP_ROOMS_MAX),
});

const upgradeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,24}$/).describe('Identifiant stable : les niveaux achetés par les joueurs y sont rattachés. Le changer revient à créer une nouvelle amélioration.'),
  enabled: z.boolean().optional().describe('Désactivée : ne se vend plus, les niveaux déjà achetés restent actifs'),
  name: z.string().optional().describe("Vide : nom de l'effet dans la langue du joueur"),
  emoji: z.string().optional().describe("Vide : icône du bot selon l'effet"),
  description: z.string().optional(),
  effect: z.enum(TOWER_UPGRADE_EFFECTS).describe('POTION potions de départ, HEALTH/ATTACK/DEFENSE/SPEED % de la stat, CRIT points de % de critique, GOLD or de départ, FORTUNE % d\'or et de chance d\'objet en combat et dans les coffres (30 % au plus)'),
  perLevel: z.number().int().min(1).describe('Gain par niveau, dans l\'unité de l\'effet'),
  maxLevel: z.number().int().min(TOWER_UPGRADE_RANGES.maxLevel.min).max(TOWER_UPGRADE_RANGES.maxLevel.max),
  baseCost: z.number().int().min(TOWER_UPGRADE_RANGES.baseCost.min).max(TOWER_UPGRADE_RANGES.baseCost.max).describe('Prix du premier niveau, en éclats'),
  costGrowthPercent: z.number().int().min(TOWER_UPGRADE_RANGES.costGrowthPercent.min).max(TOWER_UPGRADE_RANGES.costGrowthPercent.max).optional().describe('Hausse du prix à chaque niveau, en % (100 double le prix)'),
});

const merchantRange = (key: keyof typeof TOWER_MERCHANT_RANGES) => z.number().int().min(TOWER_MERCHANT_RANGES[key].min).max(TOWER_MERCHANT_RANGES[key].max).optional();
const merchantSchema = z.object({
  offers: z.array(z.enum(TOWER_OFFER_KINDS)).min(1).optional().describe('Articles du marchand en mode aléatoire (une salle de carte choisit les siens)'),
  potionPrice: merchantRange('potionPrice'),
  potionPricePerFloor: merchantRange('potionPricePerFloor'),
  healPrice: merchantRange('healPrice'),
  healPricePerFloor: merchantRange('healPricePerFloor'),
  healPercent: merchantRange('healPercent').describe('Soin vendu, en % des PV max'),
  gearPrice: merchantRange('gearPrice'),
  gearPricePerFloor: merchantRange('gearPricePerFloor'),
  potionHealPercent: merchantRange('potionHealPercent').describe('Soin de toutes les potions, en % des PV max'),
});

const fail = (e: unknown) => toolError(e);

export type TowerFloorsEdit = {
  floors?: unknown[];
  appendFloors?: unknown[];
  floor?: number;
  removeFloor?: boolean;
  useDefault?: boolean;
  name?: string;
  fog?: boolean;
  modifier?: TowerLayout['modifier'];
  theme?: TowerLayout['theme'];
  variant?: boolean;
  weight?: number;
  width?: number;
  height?: number;
  rooms?: unknown[];
};

/**
 * Étages après une modification demandée par un outil : `floors` remplace tout, `appendFloors`
 * ajoute ses cartes à la fin, sinon la carte `floor` est retirée, créée à la suite ou modifiée
 * champ par champ. Renvoie un message d'erreur quand la carte visée n'existe pas.
 */
export function editTowerFloors(existing: readonly TowerLayout[], input: TowerFloorsEdit): unknown[] | string {
  if (input.floors && input.appendFloors) return '`floors` et `appendFloors` ne se combinent pas.';
  if (input.floors) return input.floors;
  if (input.appendFloors) return [...existing, ...input.appendFloors];
  const current: TowerLayout[] = [...existing];
  const index = (input.floor ?? 1) - 1;
  if (index > current.length) return `La tour n'a que ${current.length} étage(s) : l'étage ${index + 1} ne peut pas être créé.`;
  if (input.removeFloor) {
    if (index >= current.length) return 'Cet étage n\'existe pas.';
    current.splice(index, 1);
    return current;
  }
  const { useDefault, name, fog, modifier, theme, variant, weight, width, height, rooms } = input;
  if (useDefault || name !== undefined || fog !== undefined || modifier !== undefined || theme !== undefined || variant !== undefined || weight !== undefined || width || height || rooms) {
    const base: Partial<TowerLayout> = useDefault ? defaultTowerLayout() : current[index] ?? {};
    current[index] = {
      name: name ?? base.name ?? '',
      fog: fog ?? base.fog ?? true,
      modifier: modifier ?? base.modifier ?? 'NONE',
      theme: theme ?? base.theme ?? 'AUTO',
      variant: variant ?? base.variant ?? false,
      weight: weight ?? base.weight ?? TOWER_VARIANT_WEIGHT.default,
      width: width ?? base.width ?? TOWER_MAP_SIZE.min,
      height: height ?? base.height ?? TOWER_MAP_SIZE.min,
      rooms: (rooms ?? base.rooms ?? []) as TowerLayout['rooms'],
    };
  }
  return current;
}

const ROOM_DEFAULTS = newTowerRoom(0, 0, 'EMPTY');

/**
 * Salle sans son identifiant ni les champs à leur valeur par défaut, que l'enregistrement remet
 * de lui-même : sans cela, une tour dépasse la taille d'une réponse d'outil.
 */
function compactTowerRoom(room: TowerRoom): Record<string, unknown> {
  const compact: Record<string, unknown> = { x: room.x, y: room.y, type: room.type };
  for (const [field, value] of Object.entries(room)) {
    if (field in compact || field === 'id') continue;
    // Forcé à faux hors épreuve, alors que le défaut vaut vrai.
    if (field === 'trialReward' && room.type !== 'TRIAL') continue;
    if (isDeepStrictEqual(value, ROOM_DEFAULTS[field as keyof TowerRoom])) continue;
    compact[field] = value;
  }
  return compact;
}

export function compactTowerFloors(floors: readonly TowerLayout[]) {
  return floors.map((layout) => ({ ...layout, rooms: layout.rooms.map(compactTowerRoom) }));
}

/**
 * Erreur d'un ajout en lot : la validation numérote les cartes depuis le début de la tour, on
 * rappelle donc lesquelles forment le lot et qu'aucune n'a été enregistrée.
 */
export function appendFailed(e: unknown, existing: number, appended: readonly unknown[] | undefined): unknown {
  if (!appended?.length || !(e instanceof Error)) return e;
  return new Error(`${e.message} Aucune carte du lot n'a été ajoutée : il couvrait les cartes ${existing + 1} à ${existing + appended.length}.`);
}

function towerFloorsTotals(floors: readonly TowerLayout[]) {
  return {
    floors: towerFloorCount(floors),
    cards: floors.length,
    rooms: floors.reduce((sum, entry) => sum + entry.rooms.length, 0),
  };
}

/**
 * Réponse d'un enregistrement d'étages : un résumé seulement. Renvoyer les cartes dépasserait la
 * taille d'une réponse d'outil, et le coût d'une tour dessinée carte par carte doublerait.
 */
export function towerFloorsSaved(floors: readonly TowerLayout[]) {
  return { ok: true, ...towerFloorsTotals(floors) };
}

export const TOWER_READ_CARDS_MAX = 20;

export const towerCardsReadSchema = {
  fromCard: z.number().int().min(1).max(TOWER_FLOORS_MAX).optional().describe('Première carte lue en entier (1 = première, variantes comptées). Défaut : 1.'),
  toCard: z.number().int().min(1).max(TOWER_FLOORS_MAX).optional().describe(`Dernière carte lue en entier, ${TOWER_READ_CARDS_MAX} cartes au plus à partir de fromCard. Les autres n'indiquent que leur nom, leur taille et leur nombre de salles.`),
};

/**
 * Cartes lisibles par un outil : les salles des cartes `fromCard` à `toCard` seulement, un aperçu
 * pour les autres. Une tour de 300 cartes entières dépasse de loin la taille d'une réponse.
 */
function towerFloorsView(floors: readonly TowerLayout[], cards: { fromCard?: number; toCard?: number } = {}) {
  const from = cards.fromCard ?? 1;
  const to = Math.min(cards.toCard ?? Number.POSITIVE_INFINITY, from + TOWER_READ_CARDS_MAX - 1);
  return floors.map((layout, index) => {
    const card = index + 1;
    if (card >= from && card <= to) return { card, ...compactTowerFloors([layout])[0] };
    const { rooms, ...rest } = layout;
    return { card, ...rest, roomCount: rooms.length };
  });
}

export function compactTowerSettings<T extends { floors: readonly TowerLayout[] }>(settings: T, cards?: { fromCard?: number; toCard?: number }) {
  return { ...settings, floors: towerFloorsView(settings.floors, cards) };
}

/** Réglages renvoyés après leur enregistrement : les étages n'y figurent qu'en totaux. */
export function towerSettingsSaved<T extends { floors: readonly TowerLayout[] }>(settings: T) {
  return { ...settings, floors: towerFloorsTotals(settings.floors) };
}

function mergeDefined(base: Record<string, unknown>, sent: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [field, value] of Object.entries(sent)) {
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

const range = (key: keyof typeof TOWER_RANGES) => z.number().int().min(TOWER_RANGES[key].min).max(TOWER_RANGES[key].max).optional();

export function registerRpgTowerTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  if (shouldRegister('READ_ECONOMY')) {
    server.registerTool(
      'get_rpg_tower',
      {
        description: "Lit la Tour (mode roguelite du RPG). Chaque étage est une carte : d'abord les étages dessinés (settings.floors, dans l'ordre de la montée), ensuite selon settings.floorsAfter la boucle sur les étages dessinés (LOOP) ou des étages générés (GENERATE) ; sans étage dessiné, tous sont générés. On monte d'un étage en battant son gardien, et la difficulté croît à chaque salle. Monstres à traits, gardiens à mécanique, reliques à effets uniques et salles d'événement : voir reference. Contient aussi les statistiques des parties (insights : étage moyen, taux de mort, monstres qui tuent le plus, étage le plus meurtrier avec sa variante : label « 3-E » ou « 2 » pour un étage sans variante ; cards : arrivées, passages, morts et départs sur chaque carte dessinée, avec sa chance d'être tirée) et le classement de l'ascension du jour (daily). Contient : étages dessinés (floors) et créatures proposables pour leurs salles (foes), réglages (ouverture, mode d'entrée COMPRESSED ou RESET, plafonds d'héritage et de titre, croissance des monstres, boss et bénédictions, éclats par étage, part gardée à la mort et en partant, plafond hebdomadaire, monnaie), récompenses (boutique d'éclats et paliers d'étage), statistiques, classement de la saison, améliorations permanentes (settings.upgrades) et marchand (settings.merchant) réglables, et le catalogue fixe des bénédictions. Une salle n'indique que les réglages qui s'écartent du défaut. Seules les cartes fromCard à toCard (20 au plus) sont lues en entier ; les autres n'indiquent que leur nom, leur taille et leur nombre de salles (roomCount).",
        inputSchema: towerCardsReadSchema,
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async (cards) => {
        const dashboard = await getTowerDashboard(guildId);
        return ok({
          ...dashboard,
          settings: compactTowerSettings(dashboard.settings, cards),
          reference: {
            entryModes: TOWER_ENTRY_MODES,
            rewardKinds: TOWER_REWARD_KINDS,
            rewardStats: TOWER_REWARD_STATS,
            ranges: TOWER_RANGES,
            blessings: TOWER_BLESSINGS.map((blessing) => ({ id: blessing.id, name: blessing.name, description: blessing.description, maxRank: blessing.maxRank })),
            traits: {
              list: TOWER_TRAITS,
              meaning: 'ARMORED défense ×1,8 ; VAMPIRIC se soigne de 30 % des dégâts infligés ; SWIFT vitesse ×1,6 et esquive les coups ; THORNY renvoie 15 % des dégâts reçus ; BERSERK attaque ×1,25 et PV ×0,85 ; REGENERATING rend 5 % des PV par tour. Élites et gardiens en portent un, les monstres ordinaires parfois à partir du niveau 15.',
            },
            bossMechanics: {
              list: TOWER_BOSS_MECHANICS,
              meaning: 'SHIELD bouclier de 35 % des PV ; SUMMONER un sbire tous les 3 coups (3 au plus, +25 % de dégâts chacun), dispersés par une compétence au multiplicateur 2 ou plus ; PHASES à mi-vie, soin de 20 % et +25 % attaque et défense, une fois.',
            },
            relicPerks: {
              list: TOWER_RELIC_PERKS,
              meaning: 'Effets uniques de reliques trouvées en ascension (dès la rareté UNCOMMON) : FIRST_STRIKE premier coup critique, LAST_STAND survit une fois à 1 PV, EXECUTE +50 % sous 30 % de PV, GUARDIAN_POTION une potion par gardien, SHARD_SEEKER +20 % d\'éclats.',
            },
            events: {
              list: TOWER_EVENTS,
              meaning: 'BLOOD_ALTAR 20 % des PV contre une bénédiction ; GAMBLER quitte ou double sur la moitié de l\'or ; SPRING soin de 30 % ou une potion ; BLACKSMITH reforge une arme ou armure (+15 %) contre de l\'or ; CURSED_PACT beaucoup d\'or mais +10 % d\'attaque aux monstres jusqu\'à la fin.',
            },
            floorsAfter: TOWER_FLOORS_AFTER,
            upgradeEffects: TOWER_UPGRADE_EFFECTS.map((effect) => ({ effect, perLevel: TOWER_UPGRADE_PER_LEVEL_RANGES[effect] })),
            upgradesMax: TOWER_UPGRADES_MAX,
            merchantRanges: TOWER_MERCHANT_RANGES,
          },
        });
      })
    );

    server.registerTool(
      'get_rpg_tower_player',
      {
        description: "Profil Tour d'un joueur : éclats, records (saison et tous les temps), ascensions, améliorations achetées, récompenses obtenues, et l'ascension en cours s'il y en a une. Le profil Tour est distinct du profil RPG.",
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        return ok({ userId: resolved.userId, ...(await getTowerPlayerSummary(guildId, resolved.userId)) });
      })
    );

    server.registerTool(
      'get_rpg_tower_daily',
      {
        description: "Défi du jour de la Tour (carte générée neuve chaque jour, la même pour tous, stats égales, une tentative par joueur et par jour, avec une ambiance et une malédiction imposées) : la contrainte du jour et le classement (étages gravis, salles explorées, issue). Le podium reçoit des éclats le lendemain. `day` au format AAAA-MM-JJ, dans le fuseau du serveur, aujourd'hui par défaut.",
        inputSchema: {
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ day, limit }) => {
        const dayKey = day ?? await currentTowerDay(guildId);
        const leaderboard = await getTowerDailyLeaderboard(guildId, dayKey, limit ?? 10);
        return ok({ day: dayKey, challenge: towerDailyChallenge(guildId, dayKey), podiumShards: TOWER_DAILY_PODIUM_SHARDS, leaderboard });
      })
    );
  }

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'save_rpg_tower_settings',
      {
        description: "Modifie les réglages de la Tour. Un champ omis garde sa valeur. Ne touche ni aux profils, ni aux éclats, ni aux parties en cours (elles gardent les stats de leur entrée). Requiert WRITE_MEMBERS.",
        inputSchema: {
          enabled: z.boolean().optional().describe('Ouvre ou ferme la Tour. Fermée, les parties en cours peuvent se terminer.'),
          name: z.string().optional(),
          emoji: z.string().optional(),
          description: z.string().optional(),
          entryMode: z.enum(TOWER_ENTRY_MODES).optional().describe('COMPRESSED : stats du RPG compressées et plafonnées. RESET : stats de base pour tous, seul le titre compte.'),
          inheritCapPercent: range('inheritCapPercent').describe('Bonus maximal hérité des stats du RPG, en % des stats de base'),
          titleCapPercent: range('titleCapPercent').describe('Bonus maximal du titre porté, en %'),
          floorGrowthPercent: range('floorGrowthPercent').describe('Force gagnée par les monstres à chaque étage, en %'),
          bossEvery: range('bossEvery').describe('Sans effet : chaque étage a son gardien. Ne sert qu\'aux anciennes ascensions en portes aléatoires.'),
          blessingEvery: range('blessingEvery').describe('Bénédiction tous les N étages gravis, en plus des autels ; 0 pour les autels seuls'),
          maxBlessings: range('maxBlessings'),
          shardsPerFloor: range('shardsPerFloor').describe('Éclats gagnés par étage gravi (pas par salle) ; augmente tous les 10 étages, doublé sur un étage fermé par un gardien'),
          shardsPerRoom: range('shardsPerRoom').describe('Éclats en plus pour chaque salle résolue, pour récompenser l\'exploration (0 par défaut : seul l\'étage gravi rapporte)'),
          deathShardPercent: range('deathShardPercent').describe('Part des éclats gardée à la mort'),
          leaveShardPercent: range('leaveShardPercent').describe('Part des éclats gardée en quittant hors palier sûr ; juste après un boss, quitter garde tout'),
          weeklyShardCap: range('weeklyShardCap').describe('0 pour aucun plafond'),
          skillPrice: range('skillPrice').describe("Prix de base en éclats d'une compétence du RPG, achetée au départ pour une seule ascension (0 : gratuites), multiplié selon son palier dans l'arbre : x1, x1,5, x2, x3 au bout. Dans la Tour, les compétences sont affaiblies : dégâts bonus divisés par deux, vol de vie et soins plafonnés, recharge plus longue."),
          idleTimeoutMinutes: range('idleTimeoutMinutes'),
          floorsAfter: z.enum(TOWER_FLOORS_AFTER).optional().describe('Après le dernier étage dessiné : GENERATE génère des étages inédits, LOOP reprend au premier. Sans étage dessiné, tous sont générés.'),
          generatedFog: z.boolean().optional().describe('Brouillard de guerre sur les étages générés (défaut : true). Chaque étage dessiné a son propre réglage (fog).'),
          dailyEnabled: z.boolean().optional().describe('Active l\'ascension du jour (désactivée par défaut) : même tour pour tous, stats égales, une tentative par jour et par joueur, classement séparé'),
          announceChannelId: z.string().nullable().optional().describe('Salon où annoncer les nouveaux records de la saison ; null pour aucune annonce'),
          currencyName: z.string().optional(),
          currencyEmoji: z.string().optional(),
          upgrades: z.array(upgradeSchema).max(TOWER_UPGRADES_MAX).optional().describe('Remplace la liste complète des améliorations permanentes (lire get_rpg_tower avant de modifier)'),
          merchant: merchantSchema.optional().describe('Champs du marchand à modifier ; les autres gardent leur valeur'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name, ...input }) => {
        try {
          const base: Record<string, unknown> = { ...(await getTowerConfig(guildId)) };
          delete base.seasonStartedAt;
          delete base.floors;
          const merged = mergeDefined(base, { ...input, merchant: undefined });
          if (input.merchant) merged.merchant = mergeDefined(base.merchant as Record<string, unknown>, input.merchant);
          const settings = await saveTowerSettings(guildId, merged);
          await audit(key_name, 'Réglages de la Tour MCP', settings.name, `${settings.enabled ? 'ouverte' : 'fermée'}, mode ${settings.entryMode}`);
          return ok({ ok: true, settings: towerSettingsSaved(settings) });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_tower_layout',
      {
        description: `Dessine les étages de la Tour. Chaque étage est une carte : une grille (${TOWER_MAP_SIZE.min} à ${TOWER_MAP_SIZE.max} cases de côté, ${TOWER_MAP_ROOMS_MAX} salles au plus) où deux salles qui se touchent par un côté communiquent ; une case sans salle est un mur. Il faut un seul départ, exactement une sortie (BOSS gardien, STAIRS escalier scellé avec au moins une clé, GATE porte scellée avec au moins un SEAL, EXIT escalier ouvert, COLLAPSE escalier qui s'effondre, TOLL péage ; entrée : un START, 2 à 4 WELL ou 2 à 3 ENTRANCE ; au plus une paire de portails WARP_A/WARP_B), et toutes les salles reliées au départ. Battre le gardien fait monter à l'étage suivant ; les étages se jouent dans l'ordre, puis la tour reprend au premier, plus dure. Une carte marquée \`variant\` est une variante de la carte d'avant : elles forment un même étage et l'une d'elles est tirée au sort à chaque montée, selon son \`weight\` (${TOWER_FLOORS_MAX} cartes au plus, variantes comprises). \`floors\` remplace toute la tour, \`appendFloors\` ajoute plusieurs cartes à la fin (à préférer pour dessiner une longue tour) ; sinon \`floor\` (1 = première carte, variantes comptées) désigne la carte à modifier ou à ajouter à la suite, avec \`name\`, \`variant\`, \`width\`, \`height\`, \`rooms\`, ou \`useDefault: true\` pour la carte d'exemple. \`removeFloor\` retire la carte \`floor\`. Sans aucun étage, la Tour génère les siens. Un joueur garde la carte de l'étage où il se trouve ; les étages suivants suivent la tour enregistrée. Requiert WRITE_MEMBERS.`,
        inputSchema: {
          floors: z.array(floorSchema).max(TOWER_FLOORS_MAX).optional().describe('Remplace tous les étages, dans l\'ordre de la montée'),
          appendFloors: z.array(floorSchema).max(TOWER_FLOORS_MAX).optional().describe('Cartes ajoutées à la fin de la tour, dans l\'ordre de la montée, sans toucher aux cartes existantes'),
          floor: z.number().int().min(1).max(TOWER_FLOORS_MAX).optional().describe('Carte à modifier (1 = première, variantes comptées). Défaut : 1.'),
          removeFloor: z.boolean().optional().describe('Retire l\'étage `floor`'),
          useDefault: z.boolean().optional().describe('Remplacer l\'étage par la carte d\'exemple'),
          name: z.string().max(TOWER_FLOOR_NAME_MAX).optional(),
          fog: z.boolean().optional().describe('Brouillard de guerre sur cet étage'),
          modifier: z.enum(TOWER_FLOOR_MODIFIERS).optional().describe('Ambiance de cet étage : NONE, FLOODED, BURNING, BLESSED, MIST, FROST ou MOONLESS'),
          theme: z.enum(TOWER_FLOOR_THEMES).optional().describe('Décor de l\'étage, sans effet sur le jeu : AUTO (suit la hauteur : pierre, mousse, crypte, glace, forge, arcanes, abîme), STONE, MOSS, CRYPT, ICE, FORGE, ARCANE ou ABYSS'),
          variant: z.boolean().optional().describe("Variante de la carte précédente : les deux forment un même étage et l'une est tirée au sort à chaque montée. Ignoré sur la première carte."),
          weight: z.number().int().min(TOWER_VARIANT_WEIGHT.min).max(TOWER_VARIANT_WEIGHT.max).optional().describe(`Poids de la carte au tirage entre les variantes de son étage (${TOWER_VARIANT_WEIGHT.min} à ${TOWER_VARIANT_WEIGHT.max}, défaut ${TOWER_VARIANT_WEIGHT.default}) : 1 face à 9, elle sort une fois sur dix.`),
          width: z.number().int().min(TOWER_MAP_SIZE.min).max(TOWER_MAP_SIZE.max).optional(),
          height: z.number().int().min(TOWER_MAP_SIZE.min).max(TOWER_MAP_SIZE.max).optional(),
          rooms: z.array(roomSchema).max(TOWER_MAP_ROOMS_MAX).optional().describe('Salles de l\'étage. Absent : celles de l\'étage actuel sont gardées.'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name, ...input }) => {
        try {
          const existing = (await getTowerConfig(guildId)).floors;
          const next = editTowerFloors(existing, input);
          if (typeof next === 'string') return err(next);
          const settings = await saveTowerFloors(guildId, { floors: next }).catch((e: unknown) => {
            throw appendFailed(e, existing.length, input.appendFloors);
          });
          const saved = towerFloorsSaved(settings.floors);
          await audit(key_name, 'Étages de la Tour MCP', 'Carte', `${saved.floors} étage(s), ${saved.cards} carte(s), ${saved.rooms} salles`);
          return ok(saved);
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'save_rpg_tower_reward',
      {
        description: "Crée une récompense de Tour, ou modifie celle désignée par `id` (voir get_rpg_tower). SHOP : article payé en éclats (`price`), unique par joueur sauf `repeatable` (sans titre ni rôle), éventuellement borné à `maxPurchases` achats, remis à zéro selon `limitPeriod`. MILESTONE : versé une fois au joueur qui franchit `floor` étages, peut offrir des éclats. Chaque récompense combine au choix un titre, un rôle, un objet, des pièces, de l'XP RPG, des statistiques du profil RPG (`stat` et `statAmount`, définitives), de l'énergie max (`maxEnergy`), des bons de reconversion (`reclassVouchers`, un changement de classe gratuit chacun), des points de clan (ou de l'XP de guilde RPG selon le mode d'équipe du serveur) et des éclats (paliers), avec au moins un de ces éléments. Préférer des titres sans bonus de stats. Un champ omis garde sa valeur. Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().optional().describe('ID de la récompense à modifier. Absent : création.'),
          kind: z.enum(TOWER_REWARD_KINDS).optional().describe('Requis à la création'),
          name: z.string().optional().describe('Requis à la création'),
          description: z.string().optional(),
          emoji: z.string().optional(),
          price: z.number().int().min(1).optional().describe('Prix en éclats (SHOP)'),
          floor: z.number().int().min(1).optional().describe('Étages à franchir (MILESTONE)'),
          repeatable: z.boolean().optional(),
          titleId: z.string().nullable().optional().describe('Titre offert (voir get_rpg_titles), null pour aucun'),
          roleId: z.string().nullable().optional().describe('Rôle Discord offert, null pour aucun'),
          coins: z.number().int().min(0).optional().describe('Pièces du RPG offertes'),
          xp: z.number().int().min(0).optional().describe('XP du RPG offerte'),
          clanPoints: z.number().int().min(0).optional().describe('Points de clan, ou XP de guilde RPG selon le mode d\'équipe du serveur'),
          itemName: z.string().nullable().optional().describe('Objet offert (nom exact du catalogue), null pour aucun'),
          shards: z.number().int().min(0).optional().describe('Éclats offerts (MILESTONE)'),
          stat: z.enum(TOWER_REWARD_STATS).nullable().optional().describe('Statistique du profil RPG montée : POINTS (points à répartir), ATTACK, DEFENSE, SPEED, HEALTH, ou RANDOM (une des quatre, tirée à chaque versement) ; null pour aucune'),
          statAmount: z.number().int().min(1).max(100).optional().describe('Points versés : 1 point = +1 en attaque, défense ou vitesse, ou +8 PV max'),
          maxEnergy: z.number().int().min(0).max(2_000_000).optional().describe('Énergie max ajoutée au profil RPG (et remplie d\'autant), 0 pour aucune ; le bonus d\'un joueur plafonne à 2 millions'),
          reclassVouchers: z.number().int().min(0).max(10).optional().describe('Bons de reconversion donnés au profil RPG : chacun paie un changement de classe à la place des pièces, 0 pour aucun'),
          maxPurchases: z.number().int().min(0).optional().describe('Achats au plus par joueur d\'un article répétable (SHOP) ; 0 = sans limite'),
          limitPeriod: z.enum(TOWER_REWARD_LIMIT_PERIODS).optional().describe('Remise à zéro de cette limite : NEVER (jamais), DAILY (chaque jour à minuit, fuseau du serveur), WEEKLY (chaque lundi)'),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name, ...input }) => {
        try {
          let base: Record<string, unknown> = {};
          if (id) {
            const existing = (await getTowerDashboard(guildId)).rewards.find((reward) => reward.id === id);
            if (!existing) return err('Récompense introuvable.');
            base = { ...existing };
          }
          const { reward, created } = await saveTowerReward(client, guildId, mergeDefined(base, input), id);
          await audit(key_name, created ? 'Création récompense de Tour MCP' : 'Modification récompense de Tour MCP', reward.name, reward.kind);
          return ok({ ok: true, id: reward.id, created });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'delete_rpg_tower_reward',
      {
        description: "Supprime une récompense de Tour. Les joueurs qui l'ont déjà obtenue la gardent (titre, rôle, pièces). Requiert WRITE_MEMBERS.",
        inputSchema: {
          id: z.string().describe('ID de la récompense (voir get_rpg_tower)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const reward = await deleteTowerReward(guildId, id);
          await audit(key_name, 'Suppression récompense de Tour MCP', reward.name, '');
          return ok({ ok: true });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'start_rpg_tower_season',
      {
        description: "Ouvre une nouvelle saison de la Tour : remet à zéro le meilleur étage de la saison de tous les joueurs (le classement) et, sauf `resetMilestones: false`, rend les paliers de nouveau gagnables. Ne touche PAS aux éclats, aux améliorations, aux articles achetés ni au record de tous les temps ; les parties en cours continuent sans compter pour la nouvelle saison. Irréversible pour le classement : à ne lancer que sur demande explicite. Requiert WRITE_MEMBERS.",
        inputSchema: {
          confirm: z.literal(true).describe('Doit valoir true : confirme la remise à zéro du classement'),
          resetMilestones: z.boolean().optional().describe('Rendre les paliers de nouveau gagnables (défaut : true)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ resetMilestones, key_name }) => {
        try {
          const reset = await startTowerSeason(guildId, { resetMilestones });
          await audit(key_name, 'Nouvelle saison de la Tour MCP', 'Classement', `${reset} profil(s) remis à zéro au classement`);
          return ok({ ok: true, reset });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'reset_rpg_tower',
      {
        description: "Remet la Tour à zéro : efface les ascensions et les profils Tour de tous les joueurs (éclats, améliorations, records, paliers obtenus). Avec `everything: true`, efface aussi les réglages, les étages dessinés et les récompenses. Ce qui a déjà été versé au profil RPG (pièces, XP, objets, titres, rôles) reste acquis. IRRÉVERSIBLE : à ne lancer que sur demande explicite. Requiert WRITE_MEMBERS.",
        inputSchema: {
          confirm: z.literal(true).describe('Doit valoir true : confirme l\'effacement'),
          everything: z.boolean().optional().describe('Effacer aussi réglages, étages et récompenses (défaut : false, seules les données des joueurs)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ everything, key_name }) => {
        try {
          const reset = await resetTower(guildId, { everything: everything === true });
          await audit(key_name, everything ? 'Réinitialisation complète de la Tour MCP' : 'Réinitialisation des joueurs de la Tour MCP', 'Tour', `${reset.profiles} profil(s), ${reset.runs} ascension(s), ${reset.rewards} récompense(s)`);
          return ok({ ok: true, ...reset });
        } catch (e) {
          return fail(e);
        }
      })
    );

    server.registerTool(
      'adjust_rpg_tower_shards',
      {
        description: "Ajoute (positif) ou retire (négatif) des éclats de Tour à un joueur. Le solde ne descend jamais sous zéro. N'affecte ni les records ni le plafond hebdomadaire. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          amount: z.number().int().describe('Éclats à ajouter (positif) ou retirer (négatif), non nul'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, amount, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const balance = await adjustTowerShards(guildId, resolved.userId, amount);
          await audit(key_name, 'Ajustement éclats de Tour MCP', resolved.label, `${amount > 0 ? '+' : ''}${amount} (solde ${balance})`);
          return ok({ ok: true, balance });
        } catch (e) {
          return fail(e);
        }
      })
    );
  }
}
