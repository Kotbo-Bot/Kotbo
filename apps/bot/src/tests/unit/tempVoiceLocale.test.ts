/**
 * Le panneau des salons vocaux temporaires suit la langue DU SERVEUR.
 *
 * La PR #543 avait traduit tout ce panneau en anglais EN DUR, alors que le bot
 * est en français et porte un i18n Paraglide avec une langue par serveur
 * (`Guild.language`, sinon la locale Discord du serveur). Ce fichier prouve la
 * correction là où elle se voit : sur la charge réellement envoyée à Discord.
 *
 * ⚠️ Le point dur n'est PAS « est-ce traduit ». C'est : **deux serveurs de
 * langues différentes rendent-ils chacun dans la sienne, dans le même
 * processus ?** Un état de module (une locale « courante » posée au passage)
 * rendrait le premier test vert et donnerait quand même, en production, le
 * panneau anglais au serveur français — simplement parce qu'un autre serveur a
 * cliqué entre-temps. D'où le second test, qui alterne les deux serveurs.
 *
 * `construirePanneau` et `reecrirePanneau` ne sont pas exportés : on passe par
 * l'écouteur, exactement comme la production.
 */
import path from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import { Events, MessageFlags, type Client } from 'discord.js';

import { completeModuleMock } from '../helpers/moduleMock.js';

const GUILD_FR = '110000000000000001';
const GUILD_EN = '110000000000000002';
const GUILD_AUTO = '110000000000000003';
const OWNER = '220000000000000000';
const PRESENT = '230000000000000000';
const BOT = '330000000000000000';

/** Une ligne de configuration serveur par serveur : c'est `Guild.language` qui
 *  porte le choix explicite d'un admin, et `null` qui veut dire « automatique ». */
const configsParServeur = new Map<string, Record<string, unknown> | null>();

const prismaMock = {
  tempVoiceModPermissionsConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
  tempVoiceAccessRequestConfig: { findUnique: mock(async () => null) },
  tempVoiceChannel: {
    findMany: mock(async () => [] as Array<Record<string, unknown>>),
    findUnique: mock(async () => null as Record<string, unknown> | null),
    create: mock(async () => ({})),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
  },
};

const mocksModules: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(path.resolve(import.meta.dir, '../../utils/cache.ts'), {
    getCachedGuild: mock(async (guildId: string) => configsParServeur.get(guildId) ?? null),
    cache: { invalidateGuild: mock(async () => undefined) },
  })],
];

for (const [relatif, fabrique] of mocksModules) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');

function surchargeNulle() {
  return {
    allow: { bitfield: 0n, has: () => false },
    deny: { bitfield: 0n, has: () => false },
  };
}

function fauxMembre(id: string) {
  return {
    id,
    displayName: `membre-${id}`,
    user: { id, bot: false, tag: `m${id}#0001`, username: `m${id}` },
    permissions: { has: () => false },
    roles: { cache: { has: () => false } },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: null as string | null },
    send: mock(async () => undefined),
  };
}

function fauxPanneau() {
  const charges: Array<Record<string, unknown>> = [];
  return {
    charges,
    message: {
      id: '777100000000000001',
      flags: { has: (drapeau: number) => drapeau === MessageFlags.IsComponentsV2 && false },
      edit: mock(async (charge: Record<string, unknown>) => { charges.push(charge); return undefined; }),
      delete: mock(async () => undefined),
    },
  };
}

