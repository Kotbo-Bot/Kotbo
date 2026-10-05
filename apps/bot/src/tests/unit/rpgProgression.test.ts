import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import path from 'node:path';
import {
  RPG_ADVENTURE_EVENTS,
  RPG_ITEMS,
  RPG_MONSTERS,
} from '../../services/features/rpg/rpgContent.js';

type Item = {
  id: string;
  name: string;
  type: string;
  rarity: string;
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  hpBonus: number;
  hpRestore: number;
  energyRestore: number;
  price: number;
  levelRequired: number;
};

type Profile = {
  id: string;
  guildId: string;
  userId: string;
  balance: number;
  level: number;
  xp: number;
  health: number;
  maxHealth: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  className: string | null;
  reclassVouchers: number;
  statPoints: number;
  skillPoints: number;
  weaponId: string | null;
  armorId: string | null;
  accessoryId: string | null;
  accessory2Id: string | null;
  accessory3Id: string | null;
  isTraveling: boolean;
  travelStartedAt: Date | null;
  travelDurationMin: number;
  lastEnergyTick: Date;
  updatedAt: Date;
  inventory: unknown[];
};

function makeItem(overrides: Partial<Item> & Pick<Item, 'id' | 'name' | 'type'>): Item {
  return {
    rarity: 'COMMON',
    atkBonus: 0,
    defBonus: 0,
    spdBonus: 0,
    hpBonus: 0,
    hpRestore: 0,
    energyRestore: 0,
    price: 100,
    levelRequired: 0,
    ...overrides,
  };
}

const ITEMS: Record<string, Item> = {
  sword: makeItem({ id: 'sword', name: 'Épée en bois', type: 'WEAPON', atkBonus: 5, spdBonus: 2, price: 50 }),
  blade: makeItem({ id: 'blade', name: 'Dague en fer', type: 'WEAPON', atkBonus: 9, spdBonus: 4, price: 150 }),
  ring: makeItem({ id: 'ring', name: 'Anneau de cuivre', type: 'ACCESSORY', atkBonus: 2, price: 80 }),
  mail: makeItem({ id: 'mail', name: 'Cotte de mailles', type: 'ARMOR', hpBonus: 30, price: 120 }),
  gate: makeItem({ id: 'gate', name: 'Lame des Anciens', type: 'WEAPON', atkBonus: 30, price: 900, levelRequired: 10 }),
  ore: makeItem({ id: 'ore', name: 'Écaille de Dragon', type: 'MATERIAL', price: 180 }),
};

type Instance = { id: string; rpgProfileId: string; itemId: string; upgrade: number; enchants: unknown; equipped: boolean };

let profile: Profile;
/** Exemplaires forgés ou enchantés : plusieurs par objet, chacun avec sa progression. */
let instances: Instance[];
/** Exemplaires possédés par objet, forgés compris. Un seul par défaut. */
let stock: Record<string, number>;
/** Nœuds d'arbre achetés, que la reconversion doit effacer en rendant les points. */
let skillUnlocks: { rpgProfileId: string; nodeId: string; rank: number }[];

/** Raccourci de lecture pour les tests : niveau de forge de l'exemplaire porté, sinon du plus forgé. */
function upgradeOf(itemId: string): number {
  const copies = instances.filter((instance) => instance.itemId === itemId);
  return (copies.find((instance) => instance.equipped) ?? copies[0])?.upgrade ?? 0;
}

/** Filtre Prisma réduit aux opérateurs utilisés sur les exemplaires : égalité, `in`, `not`. */
function matches(instance: Instance, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = (instance as any)[key];
    if (expected && typeof expected === 'object') {
      if ('in' in expected) return expected.in.includes(actual);
      if ('not' in expected) return actual !== expected.not;
    }
    return actual === expected;
  });
}

/** Applique le sous-ensemble d'opérateurs Prisma utilisé par les services. */
function applyData(target: Profile, data: Record<string, any>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('increment' in value) (target as any)[key] += value.increment;
      else if ('decrement' in value) (target as any)[key] -= value.decrement;
      continue;
    }
    if (value !== undefined) (target as any)[key] = value;
  }
}

