import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { Events, MessageFlags, type Client } from 'discord.js';

/**
 * Interactions du panneau : aucune ne doit finir en « Cette interaction a
 * échoué », ni rester sur « réfléchit… ».
 *
 * Le double d'interaction se comporte comme celui de discord.js : un deuxième
 * acquittement lève, `editReply` / `followUp` sans acquittement lèvent, et le
 * premier acquittement lève passé trois secondes (horloge virtuelle, avancée
 * par les appels réseau et base). Le chemin est le vrai : écouteur, répartiteur.
 */

const GUILD = '100000000000000000';
const PROPRIO = '200000000000000000';
const CIBLE = '300000000000000000';
const CHANNEL = '400000000000000000';
const ROLE = '500000000000000000';
const ABSENT = '600000000000000000';

/** Chaque appel lent coûte deux secondes et demie : un seul passe, deux ne passent pas. */
const LATENCE_MS = 2_500;
const horloge = { ms: 0 };
let ligneReglages: Record<string, unknown> | null = null;
let baseLente = false;

const prismaMock = {
  tempVoiceModPermissionsConfig: { findUnique: mock(async () => ligneReglages), upsert: mock(async () => ({})) },
  tempVoiceAccessRequestConfig: { findUnique: mock(async () => null) },
  tempVoiceChannel: {
    findMany: mock(async () => []),
    findUnique: mock(async () => {
      if (baseLente) horloge.ms += LATENCE_MS;
      return { roleId: ROLE };
    }),
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
  ['../../utils/logDispatch', () => ({ sendLogEmbed: mock(async () => undefined) })],
];
for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');

function membre(id: string) {
  return {
    id,
    displayName: `membre-${id}`,
    user: { id, bot: false, tag: `tag-${id}` },
    permissions: { has: () => false },
    roles: { cache: { has: () => false } },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: CHANNEL as string | null, disconnect: mock(async () => undefined) },
    send: mock(async () => undefined),
  };
}

/** Un salon dont les relectures (Discord) coûtent du temps virtuel quand `lent`. */
function scene(opts: { lent?: boolean; presents?: string[] } = {}) {
  const proprio = membre(PROPRIO);
  const connus = new Map<string, ReturnType<typeof membre>>([[PROPRIO, proprio], [CIBLE, membre(CIBLE)]]);
  const guild = {
    id: GUILD,
    available: true,
    ownerId: '999999999999999999',
    roles: { everyone: { id: GUILD }, cache: new Map() },
    // Un occupant connu des états vocaux mais absent du cache des membres :
    // sa récupération est le second appel lent de la relecture.
    voiceStates: { cache: new Map([[ABSENT, { id: ABSENT, channelId: CHANNEL }]]) },
    members: {
      me: { permissions: { has: () => true } },
      cache: connus,
      fetch: mock(async (arg: unknown) => {
        if (typeof arg === 'object' && opts.lent) horloge.ms += LATENCE_MS;
        return typeof arg === 'string' ? connus.get(arg) ?? null : null;
      }),
    },
    channels: {
      cache: new Map(),
      fetch: mock(async () => { if (opts.lent) horloge.ms += LATENCE_MS; return null; }),
    },
  };
  const channel = {
    id: CHANNEL,
    type: 2,
    guild,
    members: new Map<string, unknown>((opts.presents ?? []).map((id) => [id, connus.get(id) ?? membre(id)])),
    parentId: null as string | null,
    parent: null as unknown,
    send: mock(async () => ({ id: '888888888888888888' })),
    setUserLimit: mock(async () => undefined),
    permissionOverwrites: { cache: new Map(), edit: mock(async () => undefined) },
  };
  return { guild, channel, proprio };
}

type Genre = 'bouton' | 'menu' | 'menuMembres' | 'modale';

interface Appel { methode: string; charge?: Record<string, unknown> }

/**
 * Interaction qui lève comme discord.js : un deuxième acquittement, un
 * acquittement tardif, une édition sans acquittement.
 */