function fauxSalon(id: string, guildId: string, panneau: ReturnType<typeof fauxPanneau>, localeDiscord: string | null) {
  const membres = new Map<string, unknown>([[OWNER, fauxMembre(OWNER)]]);

  const channel = {
    id,
    type: 2, // ChannelType.GuildVoice
    name: `salon-${id}`,
    userLimit: 0,
    members: membres,
    messages: {
      fetch: mock(async (cible: unknown) => (typeof cible === 'string'
        ? panneau.message
        : new Map<string, unknown>([[panneau.message.id, panneau.message]]))),
    },
    permissionOverwrites: {
      cache: new Map<string, unknown>([[guildId, surchargeNulle()]]),
      edit: mock(async () => undefined),
      delete: mock(async () => undefined),
    },
    permissionsFor: () => ({ has: () => true }),
    setName: mock(async () => undefined),
    setUserLimit: mock(async () => undefined),
    delete: mock(async () => undefined),
    send: mock(async () => ({ id: '888100000000000001' })),
    parentId: null as string | null,
    parent: null as unknown,
    guild: {
      id: guildId,
      name: 'Serveur test',
      available: true,
      ownerId: '999999999999999999',
      // La locale Discord du serveur : le palier 2 de la cascade, utilisé quand
      // `Guild.language` vaut `null`.
      preferredLocale: localeDiscord,
      roles: { everyone: { id: guildId }, cache: new Map<string, unknown>() },
      members: {
        me: { id: BOT, permissions: { has: () => true } },
        cache: membres,
        fetch: mock(async (cible: unknown) => (typeof cible === 'string' ? membres.get(cible) ?? null : null)),
      },
      channels: { cache: new Map<string, unknown>(), fetch: mock(async () => null) },
    },
  };

  tempChannels.set(id, { creatorId: OWNER, panneauId: panneau.message.id });
  return channel;
}

function fauxClient() {
  const ecouteurs = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (evenement: string, ecouteur: (...args: unknown[]) => unknown) => {
      ecouteurs.set(evenement, ecouteur);
      return client;
    },
    once: () => client,
    isReady: () => false,
    guilds: { cache: new Map() },
  } as unknown as Client;
  return { client, ecouteurs };
}

async function jusqua(condition: () => boolean, limiteMs = 10_000): Promise<boolean> {
  const fin = Date.now() + limiteMs;
  while (!condition() && Date.now() < fin) await new Promise((resolve) => setTimeout(resolve, 10));
  return condition();
}

/**
 * Réécrit le panneau d'un salon du serveur donné et rend la charge que Discord a
 * reçue, sérialisée — c'est le motif déjà retenu par `tempVoiceListener.test.ts`.
 */
async function panneauDe(
  guildId: string,
  salonId: string,
  options: { language?: 'fr' | 'en' | null; localeDiscord?: string | null } = {},
): Promise<string> {
  configsParServeur.set(guildId, {
    tempVoiceEnabled: true,
    language: options.language ?? null,
    baseStaffRoleId: null,
    moderatorRoleId: null,
    testStaffRoleId: null,
  });

  const panneau = fauxPanneau();
  const channel = fauxSalon(salonId, guildId, panneau, options.localeDiscord ?? null);
  const { client, ecouteurs } = fauxClient();
  registerTempVoiceListener(client);

  await ecouteurs.get(Events.VoiceStateUpdate)?.(
    { channelId: null, channel: null },
    { channelId: channel.id, channel, guild: channel.guild, member: fauxMembre(PRESENT) },
  );

  const ecrit = await jusqua(() => panneau.charges.length > 0);
  expect(ecrit).toBe(true);
  tempChannels.delete(salonId);
  return JSON.stringify(panneau.charges.at(-1) ?? {});
}

/** La forme de la charge, textes effacés : deux langues doivent la partager. */
function squelette(rendu: string): string {
  const vider = (valeur: unknown): unknown => {
    if (typeof valeur === 'string') return '';
    if (Array.isArray(valeur)) return valeur.map(vider);
    if (valeur && typeof valeur === 'object') {
      return Object.fromEntries(Object.entries(valeur).map(([cle, v]) => [cle, vider(v)]));
    }
    return valeur;
  };
  return JSON.stringify(vider(JSON.parse(rendu)));
}

// Ce que le panneau dit, dans chaque langue. Les deux listes sont DISJOINTES :
// une seule chaîne commune aux deux rendrait les assertions `not.toContain`
// fausses sans rien signaler.
const EN_FRANCAIS = ['Ouvert', 'places illimitées', 'Kotbo · Salon temporaire', 'Salon', 'Membres', 'Propriété', 'Tout le monde'];
const EN_ANGLAIS = ['Open', 'unlimited slots', 'Kotbo · Temporary channel', 'Channel', 'Members', 'Ownership', 'Everyone'];

