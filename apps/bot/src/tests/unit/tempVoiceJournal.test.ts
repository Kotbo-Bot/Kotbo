import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { Events, type Client } from 'discord.js';

/**
 * Journal du panneau : chaque clic sur un composant `tempvoice:` écrit une ligne
 * `voice_panel` — qui, sur quel salon, quelle action. Le chemin est le vrai :
 * interaction, écouteur, traitement ; seul l'envoi du log est observé.
 *
 * Les actions sont tirées d'une table explicite, et un test vérifie qu'elle
 * couvre exactement les libellés connus du journal : un composant ajouté au
 * panneau sans ligne ici fait échouer le fichier.
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

const envoyerLog = mock(async (..._args: unknown[]) => undefined);

const cachePath = path.resolve(import.meta.dir, '../../utils/cache.ts');
const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(cachePath, {
    getCachedGuild: mock(async () => ({ tempVoiceEnabled: true })),
  })],
  ['../../utils/logDispatch', () => ({ sendLogEmbed: envoyerLog })],
];
for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const { registerTempVoiceListener, tempChannels, LIBELLES_ACTIONS_PANNEAU } = await import('../../events/tempVoice.js');

const GUILD = '100000000000000000';
const PROPRIO = '200000000000000000';
const CIBLE = '300000000000000000';
const CHANNEL = '400000000000000000';
const ROLE = '500000000000000000';

type Genre = 'bouton' | 'menu' | 'menuMembres' | 'modale';

interface Cas {
  action: string;
  genre: Genre;
  /** Paramètres ajoutés à l'identifiant (`m_kick:<id>`…). */
  suffixe?: string;
  values?: string[];
  saisie?: string;
  libelle: string;
}

/** Une ligne par composant du panneau : boutons, menus, fenêtres, anciens identifiants compris. */
const CAS: Cas[] = [
  { action: 'salon', genre: 'bouton', libelle: "Ouvrir l'onglet « Salon »" },
  { action: 'membres', genre: 'bouton', libelle: "Ouvrir l'onglet « Membres »" },
  { action: 'propriete', genre: 'bouton', libelle: "Ouvrir l'onglet « Propriété »" },
  { action: 'reglages', genre: 'bouton', libelle: 'Ouvrir les réglages des modérateurs' },
  { action: 'demander', genre: 'bouton', libelle: "Demander l'accès au salon" },
  { action: 'bascule_verrou', genre: 'bouton', libelle: 'Verrouiller ou déverrouiller le salon' },
  { action: 'limit', genre: 'bouton', libelle: 'Ouvrir la saisie de la limite de places' },
  { action: 'rename', genre: 'bouton', libelle: 'Ouvrir la saisie du nom du salon' },
  { action: 'reserve', genre: 'bouton', libelle: 'Réserver le salon' },
  { action: 'claim', genre: 'bouton', libelle: 'Récupérer le salon' },
  // Fiche d'un membre
  { action: 'm_kick', genre: 'bouton', suffixe: CIBLE, libelle: 'Expulser un membre du salon' },
  { action: 'm_ban', genre: 'bouton', suffixe: CIBLE, libelle: 'Bannir un membre du salon' },
  { action: 'm_trust', genre: 'bouton', suffixe: CIBLE, libelle: 'Autoriser un membre à rejoindre le salon' },
  { action: 'm_untrust', genre: 'bouton', suffixe: CIBLE, libelle: "Retirer l'autorisation d'un membre" },
  { action: 'm_transfer', genre: 'bouton', suffixe: CIBLE, libelle: 'Transférer la propriété du salon' },
  // Suite d'une réservation
  { action: 'resa_rien', genre: 'bouton', libelle: 'Réservation : ne déplacer personne' },
  { action: 'resa_deplacer', genre: 'bouton', libelle: 'Réservation : déplacer les membres restants' },
  { action: 'resa_deconnecter', genre: 'bouton', libelle: 'Réservation : déconnecter les membres restants' },
  // Carte de décision d'une demande d'accès
  { action: 'demande_ok', genre: 'bouton', suffixe: `${CIBLE}:${CHANNEL}`, libelle: "Accepter une demande d'accès" },
  { action: 'demande_non', genre: 'bouton', suffixe: `${CIBLE}:${CHANNEL}`, libelle: "Refuser une demande d'accès" },
  { action: 'demande_ban', genre: 'bouton', suffixe: `${CIBLE}:${CHANNEL}`, libelle: "Bannir l'auteur d'une demande d'accès" },
  { action: 'mode_select', genre: 'menu', values: ['ownerOnly'], libelle: 'Changer qui peut écrire dans le chat' },
  { action: 'reglages_mod', genre: 'menu', values: ['renommer', 'limite'], libelle: 'Modifier les réglages des modérateurs' },
  { action: 'membre_ici', genre: 'menu', values: [CIBLE], libelle: "Ouvrir la fiche d'un membre présent" },
  { action: 'membre_select', genre: 'menuMembres', values: [CIBLE], libelle: "Ouvrir la fiche d'un membre" },
  { action: 'reserve_select', genre: 'menu', values: [ROLE], libelle: 'Réserver le salon à un rôle' },
  { action: 'reserve_membres', genre: 'menuMembres', values: [CIBLE], libelle: 'Réserver le salon à des membres' },
  { action: 'transfer_select', genre: 'menuMembres', values: [CIBLE], libelle: 'Transférer la propriété du salon' },
  { action: 'trust_select', genre: 'menuMembres', values: [CIBLE], libelle: 'Autoriser un membre à rejoindre le salon' },
  { action: 'kick_select', genre: 'menuMembres', values: [CIBLE], libelle: 'Expulser un membre du salon' },
  { action: 'ban_select', genre: 'menuMembres', values: [CIBLE], libelle: 'Bannir un membre du salon' },
  { action: 'limit_modal', genre: 'modale', saisie: '5', libelle: 'Définir la limite de places' },
  { action: 'rename_modal', genre: 'modale', saisie: 'Salon de test', libelle: 'Renommer le salon' },
  // Identifiants d'un ancien panneau
  { action: 'lock', genre: 'bouton', libelle: 'Verrouiller le salon (ancien panneau)' },
  { action: 'unlock', genre: 'bouton', libelle: 'Déverrouiller le salon (ancien panneau)' },
  { action: 'chat', genre: 'bouton', libelle: 'Ouvrir ou fermer le chat (ancien panneau)' },
  { action: 'kick', genre: 'bouton', libelle: 'Choisir un membre à expulser (ancien panneau)' },
  { action: 'ban', genre: 'bouton', libelle: 'Choisir un membre à bannir (ancien panneau)' },
  { action: 'trust', genre: 'bouton', libelle: 'Choisir un membre à autoriser (ancien panneau)' },
  { action: 'transfer', genre: 'bouton', libelle: 'Choisir le nouveau propriétaire (ancien panneau)' },
];