function interactionStricte(p: {
  customId: string;
  genre: Genre;
  channel: unknown;
  guild: unknown;
  acteur?: ReturnType<typeof membre>;
  values?: string[];
  surEphemere?: boolean;
  client?: unknown;
}) {
  const appels: Appel[] = [];
  const rejets: string[] = [];
  const etat = { acquittee: false, deferee: false, resolue: false };
  const refuser = (message: string): never => {
    rejets.push(message);
    throw new Error(message);
  };
  const premierAck = (methode: string, charge?: Record<string, unknown>) => {
    if (etat.acquittee) refuser(`InteractionAlreadyReplied (${methode})`);
    if (horloge.ms > 3_000) refuser(`Unknown interaction 10062 (${methode} à ${horloge.ms} ms)`);
    etat.acquittee = true;
    appels.push({ methode, charge });
  };
  const suite = (methode: string, charge?: Record<string, unknown>) => {
    if (!etat.acquittee) refuser(`InteractionNotReplied (${methode})`);
    etat.resolue = true;
    appels.push({ methode, charge });
  };
  const acteur = p.acteur ?? membre(PROPRIO);
  const i = {
    guildId: p.guild ? GUILD : null,
    guildLocale: 'fr',
    locale: 'fr',
    customId: p.customId,
    ...(p.values ? { values: p.values } : {}),
    channel: p.channel,
    guild: p.guild,
    client: p.client ?? { channels: { fetch: async () => null } },
    member: acteur,
    user: { id: acteur.id, bot: false, tag: `tag-${acteur.id}` },
    get deferred() { return etat.deferee; },
    get replied() { return etat.acquittee && !etat.deferee; },
    isButton: () => p.genre === 'bouton',
    isModalSubmit: () => p.genre === 'modale',
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => p.genre === 'menu',
    isUserSelectMenu: () => p.genre === 'menuMembres',
    isMessageComponent: () => p.genre !== 'modale',
    isRepliable: () => true,
    fields: { getTextInputValue: () => 'x' },
    message: { flags: { has: () => Boolean(p.surEphemere) }, edit: mock(async () => undefined) },
    reply: async (c: Record<string, unknown>) => premierAck('reply', c),
    deferReply: async () => { premierAck('deferReply'); etat.deferee = true; },
    deferUpdate: async () => { premierAck('deferUpdate'); etat.deferee = true; },
    update: async (c: Record<string, unknown>) => premierAck('update', c),
    showModal: async (c: Record<string, unknown>) => premierAck('showModal', c),
    editReply: async (c: Record<string, unknown>) => suite('editReply', c),
    followUp: async (c: Record<string, unknown>) => suite('followUp', c),
  };
  return {
    i,
    appels,
    /** Appels que discord.js aurait rejetés : double acquittement, acquittement tardif, édition à vide. */
    rejets,
    methodes: () => appels.map((a) => a.methode),
    /** « Réfléchit… » : acquittée par `deferReply` mais jamais résolue. */
    get bloquee() { return etat.deferee && !etat.resolue; },
    get muette() { return !etat.acquittee; },
  };
}

async function cliquer(
  p: Parameters<typeof interactionStricte>[0],
  opts: { sansSalon?: boolean } = {},
) {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (e: string, l: (...a: unknown[]) => unknown) => { listeners.set(e, l); return client; },
    once: () => client,
    isReady: () => false,
    guilds: { cache: new Map() },
  } as unknown as Client;
  registerTempVoiceListener(client);
  if (!opts.sansSalon) tempChannels.set(CHANNEL, { creatorId: PROPRIO });
  const sc = interactionStricte(p);
  await listeners.get(Events.InteractionCreate)?.(sc.i);
  tempChannels.delete(CHANNEL);
  expect(sc.rejets).toEqual([]);
  return sc;
}

beforeEach(() => {
  horloge.ms = 0;
  ligneReglages = null;
  baseLente = false;
});