const rpgProfile = {
  findUnique: mock(async () => ({ ...profile })),
  findUniqueOrThrow: mock(async () => ({ ...profile })),
  create: mock(async () => ({ ...profile })),
  update: mock(async ({ data }: any) => {
    applyData(profile, data);
    return { ...profile };
  }),
  updateMany: mock(async ({ where, data }: any) => {
    // Reproduit les gardes atomiques dont dépendent les services.
    if (where?.balance?.gte !== undefined && profile.balance < where.balance.gte) return { count: 0 };
    if (where?.reclassVouchers?.gte !== undefined && profile.reclassVouchers < where.reclassVouchers.gte) return { count: 0 };
    if (where?.statPoints?.gte !== undefined && profile.statPoints < where.statPoints.gte) return { count: 0 };
    if (where?.className !== undefined && where.className !== profile.className) return { count: 0 };
    if (typeof where?.level === 'number' && where.level !== profile.level) return { count: 0 };
    if (where?.xp?.gte !== undefined && profile.xp < where.xp.gte) return { count: 0 };
    applyData(profile, data);
    return { count: 1 };
  }),
};

// Un événement sans choix est retiré du tirage : chacun en porte donc un.
const ADVENTURE_CHOICES = [{ text: 'Continuer', hpEffect: 0, coinEffect: 0, xpEffect: 0, minLevel: 0 }];
const ADVENTURE_EVENTS = [
  { id: 'evt-a', guildId: null, title: 'A', choices: ADVENTURE_CHOICES },
  { id: 'evt-b', guildId: null, title: 'B', choices: ADVENTURE_CHOICES },
  { id: 'evt-c', guildId: null, title: 'C', choices: ADVENTURE_CHOICES },
  { id: 'evt-d', guildId: null, title: 'D', choices: ADVENTURE_CHOICES },
];

// Le seed du catalogue tourne au premier accès profil. On lui fait voir tout le contenu
// comme déjà présent, pour qu'il n'écrive rien et n'ajoute pas de bruit aux tests.
const SEEDED_ITEM_NAMES = RPG_ITEMS.map((item) => ({ name: item.name }));
const SEEDED_MONSTER_NAMES = RPG_MONSTERS.map((monster) => ({ name: monster.name }));
const SEEDED_EVENT_TITLES = RPG_ADVENTURE_EVENTS.map((event) => ({ title: event.title }));

