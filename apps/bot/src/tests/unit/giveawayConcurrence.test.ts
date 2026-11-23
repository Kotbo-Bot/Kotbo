// Base simulée avec les garanties de Postgres : `updateMany` conditionnel
// atomique, verrou `FOR UPDATE` tenu jusqu'au commit, lectures par copie.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import nodeCrypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Client } from 'discord.js';
import type { Giveaway } from '@prisma/client';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = '333333333333333333';
const GIVEAWAY_ID = 'concours-1';

let concours: Giveaway;
const copie = (): Giveaway => structuredClone(concours);

/** Pièces créditées, une entrée par versement. */
const versements: string[] = [];

/** Écriture concurrente jouée juste après la prochaine lecture par `findUnique`. */
let apresLecture: (() => Promise<unknown>) | null = null;
/** Lectures des réglages qui échouent encore, comme une base passagèrement injoignable. */
let pannesReglages = 0;

function correspond(where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([champ, valeur]) => {
    const actuel = concours[champ as keyof Giveaway];
    // Filtre de liste `{ equals }` : égalité de tableaux, ordre compris, comme en SQL.
    if (valeur && typeof valeur === 'object' && 'equals' in valeur) return isDeepStrictEqual(actuel, valeur.equals);
    return actuel === valeur;
  });
}

const tableConcours = {
  findFirst: async ({ where }: { where: Record<string, unknown> }) => (correspond(where) ? copie() : null),
  findUnique: async ({ where }: { where: { id: string } }) => {
    const lu = where.id === concours.id ? copie() : null;
    const ecriture = apresLecture;
    apresLecture = null;
    await ecriture?.();
    return lu;
  },
  update: async ({ data }: { data: Partial<Giveaway> }) => {
    concours = { ...concours, ...structuredClone(data) };
    return copie();
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Giveaway> }) => {
    if (!correspond(where)) return { count: 0 };
    concours = { ...concours, ...structuredClone(data) };
    return { count: 1 };
  },
};

/** File d'attente du verrou de ligne : chaque preneur attend le précédent. */
let fileVerrou: Promise<void> = Promise.resolve();

async function transaction<T>(corps: (tx: unknown) => Promise<T>): Promise<T> {
  let liberer = () => {};
  let verrouTenu = false;
  const tx = {
    $queryRaw: async (sql: TemplateStringsArray) => {
      if (!verrouTenu && sql.join('?').includes('FOR UPDATE')) {
        verrouTenu = true;
        const precedent = fileVerrou;
        fileVerrou = new Promise<void>((resolve) => { liberer = resolve; });
        await precedent;
      }
      return [];
    },
    giveaway: tableConcours,
  };
  try {
    return await corps(tx);
  } finally {
    liberer();
  }
}

const fauxPrisma = {
  giveaway: tableConcours,
  $transaction: transaction,
  giveawayConfig: {
    findUnique: async () => {
      if (pannesReglages > 0) {
        pannesReglages--;
        throw new Error('base injoignable');
      }
      return null;
    },
  },
  guild: { findUnique: async () => null },
  clan: { findMany: async () => [] },
  rpgItem: { findFirst: async () => null },
  rpgProfile: {
    upsert: async ({ where }: { where: { guildId_userId: { userId: string } } }) => {
      versements.push(where.guildId_userId.userId);
      return { id: `profil-${where.guildId_userId.userId}` };
    },
  },
};

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () => completeModuleMock(source, overrides));
  }
}
mockerModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
mockerModule('../../utils/cache', {
  cache: { get: async () => null, set: async () => undefined, delete: async () => undefined },
  getCachedGuild: async () => ({ language: 'fr' }),
  getCachedDashboardSettings: async () => null,
});
mockerModule('../../services/core/moduleGate', { isModuleEnabled: async () => true });
mockerModule('../../services/features/economyService', { checkLevelUp: async () => null });

const { approveGiveawayWinners, endGiveaway, rerollGiveaway } = await import('../../services/features/giveawayService.js');

/** Serveur où tous les participants sont encore présents, et son salon d'annonce. */
function serveur() {
  const messages: string[] = [];
  const salon = {
    id: 'salon-1',
    isTextBased: () => true,
    send: mock(async (payload: { content?: string }) => {
      messages.push(payload.content ?? '');
      return { id: 'message' };
    }),
    messages: { fetch: async () => null },
  };
  const guild = {
    id: GUILD_ID,
    name: 'Serveur test',
    channels: { cache: { get: () => salon }, fetch: async () => salon },
    members: {
      fetch: async ({ user }: { user: string[] }) =>
        new Map(user.map((id) => [id, { roles: { cache: new Map() } }])),
    },
  };
  const client = { guilds: { cache: { get: () => guild }, fetch: async () => guild } } as unknown as Client;
  return { client, messages };
}

function concoursDeBase(etat: Partial<Giveaway>): Giveaway {
  return {
    id: GIVEAWAY_ID,
    guildId: GUILD_ID,
    channelId: 'salon-1',
    messageId: null,
    prize: '500 pièces',
    description: null,
    winnerCount: 1,
    endsAt: new Date(Date.now() - 60_000),
    ended: false,
    participants: ['alice', 'bruno', 'chloe'],
    winners: [],
    pendingWinners: [],
    needValidation: false,
    validationStatus: 'APPROVED',
    rpgXp: 0,
    rpgCoins: 500,
    rpgItemId: null,
    createdById: null,
    styleOverrides: null,
    ignoreBonuses: false,
    conditions: null,
    discordEventId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...etat,
  };
}