describe('Interaction sans salon ni action connus', () => {
  test('la carte d\'un salon supprimé reçoit une réponse éphémère', async () => {
    // MP d'une demande d'accès dont le salon n'existe plus : ni salon, ni serveur.
    const s = await cliquer({
      customId: `tempvoice:demande_ok:${CIBLE}:${CHANNEL}`,
      genre: 'bouton',
      channel: { id: 'dm', type: 1 },
      guild: null,
    });
    expect(s.methodes()).toEqual(['reply']);
    expect(s.appels[0].charge?.flags).toEqual([MessageFlags.Ephemeral]);
  });

  test('une fenêtre de saisie périmée ne laisse pas « réfléchit… »', async () => {
    // Ancienne fenêtre (`kick_modal`) soumise après une mise à jour : elle est
    // acquittée par le répartiteur, mais aucune branche ne la termine.
    const { channel, guild } = scene();
    const s = await cliquer({ customId: 'tempvoice:kick_modal', genre: 'modale', channel, guild });
    expect(s.muette).toBe(false);
    expect(s.bloquee).toBe(false);
    expect(s.methodes()).toEqual(['deferReply', 'editReply']);
  });

  test('un bouton inconnu reçoit une réponse au lieu du silence', async () => {
    const { channel, guild } = scene();
    const s = await cliquer({ customId: 'tempvoice:retire', genre: 'bouton', channel, guild });
    expect(s.methodes()).toEqual(['reply']);
  });

  test('un clic déjà traité n\'est pas doublé par la réponse de secours', async () => {
    // `followUp` après `deferUpdate` répond sans passer `replied` à vrai : le
    // contrôle doit compter les réponses faites, pas lire `replied`.
    const { channel, guild } = scene();
    const s = await cliquer({
      customId: 'tempvoice:membre_ici',
      genre: 'menu',
      values: ['700000000000000000'],
      channel,
      guild,
      surEphemere: true,
    });
    expect(s.methodes()).toEqual(['deferUpdate', 'followUp']);
  });

  test('l\'ouverture d\'une fenêtre de saisie reste le seul acquittement', async () => {
    const { channel, guild } = scene();
    const s = await cliquer({ customId: 'tempvoice:limit', genre: 'bouton', channel, guild });
    expect(s.methodes()).toEqual(['showModal']);
  });
});

describe('Acquitter avant toute lecture lente', () => {
  test('« Membres » : la relecture du salon ne précède pas l\'acquittement', async () => {
    // Deux relectures de 2,5 s : l'ancien `reply` partait après 5 s.
    const { channel, guild } = scene({ lent: true });
    const s = await cliquer({ customId: 'tempvoice:membres', genre: 'bouton', channel, guild });
    expect(horloge.ms).toBeGreaterThan(3_000);
    expect(s.muette).toBe(false);
    expect(s.methodes()).toEqual(['deferReply', 'editReply']);
  });

  test('« Salon » : la lecture de la base ne précède pas l\'acquittement', async () => {
    baseLente = true;
    horloge.ms = 1_000; // les lectures de l'écouteur ont déjà consommé du temps
    const { channel, guild } = scene();
    const s = await cliquer({ customId: 'tempvoice:salon', genre: 'bouton', channel, guild });
    expect(s.methodes()).toEqual(['deferReply', 'editReply']);
  });

  test('depuis un sous-panneau, la porte reprend le message sans `update` tardif', async () => {
    const { channel, guild } = scene({ lent: true });
    const s = await cliquer({ customId: 'tempvoice:membres', genre: 'bouton', channel, guild, surEphemere: true });
    expect(s.methodes()).toEqual(['deferUpdate', 'editReply']);
  });

  test('« Déplacer » : la proposition est refermée après acquittement', async () => {
    // Base (2,5 s) puis relecture du salon (2,5 s) avant le verdict : la
    // proposition se referme après l'acquittement, jamais par un `update` tardif
    // que Discord rejetterait.
    baseLente = true;
    const { channel, guild } = scene({ lent: true });
    const s = await cliquer({
      customId: 'tempvoice:resa_deplacer',
      genre: 'bouton',
      channel,
      guild,
      surEphemere: true,
    });
    expect(s.methodes()).toEqual(['deferUpdate', 'editReply']);
    expect(s.bloquee).toBe(false);
  });

  test('l\'ancien « kick » en mode plat : le sélecteur des présents arrive après l\'acquittement', async () => {
    ligneReglages = { panelMode: 'FLAT' };
    const { channel, guild } = scene({ lent: true, presents: [CIBLE] });
    const s = await cliquer({ customId: 'tempvoice:kick', genre: 'bouton', channel, guild });
    expect(s.muette).toBe(false);
    expect(s.methodes()).toEqual(['deferReply', 'editReply']);
    const composants = (s.appels[1].charge?.components ?? []) as unknown[];
    expect(composants).toHaveLength(1);
  });

  test('« Réserver » : la lecture de la réservation en cours ne précède pas l\'acquittement', async () => {
    baseLente = true;
    horloge.ms = 1_000;
    const { channel, guild } = scene();
    const s = await cliquer({ customId: 'tempvoice:reserve', genre: 'bouton', channel, guild });
    expect(s.methodes()).toEqual(['deferReply', 'editReply']);
  });
});
