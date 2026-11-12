/**
 * Le ramassage d'un drop respecte le module qui tient la ressource versée.
 *
 * Le cycle ne publie plus de drop dont le module est éteint, mais un drop déjà
 * posé restait cliquable : couper les niveaux pendant qu'un drop d'XP attendait
 * dans le salon, et `addXp` ne versait rien tout en laissant le membre lire
 * « Tu as ramassé 120 XP », sa place consommée pour rien. Le clic est désormais
 * refusé avant toute réservation.
 *
 * Le versement est suivi à part de la réservation : une erreur laisse la place
 * réservée et non versée, et le cycle reprend ces ramassages en suspens, sous
 * un bail qui empêche deux processus de verser le même.
 *
 * Le comptage des messages récents d'un salon (attente d'activité) est testé ici
 * aussi : il vit dans le même service, et profite des mêmes doubles.
 *
 * Préfixe `zzz-` : ce fichier remplace `utils/db`, `utils/i18n`, `moduleGate` et
 * `levelingService` pour tout le process (`mock.module` est global, et
 * `--isolate` ne l'isole pas). Il doit charger après tous les `zz-` :
 * `zz-gardeRessources` et `zz-moduleGate` testent la vraie garde, et les
 * suivants n'attendent pas de double sur `utils/i18n`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_ID = 'guilde-drops';
const DROP_ID = 'drop-1';

let levelingActif = true;

const dropXp = {
  id: DROP_ID,
  guildId: GUILD_ID,
  configId: 'config-1',
  type: 'XP',
  itemId: null,
  mode: 'FIRST',
  channelId: 'salon-1',
  messageId: 'message-1',
  amount: 120,
  maxClaims: 1,
  claimCount: 0,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  closedAt: null,
  deleteAfterMinutes: 0,
  createdAt: new Date(),
};

const CLAIM_ID = 'claim-1';

/** Le bail de la reprise est pris (écriture conditionnelle sur `attemptedAt`). */
let bailPris = true;

const dropClaimUpdateMany = mock(async ({ where }: { where: Record<string, unknown> }) =>
  ({ count: 'attemptedAt' in where ? (bailPris ? 1 : 0) : 1 }));

const tx = {
  dropClaim: {
    create: mock(async () => ({ id: CLAIM_ID })),
    deleteMany: mock(async () => ({ count: 1 })),
    updateMany: dropClaimUpdateMany,
  },
  drop: {
    update: mock(async () => ({})),
    updateMany: mock(async () => ({ count: 1 })),
    findUnique: mock(async () => ({ claimCount: 1 })),
  },
};

/** Règles de ramassage du serveur, telles que lues dans la colonne. */
let reglesRamassage: Record<string, unknown> = {};
let ramassagesDuJour = 0;

const fauxPrisma = {
  guild: { findUnique: mock(async () => ({ dropClaimRules: reglesRamassage })) },
  drop: {
    findUnique: mock(async () => dropXp),
    update: mock(async () => ({})),
    updateMany: mock(async () => ({ count: 0 })),
  },
  dropClaim: {
    deleteMany: mock(async () => ({ count: 1 })),
    updateMany: dropClaimUpdateMany,
    findMany: mock(async () => [] as unknown[]),
    count: mock(async () => ramassagesDuJour),
  },
  rpgItem: { findUnique: mock(async () => null) },
  $transaction: mock(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (client: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[])),
};

const addXp = mock(async (..._args: unknown[]) => undefined);

function mockerModule(relatif: string, overrides: Record<string, unknown>): void {
  const source = path.resolve(import.meta.dir, `${relatif}.ts`);
  for (const suffixe of ['.ts', '.js']) {
    mock.module(path.resolve(import.meta.dir, `${relatif}${suffixe}`), () =>
      completeModuleMock(source, overrides));
  }
}

mockerModule('../../utils/db', { default: fauxPrisma, prisma: fauxPrisma, prismaRead: fauxPrisma });
mockerModule('../../utils/i18n', { resolveGuildLocale: mock(async () => 'fr') });
mockerModule('../../services/core/moduleGate', {
  isModuleEnabled: mock(async (_guildId: string, moduleKey: string) => moduleKey !== 'leveling' || levelingActif),
});
mockerModule('../../services/progression/levelingService', { addXp });

const { countRecentMemberMessages, handleDropClaim, settlePendingDropClaims } = await import('../../services/features/dropService.js');

const editReply = mock(async (_payload: { content: string }) => undefined);