const mockDb = {
  economyConfig: {
    findUnique: mock(async () => ({
      enabled: true,
      rpgEnabled: true,
      shopEnabled: true,
      maxEnergy: 100,
      energyRecoveryPerHour: 10,
      currencyEmoji: 'coins',
    })),
  },
  rpgItem: {
    count: mock(async () => 1),
    createMany: mock(async () => ({ count: 0 })),
    findUnique: mock(async ({ where }: any) => ITEMS[where.id] ?? null),
    findMany: mock(async ({ where }: any) => {
      // Lecture d'équipement (par identifiants) vs lecture du seed (catalogue complet).
      if (where?.id?.in) return where.id.in.map((id: string) => ITEMS[id]).filter(Boolean);
      return [...SEEDED_ITEM_NAMES, ...Object.values(ITEMS).map((item) => ({ ...item }))];
    }),
  },
  rpgMonster: {
    count: mock(async () => 1),
    createMany: mock(async () => ({ count: 0 })),
    findMany: mock(async () => SEEDED_MONSTER_NAMES),
  },
  rpgRecipe: {
    findMany: mock(async () => []),
    createMany: mock(async () => ({ count: 0 })),
  },
  rpgInventoryItem: {
    findUnique: mock(async ({ where }: any) => {
      const item = ITEMS[where.rpgProfileId_itemId.itemId];
      return item ? { id: `inv-${item.id}`, quantity: stock[item.id] ?? 1, item } : null;
    }),
  },
  rpgAdventureEvent: {
    count: mock(async () => 1),
    createMany: mock(async () => ({ count: 0 })),
    findMany: mock(async ({ select }: any) => (
      // Le seed ne lit que les titres ; `resolveTravel` a besoin des événements complets.
      select?.title ? SEEDED_EVENT_TITLES : ADVENTURE_EVENTS.map((event) => ({ ...event }))
    )),
  },
  rpgProfile,
  rpgItemInstance: {
    findFirst: mock(async ({ where }: any) => {
      const found = instances.find((instance) => matches(instance, where));
      return found ? { ...found } : null;
    }),
    findMany: mock(async ({ where }: any) => instances.filter((instance) => matches(instance, where)).map((instance) => ({ ...instance }))),
    create: mock(async ({ data }: any) => {
      const created = { id: `inst-${instances.length + 1}`, enchants: [], equipped: false, upgrade: 0, ...data };
      instances.push(created);
      return { ...created };
    }),
    update: mock(async ({ where, data }: any) => {
      const instance = instances.find((candidate) => candidate.id === where.id)!;
      applyData(instance as any, data);
      return { ...instance };
    }),
    updateMany: mock(async ({ where, data }: any) => {
      const targets = instances.filter((instance) => matches(instance, where));
      for (const instance of targets) applyData(instance as any, data);
      return { count: targets.length };
    }),
    delete: mock(async ({ where }: any) => {
      const index = instances.findIndex((candidate) => candidate.id === where.id);
      const [removed] = instances.splice(index, 1);
      return removed;
    }),
  },
  // Verrou du profil : sans effet ici, les tests étant séquentiels.
  $queryRaw: mock(async () => []),
  // Arbre de compétences : la reconversion l'efface et rend les points investis.
  rpgSkillUnlock: {
    findMany: mock(async ({ where }: any) => skillUnlocks.filter((unlock) => unlock.rpgProfileId === where.rpgProfileId)),
    deleteMany: mock(async ({ where }: any) => {
      const before = skillUnlocks.length;
      skillUnlocks = skillUnlocks.filter((unlock) => unlock.rpgProfileId !== where.rpgProfileId);
      return { count: before - skillUnlocks.length };
    }),
  },
  // Les écritures groupées de la reconversion : le mock exécute simplement les promesses
  // déjà lancées, comme le ferait Prisma avec un tableau d'opérations.
  $transaction: mock(async (operations: unknown) => (
    Array.isArray(operations) ? Promise.all(operations) : (operations as (tx: unknown) => unknown)(mockDb)
  )),
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));

const { checkLevelUp, equipInventoryItem, resolveTravel } = await import('../../services/features/economyService.js');
const { allocateStatPoint, chooseRpgClass, upgradeEquipment } = await import('../../services/features/rpg/rpgProgressionService.js');

beforeEach(() => {
  const now = new Date();
  instances = [];
  stock = {};
  skillUnlocks = [];
  profile = {
    id: 'profile-1',
    guildId: 'guild-1',
    userId: 'user-1',
    balance: 0,
    level: 1,
    xp: 0,
    health: 100,
    maxHealth: 100,
    energy: 100,
    attack: 10,
    defense: 10,
    speed: 10,
    className: null,
    reclassVouchers: 0,
    statPoints: 0,
    skillPoints: 0,
    weaponId: null,
    armorId: null,
    accessoryId: null,
    accessory2Id: null,
    accessory3Id: null,
    isTraveling: false,
    travelStartedAt: null,
    travelDurationMin: 0,
    lastEnergyTick: now,
    updatedAt: now,
    inventory: [],
  };
});

