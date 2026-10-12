import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { Events, PermissionFlagsBits, type Client } from 'discord.js';

/**
 * Transfert et récupération d'un salon : le droit d'écrire suit le mode du
 * salon, pas la propriété. Seul « Moi seul » le fait passer d'un propriétaire
 * à l'autre ; « Personne » ne le donne à personne ; les trois autres modes ne
 * touchent pas à `SendMessages`, ni de l'ancien ni du nouveau propriétaire.
 *
 * Le chemin est le vrai : interaction du panneau, écouteur, `applyOwnershipTransfer`.
 */

const prismaMock = {
  tempVoiceModPermissionsConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
  tempVoiceAccessRequestConfig: { findUnique: mock(async () => null) },
  tempVoiceChannel: {
    findMany: mock(async () => []),
    findUnique: mock(async () => null),
    create: mock(async () => ({})),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
  },
};

const cachePath = path.resolve(import.meta.dir, '../../utils/cache.ts');
const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(cachePath, {
    getCachedGuild: mock(async () => ({ tempVoiceEnabled: true })),
  })],
];
for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { registerTempVoiceListener, tempChannels, modeDuSalon } = await import('../../events/tempVoice.js');

const GUILD = '100000000000000000';
const ANCIEN = '200000000000000000';
const NOUVEAU = '300000000000000000';
const CHANNEL = '400000000000000000';
const ECRIRE = PermissionFlagsBits.SendMessages;

type Surcharge = ReturnType<typeof surcharge>;

function surcharge(allow = 0n, deny = 0n) {
  return {
    allow: { bitfield: allow, has: (bit: bigint) => (allow & bit) === bit },
    deny: { bitfield: deny, has: (bit: bigint) => (deny & bit) === bit },
  };
}

/** Applique un patch comme Discord : `true` autorise, `false` refuse, `null` efface. */
function appliquer(courante: Surcharge, patch: Record<string, unknown>): Surcharge {
  let allow = courante.allow.bitfield;
  let deny = courante.deny.bitfield;
  for (const [nom, valeur] of Object.entries(patch)) {
    const bit = PermissionFlagsBits[nom as keyof typeof PermissionFlagsBits];
    if (bit === undefined) continue;
    allow = valeur === true ? allow | bit : allow & ~bit;
    deny = valeur === false ? deny | bit : deny & ~bit;
  }
  return surcharge(allow, deny);
}

/** Salon dont les surcharges de départ sont données ; le cache ne bouge qu'à `sync`, comme discord.js. */
function salon(depart: Array<[string, Surcharge]>) {
  const cache = new Map<string, Surcharge>(depart);
  const ecrit = new Map<string, Surcharge>(depart);
  const edits: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const channel = {
    id: CHANNEL,
    type: 2,
    guild: { id: GUILD, roles: { everyone: { id: GUILD } } },
    members: new Map<string, unknown>(),
    parentId: null as string | null,
    parent: null as unknown,
    send: mock(async () => ({ id: '888888888888888888' })),
    permissionOverwrites: {
      cache,
      edit: mock(async (cible: string | { id: string }, patch: Record<string, unknown>) => {
        const id = typeof cible === 'string' ? cible : cible.id;
        edits.push({ id, patch });
        ecrit.set(id, appliquer(ecrit.get(id) ?? surcharge(), patch));
      }),
    },
  };
  const sync = () => { cache.clear(); for (const [id, s] of ecrit) cache.set(id, s); };
  return { channel, edits, sync };
}

function membre(id: string) {
  return {
    id,
    displayName: `membre-${id}`,
    user: { id, bot: false },
    permissions: { has: () => false },
    roles: { cache: { has: () => false } },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: null as string | null, disconnect: mock(async () => undefined) },
    send: mock(async () => undefined),
  };
}

function guildDe(membres: Array<ReturnType<typeof membre>>) {
  const parId = new Map(membres.map((entree) => [entree.id, entree]));
  return {
    id: GUILD,
    available: true,
    ownerId: '999999999999999999',
    roles: { everyone: { id: GUILD }, cache: new Map() },
    members: {
      me: { permissions: { has: () => true } },
      cache: parId,
      fetch: mock(async (id: string) => parId.get(id) ?? null),
    },
    channels: { cache: new Map(), fetch: mock(async () => null) },
  };
}

/** Interaction du panneau (menu de transfert ou bouton « Récupérer »). */
function interaction(options: { kind: 'transfer' | 'claim'; auteurId: string; channel: unknown; guild: unknown }) {
  const estTransfert = options.kind === 'transfer';
  const i = {
    guildId: GUILD,
    customId: estTransfert ? 'tempvoice:transfer_select' : 'tempvoice:claim',
    values: [NOUVEAU],
    channel: options.channel,
    guild: options.guild,
    member: membre(options.auteurId),
    user: { id: options.auteurId, bot: false },
    deferred: false,
    replied: false,
    isButton: () => !estTransfert,
    isModalSubmit: () => false,
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => estTransfert,
    isMessageComponent: () => true,
    isRepliable: () => true,
    message: { edit: mock(async () => undefined) },
    deferUpdate: mock(async () => { i.deferred = true; }),
    deferReply: mock(async () => { i.deferred = true; }),
    reply: mock(async () => { i.replied = true; }),
    editReply: mock(async () => undefined),
    followUp: mock(async () => undefined),
    showModal: mock(async () => undefined),
  };
  return i;
}