function clic(member: { roles: string[]; joined_at: string } = {
  roles: ['role-membre'],
  joined_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
}) {
  return {
    guildId: GUILD_ID,
    user: { id: 'membre-1' },
    member,
    client: {},
    deferReply: mock(async () => undefined),
    editReply,
  } as never;
}

beforeEach(() => {
  levelingActif = true;
  bailPris = true;
  reglesRamassage = {};
  ramassagesDuJour = 0;
  fauxPrisma.dropClaim.count.mockClear();
  addXp.mockReset();
  addXp.mockImplementation(async () => undefined);
  editReply.mockClear();
  tx.dropClaim.create.mockClear();
  tx.dropClaim.deleteMany.mockClear();
  fauxPrisma.dropClaim.deleteMany.mockClear();
  fauxPrisma.dropClaim.findMany.mockReset();
  dropClaimUpdateMany.mockClear();
});

/** Appels qui marquent un ramassage comme versé (et non ceux qui prennent le bail). */
function marquagesVerses(): unknown[] {
  return dropClaimUpdateMany.mock.calls.filter(([args]) => 'paidAt' in (args as unknown as { data: object }).data);
}

describe('ramassage d\'un drop dont le module de la ressource est éteint', () => {
  test('niveaux éteints : aucune place n\'est prise et rien n\'est versé', async () => {
    levelingActif = false;
    await handleDropClaim(clic(), DROP_ID);

    expect(tx.dropClaim.create).not.toHaveBeenCalled();
    expect(addXp).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  test('niveaux allumés : l\'XP est versée', async () => {
    await handleDropClaim(clic(), DROP_ID);

    expect(tx.dropClaim.create).toHaveBeenCalledTimes(1);
    expect(addXp).toHaveBeenCalledTimes(1);
  });
});

describe('versement garanti d\'un ramassage', () => {
  test('versement réussi : le ramassage est marqué versé', async () => {
    await handleDropClaim(clic(), DROP_ID);

    expect(addXp).toHaveBeenCalledTimes(1);
    expect(marquagesVerses()).toHaveLength(1);
    expect(dropClaimUpdateMany).toHaveBeenCalledWith({
      where: { id: CLAIM_ID, paidAt: null },
      data: { paidAt: expect.any(Date) },
    });
  });

  test('versement en erreur : la place reste réservée, la reprise s\'en chargera', async () => {
    addXp.mockImplementation(async () => { throw new Error('base indisponible'); });
    await handleDropClaim(clic(), DROP_ID);

    expect(tx.dropClaim.deleteMany).not.toHaveBeenCalled();
    expect(fauxPrisma.dropClaim.deleteMany).not.toHaveBeenCalled();
    expect(marquagesVerses()).toHaveLength(0);
    expect(editReply).toHaveBeenCalledTimes(1);
  });
});

describe('règles de ramassage du serveur', () => {
  test('sans règle configurée, rien n\'est compté et le clic passe', async () => {
    await handleDropClaim(clic(), DROP_ID);

    expect(fauxPrisma.dropClaim.count).not.toHaveBeenCalled();
    expect(tx.dropClaim.create).toHaveBeenCalledTimes(1);
    expect(addXp).toHaveBeenCalledTimes(1);
  });

  test('plafond du jour atteint : refusé avant toute réservation', async () => {
    reglesRamassage = { dailyLimit: 2 };
    ramassagesDuJour = 2;
    await handleDropClaim(clic(), DROP_ID);

    expect(fauxPrisma.dropClaim.count).toHaveBeenCalledTimes(1);
    expect(tx.dropClaim.create).not.toHaveBeenCalled();
    expect(addXp).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  test('rôle requis absent : refusé', async () => {
    reglesRamassage = { requiredRoleId: 'role-vip' };
    await handleDropClaim(clic(), DROP_ID);

    expect(tx.dropClaim.create).not.toHaveBeenCalled();
  });

  test('membre arrivé trop récemment : refusé', async () => {
    reglesRamassage = { minMemberDays: 7 };
    await handleDropClaim(clic({ roles: [], joined_at: new Date().toISOString() }), DROP_ID);

    expect(tx.dropClaim.create).not.toHaveBeenCalled();
  });

  test('règles respectées : le clic passe', async () => {
    reglesRamassage = { dailyLimit: 2, minMemberDays: 7, requiredRoleId: 'role-membre' };
    ramassagesDuJour = 1;
    await handleDropClaim(clic(), DROP_ID);

    expect(tx.dropClaim.create).toHaveBeenCalledTimes(1);
  });
});

describe('reprise des versements restés en suspens', () => {
  const enSuspens = {
    id: 'claim-2',
    dropId: DROP_ID,
    guildId: GUILD_ID,
    userId: 'membre-2',
    amount: 120,
    paidAt: null,
    attemptedAt: new Date(Date.now() - 30 * 60 * 1000),
    createdAt: new Date(Date.now() - 30 * 60 * 1000),
    drop: dropXp,
  };

  test('seuls les ramassages non versés dont la tentative est ancienne sont relus', async () => {
    fauxPrisma.dropClaim.findMany.mockImplementation(async () => []);
    await settlePendingDropClaims({} as never);

    const [args] = fauxPrisma.dropClaim.findMany.mock.calls[0] as unknown as [{ where: { paidAt: null; attemptedAt: { lte: Date } } }];
    expect(args.where.paidAt).toBeNull();
    expect(args.where.attemptedAt.lte.getTime()).toBeLessThan(Date.now() - 60 * 1000);
  });

  test('bail pris : le gain est versé puis marqué', async () => {
    fauxPrisma.dropClaim.findMany.mockImplementation(async () => [enSuspens]);
    await settlePendingDropClaims({} as never);

    expect(addXp).toHaveBeenCalledTimes(1);
    expect(addXp.mock.calls[0]?.slice(0, 3)).toEqual([GUILD_ID, 'membre-2', 120]);
    expect(dropClaimUpdateMany).toHaveBeenCalledWith({
      where: { id: 'claim-2', paidAt: null },
      data: { paidAt: expect.any(Date) },
    });
  });

  test('bail déjà pris par un autre processus : rien n\'est versé', async () => {
    bailPris = false;
    fauxPrisma.dropClaim.findMany.mockImplementation(async () => [enSuspens]);
    await settlePendingDropClaims({} as never);

    expect(addXp).not.toHaveBeenCalled();
    expect(marquagesVerses()).toHaveLength(0);
  });

  test('module éteint depuis : la place est libérée sans versement', async () => {
    levelingActif = false;
    fauxPrisma.dropClaim.findMany.mockImplementation(async () => [enSuspens]);
    await settlePendingDropClaims({} as never);

    expect(addXp).not.toHaveBeenCalled();
    expect(tx.dropClaim.deleteMany).toHaveBeenCalledWith({ where: { id: 'claim-2', paidAt: null } });
  });

  test('nouvel échec : le ramassage reste en suspens pour le passage suivant', async () => {
    addXp.mockImplementation(async () => { throw new Error('base indisponible'); });
    fauxPrisma.dropClaim.findMany.mockImplementation(async () => [enSuspens]);
    await settlePendingDropClaims({} as never);

    expect(tx.dropClaim.deleteMany).not.toHaveBeenCalled();
    expect(marquagesVerses()).toHaveLength(0);
  });
});

describe('messages récents d\'un salon, pour l\'attente d\'activité', () => {
  const now = Date.now();
  const message = (id: string, minutesAgo: number, extra: Record<string, unknown> = {}) => [id, {
    author: { bot: false },
    system: false,
    webhookId: null,
    createdTimestamp: now - minutesAgo * 60 * 1000,
    ...extra,
  }] as const;

  function salon(messages: Array<readonly [string, unknown]>) {
    const fetchMessages = mock(async (_options: { limit: number }) => new Map(messages));
    const client = {
      channels: { fetch: mock(async () => ({ isTextBased: () => true, messages: { fetch: fetchMessages } })) },
    } as never;
    return { client, fetchMessages };
  }

  test('seuls les messages de membres de la fenêtre comptent', async () => {
    const { client } = salon([
      message('1', 2),
      message('2', 5),
      message('3', 1, { author: { bot: true } }),
      message('4', 1, { webhookId: 'webhook' }),
      message('5', 1, { system: true }),
      message('6', 30),
    ]);

    expect(await countRecentMemberMessages(client, 'salon-1', new Date(now - 15 * 60 * 1000))).toBe(2);
  });

  test('une seule page de messages est lue', async () => {
    const { client, fetchMessages } = salon([]);
    await countRecentMemberMessages(client, 'salon-1', new Date(now - 15 * 60 * 1000));
    expect(fetchMessages).toHaveBeenCalledWith({ limit: 100 });
  });

  test('salon injoignable : zéro, le drop attend son plafond de retard', async () => {
    const client = { channels: { fetch: mock(async () => null) } } as never;
    expect(await countRecentMemberMessages(client, 'salon-1', new Date(now))).toBe(0);
  });
});
