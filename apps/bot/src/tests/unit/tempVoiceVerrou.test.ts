import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { Events, type Client } from 'discord.js';

/**
 * Le staff garde l'entrée d'un salon fermé à @everyone : verrou, réservation à
 * un rôle ou à des membres, ancien panneau, salon créé verrouillé. Les rôles
 * staff du serveur et le membre qui agit (s'il n'est pas propriétaire) reçoivent
 * « Voir le salon » + « Se connecter » AVANT que @everyone soit fermé.
 *
 * Le chemin est le vrai : interaction (ou état vocal), écouteur, traitement.
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

let config: Record<string, unknown> | null = null;

const cachePath = path.resolve(import.meta.dir, '../../utils/cache.ts');
const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(cachePath, {
    getCachedGuild: mock(async () => config),
  })],
];
for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');

const GUILD = '100000000000000000';
const PROPRIO = '200000000000000000';
const MODO = '300000000000000000';
const CIBLE = '310000000000000000';
const CHANNEL = '400000000000000000';
const ROLE_BASE = '510000000000000000';
const ROLE_MODO = '520000000000000000';
const ROLE_TEST = '530000000000000000';
const ROLE_RESERVE = '540000000000000000';
const GENERATEUR = '600000000000000000';
const ROLES_STAFF = [ROLE_BASE, ROLE_MODO, ROLE_TEST];

const CONFIG_STAFF = {
  tempVoiceEnabled: true,
  baseStaffRoleId: ROLE_BASE,
  moderatorRoleId: ROLE_MODO,
  testStaffRoleId: ROLE_TEST,
};

interface Edit { id: string; patch: Record<string, unknown>; type?: number }

function membre(id: string, roles: string[] = []) {
  return {
    id,
    displayName: `membre-${id}`,
    user: { id, bot: false, tag: `tag-${id}` },
    permissions: { has: () => false },
    roles: { cache: { has: (r: string) => roles.includes(r) } },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: null as string | null, disconnect: mock(async () => undefined) },
    send: mock(async () => undefined),
  };
}

/** Salon qui note chaque `edit` dans l'ordre ; `refuser` fait rejeter ceux d'un identifiant. */
function salon(refuser: string[] = []) {
  const edits: Edit[] = [];
  const channel = {
    id: CHANNEL,
    type: 2,
    guild: { id: GUILD, roles: { everyone: { id: GUILD } } } as unknown,
    members: new Map<string, unknown>(),
    parentId: null as string | null,
    parent: null as unknown,
    send: mock(async () => ({ id: '888888888888888888' })),
    setUserLimit: mock(async () => undefined),
    delete: mock(async () => undefined),
    permissionOverwrites: {
      cache: new Map(),
      edit: mock(async (cible: string | { id: string }, patch: Record<string, unknown>, opts?: { type?: number }) => {
        const id = typeof cible === 'string' ? cible : cible.id;
        edits.push({ id, patch, type: opts?.type });
        if (refuser.includes(id)) throw new Error('Missing Permissions');
      }),
    },
  };
  return { channel, edits };
}

function guildDe(membres: Array<ReturnType<typeof membre>>, channel?: unknown) {
  const parId = new Map(membres.map((entree) => [entree.id, entree]));
  return {
    id: GUILD,
    name: 'serveur',
    available: true,
    ownerId: '999999999999999999',
    preferredLocale: 'fr',
    roles: { everyone: { id: GUILD }, cache: new Map([[ROLE_RESERVE, { id: ROLE_RESERVE }]]) },
    members: {
      me: { permissions: { has: () => true } },
      cache: parId,
      fetch: mock(async (id: string) => parId.get(id) ?? null),
    },
    channels: {
      cache: new Map(),
      fetch: mock(async () => null),
      create: mock(async () => channel),
    },
  };
}

type Action = 'bascule_verrou' | 'lock' | 'reserve_select' | 'reserve_membres';