describe('checkLevelUp', () => {
  test('accorde tous les paliers couverts par un gros gain d XP', async () => {
    // Paliers : niv.1 -> 100 XP, niv.2 -> 200 XP, niv.3 -> 300 XP.
    // 350 XP couvre donc deux niveaux et laisse 50 XP de reste.
    profile.xp = 350;

    const level = await checkLevelUp('guild-1', 'user-1');

    expect(level).toBe(3);
    expect(profile.level).toBe(3);
    expect(profile.xp).toBe(50);
    expect(profile.maxHealth).toBe(116); // +8 par niveau gagné
    expect(profile.attack).toBe(12); // +1 automatique par niveau
    expect(profile.health).toBe(profile.maxHealth); // soin complet
    expect(profile.statPoints).toBe(6); // 3 points à répartir par niveau
  });

  test('le soin complet remplit aussi les PV apportés par l équipement', async () => {
    profile.xp = 100;
    profile.armorId = 'mail';

    await checkLevelUp('guild-1', 'user-1');

    expect(profile.maxHealth).toBe(108);
    expect(profile.health).toBe(138);
  });

  test('garde un gain d XP ou un point investi arrivé pendant la montée', async () => {
    profile.xp = 150;
    profile.attack = 10;
    // Entre la lecture et l'écriture, le joueur gagne 30 XP et investit un point en attaque.
    rpgProfile.findUnique.mockImplementationOnce(async () => {
      const snapshot = { ...profile };
      profile.xp += 30;
      profile.attack += 1;
      return snapshot;
    });

    await checkLevelUp('guild-1', 'user-1');

    expect(profile.level).toBe(2);
    expect(profile.xp).toBe(80); // 150 + 30 - 100 : le gain n'est pas effacé
    expect(profile.attack).toBe(12); // 10 + 1 investi + 1 automatique
  });

  test('deux montées simultanées n accordent le niveau qu une fois', async () => {
    profile.xp = 100;

    await Promise.all([checkLevelUp('guild-1', 'user-1'), checkLevelUp('guild-1', 'user-1')]);

    expect(profile.level).toBe(2);
    expect(profile.xp).toBe(0);
    expect(profile.statPoints).toBe(3);
  });

  test('ne fait rien tant que le palier n est pas atteint', async () => {
    profile.xp = 99;

    expect(await checkLevelUp('guild-1', 'user-1')).toBeNull();
    expect(profile.level).toBe(1);
    expect(profile.statPoints).toBe(0);
  });
});

describe('equipInventoryItem', () => {
  test('équiper puis re-sélectionner le même objet le déséquipe', async () => {
    const equipped = await equipInventoryItem('guild-1', 'user-1', 'sword');
    expect(equipped.equipped).toBe(true);
    expect(equipped.slot).toBe('weapon');
    expect(profile.weaponId).toBe('sword');

    const unequipped = await equipInventoryItem('guild-1', 'user-1', 'sword');
    expect(unequipped.equipped).toBe(false);
    expect(profile.weaponId).toBeNull();
  });

  test('n écrit jamais dans les statistiques de base', async () => {
    // Les bonus sont dérivés à la lecture : toute écriture ici recréerait la dérive
    // permanente que le modèle actuel élimine par construction.
    const before = { attack: profile.attack, defense: profile.defense, speed: profile.speed };

    await equipInventoryItem('guild-1', 'user-1', 'sword');
    await equipInventoryItem('guild-1', 'user-1', 'blade');

    expect(profile.weaponId).toBe('blade');
    expect({ attack: profile.attack, defense: profile.defense, speed: profile.speed }).toEqual(before);
  });

  test('la progression suit l objet, pas l emplacement', async () => {
    // Le niveau de forge vit sur l'exemplaire possédé. Poser une autre arme dans le slot
    // ne lui transmet donc rien - l'exploit qui consistait à monter une babiole bon marché
    // à +10 avant d'y glisser une légendaire n'existe plus - et reprendre la première la
    // retrouve intacte, là où l'ancien modèle l'effaçait au déséquipement.
    await equipInventoryItem('guild-1', 'user-1', 'sword');
    instances.push({ id: 'inst-sword', rpgProfileId: 'profile-1', itemId: 'sword', upgrade: 7, enchants: [], equipped: true });

    await equipInventoryItem('guild-1', 'user-1', 'blade');
    expect(upgradeOf('blade')).toBe(0);
    expect(upgradeOf('sword')).toBe(7);

    await equipInventoryItem('guild-1', 'user-1', 'sword');
    expect(upgradeOf('sword')).toBe(7);
    expect(instances.find((instance) => instance.itemId === 'sword')?.equipped).toBe(true);
  });

  test('changer d exemplaire garde l emplacement et déplace la marque', async () => {
    stock.sword = 2;
    instances.push({ id: 'inst-sword', rpgProfileId: 'profile-1', itemId: 'sword', upgrade: 4, enchants: [], equipped: false });

    await equipInventoryItem('guild-1', 'user-1', 'sword', 'plain');
    expect(profile.weaponId).toBe('sword');
    expect(upgradeOf('sword')).toBe(4);
    expect(instances[0].equipped).toBe(false);

    const swapped = await equipInventoryItem('guild-1', 'user-1', 'sword', 'inst-sword');
    expect(swapped.equipped).toBe(true);
    expect(profile.weaponId).toBe('sword');
    expect(instances[0].equipped).toBe(true);
  });

  test('un accessoire occupe son propre emplacement', async () => {
    await equipInventoryItem('guild-1', 'user-1', 'sword');
    const result = await equipInventoryItem('guild-1', 'user-1', 'ring');

    expect(result.slot).toBe('accessory');
    expect(profile.accessoryId).toBe('ring');
    expect(profile.weaponId).toBe('sword'); // l'arme reste équipée
  });

  test('refuse un matériau, qui ne s équipe pas', () => {
    expect(equipInventoryItem('guild-1', 'user-1', 'ore')).rejects.toThrow(/accessoires/);
  });

  test('refuse un objet dont le niveau requis n est pas atteint', () => {
    expect(equipInventoryItem('guild-1', 'user-1', 'gate')).rejects.toThrow(/niveau 10/);
  });
});

