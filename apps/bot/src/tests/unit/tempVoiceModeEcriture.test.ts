import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { Events, PermissionFlagsBits, type Client } from 'discord.js';

/**
 * Mode d'écriture, verrou et transfert : le mode affiché est le même avant le
 * verrou, pendant et après le déverrouillage ; les rôles autorisés d'office
 * suivent le mode ; le transfert d'un salon verrouillé fait passer l'écriture.
 *
 * Le chemin est le vrai : interaction du panneau, écouteur, traitement. Le salon
 * applique chaque patch comme Discord, dans un cache lisible aussitôt.
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

const GUILD = '100000000000000000';
const PROPRIO = '200000000000000000';
const NOUVEAU = '300000000000000000';
const CHANNEL = '400000000000000000';
const ROLE_OFFICE = '510000000000000000';
const GENERATEUR = '600000000000000000';
const CATEGORIE = '700000000000000000';
const ECRIRE = PermissionFlagsBits.SendMessages;
const CONNECTER = PermissionFlagsBits.Connect;

let config: Record<string, unknown> = {};

const cachePath = path.resolve(import.meta.dir, '../../utils/cache.ts');
const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(cachePath, { getCachedGuild: mock(async () => config) })],
];
for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { registerTempVoiceListener, tempChannels, modeDuSalon } = await import('../../events/tempVoice.js');

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

/** Comme discord.js, chaque surcharge porte son type : 0 pour un rôle, 1 pour un membre. */
const typeDe = (id: string) => (id === GUILD || id === ROLE_OFFICE ? 0 : 1);

function salon(depart: Array<[string, Surcharge]>, categorie: Array<[string, Surcharge]> = []) {
  const cache = new Map<string, Surcharge & { type: number }>(depart.map(([id, s]) => [id, { ...s, type: typeDe(id) }]));
  const edits: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const channel = {
    id: CHANNEL,
    type: 2,
    guild: { id: GUILD, roles: { everyone: { id: GUILD } } },
    members: new Map<string, unknown>(),
    parentId: categorie.length ? CATEGORIE : null,
    parent: categorie.length ? { permissionOverwrites: { cache: new Map(categorie) } } : null,
    send: mock(async () => ({ id: '888888888888888888' })),
    permissionOverwrites: {
      cache,
      edit: mock(async (cible: string | { id: string }, patch: Record<string, unknown>) => {
        const id = typeof cible === 'string' ? cible : cible.id;
        edits.push({ id, patch });
        cache.set(id, { ...appliquer(cache.get(id) ?? surcharge(), patch), type: typeDe(id) });
      }),
    },
  };
  return { channel, edits };
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
    preferredLocale: 'fr',
    roles: { everyone: { id: GUILD }, cache: new Map([[ROLE_OFFICE, { id: ROLE_OFFICE }]]) },
    members: {
      me: { permissions: { has: () => true } },
      cache: parId,
      fetch: mock(async (id: string) => parId.get(id) ?? null),
    },
    channels: { cache: new Map(), fetch: mock(async () => null) },
  };
}

type Action = 'mode_select' | 'bascule_verrou' | 'reserve_select' | 'transfer_select';

function interaction(action: Action, auteurId: string, channel: unknown, guild: unknown, values: string[] = []) {
  const menuTexte = action === 'mode_select';
  const menuRole = action === 'reserve_select';
  const menuMembre = action === 'transfer_select';
  const i = {
    guildId: GUILD,
    customId: `tempvoice:${action}`,
    values,
    channel,
    guild,
    member: membre(auteurId),
    user: { id: auteurId, bot: false, tag: `tag-${auteurId}` },
    deferred: false,
    replied: false,
    isButton: () => !menuTexte && !menuRole && !menuMembre,
    isModalSubmit: () => false,
    isRoleSelectMenu: () => menuRole,
    isStringSelectMenu: () => menuTexte,
    isUserSelectMenu: () => menuMembre,
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

function ecouteur() {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (e: string, l: (...a: unknown[]) => unknown) => { listeners.set(e, l); return client; },
    once: () => client,
    isReady: () => false,
    guilds: { cache: new Map() },
  } as unknown as Client;
  registerTempVoiceListener(client);
  return listeners.get(Events.InteractionCreate)!;
}

type Mode = 'everyone' | 'ownerOnly' | 'nobody' | 'inVoice';

/** Un salon vivant et un propriétaire qui enchaîne des clics ; lit l'état entre deux. */
function session(opts: {
  depart: Array<[string, Surcharge]>;
  mode?: Mode;
  categorie?: Array<[string, Surcharge]>;
}) {
  const { channel, edits } = salon(opts.depart, opts.categorie);
  const guild = guildDe([membre(PROPRIO), membre(NOUVEAU)]);
  channel.guild = guild as never;
  const surInteraction = ecouteur();
  tempChannels.set(CHANNEL, {
    creatorId: PROPRIO,
    generateurId: GENERATEUR,
    ...(opts.mode ? { modeEcriture: opts.mode } : {}),
  });
  const entree = () => tempChannels.get(CHANNEL)!;
  return {
    edits,
    cliquer: (action: Action, values: string[] = [], auteur = PROPRIO) =>
      surInteraction(interaction(action, auteur, channel, guild, values)),
    mode: () => modeDuSalon(channel as never, entree()),
    creatorId: () => entree().creatorId,
    ecrit: (id: string): 'oui' | 'non' | 'rien' => {
      const s = channel.permissionOverwrites.cache.get(id);
      return s?.allow.has(ECRIRE) ? 'oui' : s?.deny.has(ECRIRE) ? 'non' : 'rien';
    },
    ferme: () => Boolean(channel.permissionOverwrites.cache.get(GUILD)?.deny.has(CONNECTER)),
    fin: () => tempChannels.delete(CHANNEL),
  };
}

beforeEach(() => {
  config = { tempVoiceEnabled: true, tempVoiceChannelId: GENERATEUR, tempVoiceDefaults: { autoAllowRoleIds: [ROLE_OFFICE] } };
});

const fermeEcriture = surcharge(0n, ECRIRE);
const ouvertEcriture = surcharge(ECRIRE, 0n);

describe("rôles autorisés d'office : ils suivent le mode d'écriture", () => {
  test("salon « locked » (Moi seul) puis « Personne » : le rôle perd l'écriture", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, ouvertEcriture], [ROLE_OFFICE, ouvertEcriture]], mode: 'ownerOnly' });
    await s.cliquer('mode_select', ['nobody']);
    expect(s.ecrit(ROLE_OFFICE)).toBe('non');
    s.fin();
  });

  test("salon « nobody » puis « Moi seul » : le rôle retrouve l'écriture", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, fermeEcriture], [ROLE_OFFICE, fermeEcriture]], mode: 'nobody' });
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.ecrit(ROLE_OFFICE)).toBe('oui');
    s.fin();
  });

  test("« Moi seul » : un refus nommé de la catégorie pour le rôle est respecté", async () => {
    const s = session({
      depart: [[GUILD, fermeEcriture], [PROPRIO, fermeEcriture], [ROLE_OFFICE, fermeEcriture]],
      mode: 'nobody',
      categorie: [[ROLE_OFFICE, fermeEcriture]],
    });
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.ecrit(ROLE_OFFICE)).toBe('non');
    s.fin();
  });

  test("« Tout le monde » : le rôle garde l'écriture, comme à la création", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, ouvertEcriture], [ROLE_OFFICE, ouvertEcriture]], mode: 'ownerOnly' });
    await s.cliquer('mode_select', ['everyone']);
    expect(s.ecrit(ROLE_OFFICE)).toBe('oui');
    s.fin();
  });
});