// Le tirage passe par `crypto.randomInt` (voir `secureRandom`) : c'est lui qu'on pilote.
const vraiRandomInt = nodeCrypto.randomInt;
function tirages(...valeurs: number[]) {
  let i = 0;
  (nodeCrypto as { randomInt: unknown }).randomInt = (_min: number, max: number) => Math.floor(valeurs[Math.min(i++, valeurs.length - 1)] * max);
}

beforeEach(() => {
  versements.length = 0;
  fileVerrou = Promise.resolve();
  apresLecture = null;
  pannesReglages = 0;
});

afterEach(() => {
  (nodeCrypto as { randomInt: unknown }).randomInt = vraiRandomInt;
});

describe('clôture simultanée', () => {
  test('bouton et cron en même temps : un seul tirage, un seul versement, une seule annonce', async () => {
    concours = concoursDeBase({});
    const { client, messages } = serveur();

    await Promise.all([endGiveaway(client, GIVEAWAY_ID), endGiveaway(client, GIVEAWAY_ID)]);

    expect(concours.ended).toBe(true);
    expect(concours.winners).toHaveLength(1);
    expect(versements).toEqual(concours.winners);
    expect(messages).toHaveLength(1);
  });

  test('une panne avant le tirage laisse le concours ouvert : le cron le clôt ensuite', async () => {
    concours = concoursDeBase({});
    pannesReglages = 1;
    const { client } = serveur();

    await expect(endGiveaway(client, GIVEAWAY_ID)).rejects.toThrow('base injoignable');
    expect(concours.ended).toBe(false);

    await endGiveaway(client, GIVEAWAY_ID);

    expect(concours.ended).toBe(true);
    expect(concours.winners).toHaveLength(1);
    expect(versements).toEqual(concours.winners);
  });
});

describe('validation simultanée', () => {
  test('double clic sur « Valider » : les lots ne partent qu\'une fois', async () => {
    concours = concoursDeBase({
      ended: true,
      needValidation: true,
      validationStatus: 'PENDING',
      pendingWinners: ['alice'],
    });
    const { client, messages } = serveur();

    await Promise.all([approveGiveawayWinners(client, GIVEAWAY_ID), approveGiveawayWinners(client, GIVEAWAY_ID)]);

    expect(concours.validationStatus).toBe('APPROVED');
    expect(concours.winners).toEqual(['alice']);
    expect(versements).toEqual(['alice']);
    expect(messages).toHaveLength(1);
  });

  test('une relance entre la lecture et l\'écriture de « Valider » n\'est pas écrasée', async () => {
    concours = concoursDeBase({
      ended: true,
      needValidation: true,
      validationStatus: 'PENDING',
      pendingWinners: ['alice'],
    });
    // La relance tire le dernier candidat restant, « chloe ».
    tirages(0.99);
    const { client } = serveur();
    apresLecture = () => rerollGiveaway(client, GIVEAWAY_ID);

    await approveGiveawayWinners(client, GIVEAWAY_ID);

    expect(concours.pendingWinners).toContain('chloe');
    expect(versements).toEqual([]);

    await approveGiveawayWinners(client, GIVEAWAY_ID);

    expect(concours.winners).toContain('chloe');
    expect(versements).toEqual(concours.winners);
  });
});

describe('relance simultanée', () => {
  const termine = () => concoursDeBase({ ended: true, validationStatus: 'APPROVED', winners: ['alice'] });

  test('deux relances qui tirent le même membre : il n\'est servi qu\'une fois', async () => {
    concours = termine();
    // Les deux tirages tombent sur le premier candidat restant, « bruno ».
    tirages(0);
    const { client } = serveur();

    const resultats = await Promise.all([rerollGiveaway(client, GIVEAWAY_ID), rerollGiveaway(client, GIVEAWAY_ID)]);

    expect(resultats.filter(Boolean)).toHaveLength(1);
    expect(concours.winners).toEqual(['alice', 'bruno']);
    expect(versements).toEqual(['bruno']);
  });

  test('deux relances qui tirent deux membres différents : aucun gagnant n\'est écrasé', async () => {
    concours = termine();
    // Premier tirage sur « bruno », second sur « chloe ».
    tirages(0, 0.99);
    const { client } = serveur();

    const resultats = await Promise.all([rerollGiveaway(client, GIVEAWAY_ID), rerollGiveaway(client, GIVEAWAY_ID)]);

    expect(resultats).toEqual([true, true]);
    expect([...concours.winners].sort()).toEqual(['alice', 'bruno', 'chloe']);
    expect([...versements].sort()).toEqual(['bruno', 'chloe']);
  });
});

describe('relance d\'un concours à validation', () => {
  test('gagnants validés et en attente sont conservés, seuls les nouveaux reçoivent leur lot', async () => {
    concours = concoursDeBase({ ended: true, needValidation: true, validationStatus: 'APPROVED', winners: ['alice'] });
    tirages(0);
    const { client } = serveur();

    await rerollGiveaway(client, GIVEAWAY_ID);
    await rerollGiveaway(client, GIVEAWAY_ID);
    await approveGiveawayWinners(client, GIVEAWAY_ID);

    expect(concours.winners).toEqual(['alice', 'bruno', 'chloe']);
    expect(versements).toEqual(['bruno', 'chloe']);
  });
});