describe('le panneau vocal suit la langue du serveur', () => {
  test('un serveur en « fr » et un serveur en « en » rendent le MÊME panneau dans DEUX langues', async () => {
    const rendusFr = await panneauDe(GUILD_FR, '910000000000000001', { language: 'fr' });
    const rendusEn = await panneauDe(GUILD_EN, '910000000000000002', { language: 'en' });

    for (const attendu of EN_FRANCAIS) expect(rendusFr).toContain(attendu);
    for (const attendu of EN_ANGLAIS) expect(rendusEn).toContain(attendu);

    // Et surtout : aucune des deux langues ne fuit dans l'autre panneau. C'est
    // le bug de la #543 vu de l'autre côté — un serveur français qui lit son
    // panneau en anglais.
    expect(rendusFr).not.toContain('Kotbo · Temporary channel');
    expect(rendusFr).not.toContain('unlimited slots');
    expect(rendusEn).not.toContain('Kotbo · Salon temporaire');
    expect(rendusEn).not.toContain('places illimitées');

    // Même panneau : même SQUELETTE, seuls les textes changent. L'empreinte est
    // la forme de la charge avec les chaînes vidées — si la langue changeait
    // autre chose que du texte, les deux empreintes différeraient.
    expect(squelette(rendusFr)).toBe(squelette(rendusEn));
  }, 30_000);

  test('alterner les deux serveurs ne contamine jamais le rendu de l’autre', async () => {
    // ÉCHOUE SI : la langue cesse d'être un paramètre et devient un état de
    // module (une locale « courante » posée à chaque rendu). Le test précédent
    // resterait vert — il rend chaque serveur une fois, dans l'ordre — alors
    // qu'en production les serveurs s'entrelacent.
    const sequence: Array<{ guildId: string; language: 'fr' | 'en'; salonId: string }> = [
      { guildId: GUILD_FR, language: 'fr', salonId: '920000000000000001' },
      { guildId: GUILD_EN, language: 'en', salonId: '920000000000000002' },
      { guildId: GUILD_FR, language: 'fr', salonId: '920000000000000003' },
      { guildId: GUILD_EN, language: 'en', salonId: '920000000000000004' },
    ];

    for (const { guildId, language, salonId } of sequence) {
      const rendu = await panneauDe(guildId, salonId, { language });
      const attendus = language === 'fr' ? EN_FRANCAIS : EN_ANGLAIS;
      const interdits = language === 'fr' ? EN_ANGLAIS : EN_FRANCAIS;
      for (const texte of attendus) expect(rendu).toContain(texte);
      // `Salon` est un préfixe de `Salon temporaire` et `Channel` de
      // `Temporary channel` : on écarte les deux marqueurs sans ambiguïté.
      expect(rendu).not.toContain(interdits[2]);
      expect(rendu).not.toContain(interdits[1]);
    }
  }, 60_000);

  test('sans choix explicite, la locale Discord du serveur décide', async () => {
    // `Guild.language === null` veut dire « automatique » : la cascade descend
    // au palier 2, la locale déclarée du serveur Discord.
    const rendu = await panneauDe(GUILD_AUTO, '930000000000000001', {
      language: null,
      localeDiscord: 'fr-FR',
    });
    expect(rendu).toContain('Kotbo · Salon temporaire');
    expect(rendu).not.toContain('Kotbo · Temporary channel');

    // Et une locale Discord que le bot ne parle pas retombe sur l'anglais, son
    // repli — jamais sur un panneau à moitié traduit.
    const espagnol = await panneauDe(GUILD_AUTO, '930000000000000002', {
      language: null,
      localeDiscord: 'es-ES',
    });
    expect(espagnol).toContain('Kotbo · Temporary channel');
    expect(espagnol).not.toContain('Kotbo · Salon temporaire');
  }, 30_000);
});