describe('verrou : le mode affiché ne bouge pas', () => {
  test("« Moi seul » verrouillé puis déverrouillé : @everyone refusé, propriétaire autorisé, mode inchangé", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, ouvertEcriture]], mode: 'ownerOnly' });
    await s.cliquer('bascule_verrou');
    expect(s.ferme()).toBe(true);
    expect(s.mode()).toBe('ownerOnly');
    await s.cliquer('bascule_verrou');
    expect(s.ferme()).toBe(false);
    expect(s.ecrit(GUILD)).toBe('non');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    expect(s.mode()).toBe('ownerOnly');
    s.fin();
  });

  test("« Personne » verrouillé : le propriétaire reste sans écriture, avant comme après", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, fermeEcriture]], mode: 'nobody' });
    await s.cliquer('bascule_verrou');
    expect(s.ferme()).toBe(true);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    expect(s.mode()).toBe('nobody');
    await s.cliquer('bascule_verrou');
    expect(s.ecrit(PROPRIO)).toBe('non');
    expect(s.ecrit(GUILD)).toBe('non');
    expect(s.mode()).toBe('nobody');
    s.fin();
  });

  test("« Tout le monde » verrouillé puis déverrouillé : @everyone retrouve l'écriture", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    await s.cliquer('bascule_verrou');
    expect(s.ferme()).toBe(true);
    expect(s.mode()).toBe('everyone');
    await s.cliquer('bascule_verrou');
    expect(s.ferme()).toBe(false);
    expect(s.ecrit(GUILD)).toBe('oui');
    expect(s.mode()).toBe('everyone');
    s.fin();
  });

  test("levée de réservation : le mode mémorisé redonne son écriture à @everyone et au propriétaire", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    await s.cliquer('reserve_select', [ROLE_OFFICE]);
    expect(s.ferme()).toBe(true);
    await s.cliquer('reserve_select', []);
    expect(s.ferme()).toBe(false);
    expect(s.ecrit(GUILD)).toBe('oui');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    s.fin();
  });
});

describe('transfert', () => {
  test("salon verrouillé en « Tout le monde » : l'écriture passe de l'ancien au nouveau", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    await s.cliquer('bascule_verrou');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    await s.cliquer('transfer_select', [NOUVEAU]);
    expect(s.creatorId()).toBe(NOUVEAU);
    expect(s.ecrit(NOUVEAU)).toBe('oui');
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    s.fin();
  });

  test("salon ouvert en « Tout le monde » : SendMessages n'est pas touché", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    await s.cliquer('transfer_select', [NOUVEAU]);
    expect(s.creatorId()).toBe(NOUVEAU);
    expect(s.ecrit(NOUVEAU)).not.toBe('non');
    expect(s.edits.filter((e) => e.id === NOUVEAU).some((e) => 'SendMessages' in e.patch)).toBe(false);
    s.fin();
  });

  test("« Hérité » non mémorisé dans une catégorie qui refuse l'écriture : le nouveau n'est pas coupé", async () => {
    const s = session({
      depart: [[GUILD, fermeEcriture]],
      categorie: [[GUILD, fermeEcriture]],
    });
    expect(s.mode()).toBe('nobody');
    await s.cliquer('transfer_select', [NOUVEAU]);
    expect(s.creatorId()).toBe(NOUVEAU);
    expect(s.edits.filter((e) => e.id === NOUVEAU).some((e) => e.patch.SendMessages === false)).toBe(false);
    s.fin();
  });

  test("« Personne » mémorisé : le nouveau propriétaire reste coupé", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, fermeEcriture]], mode: 'nobody' });
    await s.cliquer('transfer_select', [NOUVEAU]);
    expect(s.ecrit(NOUVEAU)).toBe('non');
    s.fin();
  });
});