function membre(id: string) {
  return {
    id,
    displayName: `membre-${id}`,
    user: { id, bot: false, tag: `tag-${id}` },
    permissions: { has: () => false },
    roles: { cache: { has: () => false } },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: null as string | null, disconnect: mock(async () => undefined) },
    send: mock(async () => undefined),
  };
}

function salon() {
  const edit = mock(async () => undefined);
  return {
    id: CHANNEL,
    type: 2,
    guild: { id: GUILD, roles: { everyone: { id: GUILD } } },
    members: new Map<string, unknown>(),
    parentId: null as string | null,
    parent: null as unknown,
    send: mock(async () => ({ id: '888888888888888888' })),
    setUserLimit: mock(async () => undefined),
    permissionOverwrites: { cache: new Map(), edit },
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

function interaction(cas: Cas, channel: unknown, guild: unknown) {
  const i = {
    guildId: GUILD,
    customId: `tempvoice:${cas.action}${cas.suffixe ? `:${cas.suffixe}` : ''}`,
    ...(cas.values ? { values: cas.values } : {}),
    channel,
    guild,
    member: membre(PROPRIO),
    user: { id: PROPRIO, bot: false, tag: `tag-${PROPRIO}` },
    deferred: false,
    replied: false,
    isButton: () => cas.genre === 'bouton',
    isModalSubmit: () => cas.genre === 'modale',
    isRoleSelectMenu: () => false,
    isStringSelectMenu: () => cas.genre === 'menu',
    isUserSelectMenu: () => cas.genre === 'menuMembres',
    isMessageComponent: () => cas.genre !== 'modale',
    isRepliable: () => true,
    fields: { getTextInputValue: () => cas.saisie ?? '' },
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

async function cliquer(cas: Cas, opts: { acteur?: string; limiteEnPanne?: boolean } = {}) {
  const channel = salon();
  if (opts.limiteEnPanne) channel.setUserLimit.mockImplementation(async () => { throw new Error('Discord indisponible'); });
  const guild = guildDe([membre(PROPRIO), membre(CIBLE)]);
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (e: string, l: (...a: unknown[]) => unknown) => { listeners.set(e, l); return client; },
    once: () => client,
    isReady: () => false,
    guilds: { cache: new Map() },
  } as unknown as Client;
  registerTempVoiceListener(client);
  tempChannels.set(CHANNEL, { creatorId: PROPRIO });
  const i = interaction(cas, channel, guild);
  if (opts.acteur) {
    i.member = membre(opts.acteur);
    i.user = { id: opts.acteur, bot: false, tag: `tag-${opts.acteur}` };
  }
  // L'écouteur enveloppe les méthodes de réponse : les espions d'origine sont gardés ici.
  const reponses = [i.reply, i.editReply, i.followUp];
  try {
    await listeners.get(Events.InteractionCreate)?.(i);
  } finally {
    tempChannels.delete(CHANNEL);
  }
  return { channel, i, reponses };
}

function champ(embed: { toJSON: () => { fields?: Array<{ name: string; value: string }> } }, nom: string): string | undefined {
  return embed.toJSON().fields?.find((f) => f.name === nom)?.value;
}

beforeEach(() => {
  envoyerLog.mockClear();
  envoyerLog.mockImplementation(async () => undefined);
});

describe('journal du panneau : un log par clic', () => {
  test('la table couvre exactement les composants connus du journal', () => {
    expect(CAS.map((c) => c.action).sort()).toEqual(Object.keys(LIBELLES_ACTIONS_PANNEAU).sort());
    for (const cas of CAS) expect(LIBELLES_ACTIONS_PANNEAU[cas.action]).toBe(cas.libelle);
  });

  for (const cas of CAS) {
    test(`${cas.action} : log voice_panel avec membre, salon et action`, async () => {
      await cliquer(cas);

      expect(envoyerLog).toHaveBeenCalledTimes(1);
      const [, embed, eventType, composants, executeur, sources] = envoyerLog.mock.calls[0] as [
        unknown, { toJSON: () => { fields?: Array<{ name: string; value: string }> } }, string, unknown, string, string[],
      ];
      expect(eventType).toBe('voice_panel');
      expect(composants).toBeUndefined();
      expect(executeur).toBe(`tag-${PROPRIO}`);
      expect(sources).toEqual([CHANNEL]);
      expect(champ(embed, 'Membre')).toContain(`<@${PROPRIO}>`);
      expect(champ(embed, 'Membre')).toContain(`tag-${PROPRIO}`);
      expect(champ(embed, 'Salon vocal')).toContain(`<#${CHANNEL}>`);
      expect(champ(embed, 'Action')).toBe(cas.libelle);
      expect(champ(embed, 'Composant')).toContain(`tempvoice:${cas.action}`);
    });
  }

  test('un menu journalise le libellé réel du choix, une saisie sa valeur, une fiche sa cible', async () => {
    await cliquer(CAS.find((c) => c.action === 'mode_select')!);
    expect(champ((envoyerLog.mock.calls[0] as unknown[])[1] as never, 'Valeur choisie')).toBe('Moi seul');

    envoyerLog.mockClear();
    await cliquer(CAS.find((c) => c.action === 'rename_modal')!);
    expect(champ((envoyerLog.mock.calls[0] as unknown[])[1] as never, 'Valeur choisie')).toBe('Salon de test');

    envoyerLog.mockClear();
    await cliquer(CAS.find((c) => c.action === 'm_kick')!);
    expect(champ((envoyerLog.mock.calls[0] as unknown[])[1] as never, 'Cible')).toBe(`<@${CIBLE}>`);
  });

  test('refus explicite du propriétaire : Issue « Refusée », motif = texte répondu', async () => {
    const { i } = await cliquer(CAS.find((c) => c.action === 'limit')!, { acteur: CIBLE });
    const embed = (envoyerLog.mock.calls[0] as unknown[])[1] as never;
    expect(i.reply).toHaveBeenCalledTimes(1);
    expect(champ(embed, 'Issue')).toBe('Refusée');
    expect(champ(embed, 'Motif')).toBeTruthy();
  });

  test('traitement qui lève : Issue « Erreur »', async () => {
    await cliquer(CAS.find((c) => c.action === 'limit_modal')!, { limiteEnPanne: true });
    const embed = (envoyerLog.mock.calls[0] as unknown[])[1] as never;
    expect(champ(embed, 'Issue')).toBe('Erreur');
    expect(champ(embed, 'Motif')).toBeTruthy();
  });

  test("une action menée à terme n'a pas d'Issue : seule la réponse au membre est donnée", async () => {
    await cliquer(CAS.find((c) => c.action === 'limit_modal')!);
    const embed = (envoyerLog.mock.calls[0] as unknown[])[1] as never;
    expect(champ(embed, 'Issue')).toBeUndefined();
    expect(champ(embed, 'Réponse au membre')).toBeTruthy();
  });

  test("l'envoi du log qui lève n'empêche pas l'action", async () => {
    envoyerLog.mockImplementation(async () => { throw new Error('salon de logs supprimé'); });
    const { channel, reponses } = await cliquer(CAS.find((c) => c.action === 'limit_modal')!);

    expect(envoyerLog).toHaveBeenCalledTimes(1);
    expect(channel.setUserLimit).toHaveBeenCalledWith(5);
    expect(reponses.reduce((n, f) => n + f.mock.calls.length, 0)).toBeGreaterThan(0);
  });
});