describe('points de caractéristiques', () => {
  test('investir un point augmente la statistique et décrémente le solde', async () => {
    profile.statPoints = 3;

    const result = await allocateStatPoint('guild-1', 'user-1', 'attack');

    expect(result.gain).toBe(1);
    expect(profile.attack).toBe(11);
    expect(profile.statPoints).toBe(2);
  });

  test('un point de vitalité vaut plusieurs PV et soigne d autant', async () => {
    profile.statPoints = 1;
    const healthBefore = profile.health;

    const result = await allocateStatPoint('guild-1', 'user-1', 'maxHealth');

    expect(result.gain).toBe(8);
    expect(profile.maxHealth).toBe(108);
    expect(profile.health).toBe(healthBefore + 8);
  });

  test('refuse de dépenser des points inexistants', () => {
    profile.statPoints = 0;
    expect(allocateStatPoint('guild-1', 'user-1', 'attack')).rejects.toThrow();
  });
});

describe('choix de classe', () => {
  test('le premier choix est gratuit à partir du niveau requis', async () => {
    profile.level = 5;

    const result = await chooseRpgClass('guild-1', 'user-1', 'MAGE');

    expect(result.cost).toBe(0);
    expect(profile.className).toBe('MAGE');
    expect(profile.balance).toBe(0);
  });

  test('refuse avant le niveau de déblocage', () => {
    profile.level = 4;
    expect(chooseRpgClass('guild-1', 'user-1', 'WARRIOR')).rejects.toThrow(/niveau 5/);
  });

  test('la reconversion est payante et refusée sans le solde', async () => {
    profile.level = 10;
    profile.className = 'WARRIOR';
    profile.balance = 100;

    expect(chooseRpgClass('guild-1', 'user-1', 'MAGE')).rejects.toThrow(/2500/);

    profile.balance = 5_000;
    const result = await chooseRpgClass('guild-1', 'user-1', 'MAGE');
    expect(result.cost).toBe(2_500);
    expect(profile.balance).toBe(2_500);
  });

  test('un bon de reconversion paie le changement à la place des pièces', async () => {
    profile.level = 10;
    profile.className = 'WARRIOR';
    profile.balance = 100;
    profile.reclassVouchers = 1;

    const result = await chooseRpgClass('guild-1', 'user-1', 'MAGE');
    expect(result.voucher).toBe(true);
    expect(result.cost).toBe(0);
    expect(profile.className).toBe('MAGE');
    expect(profile.reclassVouchers).toBe(0);
    expect(profile.balance).toBe(100);

    // Plus de bon : on retombe sur le prix en pièces.
    expect(chooseRpgClass('guild-1', 'user-1', 'WARRIOR')).rejects.toThrow(/2500/);
  });

  test('le premier choix de classe ne consomme pas de bon', async () => {
    profile.level = 5;
    profile.reclassVouchers = 2;

    const result = await chooseRpgClass('guild-1', 'user-1', 'MAGE');
    expect(result.voucher).toBe(false);
    expect(profile.reclassVouchers).toBe(2);
  });

  test('refuse une classe inconnue', () => {
    profile.level = 10;
    expect(chooseRpgClass('guild-1', 'user-1', 'NECROMANCER')).rejects.toThrow(/inconnue/);
  });
});

