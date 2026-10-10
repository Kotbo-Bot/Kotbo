<script lang="ts">
  import { untrack } from 'svelte';
  /**
   * Éditeur des étages de la Tour.
   *
   * La tour est une pile d'étages, du rez-de-chaussée au sommet, qui se jouent dans l'ordre
   * puis recommencent au premier. Chaque étage est une grille où l'on peint des salles : deux
   * salles qui se touchent par un côté communiquent, une case vide est un mur, le gardien
   * occupe une grande salle de 2×2. La géométrie reprend celle du bot (`rpgTowerMap.ts`) :
   * ce qui s'affiche ici est ce que le joueur parcourra sur Discord, et le serveur revalide
   * tout à l'enregistrement.
   */
  import { m } from '../../i18n';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import { previewRpgTowerFloor, saveRpgTowerLayout } from '../../api';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import Papicon from '../Papicon.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';

  type RoomType = 'START' | 'WELL' | 'ENTRANCE' | 'MONSTER' | 'ELITE' | 'AMBUSH' | 'WANDERER' | 'PRISONER' | 'BOSS' | 'STAIRS' | 'EXIT' | 'COLLAPSE' | 'TOLL' | 'TRIAL' | 'GATE' | 'SEAL' | 'FOUNTAIN' | 'ORACLE'
    | 'CHEST' | 'MIMIC' | 'CAMPFIRE' | 'MERCHANT' | 'MERCENARY' | 'MENTOR' | 'SHRINE' | 'EVENT' | 'TRAP' | 'WARP_A' | 'WARP_B' | 'EMPTY';
  type Modifier = 'NONE' | 'FLOODED' | 'BURNING' | 'BLESSED' | 'MIST' | 'FROST' | 'MOONLESS';
  type Captive = 'RANDOM' | 'GOLD' | 'POTION' | 'ALLY';
  type Category = 'ENTRY' | 'MONSTERS' | 'EXITS' | 'NPC' | 'OTHER';
  type Trait = 'ARMORED' | 'VAMPIRIC' | 'SWIFT' | 'THORNY' | 'BERSERK' | 'REGENERATING';
  type Mechanic = 'RANDOM' | 'NONE' | 'SHIELD' | 'SUMMONER' | 'PHASES';
  type EventChoice = 'RANDOM' | 'BLOOD_ALTAR' | 'GAMBLER' | 'SPRING' | 'BLACKSMITH' | 'CURSED_PACT';
  type ChestKind = 'BOTH' | 'GOLD' | 'GEAR';
  type OfferKind = 'POTION' | 'HEAL' | 'GEAR';
  type Room = {
    id: string;
    x: number;
    y: number;
    type: RoomType;
    foe: string | null;
    chest: ChestKind;
    healPercent: number;
    offers: OfferKind[];
    pricePercent: number;
    traits: Trait[];
    powerPercent: number;
    powerReward: boolean;
    waves: number;
    trialReward: boolean;
    collapseSteps: number;
    tollGold: number;
    wanderRadius: number;
    captive: Captive;
    mechanic: Mechanic;
    event: EventChoice;
    key: boolean;
  };
  /** `variant` : variante de la carte d'avant, tirée au sort avec elle pour un même étage, selon `weight`. */
  type Theme = 'AUTO' | 'STONE' | 'MOSS' | 'CRYPT' | 'ICE' | 'FORGE' | 'ARCANE' | 'ABYSS';
  type Layout = { name: string; width: number; height: number; fog: boolean; modifier: Modifier; theme: Theme; variant: boolean; weight: number; rooms: Room[] };
  type Foe = { name: string; emoji: string; isBoss: boolean; enabled: boolean };
  type Tool = RoomType | 'ERASE' | 'SELECT';

  const {
    canManage = false,
    disabled = false,
    initialFloors = [],
    foes = [],
    deathMap = {},
    sizeLimits = { min: 3, max: 20 },
    roomsMax = 300,
    floorsMax = 300,
    growthPercent = 8,
    floorsAfter = 'LOOP',
    onSaved,
    saveFloors = (floors: Layout[]) => saveRpgTowerLayout({ floors }),
  }: {
    canManage?: boolean;
    disabled?: boolean;
    initialFloors?: Layout[];
    foes?: Foe[];
    deathMap?: Record<string, Record<string, number>>;
    sizeLimits?: { min: number; max: number };
    roomsMax?: number;
    floorsMax?: number;
    growthPercent?: number;
    floorsAfter?: 'GENERATE' | 'LOOP';
    onSaved?: () => void | Promise<void>;
    /** Enregistrement des étages : ceux de la Tour par défaut, ceux de la Tour de clan sinon. */
    saveFloors?: (floors: Layout[]) => Promise<unknown>;
  } = $props();

  const CELL = 56;
  // Cadre de pierre autour de la grille et hauteur des créneaux, en unités du dessin.
  const FRAME = 18;
  const CRENEL = 22;
  const ROOM_TYPES: RoomType[] = [
    'START', 'WELL', 'ENTRANCE', 'MONSTER', 'ELITE', 'MIMIC', 'AMBUSH', 'WANDERER', 'PRISONER', 'BOSS', 'STAIRS', 'EXIT', 'COLLAPSE', 'TOLL', 'TRIAL', 'GATE', 'SEAL',
    'CHEST', 'CAMPFIRE', 'MERCHANT', 'MERCENARY', 'MENTOR', 'ORACLE', 'FOUNTAIN', 'SHRINE', 'EVENT', 'TRAP', 'WARP_A', 'WARP_B', 'EMPTY',
  ];
  // Ambiances d'étage (miroir de `TOWER_FLOOR_MODIFIERS`).
  const MODIFIERS: Modifier[] = ['NONE', 'FLOODED', 'BURNING', 'BLESSED', 'MIST', 'FROST', 'MOONLESS'];
  // Décors d'étage (miroir de `TOWER_FLOOR_THEMES`) : AUTO suit la hauteur.
  const THEMES: Theme[] = ['AUTO', 'STONE', 'MOSS', 'CRYPT', 'ICE', 'FORGE', 'ARCANE', 'ABYSS'];
  // Portails A et B : une seule paire par étage, liée comme par un couloir (miroir de `rpgTowerMap.ts`).
  const isWarp = (type: RoomType) => type === 'WARP_A' || type === 'WARP_B';
  // Sorties d'un étage (miroir de `TOWER_EXIT_TYPES`) : exactement une par étage.
  const EXITS: RoomType[] = ['BOSS', 'STAIRS', 'GATE', 'EXIT', 'COLLAPSE', 'TOLL'];
  // Entrées (miroir de `TOWER_ENTRY_TYPES`) : un départ, 2 à 4 puits ou 2 à 3 entrées au choix.
  const ENTRIES: RoomType[] = ['START', 'WELL', 'ENTRANCE'];
  const isEntry = (type: RoomType) => ENTRIES.includes(type);
  const WELLS = { min: 2, max: 4 };
  const ENTRANCES = { min: 2, max: 3 };
  const isExit = (type: RoomType) => EXITS.includes(type);
  // La palette est rangée par familles : on cherche une sortie parmi les sorties, pas dans une liste de quatorze.
  const CATEGORIES: { id: Category; icon: string; types: RoomType[] }[] = [
    { id: 'ENTRY', icon: 'LogIn', types: ['START', 'WELL', 'ENTRANCE'] },
    { id: 'MONSTERS', icon: 'Swords', types: ['MONSTER', 'ELITE', 'TRIAL', 'MIMIC', 'AMBUSH', 'WANDERER', 'PRISONER'] },
    { id: 'EXITS', icon: 'Flag', types: ['BOSS', 'STAIRS', 'GATE', 'SEAL', 'EXIT', 'COLLAPSE', 'TOLL'] },
    // Le prisonnier est aussi un PNJ : on le trouve qu'on pense « combat » ou « personnage ».
    { id: 'NPC', icon: 'Users', types: ['MERCHANT', 'MERCENARY', 'MENTOR', 'ORACLE', 'PRISONER'] },
    { id: 'OTHER', icon: 'LayoutGrid', types: ['CHEST', 'CAMPFIRE', 'FOUNTAIN', 'SHRINE', 'EVENT', 'TRAP', 'WARP_A', 'WARP_B', 'EMPTY'] },
  ];
  // Mêmes valeurs que `rpgTowerContent.ts` côté bot.
  const TRAITS: Trait[] = ['ARMORED', 'VAMPIRIC', 'SWIFT', 'THORNY', 'BERSERK', 'REGENERATING'];
  const TRAITS_MAX = 2;
  const MECHANICS: Mechanic[] = ['RANDOM', 'NONE', 'SHIELD', 'SUMMONER', 'PHASES'];
  const EVENTS: EventChoice[] = ['RANDOM', 'BLOOD_ALTAR', 'GAMBLER', 'SPRING', 'BLACKSMITH', 'CURSED_PACT'];
  // Force des monstres (miroir de `towerMonsterStats`) : 70 PV au niveau 1, croissance divisée par deux après 25.
  const MONSTER_BASE_HEALTH = 70;
  const GROWTH_KNEE = 25;
  // Mêmes pictogrammes que les emojis d'application du bot sur Discord.
  const ICON: Record<RoomType, string> = {
    START: 'DoorOpen', MONSTER: 'Swords', ELITE: 'Skull', BOSS: 'Crown', CHEST: 'PackageOpen',
    CAMPFIRE: 'Flame', MERCHANT: 'ShoppingCart', SHRINE: 'Sparkles', EVENT: 'HelpCircle', EMPTY: 'Square',
    STAIRS: 'ArrowUpCircle', EXIT: 'ArrowUp', TRIAL: 'Hourglass', GATE: 'Flag', SEAL: 'Target', WARP_A: 'Zap', WARP_B: 'Zap',
    MIMIC: 'Ghost', MERCENARY: 'UserPlus', MENTOR: 'BookOpen', TRAP: 'AlertTriangle',
    WELL: 'CircleDot', ENTRANCE: 'LogIn', AMBUSH: 'Eye', COLLAPSE: 'TrendingDown', TOLL: 'Coins', FOUNTAIN: 'HeartHandshake',
    WANDERER: 'Route', PRISONER: 'Lock', ORACLE: 'Compass',
  };
  const COLOR: Record<RoomType, string> = {
    START: '#64748b', MONSTER: '#ef4444', ELITE: '#a855f7', BOSS: '#f59e0b', CHEST: '#eab308',
    CAMPFIRE: '#f97316', MERCHANT: '#10b981', SHRINE: '#38bdf8', EVENT: '#e879f9', EMPTY: '#94a3b8',
    STAIRS: '#22d3ee', EXIT: '#34d399', TRIAL: '#f43f5e', GATE: '#c084fc', SEAL: '#a78bfa', WARP_A: '#2dd4bf', WARP_B: '#14b8a6',
    MIMIC: '#ca8a04', MERCENARY: '#84cc16', MENTOR: '#f472b6', TRAP: '#dc2626',
    WELL: '#64748b', ENTRANCE: '#94a3b8', AMBUSH: '#b91c1c', COLLAPSE: '#fb923c', TOLL: '#facc15', FOUNTAIN: '#38bdf8',
    WANDERER: '#ef4444', PRISONER: '#a3e635', ORACLE: '#c4b5fd',
  };
  const OFFERS: OfferKind[] = ['POTION', 'HEAL', 'GEAR'];

  function label(type: RoomType): string {
    switch (type) {
      case 'START': return m.eco_tower_room_start();
      case 'WELL': return m.eco_tower_room_well();
      case 'ENTRANCE': return m.eco_tower_room_entrance();
      case 'AMBUSH': return m.eco_tower_room_ambush();
      case 'COLLAPSE': return m.eco_tower_room_collapse();
      case 'TOLL': return m.eco_tower_room_toll();
      case 'FOUNTAIN': return m.eco_tower_room_fountain();
      case 'WANDERER': return m.eco_tower_room_wanderer();
      case 'PRISONER': return m.eco_tower_room_prisoner();
      case 'ORACLE': return m.eco_tower_room_oracle();
      case 'MONSTER': return m.eco_tower_room_monster();
      case 'ELITE': return m.eco_tower_room_elite();
      case 'BOSS': return m.eco_tower_room_boss();
      case 'CHEST': return m.eco_tower_room_chest();
      case 'CAMPFIRE': return m.eco_tower_room_campfire();
      case 'MERCHANT': return m.eco_tower_room_merchant();
      case 'SHRINE': return m.eco_tower_room_shrine();
      case 'EVENT': return m.eco_tower_room_event();
      case 'STAIRS': return m.eco_tower_room_stairs();
      case 'EXIT': return m.eco_tower_room_exit();
      case 'TRIAL': return m.eco_tower_room_trial();
      case 'GATE': return m.eco_tower_room_gate();
      case 'SEAL': return m.eco_tower_room_seal();
      case 'WARP_A': return m.eco_tower_room_warp_a();
      case 'WARP_B': return m.eco_tower_room_warp_b();
      case 'MIMIC': return m.eco_tower_room_mimic();
      case 'MERCENARY': return m.eco_tower_room_mercenary();
      case 'MENTOR': return m.eco_tower_room_mentor();
      case 'TRAP': return m.eco_tower_room_trap();
      default: return m.eco_tower_room_empty();
    }
  }

  function tip(type: RoomType): string {
    switch (type) {
      case 'START': return m.eco_tower_room_start_tip();
      case 'WELL': return m.eco_tower_room_well_tip();
      case 'ENTRANCE': return m.eco_tower_room_entrance_tip();
      case 'AMBUSH': return m.eco_tower_room_ambush_tip();
      case 'COLLAPSE': return m.eco_tower_room_collapse_tip();
      case 'TOLL': return m.eco_tower_room_toll_tip();
      case 'FOUNTAIN': return m.eco_tower_room_fountain_tip();
      case 'WANDERER': return m.eco_tower_room_wanderer_tip();
      case 'PRISONER': return m.eco_tower_room_prisoner_tip();
      case 'ORACLE': return m.eco_tower_room_oracle_tip();
      case 'MONSTER': return m.eco_tower_room_monster_tip();
      case 'ELITE': return m.eco_tower_room_elite_tip();
      case 'BOSS': return m.eco_tower_room_boss_tip();
      case 'CHEST': return m.eco_tower_room_chest_tip();
      case 'CAMPFIRE': return m.eco_tower_room_campfire_tip();
      case 'MERCHANT': return m.eco_tower_room_merchant_tip();
      case 'SHRINE': return m.eco_tower_room_shrine_tip();
      case 'EVENT': return m.eco_tower_room_event_tip();
      case 'STAIRS': return m.eco_tower_room_stairs_tip();
      case 'EXIT': return m.eco_tower_room_exit_tip();
      case 'TRIAL': return m.eco_tower_room_trial_tip();
      case 'GATE': return m.eco_tower_room_gate_tip();
      case 'SEAL': return m.eco_tower_room_seal_tip();
      case 'WARP_A':
      case 'WARP_B': return m.eco_tower_room_warp_tip();
      case 'MIMIC': return m.eco_tower_room_mimic_tip();
      case 'MERCENARY': return m.eco_tower_room_mercenary_tip();
      case 'MENTOR': return m.eco_tower_room_mentor_tip();
      case 'TRAP': return m.eco_tower_room_trap_tip();
      default: return m.eco_tower_room_empty_tip();
    }
  }

  function roomTitle(room: Room): string {
    const parts = [`${label(room.type)}${room.foe ? ` : ${room.foe}` : ''}`, tip(room.type)];
    if (hasPower(room.type) && room.powerPercent !== 100) {
      parts.push(room.powerReward ? m.eco_tower_map_power_value_reward({ percent: room.powerPercent }) : m.eco_tower_map_power_value({ percent: room.powerPercent }));
    }
    const distance = distances.get(room.id);
    if (distance === undefined) parts.push(m.eco_tower_map_unreachable_tip());
    else if (!isEntry(room.type)) parts.push(m.eco_tower_map_distance_tip({ rooms: distance }));
    return parts.join('\n');
  }

  function offerLabel(offer: OfferKind): string {
    if (offer === 'POTION') return m.eco_tower_offer_potion();
    if (offer === 'HEAL') return m.eco_tower_offer_heal();
    return m.eco_tower_offer_gear();
  }

  function modifierLabel(modifier: Modifier): string {
    switch (modifier) {
      case 'FLOODED': return m.eco_tower_modifier_flooded();
      case 'BURNING': return m.eco_tower_modifier_burning();
      case 'BLESSED': return m.eco_tower_modifier_blessed();
      case 'MIST': return m.eco_tower_modifier_mist();
      case 'FROST': return m.eco_tower_modifier_frost();
      case 'MOONLESS': return m.eco_tower_modifier_moonless();
      default: return m.eco_tower_modifier_none();
    }
  }

  function themeLabel(theme: Theme): string {
    switch (theme) {
      case 'STONE': return m.eco_tower_theme_stone();
      case 'MOSS': return m.eco_tower_theme_moss();
      case 'CRYPT': return m.eco_tower_theme_crypt();
      case 'ICE': return m.eco_tower_theme_ice();
      case 'FORGE': return m.eco_tower_theme_forge();
      case 'ARCANE': return m.eco_tower_theme_arcane();
      case 'ABYSS': return m.eco_tower_theme_abyss();
      default: return m.eco_tower_theme_auto();
    }
  }

  function categoryLabel(category: Category): string {
    switch (category) {
      case 'ENTRY': return m.eco_tower_category_entry();
      case 'MONSTERS': return m.eco_tower_category_monsters();
      case 'EXITS': return m.eco_tower_category_exits();
      case 'NPC': return m.eco_tower_category_npc();
      default: return m.eco_tower_category_other();
    }
  }

  function categoryTip(category: Category): string {
    switch (category) {
      case 'ENTRY': return m.eco_tower_category_entry_tip();
      case 'MONSTERS': return m.eco_tower_category_monsters_tip();
      case 'EXITS': return m.eco_tower_category_exits_tip();
      case 'NPC': return m.eco_tower_category_npc_tip();
      default: return m.eco_tower_category_other_tip();
    }
  }

  function traitLabel(trait: Trait): string {
    switch (trait) {
      case 'ARMORED': return m.eco_tower_trait_armored();
      case 'VAMPIRIC': return m.eco_tower_trait_vampiric();
      case 'SWIFT': return m.eco_tower_trait_swift();
      case 'THORNY': return m.eco_tower_trait_thorny();
      case 'BERSERK': return m.eco_tower_trait_berserk();
      default: return m.eco_tower_trait_regenerating();
    }
  }

  function traitTip(trait: Trait): string {
    switch (trait) {
      case 'ARMORED': return m.eco_tower_trait_armored_tip();
      case 'VAMPIRIC': return m.eco_tower_trait_vampiric_tip();
      case 'SWIFT': return m.eco_tower_trait_swift_tip();
      case 'THORNY': return m.eco_tower_trait_thorny_tip();
      case 'BERSERK': return m.eco_tower_trait_berserk_tip();
      default: return m.eco_tower_trait_regenerating_tip();
    }
  }

  function mechanicLabel(mechanic: Mechanic): string {
    switch (mechanic) {
      case 'RANDOM': return m.eco_tower_choice_random();
      case 'NONE': return m.eco_tower_choice_none();
      case 'SHIELD': return m.eco_tower_mechanic_shield();
      case 'SUMMONER': return m.eco_tower_mechanic_summoner();
      default: return m.eco_tower_mechanic_phases();
    }
  }

  function mechanicTip(mechanic: Mechanic): string {
    switch (mechanic) {
      case 'RANDOM': return m.eco_tower_mechanic_random_tip();
      case 'NONE': return m.eco_tower_mechanic_none_tip();
      case 'SHIELD': return m.eco_tower_mechanic_shield_tip();
      case 'SUMMONER': return m.eco_tower_mechanic_summoner_tip();
      default: return m.eco_tower_mechanic_phases_tip();
    }
  }

  function eventLabel(event: EventChoice): string {
    switch (event) {
      case 'RANDOM': return m.eco_tower_choice_random();
      case 'BLOOD_ALTAR': return m.eco_tower_event_blood_altar();
      case 'GAMBLER': return m.eco_tower_event_gambler();
      case 'SPRING': return m.eco_tower_event_spring();
      case 'BLACKSMITH': return m.eco_tower_event_blacksmith();
      default: return m.eco_tower_event_cursed_pact();
    }
  }

  function eventTip(event: EventChoice): string {
    switch (event) {
      case 'RANDOM': return m.eco_tower_event_random_tip();
      case 'BLOOD_ALTAR': return m.eco_tower_event_blood_altar_tip();
      case 'GAMBLER': return m.eco_tower_event_gambler_tip();
      case 'SPRING': return m.eco_tower_event_spring_tip();
      case 'BLACKSMITH': return m.eco_tower_event_blacksmith_tip();
      default: return m.eco_tower_event_cursed_pact_tip();
    }
  }

  /** Poids d'une variante au tirage (mêmes bornes que `TOWER_VARIANT_WEIGHT` côté bot). */
  const WEIGHT = { min: 1, max: 100, default: 10 };

  function newRoom(x: number, y: number, type: RoomType): Room {
    return {
      id: `${x}-${y}`, x, y, type, foe: null, chest: 'BOTH', healPercent: 35, offers: [...OFFERS], pricePercent: 100,
      traits: [], powerPercent: 100, powerReward: false, waves: 3, trialReward: true, collapseSteps: 10, tollGold: 60, wanderRadius: 3, captive: 'RANDOM', mechanic: 'RANDOM', event: 'RANDOM', key: false,
    };
  }

  function exampleLayout(): Layout {
    const r = newRoom;
    return {
      name: '',
      fog: true,
      modifier: 'NONE',
      theme: 'AUTO',
      variant: false,
      weight: WEIGHT.default,
      width: 9,
      height: 9,
      rooms: [
        r(3, 8, 'START'), r(3, 7, 'MONSTER'), r(3, 6, 'MONSTER'), r(3, 5, 'CAMPFIRE'),
        r(2, 5, 'MONSTER'), r(1, 5, 'CHEST'), r(4, 5, 'ELITE'), r(5, 5, 'MERCHANT'),
        r(3, 4, 'EVENT'), r(2, 2, 'BOSS'), r(4, 4, 'MONSTER'), r(5, 4, 'SHRINE'),
        r(6, 4, 'MONSTER'), { ...r(7, 4, 'CHEST'), chest: 'GEAR' },
      ],
    };
  }

  function cloneLayout(source: Partial<Layout> | null): Layout {
    return {
      name: source?.name ?? '',
      // Un étage neuf a son brouillard ; un étage enregistré sans ce champ n'en avait pas.
      fog: source ? source.fog === true : true,
      modifier: source?.modifier ?? 'NONE',
      theme: source?.theme ?? 'AUTO',
      variant: source?.variant === true,
      weight: source?.weight ?? WEIGHT.default,
      width: source?.width ?? 7,
      height: source?.height ?? 7,
      rooms: (source?.rooms ?? []).map((room) => ({
        ...room,
        offers: [...room.offers],
        traits: [...(room.traits ?? [])],
        powerPercent: room.powerPercent ?? 100,
        powerReward: room.powerReward === true,
        waves: room.waves ?? 3,
        trialReward: room.trialReward !== false,
        collapseSteps: room.collapseSteps ?? 10,
        tollGold: room.tollGold ?? 60,
        wanderRadius: room.wanderRadius ?? 3,
        captive: room.captive ?? 'RANDOM',
        mechanic: room.mechanic ?? 'RANDOM',
        event: room.event ?? 'RANDOM',
        key: room.key === true,
      })),
    };
  }

  const actionState = createAsyncActionState();
  // L'éditeur est recréé à chaque chargement : il part des étages enregistrés à ce moment-là.
  const seeded = untrack(() => (initialFloors.length > 0 ? initialFloors.map((floor) => cloneLayout(floor)) : [cloneLayout(null)]));
  // `floors` garde une copie de chaque étage ; `layout` est l'étage ouvert, recopié à chaque changement d'étage.
  let floors = $state<Layout[]>(seeded);
  let current = $state(0);
  let layout = $state<Layout>(cloneLayout(seeded[0]));
  let tool = $state<Tool>('MONSTER');
  let category = $state<Category>('MONSTERS');
  let selectedId = $state<string | null>(null);
  let painting = $state(false);
  let dirty = $state(false);
  let preview = $state<string | null>(null);
  let previewing = $state(false);

  /** Puissances proposées pour un adversaire, en % de la force normale à sa profondeur. */
  const POWERS = [50, 75, 100, 125, 150, 200, 250, 300];

  /** Vagues possibles d'une épreuve (mêmes bornes que `TOWER_TRIAL_WAVES` côté bot). */
  const WAVES = [2, 3, 4, 5];

  /** Salles dont la puissance se règle : celles qui opposent un adversaire, épreuve comprise. */
  function hasPower(type: RoomType): boolean {
    return type === 'MONSTER' || type === 'ELITE' || type === 'BOSS' || type === 'TRIAL' || type === 'AMBUSH' || type === 'COLLAPSE' || type === 'WANDERER' || type === 'PRISONER';
  }

  // ── Pipette : peindre des salles avec les réglages d'une salle existante ──
  let template = $state<Room | null>(null);

  function copyRoom(room: Room, x: number, y: number): Room {
    return { ...room, id: `${x}-${y}`, x, y, offers: [...room.offers], traits: [...room.traits] };
  }

  function pickTool(next: Tool) {
    tool = next;
    template = null;
  }

  function pickTemplate(room: Room) {
    template = copyRoom(room, room.x, room.y);
    tool = room.type;
    category = CATEGORIES.find((entry) => entry.types.includes(room.type))?.id ?? category;
  }

  function templateSummary(room: Room): string {
    const parts = [label(room.type)];
    if (room.foe) parts.push(room.foe);
    if (hasPower(room.type) && room.powerPercent !== 100) parts.push(`×${room.powerPercent / 100}`);
    if (room.traits.length > 0) parts.push(room.traits.map(traitLabel).join(', '));
    return parts.join(' · ');
  }

  // ── Annuler / rétablir (étage ouvert) ───────────────────────────
  const HISTORY_MAX = 50;
  let past = $state<Layout[]>([]);
  let future = $state<Layout[]>([]);
  /** État d'avant un coup de pinceau : il n'entre dans l'historique que si le coup change la carte. */
  let stroke: Layout | null = null;
  /** Coup de pinceau au clic droit : il efface, quel que soit l'outil. */
  let erasing = $state(false);

  function capture(): Layout {
    return cloneLayout($state.snapshot(layout) as Layout);
  }

  function pushPast(entry: Layout) {
    past = [...past.slice(1 - HISTORY_MAX), entry];
    future = [];
  }

  /** À appeler juste avant de modifier l'étage ouvert. */
  function remember() {
    pushPast(capture());
  }

  function restore(entry: Layout) {
    layout = entry;
    if (selectedId && !layout.rooms.some((room) => room.id === selectedId)) selectedId = null;
    dirty = true;
  }

  function undo() {
    const entry = past.at(-1);
    if (!entry) return;
    future = [capture(), ...future];
    past = past.slice(0, -1);
    restore(entry);
  }

  function redo() {
    const [entry, ...rest] = future;
    if (!entry) return;
    past = [...past, capture()];
    future = rest;
    restore(entry);
  }

  function resetHistory() {
    past = [];
    future = [];
  }

  function removeSelected() {
    if (!selected || !canManage || disabled) return;
    remember();
    removeAt([[selected.x, selected.y]]);
    dirty = true;
  }

  function onKeydown(event: KeyboardEvent) {
    if (!canManage || disabled) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && key === 'y') {
      event.preventDefault();
      redo();
    } else if (event.key === 'Delete' && selected) {
      event.preventDefault();
      removeSelected();
    } else if (event.key === 'Escape') {
      selectedId = null;
      rect = null;
    }
  }

  // ── Géométrie (même règles que le bot) ──────────────────────────
  function cellsOf(room: Pick<Room, 'x' | 'y' | 'type'>): [number, number][] {
    if (room.type !== 'BOSS') return [[room.x, room.y]];
    return [[room.x, room.y], [room.x + 1, room.y], [room.x, room.y + 1], [room.x + 1, room.y + 1]];
  }

  const occupied = $derived.by(() => {
    const map = new Map<string, Room>();
    for (const room of layout.rooms) for (const [x, y] of cellsOf(room)) map.set(`${x},${y}`, room);
    return map;
  });

  /** Salles reliées à une salle : ses voisines de côté, et le portail jumeau pour un portail. */
  function linkedRooms(floor: Layout, room: Room, cells: Map<string, Room>): Room[] {
    const found = new Map<string, Room>();
    for (const [x, y] of cellsOf(room)) {
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const other = cells.get(`${x + dx},${y + dy}`);
        if (other && other.id !== room.id) found.set(other.id, other);
      }
    }
    if (isWarp(room.type)) {
      const twin = floor.rooms.find((candidate) => candidate.type === (room.type === 'WARP_A' ? 'WARP_B' : 'WARP_A'));
      if (twin) found.set(twin.id, twin);
    }
    return [...found.values()];
  }

  function neighbors(room: Room): Room[] {
    return linkedRooms(layout, room, occupied);
  }

  const distances = $derived.by(() => {
    const result = new Map<string, number>();
    // Toutes les entrées partent ensemble : un étage à puits se mesure depuis le plus proche.
    const queue = layout.rooms.filter((room) => isEntry(room.type));
    for (const room of queue) result.set(room.id, 0);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of neighbors(current)) {
        if (result.has(next.id)) continue;
        result.set(next.id, result.get(current.id)! + 1);
        queue.push(next);
      }
    }
    return result;
  });

  const links = $derived.by(() => {
    const seen = new Set<string>();
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const room of layout.rooms) {
      for (const other of neighbors(room)) {
        if (isWarp(room.type) && isWarp(other.type)) continue;
        const key = [room.id, other.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const a = center(room);
        const b = center(other);
        lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
    return lines;
  });

  // Le lien des portails, dessiné en pointillés par-dessus la grille.
  const warpLink = $derived.by(() => {
    const a = layout.rooms.find((room) => room.type === 'WARP_A');
    const b = layout.rooms.find((room) => room.type === 'WARP_B');
    if (!a || !b) return null;
    const from = center(a);
    const to = center(b);
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  });

  function center(room: Room): { x: number; y: number } {
    const span = room.type === 'BOSS' ? 2 : 1;
    return { x: (room.x + span / 2) * CELL, y: (room.y + span / 2) * CELL };
  }

  const counts = $derived(Object.fromEntries(ROOM_TYPES.map((type) => [type, layout.rooms.filter((room) => room.type === type).length])) as Record<RoomType, number>);
  const unreachable = $derived(layout.rooms.filter((room) => !distances.has(room.id)).length);
  const bossDepth = $derived.by(() => {
    const depths = layout.rooms.filter((room) => isExit(room.type) && distances.has(room.id)).map((room) => distances.get(room.id)!);
    return depths.length > 0 ? Math.min(...depths) : null;
  });

  /** Règles de la sortie, mêmes que le serveur : une seule, et ce qui l'ouvre avec elle. */
  function exitProblems(floor: Layout): string[] {
    const list: string[] = [];
    const exits = floor.rooms.filter((room) => isExit(room.type));
    const keys = floor.rooms.filter((room) => room.key).length;
    const seals = floor.rooms.filter((room) => room.type === 'SEAL').length;
    if (exits.length === 0) list.push(m.eco_tower_map_need_exit());
    if (exits.length > 1) list.push(m.eco_tower_map_one_exit());
    const exit = exits.length === 1 ? exits[0].type : null;
    if (exit === 'STAIRS' && keys === 0) list.push(m.eco_tower_map_stairs_need_key());
    if (exit !== 'STAIRS' && keys > 0) list.push(m.eco_tower_map_keys_without_stairs());
    if (exit === 'GATE' && seals === 0) list.push(m.eco_tower_map_gate_need_seal());
    if (exit !== 'GATE' && seals > 0) list.push(m.eco_tower_map_seals_without_gate());
    const warpsA = floor.rooms.filter((room) => room.type === 'WARP_A').length;
    const warpsB = floor.rooms.filter((room) => room.type === 'WARP_B').length;
    if (warpsA !== warpsB) list.push(m.eco_tower_map_warp_pair());
    return list;
  }

  /** Règles de l'entrée, mêmes que le serveur : une seule sorte, en nombre permis. */
  function entryProblems(floor: Layout): string[] {
    const count = (type: RoomType) => floor.rooms.filter((room) => room.type === type).length;
    const starts = count('START');
    const wells = count('WELL');
    const entrances = count('ENTRANCE');
    const kinds = [starts, wells, entrances].filter((value) => value > 0).length;
    if (kinds === 0) return [m.eco_tower_map_need_start()];
    if (kinds > 1) return [m.eco_tower_map_entry_mixed()];
    if (starts > 1) return [m.eco_tower_map_need_start()];
    if (wells > 0 && (wells < WELLS.min || wells > WELLS.max)) return [m.eco_tower_map_wells_count({ min: WELLS.min, max: WELLS.max })];
    if (entrances > 0 && (entrances < ENTRANCES.min || entrances > ENTRANCES.max)) return [m.eco_tower_map_entrances_count({ min: ENTRANCES.min, max: ENTRANCES.max })];
    return [];
  }

  const problems = $derived.by(() => {
    const list: string[] = [];
    const entry = entryProblems(layout);
    list.push(...entry);
    list.push(...exitProblems(layout));
    if (entry.length === 0 && unreachable > 0) list.push(m.eco_tower_map_unreachable({ count: unreachable }));
    if (layout.rooms.some((room) => room.type === 'MERCHANT' && room.offers.length === 0)) list.push(m.eco_tower_map_empty_merchant());
    if (layout.rooms.length > roomsMax) list.push(m.eco_tower_map_too_many({ max: roomsMax }));
    return list;
  });

  // ── Étages ──────────────────────────────────────────────────────
  /** Mêmes règles que le serveur : un départ, un gardien, tout relié, aucun marchand vide. */
  function floorValid(floor: Layout): boolean {
    if (floor.rooms.length === 0 || floor.rooms.length > roomsMax) return false;
    const starts = floor.rooms.filter((room) => isEntry(room.type));
    if (entryProblems(floor).length > 0 || exitProblems(floor).length > 0) return false;
    if (floor.rooms.some((room) => room.type === 'MERCHANT' && room.offers.length === 0)) return false;
    const cells = new Map<string, Room>();
    for (const room of floor.rooms) for (const [x, y] of cellsOf(room)) cells.set(`${x},${y}`, room);
    const reached = new Set([starts[0].id]);
    const queue = [starts[0]];
    while (queue.length > 0) {
      const room = queue.shift()!;
      for (const other of linkedRooms(floor, room, cells)) {
        if (!reached.has(other.id)) {
          reached.add(other.id);
          queue.push(other);
        }
      }
    }
    return reached.size === floor.rooms.length;
  }

  // L'étage ouvert se lit dans `layout`, les autres dans leur copie.
  const allFloors = $derived(floors.map((floor, index) => (index === current ? layout : floor)));
  const towerEmpty = $derived(allFloors.length === 1 && allFloors[0].rooms.length === 0);
  // Validité de chaque carte, calculée une fois : la colonne en affiche des centaines.
  const validity = $derived(allFloors.map((floor) => towerEmpty || floorValid(floor)));
  const invalidFloors = $derived(validity.filter((valid) => !valid).length);
  // Du sommet au rez-de-chaussée, comme on lit une tour.
  const stack = $derived(allFloors.map((floor, index) => ({ floor, index })).reverse());

  /**
   * Numéro d'étage de chaque carte, sa lettre de variante (« A », « B »…) quand l'étage en a
   * plusieurs, et sa chance d'être tirée.
   */
  const floorTags = $derived.by(() => {
    const tags: { floor: number; variant: string }[] = [];
    let floor = 0;
    let rank = 0;
    for (const [index, entry] of allFloors.entries()) {
      if (index === 0 || !entry.variant) {
        floor += 1;
        rank = 0;
      } else {
        rank += 1;
      }
      tags.push({ floor, variant: String.fromCharCode(65 + rank) });
    }
    const sizes = new Map<number, number>();
    const weights = new Map<number, number>();
    for (const [index, tag] of tags.entries()) {
      sizes.set(tag.floor, (sizes.get(tag.floor) ?? 0) + 1);
      weights.set(tag.floor, (weights.get(tag.floor) ?? 0) + allFloors[index].weight);
    }
    return tags.map((tag, index) => ({
      floor: tag.floor,
      variant: (sizes.get(tag.floor) ?? 1) > 1 ? tag.variant : '',
      chance: Math.round((allFloors[index].weight / (weights.get(tag.floor) ?? 1)) * 100),
    }));
  });
  const floorCount = $derived(floorTags.length > 0 ? floorTags[floorTags.length - 1].floor : 0);

  // Au-delà, la colonne passe en lignes compactes, sans vignette : des centaines de cartes restent lisibles.
  const COMPACT_FROM = 30;
  const compact = $derived(floors.length > COMPACT_FROM);
  let stackList = $state<HTMLDivElement | null>(null);
  let jumpTo = $state<number | null>(null);

  // La carte ouverte reste visible dans la colonne, même au bout d'une longue tour.
  // Seule la colonne défile : `scrollIntoView` ferait aussi bouger la page à l'ouverture.
  $effect(() => {
    const list = stackList;
    const row = list?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
  });

  /** Ouvre la première carte de l'étage `floor` (variante A s'il en a plusieurs). */
  function jumpToFloor() {
    const target = Number(jumpTo);
    if (!Number.isInteger(target) || target < 1) return;
    const index = floorTags.findIndex((tag) => tag.floor === target);
    selectFloor(index >= 0 ? index : floors.length - 1);
  }

  /** Ouvre la prochaine carte à corriger après celle ouverte, en reprenant au début. */
  function nextInvalid() {
    const order = [...validity.keys()].map((offset) => (current + 1 + offset) % validity.length);
    const index = order.find((candidate) => !validity[candidate]);
    if (index !== undefined) selectFloor(index);
  }

  function floorTitle(index: number): string {
    const tag = floorTags[index];
    if (!tag) return m.eco_tower_floor_label({ floor: index + 1 });
    return tag.variant ? m.eco_tower_floor_variant_label({ floor: tag.floor, variant: tag.variant }) : m.eco_tower_floor_label({ floor: tag.floor });
  }

  /** Distance au gardien et salles à résoudre d'un étage, pour estimer la profondeur. */
  function floorSpan(floor: Layout): { shortest: number; rooms: number } {
    const cells = new Map<string, Room>();
    for (const room of floor.rooms) for (const [x, y] of cellsOf(room)) cells.set(`${x},${y}`, room);
    const entries = floor.rooms.filter((room) => isEntry(room.type));
    const rooms = floor.rooms.filter((room) => !isEntry(room.type) && room.type !== 'EMPTY').length;
    if (entries.length === 0) return { shortest: 0, rooms };
    const distance = new Map(entries.map((room) => [room.id, 0]));
    const queue = [...entries];
    while (queue.length > 0) {
      const room = queue.shift()!;
      for (const other of linkedRooms(floor, room, cells)) {
        if (!distance.has(other.id)) {
          distance.set(other.id, distance.get(room.id)! + 1);
          queue.push(other);
        }
      }
    }
    const boss = floor.rooms.filter((room) => isExit(room.type)).map((room) => distance.get(room.id)).filter((value): value is number => value !== undefined);
    return { shortest: boss.length > 0 ? Math.min(...boss) : 0, rooms };
  }

  function monsterHealth(level: number): number {
    const rate = growthPercent / 100;
    const steps = Math.max(0, level - 1);
    const steep = Math.min(steps, GROWTH_KNEE - 1);
    return Math.round(MONSTER_BASE_HEALTH * Math.pow(1 + rate, steep) * Math.pow(1 + rate / 2, steps - steep));
  }

  /**
   * Difficulté estimée de l'étage ouvert : la force des monstres suit les salles résolues
   * depuis l'entrée. Au plus bas, le joueur a filé droit au gardien de chaque étage ; au plus
   * haut, il a tout exploré.
   */
  const difficulty = $derived.by(() => {
    // Les étages d'en dessous, variantes comprises : au plus bas la plus courte, au plus haut la plus longue.
    let low = 1;
    let high = 1;
    const below = new Map<number, { shortest: number; rooms: number }>();
    const own = floorTags[current]?.floor ?? current + 1;
    for (const [index, floor] of allFloors.entries()) {
      const tag = floorTags[index]?.floor ?? index + 1;
      if (tag >= own) continue;
      const span = floorSpan(floor);
      const seen = below.get(tag);
      below.set(tag, seen ? { shortest: Math.min(seen.shortest, span.shortest), rooms: Math.max(seen.rooms, span.rooms) } : span);
    }
    for (const span of below.values()) {
      low += span.shortest;
      high += span.rooms;
    }
    const mine = floorSpan(layout);
    return { from: low, to: high + mine.rooms, healthFrom: monsterHealth(low), healthTo: monsterHealth(high + mine.rooms) };
  });

  // ── Miroir et rotation ──────────────────────────────────────────
  /** Retourne ou tourne l'étage ouvert d'un quart de tour ; le gardien (2×2) garde son ancre en haut à gauche. */
  function transform(kind: 'FLIP_X' | 'FLIP_Y' | 'ROTATE') {
    if (!canManage || disabled || layout.rooms.length === 0) return;
    remember();
    const w = layout.width;
    const h = layout.height;
    const rooms = layout.rooms.map((room) => {
      const extra = room.type === 'BOSS' ? 1 : 0;
      const [x, y] = kind === 'FLIP_X' ? [w - 1 - room.x - extra, room.y]
        : kind === 'FLIP_Y' ? [room.x, h - 1 - room.y - extra]
        : [h - 1 - room.y - extra, room.x];
      return { ...room, id: `${x}-${y}`, x, y };
    });
    layout = {
      name: layout.name,
      fog: layout.fog,
      modifier: layout.modifier,
      theme: layout.theme,
      variant: layout.variant,
      weight: layout.weight,
      width: kind === 'ROTATE' ? h : w,
      height: kind === 'ROTATE' ? w : h,
      rooms,
    };
    selectedId = null;
    dirty = true;
  }

  // ── Export / import d'un étage ──────────────────────────────────
  let importError = $state(false);

  function exportFloor() {
    const blob = new Blob([JSON.stringify($state.snapshot(layout), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tour-etage-${current + 1}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Étage lu dans un fichier exporté ; lève une erreur s'il n'en a pas la forme. */
  function parseFloor(raw: any): Layout {
    const inRange = (value: unknown) => Number.isInteger(value) && (value as number) >= sizeLimits.min && (value as number) <= sizeLimits.max;
    if (!raw || !Array.isArray(raw.rooms) || raw.rooms.length > roomsMax || !inRange(raw.width) || !inRange(raw.height)) throw new Error('invalid');
    // Salles hors de la grille ou sur une case déjà prise : ignorées, la première posée l'emporte.
    const taken = new Set<string>();
    const rooms: Room[] = [];
    for (const entry of raw.rooms as Partial<Room>[]) {
      if (!ROOM_TYPES.includes(entry.type as RoomType) || !Number.isInteger(entry.x) || !Number.isInteger(entry.y)) continue;
      const room: Room = { ...newRoom(entry.x!, entry.y!, entry.type!), ...entry, id: `${entry.x}-${entry.y}` };
      const cells = cellsOf(room);
      if (cells.some(([x, y]) => x < 0 || y < 0 || x >= raw.width || y >= raw.height || taken.has(`${x},${y}`))) continue;
      cells.forEach(([x, y]) => taken.add(`${x},${y}`));
      rooms.push(room);
    }
    return cloneLayout({
      name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : '',
      fog: raw.fog === true,
      modifier: MODIFIERS.includes(raw.modifier) ? raw.modifier : 'NONE',
      theme: THEMES.includes(raw.theme) ? raw.theme : 'AUTO',
      variant: raw.variant === true,
      weight: Number.isInteger(raw.weight) ? Math.min(WEIGHT.max, Math.max(WEIGHT.min, raw.weight)) : WEIGHT.default,
      width: raw.width,
      height: raw.height,
      rooms,
    });
  }

  /** Remplace l'étage ouvert par un fichier exporté ; le bot revalide tout à l'enregistrement. */
  async function importFloor(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !canManage || disabled) return;
    importError = false;
    try {
      const raw = JSON.parse(await file.text());
      const parsed = parseFloor(raw);
      remember();
      layout = { ...parsed, name: typeof raw.name === 'string' ? parsed.name : layout.name, variant: layout.variant, weight: layout.weight };
      selectedId = null;
      dirty = true;
    } catch {
      importError = true;
    }
  }

  // ── Export / import de toute la tour ────────────────────────────
  /** Carte fautive d'un import de tour (numéro à partir de 1), 0 quand c'est le fichier lui-même. */
  let towerImportError = $state<number | null>(null);

  function exportTower() {
    commit();
    // Sans indentation : une longue tour pèse vite plusieurs mégaoctets.
    const blob = new Blob([JSON.stringify({ floors: $state.snapshot(floors) })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tour.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Remplace toutes les cartes par un fichier `{ floors: [...] }` (ou la liste seule). Rien n'est
   * enregistré avant le bouton d'enregistrement, et le bot revalide chaque carte.
   */
  async function importTower(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !canManage || disabled) return;
    towerImportError = null;
    let list: unknown;
    try {
      const raw = JSON.parse(await file.text());
      list = Array.isArray(raw) ? raw : raw?.floors;
    } catch {
      towerImportError = 0;
      return;
    }
    if (!Array.isArray(list) || list.length === 0 || list.length > floorsMax) {
      towerImportError = 0;
      return;
    }
    const parsed: Layout[] = [];
    for (const [index, entry] of list.entries()) {
      try {
        parsed.push(parseFloor(entry));
      } catch {
        towerImportError = index + 1;
        return;
      }
    }
    const confirmed = await confirmDialog.danger(
      m.eco_tower_import_all_confirm({ cards: parsed.length }),
      m.eco_tower_import_all_confirm_desc({ current: floors.length }),
      m.eco_tower_import_all_confirm_button(),
    );
    if (!confirmed) return;
    floors = parsed;
    current = 0;
    layout = cloneLayout(floors[0]);
    anchorFirst();
    selectedId = null;
    resetHistory();
    dirty = true;
  }

  // ── Remplissage par zone (Maj+glisser) ──────────────────────────
  let rect = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rectBox = $derived(rect ? {
    x: Math.min(rect.x0, rect.x1), y: Math.min(rect.y0, rect.y1),
    w: Math.abs(rect.x1 - rect.x0) + 1, h: Math.abs(rect.y1 - rect.y0) + 1,
  } : null);

  const rectColor = $derived(erasing || tool === 'ERASE' || tool === 'SELECT' ? '#ef4444' : COLOR[tool]);

  /** Outils qui se posent en zone : pas le départ, les sorties, les portails ni le gardien. */
  function fillable(brush: Tool): boolean {
    return brush === 'ERASE' || (brush !== 'SELECT' && !isEntry(brush) && !isExit(brush) && !isWarp(brush));
  }

  function fillRect() {
    const box = rectBox;
    rect = null;
    if (!box) return;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) apply(x, y);
    }
  }

  // ── Carte des morts ─────────────────────────────────────────────
  /** Même empreinte que `towerLayoutKey` côté bot : taille et salles (position et type). */
  function layoutKey(floor: Pick<Layout, 'width' | 'height' | 'rooms'>): string {
    const text = `${floor.width}x${floor.height}|${floor.rooms.map((room) => `${room.x},${room.y}:${room.type}`).sort().join(';')}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  // ── Monstre errant : sa zone de patrouille (miroir de `wanderZone` et `canWanderInto`) ──
  const WALKABLE: RoomType[] = ['EMPTY', 'WANDERER', 'MONSTER', 'ELITE', 'AMBUSH', 'TRAP'];
  const wanderCells = $derived.by(() => {
    const cells = new Set<string>();
    if (!selected || selected.type !== 'WANDERER') return cells;
    const distance = new Map<string, number>([[selected.id, 0]]);
    const queue: Room[] = [selected];
    while (queue.length > 0) {
      const room = queue.shift()!;
      if (WALKABLE.includes(room.type)) cells.add(room.id);
      if (distance.get(room.id)! >= selected.wanderRadius) continue;
      for (const [x, y] of cellsOf(room)) {
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const other = occupied.get(`${x + dx},${y + dy}`);
          if (!other || distance.has(other.id)) continue;
          distance.set(other.id, distance.get(room.id)! + 1);
          queue.push(other);
        }
      }
    }
    return cells;
  });

  const CAPTIVES: Captive[] = ['RANDOM', 'GOLD', 'POTION', 'ALLY'];
  function captiveLabel(captive: Captive): string {
    switch (captive) {
      case 'GOLD': return m.eco_tower_captive_gold();
      case 'POTION': return m.eco_tower_captive_potion();
      case 'ALLY': return m.eco_tower_captive_ally();
      default: return m.eco_tower_captive_random();
    }
  }

  let showDeaths = $state(false);
  // Numéro de chaque entrée au choix, dans l'ordre où le bot les propose.
  const entranceNumber = $derived(new Map(layout.rooms.filter((room) => room.type === 'ENTRANCE').map((room, index) => [room.id, index + 1])));
  // Morts de l'étage ouvert tel qu'il est : une salle déplacée ou retypée repart de zéro.
  const floorDeaths = $derived(deathMap[layoutKey(layout)] ?? {});
  const deathsTotal = $derived(Object.values(floorDeaths).reduce((sum, count) => sum + count, 0));
  const deathsMax = $derived(Math.max(1, ...Object.values(floorDeaths)));

  /** Salles dont la puissance est réglée, et ce que ça donne sur la plus forte d'entre elles. */
  const powered = $derived.by(() => {
    const rooms = layout.rooms.filter((room) => hasPower(room.type) && room.powerPercent !== 100);
    if (rooms.length === 0) return null;
    const max = Math.max(...rooms.map((room) => room.powerPercent));
    const min = Math.min(...rooms.map((room) => room.powerPercent));
    const top = max > 100 ? max : min;
    return {
      count: rooms.length,
      factor: `×${top / 100}`,
      hpFrom: Math.round(difficulty.healthFrom * top / 100),
      hpTo: Math.round(difficulty.healthTo * top / 100),
    };
  });

  async function openPreview() {
    previewing = true;
    try {
      const res = await previewRpgTowerFloor({ layout, floor: floorTags[current]?.floor ?? current + 1 });
      preview = res?.image ?? null;
    } catch (err) {
      console.error(err);
    } finally {
      previewing = false;
    }
  }

  function toggleTrait(trait: Trait) {
    if (!selected) return;
    const has = selected.traits.includes(trait);
    if (!has && selected.traits.length >= TRAITS_MAX) return;
    updateSelected({ traits: has ? selected.traits.filter((entry) => entry !== trait) : [...selected.traits, trait] });
  }

  function commit() {
    floors[current] = cloneLayout(layout);
  }

  /** La première carte ouvre la tour : elle ne peut pas être la variante d'une autre. */
  function anchorFirst() {
    if (floors[0]?.variant) floors[0] = { ...floors[0], variant: false };
    if (current === 0) layout.variant = false;
  }

  function selectFloor(index: number) {
    if (index === current) return;
    commit();
    current = index;
    layout = cloneLayout(floors[index]);
    selectedId = null;
    resetHistory();
  }

  function addFloor() {
    if (floors.length >= floorsMax) return;
    commit();
    floors = [...floors, cloneLayout({ width: layout.width, height: layout.height, fog: true })];
    current = floors.length - 1;
    layout = cloneLayout(floors[current]);
    selectedId = null;
    resetHistory();
    dirty = true;
  }

  function duplicateFloor() {
    if (floors.length >= floorsMax) return;
    commit();
    const copy = cloneLayout(floors[current]);
    floors = [...floors.slice(0, current + 1), copy, ...floors.slice(current + 1)];
    current += 1;
    layout = cloneLayout(copy);
    selectedId = null;
    resetHistory();
    dirty = true;
  }

  function moveFloor(delta: number) {
    const target = current + delta;
    if (target < 0 || target >= floors.length) return;
    commit();
    const next = [...floors];
    [next[current], next[target]] = [next[target], next[current]];
    floors = next;
    current = target;
    anchorFirst();
    dirty = true;
  }

  async function removeFloor() {
    if (floors.length <= 1) {
      clearMap();
      return;
    }
    const confirmed = await confirmDialog.danger(
      m.eco_tower_floor_delete_confirm({ floor: floorTitle(current) }),
      m.eco_tower_floor_delete_confirm_desc(),
    );
    if (!confirmed) return;
    floors = floors.filter((_, index) => index !== current);
    current = Math.min(current, floors.length - 1);
    layout = cloneLayout(floors[current]);
    anchorFirst();
    selectedId = null;
    resetHistory();
    dirty = true;
  }

  const selected = $derived(layout.rooms.find((room) => room.id === selectedId) ?? null);

  const frameW = $derived(layout.width * CELL + FRAME * 2);
  const frameH = $derived(layout.height * CELL + FRAME * 2);
  // En nombre impair, pour qu'un créneau tombe sur chaque angle.
  const merlons = $derived(Math.max(5, Math.round(frameW / 44) | 1));
  const foeOptions = $derived.by(() => {
    if (!selected) return [];
    // Le gardien d'un escalier effondré est un gardien comme un autre : il se choisit parmi les boss.
    const wantBoss = selected.type === 'BOSS' || selected.type === 'COLLAPSE';
    // Errant et geôlier sont des monstres ordinaires, renforcés par la Tour.
    return foes
      .filter((foe) => foe.isBoss === wantBoss)
      .map((foe) => ({ id: foe.name, name: `${foe.emoji} ${foe.name}${foe.enabled ? '' : ` · ${m.eco_tower_map_foe_disabled()}`}` }));
  });

  // ── Édition ─────────────────────────────────────────────────────
  function removeAt(cells: [number, number][]) {
    const doomed = new Set<string>();
    for (const [x, y] of cells) {
      const room = occupied.get(`${x},${y}`);
      if (room) doomed.add(room.id);
    }
    if (doomed.size === 0) return;
    layout.rooms = layout.rooms.filter((room) => !doomed.has(room.id));
    if (selectedId && doomed.has(selectedId)) selectedId = null;
  }

  /** Première modification d'un coup de pinceau : l'état d'avant entre dans l'historique. */
  function changed() {
    if (stroke) {
      pushPast(stroke);
      stroke = null;
    }
    dirty = true;
  }

  function apply(x: number, y: number) {
    if (!canManage || disabled) return;
    const existing = occupied.get(`${x},${y}`);
    const brush: Tool = erasing ? 'ERASE' : tool;

    if (brush === 'SELECT') {
      selectedId = existing?.id ?? null;
      return;
    }
    if (brush === 'ERASE') {
      if (existing) {
        removeAt([[x, y]]);
        changed();
      }
      return;
    }
    const sameAnchor = Boolean(existing && existing.type === brush && existing.x === x && existing.y === y);
    // Avec la pipette, repeindre une salle du même type lui applique les réglages copiés.
    const copied = template && template.type === brush ? template : null;
    if (sameAnchor && !copied) {
      selectedId = existing!.id;
      return;
    }
    if (brush === 'BOSS' && (x + 1 >= layout.width || y + 1 >= layout.height)) return;
    if (layout.rooms.length >= roomsMax && !existing) return;

    // La clé n'est pas un réglage : elle ne se copie pas, et une salle repeinte garde la sienne.
    const room = copied ? { ...copyRoom(copied, x, y), key: sameAnchor && existing!.key } : newRoom(x, y, brush);
    removeAt(cellsOf(room));
    // Une seule sortie par étage : en poser une nouvelle remplace l'ancienne. Une seule sorte
    // d'entrée : en poser une d'une autre sorte retire les autres, et le départ reste unique.
    if (isEntry(brush)) layout.rooms = layout.rooms.filter((candidate) => !isEntry(candidate.type) || (candidate.type === brush && brush !== 'START'));
    if (isExit(brush)) layout.rooms = layout.rooms.filter((candidate) => !isExit(candidate.type));
    // Une seule paire de portails : poser un portail A (ou B) déplace l'ancien.
    if (isWarp(brush)) layout.rooms = layout.rooms.filter((candidate) => candidate.type !== brush);
    layout.rooms = [...layout.rooms, room];
    selectedId = room.id;
    changed();
  }

  function pointerDown(event: PointerEvent, x: number, y: number) {
    if (event.button !== 0 && event.button !== 2) return;
    // Alt+clic : pipette sur la salle visée.
    if (event.button === 0 && event.altKey) {
      const existing = occupied.get(`${x},${y}`);
      if (existing && canManage && !disabled) pickTemplate(existing);
      return;
    }
    // Au toucher, le navigateur capture le pointeur sur la première case : sans ce relâchement,
    // glisser le doigt ne peindrait jamais les cases suivantes.
    const target = event.target as Element | null;
    if (target?.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
    erasing = event.button === 2;
    stroke = capture();
    if (event.shiftKey && fillable(erasing ? 'ERASE' : tool)) {
      rect = { x0: x, y0: y, x1: x, y1: y };
      painting = false;
      return;
    }
    // Entrées, sortie et portails se posent un par un : glisser ne les répète pas.
    painting = erasing || (tool !== 'SELECT' && (tool === 'ERASE' || (!isEntry(tool) && !isExit(tool) && !isWarp(tool))));
    apply(x, y);
  }

  function pointerEnter(x: number, y: number) {
    if (rect) rect = { ...rect, x1: x, y1: y };
    else if (painting) apply(x, y);
  }

  function resize(width: number, height: number) {
    remember();
    const w = Math.min(sizeLimits.max, Math.max(sizeLimits.min, Math.trunc(width) || sizeLimits.min));
    const h = Math.min(sizeLimits.max, Math.max(sizeLimits.min, Math.trunc(height) || sizeLimits.min));
    layout = {
      name: layout.name,
      fog: layout.fog,
      modifier: layout.modifier,
      theme: layout.theme,
      variant: layout.variant,
      weight: layout.weight,
      width: w,
      height: h,
      rooms: layout.rooms.filter((room) => cellsOf(room).every(([x, y]) => x < w && y < h)),
    };
    if (selectedId && !layout.rooms.some((room) => room.id === selectedId)) selectedId = null;
    dirty = true;
  }

  function updateSelected(patch: Partial<Room>) {
    if (!selected) return;
    remember();
    const id = selected.id;
    layout.rooms = layout.rooms.map((room) => (room.id === id ? { ...room, ...patch } : room));
    dirty = true;
  }

  function toggleOffer(offer: OfferKind) {
    if (!selected) return;
    const offers = selected.offers.includes(offer)
      ? selected.offers.filter((entry) => entry !== offer)
      : OFFERS.filter((entry) => entry === offer || selected!.offers.includes(entry));
    updateSelected({ offers });
  }

  function loadExample() {
    remember();
    layout = { ...exampleLayout(), name: layout.name, fog: layout.fog, modifier: layout.modifier, theme: layout.theme, variant: layout.variant, weight: layout.weight };
    selectedId = null;
    dirty = true;
  }

  function clearMap() {
    remember();
    layout = { name: layout.name, fog: layout.fog, modifier: layout.modifier, theme: layout.theme, variant: layout.variant, weight: layout.weight, width: layout.width, height: layout.height, rooms: [] };
    selectedId = null;
    dirty = true;
  }

  async function save() {
    commit();
    await actionState.run(async () => {
      // Aucun étage dessiné : la Tour génère les siens.
      await saveFloors(towerEmpty ? [] : floors);
      dirty = false;
      await onSaved?.();
      return true;
    });
  }
</script>

{#snippet powerSettings(room: Room)}
  <div class="space-y-1">
    <span class="text-xs font-semibold text-on-surface-variant/60" title={m.eco_tower_map_power_tip()}>{m.eco_tower_map_power()} · <span class="font-mono">×{room.powerPercent / 100}</span></span>
    <div class="flex flex-wrap gap-1.5">
      {#each POWERS as power}
        <button type="button" disabled={!canManage || disabled} onclick={() => updateSelected({ powerPercent: power })}
          class="px-2 py-1 rounded-lg text-2xs font-bold border font-mono {room.powerPercent === power ? (power > 100 ? 'border-error bg-error/15 text-error' : power < 100 ? 'border-success bg-success/15 text-success' : 'border-primary bg-primary/15') : 'border-outline-variant/15'}">×{power / 100}</button>
      {/each}
    </div>
    <p class="text-2xs text-on-surface-variant/50">{m.eco_tower_map_power_hint()}</p>
    {#if room.powerPercent !== 100}
      <label class="flex items-start gap-2 text-xs pt-1" title={m.eco_tower_map_power_reward_tip()}>
        <input type="checkbox" class="mt-0.5" checked={room.powerReward} disabled={!canManage || disabled}
          onchange={(e) => updateSelected({ powerReward: (e.currentTarget as HTMLInputElement).checked })} />
        {m.eco_tower_map_power_reward({ factor: `×${room.powerPercent / 100}` })}
      </label>
    {/if}
  </div>
{/snippet}

<svelte:window onpointerup={() => { if (rect) fillRect(); painting = false; erasing = false; stroke = null; }} onkeydown={onKeydown} />

<div class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
  <InlineFeedback state={actionState} />

  <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-outline-variant/15 pb-4">
    <div>
      <h3 class="text-lg font-semibold">{m.eco_tower_map_title()}</h3>
      <p class="text-xs text-on-surface-variant/60 mt-1 leading-relaxed max-w-2xl">{m.eco_tower_map_desc()}</p>
    </div>
  </div>

  <!-- Ce que les joueurs vont réellement parcourir, dit en clair. -->
  <p class="text-xs flex items-start gap-2 bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
    <Papicon icon="Info" size={13} />
    {towerEmpty
      ? m.eco_tower_map_status_generated()
      : floorsAfter === 'GENERATE'
        ? m.eco_tower_map_status_then_generated({ floors: floorCount })
        : m.eco_tower_map_status_then_loop({ floors: floorCount })}
  </p>

  {#if canManage}
    <div class="flex flex-wrap items-end gap-3">
      <div class="space-y-1">
        <label for="floorName" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_tower_floor_name()} · {floorTitle(current)}</label>
        <input id="floorName" type="text" maxlength="40" bind:value={layout.name} disabled={disabled} oninput={() => { dirty = true; }}
          placeholder={m.eco_tower_floor_name_placeholder()}
          class="w-56 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
      </div>
      <div class="space-y-1">
        <label for="mapWidth" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_tower_map_width()}</label>
        <input id="mapWidth" type="number" min={sizeLimits.min} max={sizeLimits.max} value={layout.width} disabled={disabled}
          onchange={(e) => resize(Number((e.currentTarget as HTMLInputElement).value), layout.height)}
          class="w-20 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
      </div>
      <div class="space-y-1">
        <label for="mapHeight" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_tower_map_height()}</label>
        <input id="mapHeight" type="number" min={sizeLimits.min} max={sizeLimits.max} value={layout.height} disabled={disabled}
          onchange={(e) => resize(layout.width, Number((e.currentTarget as HTMLInputElement).value))}
          class="w-20 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
      </div>
      <button type="button" onclick={loadExample} disabled={disabled} class="px-3 py-2 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50">
        <Papicon icon="Sparkles" size={12} /> {m.eco_tower_map_example()}
      </button>
      <button type="button" onclick={clearMap} disabled={disabled} class="px-3 py-2 bg-error/10 hover:bg-error/20 text-error text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50">
        <Papicon icon="trash" size={12} /> {m.eco_tower_map_clear()}
      </button>
      <div class="flex items-center gap-1 px-1 py-1 rounded-lg bg-outline-variant/10">
        <button type="button" onclick={() => transform('FLIP_X')} disabled={disabled || layout.rooms.length === 0} title={m.eco_tower_map_flip_x()} aria-label={m.eco_tower_map_flip_x()}
          class="p-1.5 rounded-md hover:bg-outline-variant/25 flex disabled:opacity-40"><Papicon icon="ArrowLeftRight" size={13} /></button>
        <button type="button" onclick={() => transform('FLIP_Y')} disabled={disabled || layout.rooms.length === 0} title={m.eco_tower_map_flip_y()} aria-label={m.eco_tower_map_flip_y()}
          class="p-1.5 rounded-md hover:bg-outline-variant/25 flex disabled:opacity-40"><span class="flex rotate-90"><Papicon icon="ArrowLeftRight" size={13} /></span></button>
        <button type="button" onclick={() => transform('ROTATE')} disabled={disabled || layout.rooms.length === 0} title={m.eco_tower_map_rotate()} aria-label={m.eco_tower_map_rotate()}
          class="p-1.5 rounded-md hover:bg-outline-variant/25 flex disabled:opacity-40"><Papicon icon="RefreshCw" size={13} /></button>
        <span class="w-px h-5 bg-outline-variant/25 mx-0.5" aria-hidden="true"></span>
        <button type="button" onclick={exportFloor} disabled={layout.rooms.length === 0} title={m.eco_tower_map_export_tip()} aria-label={m.eco_tower_map_export()}
          class="p-1.5 rounded-md hover:bg-outline-variant/25 flex disabled:opacity-40"><Papicon icon="Download" size={13} /></button>
        <label title={m.eco_tower_map_import_tip()} aria-label={m.eco_tower_map_import()}
          class="p-1.5 rounded-md hover:bg-outline-variant/25 flex {disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}">
          <Papicon icon="UploadCloud" size={13} />
          <input type="file" accept="application/json,.json" class="hidden" disabled={disabled} onchange={importFloor} />
        </label>
      </div>
      {#if importError}
        <span class="text-2xs text-error flex items-center gap-1"><Papicon icon="AlertTriangle" size={11} /> {m.eco_tower_map_import_invalid()}</span>
      {/if}
      <!-- La brume impose le brouillard sans toucher au réglage : il revient tel quel sans elle. -->
      <div class="flex items-center gap-2 px-2" title={layout.modifier === 'MIST' ? m.eco_tower_fog_forced_tip() : m.eco_tower_fog_tip()}>
        <ToggleSwitch checked={layout.fog || layout.modifier === 'MIST'} disabled={disabled || layout.modifier === 'MIST'} ariaLabel={m.eco_tower_fog()} onToggle={(value: boolean) => { remember(); layout.fog = value; dirty = true; }} />
        <span class="text-xs font-semibold flex items-center gap-1"><Papicon icon="Eye" size={12} /> {m.eco_tower_fog()}</span>
      </div>
      <div class="flex items-center gap-2 px-2 {current === 0 ? 'opacity-50' : ''}" title={current === 0 ? m.eco_tower_floor_variant_first() : m.eco_tower_floor_variant_tip()}>
        <ToggleSwitch checked={layout.variant} disabled={disabled || current === 0} ariaLabel={m.eco_tower_floor_variant()} onToggle={(value: boolean) => { remember(); layout.variant = value; dirty = true; }} />
        <span class="text-xs font-semibold flex items-center gap-1"><Papicon icon="Copy" size={12} /> {m.eco_tower_floor_variant()}</span>
      </div>
      {#if floorTags[current]?.variant}
        <div class="space-y-1" title={m.eco_tower_floor_weight_tip()}>
          <label for="floorWeight" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_tower_floor_weight({ chance: floorTags[current].chance })}</label>
          <input id="floorWeight" type="number" min={WEIGHT.min} max={WEIGHT.max} value={layout.weight} disabled={disabled}
            onchange={(e) => { remember(); layout.weight = Math.min(WEIGHT.max, Math.max(WEIGHT.min, Math.trunc(Number((e.currentTarget as HTMLInputElement).value)) || WEIGHT.default)); dirty = true; }}
            class="w-20 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
        </div>
      {/if}
      <div class="space-y-1" title={m.eco_tower_modifier_tip()}>
        <label for="floorModifier" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_tower_modifier()}</label>
        <select id="floorModifier" value={layout.modifier} disabled={disabled}
          onchange={(e) => { remember(); layout.modifier = (e.currentTarget as HTMLSelectElement).value as Modifier; dirty = true; }}
          class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none">
          {#each MODIFIERS as modifier}<option value={modifier}>{modifierLabel(modifier)}</option>{/each}
        </select>
      </div>
      <div class="space-y-1" title={m.eco_tower_theme_tip()}>
        <label for="floorTheme" class="text-xs font-semibold text-on-surface-variant/60 ml-2">{m.eco_tower_theme()}</label>
        <select id="floorTheme" value={layout.theme} disabled={disabled}
          onchange={(e) => { remember(); layout.theme = (e.currentTarget as HTMLSelectElement).value as Theme; dirty = true; }}
          class="bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none">
          {#each THEMES as theme}<option value={theme}>{themeLabel(theme)}</option>{/each}
        </select>
      </div>
      <button type="button" onclick={() => { showDeaths = !showDeaths; }} disabled={deathsTotal === 0} title={m.eco_tower_death_map_tip()}
        class="px-3 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50 {showDeaths ? 'bg-error/20 text-error' : 'bg-outline-variant/10 hover:bg-outline-variant/25'}">
        <Papicon icon="Skull" size={12} /> {m.eco_tower_death_map({ count: deathsTotal })}
      </button>
      <button type="button" onclick={openPreview} disabled={previewing || problems.length > 0 || layout.rooms.length === 0} title={m.eco_tower_preview_tip()}
        class="px-3 py-2 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 disabled:opacity-50">
        <Papicon icon="Image" size={12} /> {m.eco_tower_preview_btn()}
      </button>
    </div>

    <!-- Palette : les outils toujours à portée, puis les salles rangées par famille. -->
    <div class="rounded-xl border border-outline-variant/15 bg-surface-container-high/20 overflow-hidden">
      <div class="flex flex-wrap items-center gap-2 p-2 border-b border-outline-variant/10">
        <button type="button" onclick={() => pickTool('SELECT')} title={m.eco_tower_map_tool_select_tip()} class="px-3 py-1.5 rounded-lg text-xs font-bold border transition-all flex items-center gap-1.5 {tool === 'SELECT' ? 'border-primary bg-primary/15' : 'border-transparent hover:bg-outline-variant/10'}">
          <Papicon icon="MousePointer" size={12} /> {m.eco_tower_map_tool_select()}
        </button>
        <button type="button" onclick={() => pickTool('ERASE')} title={m.eco_tower_map_tool_erase_tip()} class="px-3 py-1.5 rounded-lg text-xs font-bold border transition-all flex items-center gap-1.5 {tool === 'ERASE' ? 'border-error bg-error/15 text-error' : 'border-transparent hover:bg-outline-variant/10'}">
          <Papicon icon="Eraser" size={12} /> {m.eco_tower_map_tool_erase()}
        </button>
        <button type="button" onclick={undo} disabled={disabled || past.length === 0} title={m.eco_tower_map_undo_tip()} aria-label={m.eco_tower_map_undo()}
          class="p-1.5 rounded-lg border border-transparent hover:bg-outline-variant/10 transition-all flex items-center disabled:opacity-35">
          <Papicon icon="RotateCcw" size={13} />
        </button>
        <button type="button" onclick={redo} disabled={disabled || future.length === 0} title={m.eco_tower_map_redo_tip()} aria-label={m.eco_tower_map_redo()}
          class="p-1.5 rounded-lg border border-transparent hover:bg-outline-variant/10 transition-all flex items-center disabled:opacity-35">
          <span class="flex -scale-x-100"><Papicon icon="RotateCcw" size={13} /></span>
        </button>
        {#if template && tool === template.type}
          <span class="px-2 py-1 rounded-lg text-2xs font-bold border flex items-center gap-1.5" style="border-color: {COLOR[template.type]}; color: {COLOR[template.type]}" title={m.eco_tower_map_pipette_tip()}>
            <Papicon icon="Copy" size={11} /> {templateSummary(template)}
            <button type="button" onclick={() => { template = null; }} aria-label={m.eco_tower_map_pipette_clear()} class="flex opacity-70 hover:opacity-100"><Papicon icon="X" size={11} /></button>
          </span>
        {/if}
        <span class="w-px h-6 bg-outline-variant/20 mx-1" aria-hidden="true"></span>
        <div class="flex flex-wrap gap-1" role="tablist" aria-label={m.eco_tower_categories_aria()}>
          {#each CATEGORIES as entry (entry.id)}
            {@const placed = entry.types.reduce((sum, type) => sum + counts[type], 0)}
            <button type="button" role="tab" aria-selected={category === entry.id} title={categoryTip(entry.id)} onclick={() => { category = entry.id; }}
              class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 {category === entry.id ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant/80 hover:bg-outline-variant/10'}">
              <Papicon icon={entry.icon} size={12} /> {categoryLabel(entry.id)}
              {#if placed > 0}<span class="text-2xs px-1.5 rounded-full {category === entry.id ? 'bg-on-primary/20' : 'bg-outline-variant/20'}">{placed}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
      {#each CATEGORIES.filter((entry) => entry.id === category) as entry (entry.id)}
        <div class="p-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {#each entry.types as type}
            <button type="button" onclick={() => pickTool(type)} title={tip(type)}
              class="group text-left p-2 rounded-lg border transition-all flex items-start gap-2 {tool === type ? 'bg-surface-container-high/60' : 'border-outline-variant/10 hover:border-outline-variant/30'}"
              style={tool === type ? `border-color: ${COLOR[type]}; box-shadow: inset 3px 0 0 ${COLOR[type]}` : ''}>
              <span class="shrink-0 w-7 h-7 rounded-md flex items-center justify-center" style="background: {COLOR[type]}26; color: {COLOR[type]}">
                <Papicon icon={ICON[type]} size={14} />
              </span>
              <span class="min-w-0">
                <span class="flex items-center gap-1 text-xs font-bold">{label(type)}{#if counts[type] > 0}<span class="text-2xs text-on-surface-variant/50 font-mono">×{counts[type]}</span>{/if}</span>
                <span class="block text-2xs text-on-surface-variant/55 leading-snug line-clamp-2">{tip(type)}</span>
              </span>
            </button>
          {/each}
        </div>
        {#if entry.id === 'EXITS'}
          <p class="px-3 pb-2 text-2xs text-on-surface-variant/60 flex items-start gap-1.5"><Papicon icon="Info" size={11} /> {m.eco_tower_category_exits_rule()}</p>
        {/if}
      {/each}
      <p class="px-3 py-1.5 border-t border-outline-variant/10 text-2xs text-on-surface-variant/55 flex items-center gap-1.5"><Papicon icon="Keyboard" size={11} /> {m.eco_tower_map_shortcuts()}</p>
    </div>
    <p class="text-2xs text-on-surface-variant/50">{m.eco_tower_map_hint()}</p>
  {/if}

  <div class="grid grid-cols-1 xl:grid-cols-[220px_1fr_300px] gap-6">
    <!-- La tour : un étage par carte, du rez-de-chaussée au sommet -->
    <div class="space-y-3">
      <div>
        <p class="text-sm font-bold flex items-center gap-2"><Papicon icon="Building" size={14} /> {m.eco_tower_floors_title()}</p>
        <p class="text-2xs text-on-surface-variant/60 leading-relaxed mt-1">{m.eco_tower_floors_desc()}</p>
      </div>
      <div>
        <div class="flex justify-between px-0.5" aria-hidden="true">
          {#each Array(5) as _}<span class="w-6 h-3 rounded-t-sm bg-outline-variant/35"></span>{/each}
        </div>
        <div class="border-x-4 border-b-4 border-t-4 border-outline-variant/35 rounded-b-lg p-1.5 space-y-1.5 bg-outline-variant/5">
          {#if canManage}
            <button type="button" onclick={addFloor} disabled={disabled || floors.length >= floorsMax} title={m.eco_tower_floors_max({ max: floorsMax })}
              class="w-full px-2 py-1.5 rounded-md border border-dashed border-outline-variant/30 text-2xs font-bold flex items-center justify-center gap-1 hover:bg-outline-variant/10 disabled:opacity-40">
              <Papicon icon="Plus" size={11} /> {m.eco_tower_floor_add()}
            </button>
          {/if}
          <div bind:this={stackList} class="max-h-[60vh] overflow-y-auto space-y-1.5 pr-0.5">
            {#each stack as entry (entry.index)}
              {@const valid = validity[entry.index] ?? true}
              {#if compact}
                <!-- Longue tour : une ligne par carte, sans vignette. -->
                <button type="button" data-index={entry.index} onclick={() => selectFloor(entry.index)}
                  title={valid ? '' : m.eco_tower_floor_invalid()}
                  class="w-full text-left rounded-md px-2 py-1 border transition-all flex items-center gap-2 {entry.index === current ? 'border-primary bg-primary/15' : 'border-outline-variant/15 bg-surface-container-high/40 hover:border-outline-variant/40'}">
                  <span class="text-2xs font-mono text-on-surface-variant/60 shrink-0">{floorTitle(entry.index)}</span>
                  <span class="text-2xs font-semibold truncate flex-1">{entry.floor.name || '–'}</span>
                  {#if floorTags[entry.index]?.variant}<span class="text-2xs text-on-surface-variant/50 shrink-0">{floorTags[entry.index].chance} %</span>{/if}
                  {#if !valid}<span class="text-warning flex shrink-0"><Papicon icon="AlertTriangle" size={11} /></span>{/if}
                </button>
              {:else}
                <button type="button" data-index={entry.index} onclick={() => selectFloor(entry.index)}
                  title={valid ? '' : m.eco_tower_floor_invalid()}
                  class="w-full text-left rounded-md px-2.5 py-2 border transition-all {entry.index === current ? 'border-primary bg-primary/15' : 'border-outline-variant/15 bg-surface-container-high/40 hover:border-outline-variant/40'}">
                  <span class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-mono text-on-surface-variant/60">{floorTitle(entry.index)}{#if floorTags[entry.index]?.variant} · {floorTags[entry.index].chance} %{/if}</span>
                    {#if !valid}<span class="text-warning flex"><Papicon icon="AlertTriangle" size={11} /></span>{/if}
                  </span>
                  <span class="flex items-center gap-2">
                    <!-- Vignette de l'étage, pour le reconnaître d'un coup d'œil. -->
                    <svg viewBox="0 0 {entry.floor.width} {entry.floor.height}" class="w-10 h-10 shrink-0 rounded bg-surface-container-low" aria-hidden="true">
                      {#each entry.floor.rooms as room}
                        <rect x={room.x + 0.1} y={room.y + 0.1} width={(room.type === 'BOSS' ? 2 : 1) - 0.2} height={(room.type === 'BOSS' ? 2 : 1) - 0.2} rx="0.2" fill={COLOR[room.type]} fill-opacity="0.85" />
                      {/each}
                    </svg>
                    <span class="min-w-0">
                      <span class="block text-xs font-semibold truncate">{entry.floor.name || '–'}</span>
                      <span class="block text-2xs text-on-surface-variant/50">{m.eco_tower_map_summary({ rooms: entry.floor.rooms.length, max: roomsMax })}</span>
                    </span>
                  </span>
                </button>
              {/if}
            {/each}
          </div>
        </div>
        <div class="h-2 mx-[-6px] rounded-sm bg-outline-variant/35" aria-hidden="true"></div>
      </div>
      <p class="text-2xs text-on-surface-variant/60">{m.eco_tower_floors_count({ cards: floors.length, floors: floorCount, max: floorsMax })}</p>
      {#if floors.length > 1}
        <div class="flex items-center gap-1.5">
          <input type="number" min="1" max={floorCount} bind:value={jumpTo} placeholder={m.eco_tower_floor_jump_placeholder()} aria-label={m.eco_tower_floor_jump()}
            onkeydown={(event) => { if (event.key === 'Enter') jumpToFloor(); }}
            class="w-20 bg-surface-container-high/40 border border-outline-variant/10 rounded-md px-2 py-1 text-2xs focus:outline-none" />
          <button type="button" onclick={jumpToFloor} class="px-2 py-1 rounded-md bg-outline-variant/10 hover:bg-outline-variant/25 text-2xs font-bold">{m.eco_tower_floor_jump()}</button>
          {#if invalidFloors > 0}
            <button type="button" onclick={nextInvalid} title={m.eco_tower_floor_next_invalid()} aria-label={m.eco_tower_floor_next_invalid()}
              class="ml-auto px-2 py-1 rounded-md bg-warning/10 hover:bg-warning/20 text-warning text-2xs font-bold flex items-center gap-1">
              <Papicon icon="AlertTriangle" size={11} /> {invalidFloors}
            </button>
          {/if}
        </div>
      {/if}
      <p class="text-2xs text-on-surface-variant/50 leading-relaxed">
        {floorsAfter === 'GENERATE' ? m.eco_tower_floors_after_generate_note() : m.eco_tower_floors_after_loop_note()}
      </p>
      {#if canManage}
        <div class="grid grid-cols-2 gap-1.5">
          <button type="button" onclick={() => moveFloor(1)} disabled={disabled || current >= floors.length - 1} class="px-2 py-1.5 rounded-md bg-outline-variant/10 hover:bg-outline-variant/25 text-2xs font-bold flex items-center justify-center gap-1 disabled:opacity-40">
            <Papicon icon="ArrowUp" size={11} /> {m.eco_tower_floor_up()}
          </button>
          <button type="button" onclick={() => moveFloor(-1)} disabled={disabled || current <= 0} class="px-2 py-1.5 rounded-md bg-outline-variant/10 hover:bg-outline-variant/25 text-2xs font-bold flex items-center justify-center gap-1 disabled:opacity-40">
            <Papicon icon="ArrowDown" size={11} /> {m.eco_tower_floor_down()}
          </button>
          <button type="button" onclick={duplicateFloor} disabled={disabled || floors.length >= floorsMax} class="px-2 py-1.5 rounded-md bg-outline-variant/10 hover:bg-outline-variant/25 text-2xs font-bold flex items-center justify-center gap-1 disabled:opacity-40">
            <Papicon icon="Copy" size={11} /> {m.eco_tower_floor_duplicate()}
          </button>
          <button type="button" onclick={removeFloor} disabled={disabled} class="px-2 py-1.5 rounded-md bg-error/10 hover:bg-error/20 text-error text-2xs font-bold flex items-center justify-center gap-1 disabled:opacity-40">
            <Papicon icon="trash" size={11} /> {m.eco_tower_floor_delete()}
          </button>
          <button type="button" onclick={exportTower} title={m.eco_tower_export_all_tip()} class="px-2 py-1.5 rounded-md bg-outline-variant/10 hover:bg-outline-variant/25 text-2xs font-bold flex items-center justify-center gap-1">
            <Papicon icon="Download" size={11} /> {m.eco_tower_export_all()}
          </button>
          <label title={m.eco_tower_import_all_tip()}
            class="px-2 py-1.5 rounded-md bg-outline-variant/10 hover:bg-outline-variant/25 text-2xs font-bold flex items-center justify-center gap-1 {disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}">
            <Papicon icon="UploadCloud" size={11} /> {m.eco_tower_import_all()}
            <input type="file" accept="application/json,.json" class="hidden" disabled={disabled} onchange={importTower} />
          </label>
        </div>
        {#if towerImportError !== null}
          <p class="text-2xs text-error flex items-center gap-1">
            <Papicon icon="AlertTriangle" size={11} />
            {towerImportError === 0 ? m.eco_tower_import_all_invalid({ max: floorsMax }) : m.eco_tower_import_all_invalid_card({ card: towerImportError })}
          </p>
        {/if}
      {/if}
    </div>

    <!-- Carte de l'étage ouvert -->
    <div class="bg-surface-container-high/20 border border-outline-variant/10 rounded-xl p-3 overflow-auto">
      <svg
        viewBox="0 0 {frameW} {frameH + CRENEL}"
        class="w-full max-w-[720px] mx-auto select-none touch-none"
        role="grid"
        tabindex="-1"
        aria-label={m.eco_tower_map_title()}
        oncontextmenu={(event) => { if (canManage && !disabled) event.preventDefault(); }}
      >
        <!-- La tour en pierre : créneaux, maçonnerie, puis l'étage dans son cadre. -->
        <defs>
          <pattern id="towerBricks" width="32" height="16" patternUnits="userSpaceOnUse">
            <rect width="32" height="16" class="fill-outline-variant/25" />
            <path d="M0 0.5H32M0 8.5H32M0.5 0V8M16.5 8V16" class="stroke-outline-variant/40" stroke-width="1" fill="none" />
          </pattern>
        </defs>
        {#each Array(merlons) as _, index}
          {#if index % 2 === 0}
            <rect x={(frameW / merlons) * index} y="0" width={frameW / merlons} height={CRENEL + 2} fill="url(#towerBricks)" pointer-events="none" />
          {/if}
        {/each}
        <rect x="0" y={CRENEL} width={frameW} height={frameH} rx="6" fill="url(#towerBricks)" pointer-events="none" />
        <rect x={FRAME - 4} y={CRENEL + FRAME - 4} width={layout.width * CELL + 8} height={layout.height * CELL + 8} rx="6" class="fill-surface-container-low" pointer-events="none" />
        <g transform="translate({FRAME} {FRAME + CRENEL})">
        {#each Array(layout.height) as _, y}
          {#each Array(layout.width) as __, x}
            <rect
              x={x * CELL + 2} y={y * CELL + 2} width={CELL - 4} height={CELL - 4} rx="8"
              class="fill-outline-variant/5 stroke-outline-variant/15 {canManage ? 'cursor-pointer hover:fill-outline-variant/20' : ''}"
              stroke-width="1"
              role="gridcell"
              tabindex="-1"
              onpointerdown={(event) => pointerDown(event, x, y)}
              onpointerenter={() => pointerEnter(x, y)}
            />
          {/each}
        {/each}

        {#each links as link}
          <line x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} stroke="currentColor" class="text-on-surface-variant/30" stroke-width="6" stroke-linecap="round" pointer-events="none" />
        {/each}
        {#if warpLink}
          <line x1={warpLink.x1} y1={warpLink.y1} x2={warpLink.x2} y2={warpLink.y2} stroke="#2dd4bf" stroke-opacity="0.7" stroke-width="3" stroke-dasharray="8 6" stroke-linecap="round" pointer-events="none" />
        {/if}

        {#each layout.rooms as room (room.id)}
          {@const span = room.type === 'BOSS' ? 2 : 1}
          {@const reachable = distances.has(room.id)}
          {@const iconSize = room.type === 'BOSS' ? 40 : 22}
          <g
            class={canManage ? 'cursor-pointer' : ''}
            role="gridcell"
            tabindex="-1"
            onpointerdown={(event) => pointerDown(event, room.x, room.y)}
            onpointerenter={() => { if (rect || room.type !== 'BOSS') pointerEnter(room.x, room.y); }}
          >
            <title>{roomTitle(room)}</title>
            <rect
              x={room.x * CELL + 5} y={room.y * CELL + 5}
              width={span * CELL - 10} height={span * CELL - 10}
              rx={room.type === 'BOSS' ? 18 : 10}
              fill={COLOR[room.type]} fill-opacity={room.type === 'EMPTY' ? 0.12 : 0.22}
              stroke={reachable ? COLOR[room.type] : '#ef4444'}
              stroke-width={room.id === selectedId ? 4 : reachable ? 2 : 3}
              stroke-dasharray={reachable ? undefined : '6 4'}
            />
            <g
              transform="translate({(room.x + span / 2) * CELL - iconSize / 2} {(room.y + span / 2) * CELL - iconSize / 2 - (room.type === 'BOSS' ? 6 : 0)})"
              style="color: {COLOR[room.type]}"
              pointer-events="none"
            >
              <Papicon icon={ICON[room.type]} size={iconSize} />
            </g>
            {#if room.type === 'BOSS'}
              <text x={(room.x + 1) * CELL} y={(room.y + 2) * CELL - 16} text-anchor="middle" font-size="11" font-weight="700" fill={COLOR.BOSS} pointer-events="none">
                {room.foe ?? 'BOSS'}
              </text>
            {/if}
            {#if reachable && !isEntry(room.type)}
              <text x={room.x * CELL + 11} y={room.y * CELL + 17} font-size="10" font-weight="700" fill="currentColor" class="text-on-surface-variant/70" pointer-events="none">
                {distances.get(room.id)}
              </text>
            {/if}
            {#if room.type === 'ENTRANCE' || room.type === 'WELL'}
              <!-- Entrées au choix numérotées comme sur Discord ; un puits, c'est le hasard. -->
              <text x={room.x * CELL + CELL - 12} y={room.y * CELL + CELL - 10} text-anchor="middle" font-size="13" font-weight="800" fill={COLOR[room.type]} pointer-events="none">
                {room.type === 'ENTRANCE' ? entranceNumber.get(room.id) : '?'}
              </text>
            {/if}
            {#if isWarp(room.type)}
              <text x={room.x * CELL + CELL - 12} y={room.y * CELL + CELL - 10} text-anchor="middle" font-size="13" font-weight="800" fill={COLOR[room.type]} pointer-events="none">
                {room.type === 'WARP_A' ? 'A' : 'B'}
              </text>
            {/if}
            {#if room.key}
              <g transform="translate({room.x * CELL + CELL - 22} {room.y * CELL + CELL - 22})" style="color: #fbbf24" pointer-events="none">
                <Papicon icon="Lock" size={14} />
              </g>
            {/if}
            {#if wanderCells.has(room.id)}
              <!-- Zone de patrouille de l'errant sélectionné : là où il peut passer. -->
              <rect x={room.x * CELL + 3} y={room.y * CELL + 3} width={span * CELL - 6} height={span * CELL - 6} rx="11"
                fill="#ef4444" fill-opacity="0.12" stroke="#ef4444" stroke-width="2" stroke-dasharray="3 3" pointer-events="none" />
            {/if}
            {#if showDeaths && (floorDeaths[room.id] ?? 0) > 0}
              {@const deaths = floorDeaths[room.id]}
              <rect x={room.x * CELL + 5} y={room.y * CELL + 5} width={span * CELL - 10} height={span * CELL - 10} rx={room.type === 'BOSS' ? 18 : 10}
                fill="#ef4444" fill-opacity={0.15 + 0.55 * (deaths / deathsMax)} pointer-events="none" />
              <text x={(room.x + span / 2) * CELL} y={(room.y + span) * CELL - 10} text-anchor="middle" font-size="11" font-weight="800" fill="#fecaca" pointer-events="none">
                {m.eco_tower_death_count({ count: deaths })}
              </text>
            {/if}
            {#if hasPower(room.type) && room.powerPercent !== 100}
              <text x={(room.x + span) * CELL - 10} y={room.y * CELL + 17} text-anchor="end" font-size="10" font-weight="800" fill={room.powerPercent > 100 ? '#ef4444' : '#22c55e'} pointer-events="none">
                ×{room.powerPercent / 100}
              </text>
            {/if}
          </g>
        {/each}
        {#if rectBox}
          <rect x={rectBox.x * CELL + 2} y={rectBox.y * CELL + 2} width={rectBox.w * CELL - 4} height={rectBox.h * CELL - 4} rx="8"
            fill={rectColor} fill-opacity="0.15" stroke={rectColor} stroke-width="2" stroke-dasharray="6 4" pointer-events="none" />
        {/if}
        </g>
      </svg>
    </div>

    <!-- Informations et salle sélectionnée -->
    <div class="space-y-4">
      <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl p-4 space-y-2 text-xs">
        <p class="font-semibold">{m.eco_tower_map_summary({ rooms: layout.rooms.length, max: roomsMax })}</p>
        <p class="text-on-surface-variant/70">
          {bossDepth !== null ? m.eco_tower_map_exit_depth({ rooms: bossDepth }) : m.eco_tower_map_no_path()}
        </p>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-on-surface-variant/70">
          {#each ROOM_TYPES as type}
            {#if counts[type] > 0}<span class="flex items-center gap-1" title={label(type)}><span style="color: {COLOR[type]}" class="flex"><Papicon icon={ICON[type]} size={11} /></span> {counts[type]}</span>{/if}
          {/each}
        </div>
        {#if problems.length > 0}
          <ul class="space-y-1 pt-1">
            {#each problems as problem}
              <li class="text-2xs text-warning flex items-start gap-1.5"><Papicon icon="AlertTriangle" size={11} /> {problem}</li>
            {/each}
          </ul>
        {/if}
        <p class="text-2xs text-on-surface-variant/70 flex items-start gap-1.5 pt-1" title={m.eco_tower_difficulty_estimate_tip()}>
          <Papicon icon="Skull" size={11} />
          {m.eco_tower_difficulty_estimate({ from: difficulty.from, to: difficulty.to, hpFrom: difficulty.healthFrom, hpTo: difficulty.healthTo })}
        </p>
        {#if powered}
          <p class="text-2xs text-on-surface-variant/70 flex items-start gap-1.5" title={m.eco_tower_map_power_tip()}>
            <Papicon icon="Zap" size={11} />
            {m.eco_tower_difficulty_power({ count: powered.count, factor: powered.factor, hpFrom: powered.hpFrom, hpTo: powered.hpTo })}
          </p>
        {/if}
        <p class="text-2xs text-on-surface-variant/50 leading-relaxed pt-1">{m.eco_tower_map_rules()}</p>
      </div>

      {#if selected}
        {#key selected.id}
        <div class="bg-surface-container-high/30 border border-outline-variant/10 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between">
            <p class="text-sm font-bold flex items-center gap-2" title={tip(selected.type)}><span style="color: {COLOR[selected.type]}" class="flex"><Papicon icon={ICON[selected.type]} size={16} /></span> {label(selected.type)}</p>
            <span class="text-2xs text-on-surface-variant/50 font-mono">{selected.x},{selected.y}</span>
          </div>
          {#if canManage && !isEntry(selected.type) && !isExit(selected.type) && !isWarp(selected.type)}
            <button type="button" onclick={() => pickTemplate(selected!)} disabled={disabled} title={m.eco_tower_map_pipette_tip()}
              class="w-full px-3 py-1.5 rounded-lg text-2xs font-bold border border-outline-variant/15 hover:bg-outline-variant/10 flex items-center justify-center gap-1.5 disabled:opacity-50">
              <Papicon icon="Copy" size={11} /> {m.eco_tower_map_pipette_use()}
            </button>
          {/if}

          {#if selected.type === 'MONSTER' || selected.type === 'ELITE' || selected.type === 'BOSS' || selected.type === 'COLLAPSE' || selected.type === 'WANDERER' || selected.type === 'PRISONER'}
            {#if selected.type === 'WANDERER'}
              <div class="space-y-1">
                <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_wander_radius()} · <span class="font-mono">{selected.wanderRadius}</span></span>
                <div class="flex flex-wrap gap-1.5">
                  {#each [1, 2, 3, 4, 5, 6] as radius}
                    <button type="button" disabled={!canManage || disabled} onclick={() => updateSelected({ wanderRadius: radius })}
                      class="px-2.5 py-1 rounded-lg text-2xs font-bold border font-mono {selected.wanderRadius === radius ? 'border-primary bg-primary/15' : 'border-outline-variant/15'}">{radius}</button>
                  {/each}
                </div>
                <p class="text-2xs text-on-surface-variant/50">{m.eco_tower_map_wander_hint({ rooms: wanderCells.size })}</p>
              </div>
            {/if}
            {#if selected.type === 'PRISONER'}
              <div class="space-y-1">
                <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_captive()}</span>
                <div class="flex flex-wrap gap-1.5">
                  {#each CAPTIVES as captive}
                    <button type="button" disabled={!canManage || disabled} onclick={() => updateSelected({ captive })}
                      class="px-2 py-1 rounded-lg text-2xs font-bold border {selected.captive === captive ? 'border-primary bg-primary/15' : 'border-outline-variant/15'}">{captiveLabel(captive)}</button>
                  {/each}
                </div>
              </div>
            {/if}
            {#if selected.type === 'COLLAPSE'}
              <div class="space-y-1">
                <label for="roomCollapse" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_collapse_steps()}</label>
                <input id="roomCollapse" type="number" min="3" max="40" value={selected.collapseSteps} disabled={!canManage || disabled}
                  onchange={(e) => updateSelected({ collapseSteps: Math.min(40, Math.max(3, Number((e.currentTarget as HTMLInputElement).value) || 10)) })}
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
                <p class="text-2xs text-on-surface-variant/50">{m.eco_tower_map_collapse_hint({ shortest: bossDepth ?? 0 })}</p>
              </div>
              <p class="text-xs font-semibold pt-1">{m.eco_tower_map_collapse_guardian()}</p>
            {/if}
            <div class="space-y-1">
              <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_foe()}</span>
              <SearchableSelect
                value={selected.foe}
                options={foeOptions}
                placeholder={m.eco_tower_map_foe_random()}
                clearable={true}
                showId={false}
                className="w-full"
                on:change={(e: any) => updateSelected({ foe: e.detail?.value ?? null })}
              />
            </div>
            {@render powerSettings(selected)}
            <div class="space-y-1">
              <span class="text-xs font-semibold text-on-surface-variant/60" title={m.eco_tower_map_traits_tip()}>{m.eco_tower_map_traits({ max: TRAITS_MAX })}</span>
              <div class="flex flex-wrap gap-1.5">
                {#each TRAITS as trait}
                  <button type="button" disabled={!canManage || disabled || (!selected.traits.includes(trait) && selected.traits.length >= TRAITS_MAX)} title={traitTip(trait)} onclick={() => toggleTrait(trait)}
                    class="px-2 py-1 rounded-lg text-2xs font-bold border disabled:opacity-40 {selected.traits.includes(trait) ? 'border-error bg-error/15 text-error' : 'border-outline-variant/15'}">{traitLabel(trait)}</button>
                {/each}
              </div>
              <p class="text-2xs text-on-surface-variant/50">{m.eco_tower_map_traits_hint()}</p>
            </div>
            {#if selected.type === 'BOSS' || selected.type === 'COLLAPSE'}
              <div class="space-y-1">
                <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_mechanic()}</span>
                <div class="flex flex-wrap gap-1.5">
                  {#each MECHANICS as mechanic}
                    <button type="button" disabled={!canManage || disabled} title={mechanicTip(mechanic)} onclick={() => updateSelected({ mechanic })}
                      class="px-2 py-1 rounded-lg text-2xs font-bold border {selected.mechanic === mechanic ? 'border-primary bg-primary/15' : 'border-outline-variant/15'}">{mechanicLabel(mechanic)}</button>
                  {/each}
                </div>
              </div>
            {/if}
          {:else if selected.type === 'AMBUSH'}
            {@render powerSettings(selected)}
          {:else if selected.type === 'TOLL'}
            <div class="space-y-1">
              <label for="roomToll" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_toll_gold()}</label>
              <input id="roomToll" type="number" min="1" max="10000" value={selected.tollGold} disabled={!canManage || disabled}
                onchange={(e) => updateSelected({ tollGold: Math.min(10000, Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 60)) })}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
              <p class="text-2xs text-on-surface-variant/50">{m.eco_tower_map_toll_hint()}</p>
            </div>
          {:else if selected.type === 'TRIAL'}
            <div class="space-y-1">
              <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_waves()}</span>
              <div class="flex flex-wrap gap-1.5">
                {#each WAVES as waves}
                  <button type="button" disabled={!canManage || disabled} onclick={() => updateSelected({ waves })}
                    class="px-2.5 py-1 rounded-lg text-2xs font-bold border font-mono {selected.waves === waves ? 'border-primary bg-primary/15' : 'border-outline-variant/15'}">{waves}</button>
                {/each}
              </div>
              <p class="text-2xs text-on-surface-variant/50">{m.eco_tower_map_waves_hint()}</p>
            </div>
            {@render powerSettings(selected)}
            <label class="flex items-start gap-2 text-xs" title={m.eco_tower_map_trial_reward_tip()}>
              <input type="checkbox" class="mt-0.5" checked={selected.trialReward} disabled={!canManage || disabled}
                onchange={(e) => updateSelected({ trialReward: (e.currentTarget as HTMLInputElement).checked })} />
              {m.eco_tower_map_trial_reward()}
            </label>
          {:else if selected.type === 'EVENT'}
            <div class="space-y-1">
              <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_event()}</span>
              <div class="flex flex-wrap gap-1.5">
                {#each EVENTS as event}
                  <button type="button" disabled={!canManage || disabled} title={eventTip(event)} onclick={() => updateSelected({ event })}
                    class="px-2 py-1 rounded-lg text-2xs font-bold border {selected.event === event ? 'border-primary bg-primary/15' : 'border-outline-variant/15'}">{eventLabel(event)}</button>
                {/each}
              </div>
            </div>
          {:else if selected.type === 'CHEST'}
            <div class="space-y-1">
              <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_chest()}</span>
              <div class="flex gap-1.5">
                {#each [['BOTH', m.eco_tower_map_chest_both()], ['GOLD', m.eco_tower_map_chest_gold()], ['GEAR', m.eco_tower_map_chest_gear()]] as [kind, text]}
                  <button type="button" disabled={!canManage || disabled} onclick={() => updateSelected({ chest: kind as ChestKind })}
                    class="flex-1 px-2 py-1.5 rounded-lg text-2xs font-bold border {selected.chest === kind ? 'border-primary bg-primary/15' : 'border-outline-variant/15'}">{text}</button>
                {/each}
              </div>
            </div>
          {:else if selected.type === 'CAMPFIRE'}
            <div class="space-y-1">
              <label for="roomHeal" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_heal()}</label>
              <input id="roomHeal" type="number" min="5" max="100" value={selected.healPercent} disabled={!canManage || disabled}
                onchange={(e) => updateSelected({ healPercent: Math.min(100, Math.max(5, Number((e.currentTarget as HTMLInputElement).value) || 35)) })}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
            </div>
          {:else if selected.type === 'MERCHANT'}
            <div class="space-y-2">
              <span class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_offers()}</span>
              <div class="flex flex-col gap-1.5">
                {#each OFFERS as offer}
                  <label class="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={selected.offers.includes(offer)} disabled={!canManage || disabled} onchange={() => toggleOffer(offer)} />
                    {offerLabel(offer)}
                  </label>
                {/each}
              </div>
              <label for="roomPrice" class="text-xs font-semibold text-on-surface-variant/60">{m.eco_tower_map_price()}</label>
              <input id="roomPrice" type="number" min="10" max="500" value={selected.pricePercent} disabled={!canManage || disabled}
                onchange={(e) => updateSelected({ pricePercent: Math.min(500, Math.max(10, Number((e.currentTarget as HTMLInputElement).value) || 100)) })}
                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" />
            </div>
          {:else}
            <p class="text-2xs text-on-surface-variant/60">{m.eco_tower_map_no_option()}</p>
          {/if}
          {#if selected.type === 'ELITE' || selected.type === 'CHEST' || selected.type === 'TRIAL'}
            <label class="flex items-start gap-2 text-xs pt-1" title={m.eco_tower_map_key_tip()}>
              <input type="checkbox" checked={selected.key} disabled={!canManage || disabled} onchange={() => updateSelected({ key: !selected!.key })} />
              <span><span class="font-semibold flex items-center gap-1"><Papicon icon="Lock" size={11} /> {m.eco_tower_map_key()}</span>
                <span class="block text-2xs text-on-surface-variant/50">{m.eco_tower_map_key_tip()}</span></span>
            </label>
          {/if}
          <p class="text-2xs text-on-surface-variant/50 leading-relaxed">{tip(selected.type)}</p>
        </div>
        {/key}
      {:else}
        <p class="text-2xs text-on-surface-variant/50 italic px-1">{m.eco_tower_map_select_hint()}</p>
      {/if}
    </div>
  </div>

  {#if canManage}
    <div class="flex items-center justify-end gap-3 pt-4 border-t border-outline-variant/10">
      {#if invalidFloors > 0}<span class="text-2xs text-warning">{m.eco_tower_floors_invalid()}</span>
      {:else if dirty}<span class="text-2xs text-warning">{m.eco_tower_map_unsaved()}</span>{/if}
      <button
        type="button"
        onclick={save}
        disabled={disabled || actionState.state.loading || invalidFloors > 0}
        class="px-4 py-2 bg-primary hover:bg-primary-hover text-on-primary text-body-sm font-medium rounded-lg transition-all disabled:opacity-50"
      >
        {m.eco_btn_save()}
      </button>
    </div>
  {/if}
</div>

{#if preview}
  <!-- Aperçu : l'image exacte que verront les joueurs en arrivant sur cet étage. -->
  <div class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" role="presentation" onclick={() => { preview = null; }}>
    <div class="bg-surface-container rounded-xl border border-outline-variant/30 p-4 max-w-4xl w-full space-y-3" role="dialog" aria-label={m.eco_tower_preview_btn()} tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => { if (event.key === 'Escape') preview = null; }}>
      <div class="flex items-center justify-between">
        <p class="text-sm font-bold flex items-center gap-2"><Papicon icon="Image" size={14} /> {m.eco_tower_preview_title()}</p>
        <button type="button" onclick={() => { preview = null; }} class="px-3 py-1.5 bg-outline-variant/10 hover:bg-outline-variant/25 text-xs font-bold rounded-lg">{m.eco_btn_cancel()}</button>
      </div>
      <img src={preview} alt={m.eco_tower_preview_title()} class="w-full rounded-lg" />
      <p class="text-2xs text-on-surface-variant/60">{m.eco_tower_preview_hint()}</p>
    </div>
  </div>
{/if}