async function executer(options: {
  kind: 'transfer' | 'claim';
  depart: Array<[string, Surcharge]>;
  modeEcriture?: 'everyone' | 'ownerOnly' | 'nobody' | 'inVoice';
  /** Celui qui détient le salon avant l'action. */
  proprietaire: string;
}) {
  const { channel, edits, sync } = salon(options.depart);
  const auteur = options.kind === 'transfer' ? options.proprietaire : NOUVEAU;
  const guild = guildDe([membre(ANCIEN), membre(NOUVEAU)]);
  // « Récupérer » : le propriétaire est parti, celui qui récupère est en vocal.
  if (options.kind === 'claim') channel.members.set(NOUVEAU, membre(NOUVEAU));

  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (e: string, l: (...a: unknown[]) => unknown) => { listeners.set(e, l); return client; },
    once: () => client,
    isReady: () => false,
    guilds: { cache: new Map() },
  } as unknown as Client;
  registerTempVoiceListener(client);
  tempChannels.set(CHANNEL, {
    creatorId: options.proprietaire,
    ...(options.modeEcriture ? { modeEcriture: options.modeEcriture } : {}),
  });

  const avant = modeDuSalon(channel as never, tempChannels.get(CHANNEL)!);
  await listeners.get(Events.InteractionCreate)?.(interaction({ kind: options.kind, auteurId: auteur, channel, guild }));
  sync();
  const apres = modeDuSalon(channel as never, tempChannels.get(CHANNEL)!);
  const creatorId = tempChannels.get(CHANNEL)?.creatorId;
  tempChannels.delete(CHANNEL);

  const ecriture = (id: string) => edits.filter((entree) => entree.id === id).map((entree) => entree.patch.SendMessages);
  return { avant, apres, creatorId, ecriture };
}

// Départ de chaque mode, tel que `surchargesModeEcriture` le pose.
const everyoneFerme: Array<[string, Surcharge]> = [[GUILD, surcharge(0n, ECRIRE)]];
const departOwnerOnly: Array<[string, Surcharge]> = [...everyoneFerme, [ANCIEN, surcharge(ECRIRE, 0n)]];
const departNobody: Array<[string, Surcharge]> = [...everyoneFerme, [ANCIEN, surcharge(0n, ECRIRE)]];
// « Ceux qui sont en vocal » : l'ancien propriétaire, encore en vocal, écrit par présence.
const departInVoice: Array<[string, Surcharge]> = [...everyoneFerme, [ANCIEN, surcharge(ECRIRE, 0n)]];

describe("transfert : le droit d'écrire suit le mode du salon", () => {
  test("« Moi seul » : le droit passe de l'ancien au nouveau", async () => {
    const r = await executer({ kind: 'transfer', depart: departOwnerOnly, proprietaire: ANCIEN });
    expect(r.avant).toBe('ownerOnly');
    expect(r.ecriture(NOUVEAU)).toEqual([true]);
    expect(r.ecriture(ANCIEN)).toEqual([null]);
    expect(r.creatorId).toBe(NOUVEAU);
    expect(r.apres).toBe('ownerOnly');
  });

  test("« Personne » : le nouveau propriétaire n'écrit pas, ni l'ancien", async () => {
    const r = await executer({ kind: 'transfer', depart: departNobody, proprietaire: ANCIEN });
    expect(r.avant).toBe('nobody');
    expect(r.ecriture(NOUVEAU)).not.toContain(true);
    expect(r.ecriture(ANCIEN)).not.toContain(true);
    expect(r.creatorId).toBe(NOUVEAU);
    expect(r.apres).toBe('nobody');
  });

  test("« Ceux qui sont en vocal » : aucune écriture de SendMessages, l'ancien garde la sienne", async () => {
    const r = await executer({ kind: 'transfer', depart: departInVoice, modeEcriture: 'inVoice', proprietaire: ANCIEN });
    expect(r.avant).toBe('inVoice');
    expect(r.ecriture(NOUVEAU)).toEqual([undefined]);
    expect(r.ecriture(ANCIEN)).toEqual([undefined]);
    expect(r.apres).toBe('inVoice');
  });

  test("« Tout le monde » : SendMessages n'est touché pour personne", async () => {
    const r = await executer({
      kind: 'transfer',
      depart: [[GUILD, surcharge(ECRIRE, 0n)], [ANCIEN, surcharge(ECRIRE, 0n)]],
      modeEcriture: 'everyone',
      proprietaire: ANCIEN,
    });
    expect(r.ecriture(NOUVEAU)).toEqual([undefined]);
    expect(r.ecriture(ANCIEN)).toEqual([undefined]);
    expect(r.avant).toBe('everyone');
    expect(r.apres).toBe('everyone');
  });

  test("« Hérité » : SendMessages n'est touché pour personne", async () => {
    const r = await executer({ kind: 'transfer', depart: [[GUILD, surcharge()]], proprietaire: ANCIEN });
    expect(r.ecriture(NOUVEAU)).toEqual([undefined]);
    expect(r.ecriture(ANCIEN)).toEqual([undefined]);
    expect(r.avant).toBe(r.apres);
  });
});

describe('récupération : même règle que le transfert', () => {
  test("« Moi seul » : le droit passe de l'ancien propriétaire à celui qui récupère", async () => {
    const r = await executer({ kind: 'claim', depart: departOwnerOnly, proprietaire: ANCIEN });
    expect(r.creatorId).toBe(NOUVEAU);
    expect(r.ecriture(NOUVEAU)).toEqual([true]);
    expect(r.ecriture(ANCIEN)).toEqual([null]);
    expect(r.apres).toBe('ownerOnly');
  });
});
