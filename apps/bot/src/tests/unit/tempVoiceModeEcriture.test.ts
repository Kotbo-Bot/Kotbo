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
// Un salon neuf par test : le registre des présences du module survit d'un test à l'autre.
let CHANNEL = '';
let numeroSalon = 0;
const ROLE_OFFICE = '510000000000000000';
const ROLE_R = '520000000000000000';
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
const typeDe = (id: string) => (id === GUILD || id === ROLE_OFFICE || id === ROLE_R ? 0 : 1);

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
    roles: { everyone: { id: GUILD }, cache: new Map([[ROLE_OFFICE, { id: ROLE_OFFICE }], [ROLE_R, { id: ROLE_R }]]) },
    members: {
      me: { permissions: { has: () => true } },
      cache: parId,
      fetch: mock(async (id: string) => parId.get(id) ?? null),
    },
    channels: { cache: new Map(), fetch: mock(async () => null) },
  };
}

type Action = 'mode_select' | 'bascule_verrou' | 'reserve_select' | 'transfer_select' | 'trust_select' | 'reserve_membres' | 'unlock' | 'chat' | `m_trust:${string}`;

function interaction(action: Action, auteurId: string, channel: unknown, guild: unknown, values: string[] = []) {
  const menuTexte = action === 'mode_select';
  const menuRole = action === 'reserve_select';
  const menuMembre = action === 'transfer_select' || action === 'trust_select' || action === 'reserve_membres';
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
    channel,
  };
}

beforeEach(() => {
  CHANNEL = String(400000000000000000n + BigInt(++numeroSalon));
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

describe('« ceux qui sont en vocal » : le propriétaire connecté écrit par sa présence', () => {
  test('verrou puis déverrouillage : le propriétaire connecté écrit toujours', async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    s.channel.members.set(PROPRIO, {});
    await s.cliquer('mode_select', ['inVoice']);
    await s.cliquer('bascule_verrou');
    await s.cliquer('bascule_verrou');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    expect(s.mode()).toBe('inVoice');
    s.fin();
  });

  test('re-sélection du mode : le propriétaire connecté garde la parole', async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    s.channel.members.set(PROPRIO, {});
    await s.cliquer('mode_select', ['inVoice']);
    await s.cliquer('mode_select', ['inVoice']);
    expect(s.ecrit(PROPRIO)).toBe('oui');
    s.fin();
  });

  test("transfert d'un salon verrouillé : l'ancien propriétaire présent garde la parole, le nouveau présent l'a", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    s.channel.members.set(PROPRIO, {});
    s.channel.members.set(NOUVEAU, {});
    await s.cliquer('mode_select', ['inVoice']);
    await s.cliquer('bascule_verrou');
    await s.cliquer('transfer_select', [NOUVEAU]);
    expect(s.creatorId()).toBe(NOUVEAU);
    expect(s.ecrit(PROPRIO)).toBe('oui');
    expect(s.ecrit(NOUVEAU)).toBe('oui');
    s.fin();
  });

  test("transfert d'un salon verrouillé : l'ancien propriétaire absent n'écrit plus", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    s.channel.members.set(NOUVEAU, {});
    await s.cliquer('mode_select', ['inVoice']);
    await s.cliquer('bascule_verrou');
    await s.cliquer('transfer_select', [NOUVEAU]);
    expect(s.creatorId()).toBe(NOUVEAU);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    await s.cliquer('bascule_verrou', [], NOUVEAU);
    expect(s.ferme()).toBe(false);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    s.fin();
  });
});

describe("« Personne » : les autorisations d'accès n'accordent pas l'écriture", () => {
  const personne = () => session({ depart: [[GUILD, fermeEcriture], [PROPRIO, fermeEcriture]], mode: 'nobody' });

  test('réservation à des membres : le propriétaire reste sans écriture', async () => {
    const s = personne();
    await s.cliquer('reserve_membres', [NOUVEAU]);
    expect(s.ferme()).toBe(true);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    s.fin();
  });

  test('réservation à un rôle : le propriétaire et le rôle restent sans écriture', async () => {
    const s = personne();
    await s.cliquer('reserve_select', [ROLE_OFFICE]);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    expect(s.ecrit(ROLE_OFFICE)).not.toBe('oui');
    s.fin();
  });

  test('« Autoriser » un membre : il entre sans écrire', async () => {
    const s = personne();
    await s.cliquer('trust_select', [NOUVEAU]);
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    expect(s.edits.some((e) => e.id === NOUVEAU && 'Connect' in e.patch)).toBe(true);
    s.fin();
  });

  test("bouton « Autoriser » de la fiche membre : il entre sans écrire", async () => {
    const s = personne();
    await s.cliquer(`m_trust:${NOUVEAU}`);
    expect(s.edits.some((e) => e.id === NOUVEAU && 'Connect' in e.patch)).toBe(true);
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    s.fin();
  });
});