describe('forge', () => {
  test('un échec ne rétrograde pas l objet mais coûte les pièces', async () => {
    profile.weaponId = 'sword';
    instances.push({
      id: 'inst-sword', rpgProfileId: 'profile-1', itemId: 'sword', upgrade: 9, enchants: [], equipped: true,
    }); // au-delà de la zone garantie
    profile.balance = 1_000_000;
    const balanceBefore = profile.balance;

    const result = await upgradeEquipment('guild-1', 'user-1', 'weapon');

    expect(profile.balance).toBe(balanceBefore - result.cost);
    expect(upgradeOf('sword')).toBeGreaterThanOrEqual(9); // jamais de perte de niveau
    expect(result.newLevel).toBe(result.success ? 10 : 9);
  });

  test('les trois premiers niveaux réussissent toujours', async () => {
    profile.weaponId = 'sword';
    profile.balance = 1_000_000;

    // Le pire tirage possible : seule une chance de 1 le transforme en réussite.
    const random = spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      for (const level of [0, 1, 2]) {
        const result = await upgradeEquipment('guild-1', 'user-1', 'weapon');
        expect(result.success).toBe(true);
        expect(upgradeOf('sword')).toBe(level + 1);
      }
    } finally {
      random.mockRestore();
    }
  });

  test('forger l exemplaire porté ne rend pas forgés les autres exemplaires', async () => {
    profile.weaponId = 'sword';
    profile.balance = 1_000_000;
    stock.sword = 3;

    const random = spyOn(Math, 'random').mockReturnValue(0);
    try {
      await upgradeEquipment('guild-1', 'user-1', 'weapon');
      await upgradeEquipment('guild-1', 'user-1', 'weapon');
    } finally {
      random.mockRestore();
    }

    // Un seul exemplaire individualisé, porté, à +2 : les deux autres restent ordinaires.
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ itemId: 'sword', upgrade: 2, equipped: true });
  });

  test('refuse d améliorer un emplacement vide', () => {
    profile.balance = 1_000_000;
    expect(upgradeEquipment('guild-1', 'user-1', 'armor')).rejects.toThrow(/Aucun objet/);
  });

  test('refuse si le solde est insuffisant', () => {
    profile.weaponId = 'sword';
    profile.balance = 1;
    expect(upgradeEquipment('guild-1', 'user-1', 'weapon')).rejects.toThrow(/coûte/);
  });
});

describe('resolveTravel', () => {
  test('rouvrir la vue Voyage retombe sur le même événement', async () => {
    profile.isTraveling = true;
    profile.travelDurationMin = 5;
    profile.travelStartedAt = new Date(Date.now() - 10 * 60 * 1000);

    const first = await resolveTravel('guild-1', 'user-1');
    const second = await resolveTravel('guild-1', 'user-1');

    expect(first.complete).toBe(true);
    expect(first.event?.id).toBeDefined();
    expect(second.event?.id).toBe(first.event?.id);
  });

  test('signale le temps restant tant que le voyage est en cours', async () => {
    profile.isTraveling = true;
    profile.travelDurationMin = 30;
    profile.travelStartedAt = new Date(Date.now() - 5 * 60 * 1000);

    const status = await resolveTravel('guild-1', 'user-1');

    expect(status.complete).toBe(false);
    expect(status.remainingMinutes).toBe(25);
  });
});