function interaction(action: Action, acteur: ReturnType<typeof membre>, channel: unknown, guild: unknown) {
  const select = action === 'reserve_select' || action === 'reserve_membres';
  const i = {
    guildId: GUILD,
    customId: `tempvoice:${action}`,
    ...(action === 'reserve_select' ? { values: [ROLE_RESERVE] } : {}),
    ...(action === 'reserve_membres' ? { values: [CIBLE] } : {}),
    channel,
    guild,
    member: acteur,
    user: acteur.user,
    deferred: false,
    replied: false,
    isButton: () => !select,
    isModalSubmit: () => false,
    isRoleSelectMenu: () => action === 'reserve_select',
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => action === 'reserve_membres',
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

function ecouteurs() {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (e: string, l: (...a: unknown[]) => unknown) => { listeners.set(e, l); return client; },
    once: () => client,
    isReady: () => false,
    guilds: { cache: new Map() },
  } as unknown as Client;
  registerTempVoiceListener(client);
  return listeners;
}

/** Un clic sur le panneau, par le propriétaire ou par un modérateur (rôle staff, non propriétaire). */
async function cliquer(action: Action, opts: { acteur?: 'proprietaire' | 'modo'; refuser?: string[] } = {}) {
  const { channel, edits } = salon(opts.refuser);
  const acteur = opts.acteur === 'proprietaire' ? membre(PROPRIO) : membre(MODO, [ROLE_MODO]);
  const guild = guildDe([membre(PROPRIO), acteur, membre(CIBLE)]);
  channel.guild = guild;
  tempChannels.set(CHANNEL, { creatorId: PROPRIO });
  try {
    await ecouteurs().get(Events.InteractionCreate)?.(interaction(action, acteur, channel, guild));
  } finally {
    tempChannels.delete(CHANNEL);
  }
  return { edits, acteurId: acteur.id };
}

/** Création d'un salon par l'entrée dans le salon générateur. */
async function creer(lockOnCreate: boolean) {
  const { channel, edits } = salon();
  const createur = membre(PROPRIO);
  const guild = guildDe([createur], channel);
  createur.guild = guild as never;
  channel.guild = guild;
  config = { ...config, tempVoiceChannelId: GENERATEUR, tempVoiceDefaults: { lockOnCreate } };
  const state = {
    member: createur,
    guild,
    channelId: GENERATEUR,
    channel: null,
    setChannel: mock(async () => undefined),
    disconnect: mock(async () => undefined),
  };
  try {
    await ecouteurs().get(Events.VoiceStateUpdate)?.({ channelId: null }, state);
  } finally {
    tempChannels.delete(CHANNEL);
  }
  return { edits };
}

const estEntree = (e: Edit) => e.patch.ViewChannel === true && e.patch.Connect === true;
const entreesRoles = (edits: Edit[]) => edits.filter((e) => ROLES_STAFF.includes(e.id) && estEntree(e));
const idsRoles = (edits: Edit[]) => entreesRoles(edits).map((e) => e.id).sort();
const indexVerrou = (edits: Edit[]) => edits.findIndex((e) => e.id === GUILD && e.patch.Connect === false);

beforeEach(() => {
  config = { ...CONFIG_STAFF };
});

describe('verrou : le staff garde l\'entrée', () => {
  test("un modérateur qui verrouille : rôles staff et lui-même entrent, AVANT la fermeture d'@everyone", async () => {
    const { edits, acteurId } = await cliquer('bascule_verrou');

    expect(idsRoles(edits)).toEqual([...ROLES_STAFF].sort());
    expect(entreesRoles(edits).every((e) => e.type === 0)).toBe(true);
    const lui = edits.filter((e) => e.id === acteurId && estEntree(e));
    expect(lui).toHaveLength(1);
    expect(lui[0]!.type).toBe(1);

    const verrou = indexVerrou(edits);
    expect(verrou).toBeGreaterThan(-1);
    for (const e of [...entreesRoles(edits), ...lui]) expect(edits.indexOf(e)).toBeLessThan(verrou);
    // Jamais de surcharge « entrée » posée sur @everyone.
    expect(edits.some((e) => e.id === GUILD && estEntree(e))).toBe(false);
  });

  test("le propriétaire qui verrouille : rôles staff oui, pas de surcharge d'entrée en son nom", async () => {
    const { edits } = await cliquer('bascule_verrou', { acteur: 'proprietaire' });

    expect(idsRoles(edits)).toEqual([...ROLES_STAFF].sort());
    expect(edits.some((e) => e.id === PROPRIO && estEntree(e))).toBe(false);
    expect(indexVerrou(edits)).toBeGreaterThan(-1);
  });

  test("ancien panneau (« lock ») : même garantie, avant le verrou", async () => {
    const { edits, acteurId } = await cliquer('lock');

    expect(idsRoles(edits)).toEqual([...ROLES_STAFF].sort());
    expect(edits.some((e) => e.id === acteurId && estEntree(e))).toBe(true);
    const verrou = indexVerrou(edits);
    expect(verrou).toBeGreaterThan(-1);
    for (const e of entreesRoles(edits)) expect(edits.indexOf(e)).toBeLessThan(verrou);
  });
});

describe('réservation : le staff garde l\'entrée', () => {
  test('réservation à un rôle : rôles staff et acteur entrent avant le verrou', async () => {
    const { edits, acteurId } = await cliquer('reserve_select');

    expect(edits.some((e) => e.id === ROLE_RESERVE)).toBe(true);
    expect(idsRoles(edits)).toEqual([...ROLES_STAFF].sort());
    expect(edits.some((e) => e.id === acteurId && estEntree(e))).toBe(true);
    const verrou = indexVerrou(edits);
    expect(verrou).toBeGreaterThan(-1);
    for (const e of entreesRoles(edits)) expect(edits.indexOf(e)).toBeLessThan(verrou);
  });

  test('réservation à des membres : rôles staff et acteur entrent avant le verrou', async () => {
    const { edits, acteurId } = await cliquer('reserve_membres');

    expect(edits.some((e) => e.id === CIBLE)).toBe(true);
    expect(idsRoles(edits)).toEqual([...ROLES_STAFF].sort());
    expect(edits.some((e) => e.id === acteurId && estEntree(e))).toBe(true);
    const verrou = indexVerrou(edits);
    expect(verrou).toBeGreaterThan(-1);
    for (const e of entreesRoles(edits)) expect(edits.indexOf(e)).toBeLessThan(verrou);
  });
});

describe('création : le staff entre seulement si le salon naît verrouillé', () => {
  test('lockOnCreate : les rôles staff ont l\'entrée', async () => {
    const { edits } = await creer(true);
    expect(idsRoles(edits)).toEqual([...ROLES_STAFF].sort());
    expect(edits.some((e) => e.id === PROPRIO)).toBe(false);
  });

  test('sans lockOnCreate : aucune surcharge staff', async () => {
    const { edits } = await creer(false);
    expect(edits.filter((e) => ROLES_STAFF.includes(e.id))).toEqual([]);
  });
});

describe('cas limites', () => {
  test("config sans rôle staff : aucun appel staff, le verrou est posé", async () => {
    config = { tempVoiceEnabled: true, baseStaffRoleId: null, moderatorRoleId: null, testStaffRoleId: null };
    const { edits } = await cliquer('bascule_verrou', { acteur: 'proprietaire' });

    expect(edits.filter((e) => estEntree(e))).toEqual([]);
    expect(indexVerrou(edits)).toBeGreaterThan(-1);
  });

  test("aucune config du serveur : le verrou est posé", async () => {
    config = null;
    const { edits } = await cliquer('bascule_verrou', { acteur: 'proprietaire' });
    expect(indexVerrou(edits)).toBeGreaterThan(-1);
  });

  test("une surcharge staff refusée par Discord : le verrou est posé quand même", async () => {
    const { edits } = await cliquer('bascule_verrou', { refuser: [ROLE_MODO, MODO] });

    // Les autres rôles ont bien été tentés malgré le refus, et le verrou suit.
    expect(idsRoles(edits)).toEqual([...ROLES_STAFF].sort());
    expect(indexVerrou(edits)).toBeGreaterThan(-1);
  });

  test("@everyone configuré comme rôle staff : jamais de surcharge d'entrée sur @everyone", async () => {
    config = { ...CONFIG_STAFF, baseStaffRoleId: GUILD };
    const { edits } = await cliquer('bascule_verrou', { acteur: 'proprietaire' });
    expect(edits.some((e) => e.id === GUILD && estEntree(e))).toBe(false);
  });
});