describe("« Moi seul » : les membres autorisés entrent sans écrire, le propriétaire écrit", () => {
  const moiSeul = () => session({ depart: [[GUILD, fermeEcriture], [PROPRIO, ouvertEcriture]], mode: 'ownerOnly' });

  test("« Autoriser » un membre : il entre sans écrire", async () => {
    const s = moiSeul();
    await s.cliquer('trust_select', [NOUVEAU]);
    expect(s.edits.some((e) => e.id === NOUVEAU && 'Connect' in e.patch)).toBe(true);
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    s.fin();
  });

  test("bouton « Autoriser » de la fiche membre : il entre sans écrire", async () => {
    const s = moiSeul();
    await s.cliquer(`m_trust:${NOUVEAU}`);
    expect(s.edits.some((e) => e.id === NOUVEAU && 'Connect' in e.patch)).toBe(true);
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    s.fin();
  });

  test("re-sélection de « Moi seul » : le membre autorisé n'écrit toujours pas", async () => {
    const s = moiSeul();
    await s.cliquer('trust_select', [NOUVEAU]);
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    s.fin();
  });

  test("« Moi seul » choisi après « Autoriser » : le membre autorisé se tait", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    await s.cliquer('trust_select', [NOUVEAU]);
    expect(s.ecrit(NOUVEAU)).toBe('oui');
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    s.fin();
  });

  test('réservation à des membres : le propriétaire garde son écriture, le membre non', async () => {
    // Propriétaire sans surcharge d'écriture : seule la réservation peut la lui donner.
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, surcharge()]], mode: 'ownerOnly' });
    await s.cliquer('reserve_membres', [NOUVEAU]);
    expect(s.ferme()).toBe(true);
    expect(s.ecrit(PROPRIO)).toBe('oui');
    expect(s.ecrit(NOUVEAU)).not.toBe('oui');
    s.fin();
  });

  test('réservation à un rôle : le propriétaire garde son écriture', async () => {
    // Propriétaire sans surcharge d'écriture : seule la réservation peut la lui donner.
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, surcharge()]], mode: 'ownerOnly' });
    await s.cliquer('reserve_select', [ROLE_OFFICE]);
    expect(s.ecrit(PROPRIO)).toBe('oui');
    expect(s.ecrit(ROLE_OFFICE)).not.toBe('oui');
    s.fin();
  });

  test('de « ceux qui sont en vocal » à « Moi seul », propriétaire connecté : il écrit', async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    s.channel.members.set(PROPRIO, {});
    await s.cliquer('mode_select', ['inVoice']);
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.ecrit(GUILD)).toBe('non');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    s.fin();
  });
});

describe('anciens boutons du panneau', () => {
  test('« chat » : ferme puis rouvre, le mode mémorisé suit', async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    await s.cliquer('chat');
    expect(s.mode()).toBe('ownerOnly');
    expect(s.ecrit(GUILD)).toBe('non');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    await s.cliquer('chat');
    expect(s.mode()).toBe('everyone');
    expect(s.ecrit(GUILD)).toBe('oui');
    s.fin();
  });

  test('« unlock » : rétablit le mode mémorisé, pas « Moi seul » par défaut', async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, fermeEcriture]], mode: 'nobody' });
    await s.cliquer('bascule_verrou');
    await s.cliquer('unlock');
    expect(s.ferme()).toBe(false);
    expect(s.mode()).toBe('nobody');
    expect(s.ecrit(PROPRIO)).toBe('non');
    s.fin();
  });
});

describe("rôles autorisés d'office : seuls les rôles déjà surchargés sont réglés", () => {
  test("un rôle sans surcharge sur le salon n'en reçoit pas", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.channel.permissionOverwrites.cache.has(ROLE_OFFICE)).toBe(false);
    s.fin();
  });
});

