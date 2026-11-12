/**
 * Le ramassage d'un drop respecte le module qui tient la ressource versée.
 *
 * Le cycle ne publie plus de drop dont le module est éteint, mais un drop déjà
 * posé restait cliquable : couper les niveaux pendant qu'un drop d'XP attendait
 * dans le salon, et `addXp` ne versait rien tout en laissant le membre lire
 * « Tu as ramassé 120 XP », sa place consommée pour rien. Le clic est désormais
 * refusé avant toute réservation.
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

const tx = {
  dropClaim: { create: mock(async () => ({})) },
  drop: {
    updateMany: mock(async () => ({ count: 1 })),
    findUnique: mock(async () => ({ claimCount: 1 })),
  },
};

const fauxPrisma = {
  drop: {
    findUnique: mock(async () => dropXp),
    update: mock(async () => ({})),
    updateMany: mock(async () => ({ count: 0 })),
  },
  dropClaim: { deleteMany: mock(async () => ({ count: 1 })) },
  rpgItem: { findUnique: mock(async () => null) },
  $transaction: mock(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (client: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[])),
};

const addXp = mock(async () => undefined);

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

const { countRecentMemberMessages, handleDropClaim } = await import('../../services/features/dropService.js');

const editReply = mock(async (_payload: { content: string }) => undefined);

function clic() {
  return {
    guildId: GUILD_ID,
    user: { id: 'membre-1' },
    client: {},
    deferReply: mock(async () => undefined),
    editReply,
  } as never;
}

beforeEach(() => {
  levelingActif = true;
  addXp.mockClear();
  editReply.mockClear();
  tx.dropClaim.create.mockClear();
});

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