describe('verrou en « ceux qui sont en vocal » et rôle réservé', () => {
  test("verrou, propriétaire absent : le verrou ne lui donne pas l'écriture", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture]], mode: 'inVoice' });
    await s.cliquer('bascule_verrou');
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    s.fin();
  });

  test("ancien « lock » puis « unlock », propriétaire connecté : il écrit", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture]], mode: 'everyone' });
    s.channel.members.set(PROPRIO, {});
    await s.cliquer('mode_select', ['inVoice']);
    await s.cliquer('lock' as never);
    expect(s.ecrit(PROPRIO)).toBe('oui');
    await s.cliquer('unlock');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    s.fin();
  });

  test("ancien « lock » en « ceux qui sont en vocal », propriétaire absent : il n'écrit pas", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture]], mode: 'inVoice' });
    await s.cliquer('lock' as never);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    s.fin();
  });

  /** Réserve le salon au rôle R en « Tout le monde » : la base le rend à la lecture suivante. */
  async function reserveEnToutLeMonde() {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture], [ROLE_OFFICE, ouvertEcriture]], mode: 'everyone' });
    prismaMock.tempVoiceChannel.findUnique.mockImplementation((async () => ({ roleId: ROLE_R })) as never);
    await s.cliquer('reserve_select', [ROLE_R]);
    expect(s.ecrit(ROLE_R)).toBe('oui');
    return s;
  }
  const finReserve = () => prismaMock.tempVoiceChannel.findUnique.mockImplementation((async () => null) as never);

  test("rôle réservé en « Tout le monde » puis « Moi seul » : il n'écrit plus", async () => {
    const s = await reserveEnToutLeMonde();
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.ecrit(ROLE_R)).not.toBe('oui');
    expect(s.ecrit(PROPRIO)).toBe('oui');
    expect(s.ecrit(ROLE_OFFICE)).toBe('oui');
    s.fin();
    finReserve();
  });

  test("rôle réservé en « Tout le monde » puis « Personne » : il n'écrit plus", async () => {
    const s = await reserveEnToutLeMonde();
    await s.cliquer('mode_select', ['nobody']);
    expect(s.ecrit(ROLE_R)).not.toBe('oui');
    s.fin();
    finReserve();
  });

  test("rôle réservé en « Tout le monde » puis « ceux qui sont en vocal » : la présence décide", async () => {
    const s = await reserveEnToutLeMonde();
    await s.cliquer('mode_select', ['inVoice']);
    expect(s.ecrit(ROLE_R)).not.toBe('oui');
    s.fin();
    finReserve();
  });

  test("rôle réservé autorisé d'office : il garde l'écriture en « Moi seul »", async () => {
    const s = session({ depart: [[GUILD, ouvertEcriture], [PROPRIO, ouvertEcriture], [ROLE_OFFICE, ouvertEcriture]], mode: 'everyone' });
    prismaMock.tempVoiceChannel.findUnique.mockImplementation((async () => ({ roleId: ROLE_OFFICE })) as never);
    await s.cliquer('mode_select', ['ownerOnly']);
    expect(s.ecrit(ROLE_OFFICE)).toBe('oui');
    s.fin();
    finReserve();
  });

  test("retour en « Tout le monde » après « Moi seul » : @everyone écrit, le rôle réservé n'a pas de bit", async () => {
    const s = await reserveEnToutLeMonde();
    await s.cliquer('mode_select', ['ownerOnly']);
    await s.cliquer('mode_select', ['everyone']);
    expect(s.ecrit(GUILD)).toBe('oui');
    expect(s.ecrit(ROLE_R)).not.toBe('non');
    s.fin();
    finReserve();
  });
});

describe('réservation en « ceux qui sont en vocal » : la présence décide', () => {
  test("propriétaire absent, réservation à un rôle : il n'écrit pas", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [ROLE_OFFICE, ouvertEcriture]], mode: 'inVoice' });
    await s.cliquer('reserve_select', [ROLE_R]);
    expect(s.ferme()).toBe(true);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    s.fin();
  });

  test("réservation à un rôle : le rôle réservé n'écrit pas", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [ROLE_OFFICE, ouvertEcriture]], mode: 'inVoice' });
    await s.cliquer('reserve_select', [ROLE_R]);
    expect(s.ecrit(ROLE_R)).not.toBe('oui');
    s.fin();
  });

  test("propriétaire absent, réservation à des membres : il n'écrit pas", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture]], mode: 'inVoice' });
    await s.cliquer('reserve_membres' as never, [NOUVEAU]);
    expect(s.ecrit(PROPRIO)).not.toBe('oui');
    s.fin();
  });

  test("propriétaire connecté, réservation à un rôle : il écrit", async () => {
    const s = session({ depart: [[GUILD, fermeEcriture], [PROPRIO, ouvertEcriture], [ROLE_OFFICE, ouvertEcriture]], mode: 'inVoice' });
    s.channel.members.set(PROPRIO, {});
    await s.cliquer('reserve_select', [ROLE_R]);
    expect(s.ecrit(PROPRIO)).toBe('oui');
    s.fin();
  });
});
