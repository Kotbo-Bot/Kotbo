import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import { Events, type Client } from 'discord.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import { DASHBOARD_ACCESS_ADMIN, type AuthClaims, type DashboardAccess } from '../../api/shared.js';

/**
 * Passation d'un salon temporaire dont le propriétaire part.
 *
 * Tout passe par les vrais écouteurs (`VoiceStateUpdate`, `InteractionCreate`)
 * et, pour le dashboard, par le vrai gestionnaire PATCH/GET : seuls Discord,
 * Prisma, le cache et l'envoi des logs sont simulés. Le temps est simulé
 * (`jest.useFakeTimers`) : les délais se font avancer, jamais attendre.
 */

// ─── Base simulée : une seule ligne de réglages, écrite par la route, lue par le bot ───
let ligne: Record<string, unknown> | null = null;
const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async () => ligne),
    upsert: mock(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      ligne = ligne ? { ...ligne, ...args.update } : { ...args.create };
      return ligne;
    }),
  },
  tempVoiceAccessRequestConfig: { findUnique: mock(async () => null), upsert: mock(async () => ({})) },
  tempVoiceChannel: {
    findMany: mock(async () => [] as Array<Record<string, unknown>>),
    findUnique: mock(async () => null),
    create: mock(async () => ({})),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
  },
  guild: { findUnique: mock(async () => ({ id: GUILD, tempVoiceEnabled: true })), update: mock(async () => ({})) },
  dashboardAuditLog: { create: mock(async () => ({})) },
};

const MODO_ROLE = '900000000000000001';
let guildConfig: Record<string, unknown> = {};
const envoyerLog = mock(async (..._args: unknown[]) => undefined);

const cachePath = path.resolve(import.meta.dir, '../../utils/cache.ts');
const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', () => completeModuleMock(cachePath, {
    getCachedGuild: mock(async () => guildConfig),
    cache: { invalidateGuild: mock(async () => undefined) },
  })],
  ['../../utils/logDispatch', () => ({ sendLogEmbed: envoyerLog })],
];
for (const [relatif, fabrique] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');
const { handleChannelsManagementRoutes, normalizeTempVoiceModPermissionsInput } = await import(
  '../../api/routes/dashboard/modules/channels-management.js'
);

const GUILD = '100000000000000000';
const SALON = '400000000000000000';
const PROPRIO = '200000000000000000';
const MEMBRE = '300000000000000000';
const MEMBRE2 = '310000000000000000';
const MODO = '500000000000000000';
const BOT = '600000000000000000';
const SANS_CONVERSION = Symbol.for('kotbo.sansConversionV2');

// ─── Faux Discord ───

interface FauxMessage {
  id: string;
  charge: Record<string, unknown>;
  edit: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
}

let compteurMessages = 0;
function fauxMessage(charge: Record<string, unknown>): FauxMessage {
  compteurMessages += 1;
  return {
    id: `7${String(compteurMessages).padStart(17, '0')}`,
    charge,
    edit: mock(async () => undefined),
    delete: mock(async () => undefined),
  };
}

function fauxMembre(id: string, options: { staff?: boolean; bot?: boolean; mpFermes?: boolean } = {}) {
  const mp: FauxMessage[] = [];
  return {
    id,
    displayName: `nom-${id}`,
    user: { id, bot: options.bot ?? false, tag: `tag-${id}` },
    permissions: { has: () => false },
    roles: { cache: new Map<string, unknown>(options.staff ? [[MODO_ROLE, {}]] : []) },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: null as string | null },
    mp,
    send: mock(async (charge: Record<string, unknown>) => {
      if (options.mpFermes) throw new Error('Cannot send messages to this user');
      const message = fauxMessage(charge);
      mp.push(message);
      return message;
    }),
  };
}
type FauxMembre = ReturnType<typeof fauxMembre>;

function scene(presents: FauxMembre[], horsSalon: FauxMembre[] = []) {
  const tous = new Map([...presents, ...horsSalon].map((m) => [m.id, m]));
  const postes: FauxMessage[] = [];
  const guild = {
    id: GUILD,
    available: true,
    ownerId: '999999999999999999',
    preferredLocale: 'fr',
    roles: { everyone: { id: GUILD }, cache: new Map() },
    members: {
      me: { id: BOT, permissions: { has: () => true } },
      cache: tous,
      fetch: mock(async (id: string) => tous.get(id) ?? null),
    },
    channels: { cache: new Map(), fetch: mock(async () => null) },
  };
  const channel = {
    id: SALON,
    name: 'Salon de test',
    type: 2,
    guild,
    members: new Map<string, FauxMembre>(presents.map((m) => [m.id, m])),
    parentId: null as string | null,
    parent: null as unknown,
    messages: { fetch: mock(async () => null) },
    delete: mock(async () => undefined),
    send: mock(async (charge: Record<string, unknown>) => {
      const message = fauxMessage(charge);
      postes.push(message);
      return message;
    }),
    permissionOverwrites: { cache: new Map(), edit: mock(async () => undefined) },
  };
  for (const m of presents) m.voice.channelId = SALON;

  const ecouteurs = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: (e: string, l: (...a: unknown[]) => unknown) => { ecouteurs.set(e, l); return client; },
    once: () => client,
    isReady: () => false,
    guilds: { cache: new Map() },
    channels: { fetch: mock(async (id: string) => (id === SALON ? channel : null)) },
  };
  registerTempVoiceListener(client as unknown as Client);
  tempChannels.set(SALON, { creatorId: PROPRIO });

  const quitter = async (m: FauxMembre) => {
    channel.members.delete(m.id);
    m.voice.channelId = null;
    await ecouteurs.get(Events.VoiceStateUpdate)?.(
      { channelId: SALON, channel },
      { channelId: null, channel: null, guild, member: m },
    );
    await vider();
  };
  const entrer = async (m: FauxMembre) => {
    channel.members.set(m.id, m);
    m.voice.channelId = SALON;
    await ecouteurs.get(Events.VoiceStateUpdate)?.(
      { channelId: null, channel: null },
      { channelId: SALON, channel, guild, member: m },
    );
    await vider();
  };

  /** Un clic : `ou` dit où vit le composant (sous-panneau éphémère, chat du salon, MP). */
  const cliquer = async (
    auteur: FauxMembre,
    customId: string,
    options: { valeurs?: string[]; ou?: 'ephemere' | 'salon' | 'mp'; message?: FauxMessage; guildId?: string } = {},
  ) => {
    const ou = options.ou ?? 'ephemere';
    const textes: string[] = [];
    const noter = (charge: unknown) => {
      const c = charge as { content?: string; embeds?: Array<{ data?: { description?: string } }> };
      textes.push(c?.embeds?.[0]?.data?.description ?? c?.content ?? '');
    };
    const message = options.message ?? fauxMessage({});
    const i = {
      guildId: options.guildId ?? (ou === 'mp' ? null : GUILD),
      customId,
      ...(options.valeurs ? { values: options.valeurs } : {}),
      channel: ou === 'mp' ? { type: 1, id: '800000000000000000' } : channel,
      guild: ou === 'mp' ? null : guild,
      member: ou === 'mp' ? null : auteur,
      user: auteur.user,
      client,
      deferred: false,
      replied: false,
      isButton: () => !options.valeurs,
      isStringSelectMenu: () => Boolean(options.valeurs),
      isUserSelectMenu: () => false,
      isRoleSelectMenu: () => false,
      isModalSubmit: () => false,
      isMessageComponent: () => true,
      isRepliable: () => true,
      message: Object.assign(message, { flags: { has: (f: number) => ou === 'ephemere' && f === 64 } }),
      deferUpdate: mock(async () => { i.deferred = true; }),
      deferReply: mock(async () => { i.deferred = true; }),
      reply: mock(async (c: unknown) => { i.replied = true; noter(c); }),
      editReply: mock(async (c: unknown) => { noter(c); }),
      followUp: mock(async (c: unknown) => { noter(c); }),
      showModal: mock(async () => undefined),
    };
    await ecouteurs.get(Events.InteractionCreate)?.(i);
    await vider();
    return { i, textes, dernier: textes[textes.length - 1] ?? '' };
  };

  return { channel, guild, postes, quitter, entrer, cliquer, ecouteurs, client };
}

/** Laisse les promesses en cours aboutir. */
async function vider(): Promise<void> {
  for (let n = 0; n < 5; n += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Fait passer le temps simulé par pas d'une seconde. */
async function avancer(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1000) {
    jest.advanceTimersByTime(1000);
    await vider();
  }
}

const proprietaire = () => tempChannels.get(SALON)?.creatorId;

/** Les messages « Récupérer le salon » postés dans le chat du salon. */
const messagesRecuperer = (postes: FauxMessage[]) => postes.filter((p) => idsDe(p.charge).includes('tempvoice:reclamer'));

function composantsDe(charge: unknown): Array<Record<string, unknown>> {
  const rangees = ((charge as { components?: unknown[] })?.components ?? []) as Array<{ components?: Array<{ data?: Record<string, unknown> }> }>;
  return rangees.flatMap((r) => (r.components ?? []).map((c) => c.data ?? (c as Record<string, unknown>)));
}
const idsDe = (charge: unknown) => composantsDe(charge).map((c) => String(c.custom_id));
const derniereEdition = (message: FauxMessage) => (message.edit.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
const texteEmbed = (charge: unknown) => {
  const e = (charge as { embeds?: Array<{ data?: { title?: string; description?: string } }> })?.embeds?.[0]?.data;
  return `${e?.title ?? ''} ${e?.description ?? ''}`;
};

interface LigneJournal { action: string; membre: string; proprietaire?: string; issue?: string; canal?: string; executeur: unknown }
function journal(): LigneJournal[] {
  return envoyerLog.mock.calls.map((appel) => {
    const [, embed, type, , executeur] = appel as [unknown, { toJSON: () => { fields?: Array<{ name: string; value: string }> } }, string, unknown, unknown];
    expect(type).toBe('voice_panel');
    const champ = (nom: string) => embed.toJSON().fields?.find((f) => f.name === nom)?.value;
    return {
      action: champ('Action') ?? '',
      membre: champ('Membre') ?? '',
      proprietaire: champ('Propriétaire'),
      issue: champ('Issue'),
      canal: champ('Canal'),
      executeur,
    };
  });
}
const actions = () => journal().map((l) => l.action);

beforeEach(() => {
  jest.useFakeTimers();
  ligne = null;
  guildConfig = { tempVoiceEnabled: true, moderatorRoleId: MODO_ROLE, language: 'fr' };
  envoyerLog.mockClear();
  prismaMock.tempVoiceChannel.delete.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  tempChannels.delete(SALON);
});

describe('passation : le MP du propriétaire qui part', () => {
  test("scénario : le leader quitte, un simple membre récupère le salon après le délai", async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([proprio, membre]);

    await s.quitter(proprio);
    // Le MP porte le menu des présents, hors bots.
    expect(proprio.mp).toHaveLength(1);
    expect(idsDe(proprio.mp[0]!.charge)).toEqual([`tempvoice:leader:${PROPRIO}:${SALON}`]);
    expect(actions()).toContain('Départ du propriétaire : MP de passation envoyé');
    expect(journal().find((l) => l.action.startsWith('Départ'))?.canal).toBe('Message privé');

    // Pendant le délai, le membre est refusé avec le temps restant.
    const refus = await s.cliquer(membre, 'tempvoice:claim');
    expect(refus.dernier).toContain('réessaie dans 30 s');
    expect(proprietaire()).toBe(PROPRIO);
    expect(journal().at(-1)).toMatchObject({ action: 'Récupérer le salon', issue: 'Refusée' });

    await avancer(10_000);
    expect((await s.cliquer(membre, 'tempvoice:claim')).dernier).toContain('réessaie dans 20 s');
    expect(messagesRecuperer(s.postes)).toHaveLength(0);

    // Délai écoulé : le MP se referme, le message « Récupérer le salon » est posté.
    await avancer(20_000);
    expect(texteEmbed(derniereEdition(proprio.mp[0]!))).toContain('Délai écoulé');
    expect(actions()).toEqual(expect.arrayContaining(['Délai de passation écoulé sans choix', 'Message « Récupérer le salon » posté']));
    const [message] = messagesRecuperer(s.postes);
    expect(message).toBeDefined();
    expect(texteEmbed(message!.charge)).toContain(`<@${PROPRIO}> a quitté le salon`);

    const prise = await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: message! });
    expect(proprietaire()).toBe(MEMBRE);
    expect(prise.dernier).toContain('a récupéré la propriété');
    expect(journal().at(-1)).toMatchObject({
      action: 'Récupérer le salon (message du salon)',
      proprietaire: `<@${PROPRIO}> → <@${MEMBRE}>`,
    });
    // Le message est mis à jour : bouton grisé, « Récupéré par », annulation pour le staff.
    const edition = derniereEdition(message!);
    expect(texteEmbed(edition)).toContain(`Récupéré par <@${MEMBRE}>`);
    expect(composantsDe(edition).find((c) => c.custom_id === 'tempvoice:reclamer')?.disabled).toBe(true);
    expect(idsDe(edition)).toContain(`tempvoice:reclam_annuler:${MEMBRE}:${SALON}`);
  });

  test('le choix du propriétaire, dans le délai, désigne le nouveau propriétaire', async () => {
    const proprio = fauxMembre(PROPRIO);
    const s = scene([proprio, fauxMembre(MEMBRE)]);
    await s.quitter(proprio);

    const choix = await s.cliquer(proprio, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE], ou: 'mp', message: proprio.mp[0] });
    expect(proprietaire()).toBe(MEMBRE);
    expect(choix.dernier).toContain(`**nom-${MEMBRE}** est le nouveau propriétaire`);
    expect(derniereEdition(proprio.mp[0]!).components).toEqual([]);
    expect(journal().at(-1)).toMatchObject({ proprietaire: `<@${PROPRIO}> → <@${MEMBRE}>` });

    // Plus rien après le délai : la passation est close.
    await avancer(31_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
  });

  test("un membre choisi qui a quitté le vocal est refusé, et le MP reste valable", async () => {
    const proprio = fauxMembre(PROPRIO);
    const parti = fauxMembre(MEMBRE);
    const s = scene([proprio, parti, fauxMembre(MEMBRE2)]);
    await s.quitter(proprio);
    await s.quitter(parti);

    const refus = await s.cliquer(proprio, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE], ou: 'mp', message: proprio.mp[0] });
    expect(refus.dernier).toContain('a quitté le salon : choisis quelqu\'un d\'autre');
    expect(proprietaire()).toBe(PROPRIO);
    expect(proprio.mp[0]!.edit).not.toHaveBeenCalled();
    expect(journal().at(-1)).toMatchObject({ issue: 'Refusée' });

    await s.cliquer(proprio, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE2], ou: 'mp', message: proprio.mp[0] });
    expect(proprietaire()).toBe(MEMBRE2);
  });

  test('un modérateur peut récupérer le salon pendant le délai', async () => {
    const proprio = fauxMembre(PROPRIO);
    const modo = fauxMembre(MODO, { staff: true });
    const s = scene([proprio, fauxMembre(MEMBRE), modo]);
    await s.quitter(proprio);

    await s.cliquer(modo, 'tempvoice:claim');
    expect(proprietaire()).toBe(MODO);
    expect(texteEmbed(derniereEdition(proprio.mp[0]!))).toContain(`récupéré par <@${MODO}>`);
    await avancer(31_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
  });

  test('le propriétaire qui revient pendant le délai annule la passation', async () => {
    const proprio = fauxMembre(PROPRIO);
    const s = scene([proprio, fauxMembre(MEMBRE)]);
    await s.quitter(proprio);
    await avancer(10_000);
    await s.entrer(proprio);

    expect(texteEmbed(derniereEdition(proprio.mp[0]!))).toContain('la passation est annulée');
    expect(actions()).toContain('Passation annulée : retour du propriétaire');
    await avancer(31_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
    expect(proprietaire()).toBe(PROPRIO);

    // Le MP est périmé.
    const tardif = await s.cliquer(proprio, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE], ou: 'mp', message: proprio.mp[0] });
    expect(tardif.dernier).toContain("n'est plus valable");
    expect(proprietaire()).toBe(PROPRIO);
  });

  test("le propriétaire qui revient après le message le retire", async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([proprio, membre]);
    await s.quitter(proprio);
    await avancer(31_000);
    const [message] = messagesRecuperer(s.postes);
    await s.entrer(proprio);

    expect(message!.delete).toHaveBeenCalled();
    expect(actions()).toContain('Message « Récupérer le salon » retiré : retour du propriétaire');
    const tardif = await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: message! });
    expect(tardif.dernier).toContain(`<@${PROPRIO}> est déjà propriétaire`);
    expect(proprietaire()).toBe(PROPRIO);
  });

  test('MP fermés : le message est posté tout de suite', async () => {
    const proprio = fauxMembre(PROPRIO, { mpFermes: true });
    const s = scene([proprio, fauxMembre(MEMBRE)]);
    await s.quitter(proprio);

    expect(messagesRecuperer(s.postes)).toHaveLength(1);
    expect(journal().find((l) => l.action === 'Message « Récupérer le salon » posté')).toBeDefined();
    expect(envoyerLog.mock.calls.some((c) => JSON.stringify((c[1] as { toJSON: () => unknown }).toJSON()).includes('MP impossible'))).toBe(true);
    // Aucun délai : le membre récupère sans attendre.
    await s.cliquer(fauxMembre(MEMBRE), 'tempvoice:claim');
    expect(proprietaire()).toBe(MEMBRE);
  });
});

describe('le message « Récupérer le salon »', () => {
  async function apresDelai(presents: FauxMembre[]) {
    const proprio = fauxMembre(PROPRIO);
    const s = scene([proprio, ...presents]);
    await s.quitter(proprio);
    await avancer(31_000);
    const [message] = messagesRecuperer(s.postes);
    return { s, message: message!, proprio };
  }

  test('deux clics simultanés : un seul gagne, l\'autre est prévenu', async () => {
    const a = fauxMembre(MEMBRE);
    const b = fauxMembre(MEMBRE2);
    const { s, message } = await apresDelai([a, b]);

    const [ra, rb] = await Promise.all([
      s.cliquer(a, 'tempvoice:reclamer', { ou: 'salon', message }),
      s.cliquer(b, 'tempvoice:reclamer', { ou: 'salon', message }),
    ]);
    const gagnant = proprietaire();
    expect([MEMBRE, MEMBRE2]).toContain(gagnant!);
    const perdant = gagnant === MEMBRE ? rb : ra;
    expect(perdant.dernier).toContain(`<@${gagnant}> est déjà propriétaire`);
    expect(journal().filter((l) => l.proprietaire)).toHaveLength(1);
  });

  test('double clic du même membre : une seule prise', async () => {
    const a = fauxMembre(MEMBRE);
    const { s, message } = await apresDelai([a]);
    const [r1, r2] = await Promise.all([
      s.cliquer(a, 'tempvoice:reclamer', { ou: 'salon', message }),
      s.cliquer(a, 'tempvoice:reclamer', { ou: 'salon', message }),
    ]);
    expect(proprietaire()).toBe(MEMBRE);
    expect([r1.dernier, r2.dernier].filter((t) => t.includes('est déjà propriétaire'))).toHaveLength(1);
  });

  test('message caduc : clic tardif refusé en éphémère', async () => {
    const a = fauxMembre(MEMBRE);
    const b = fauxMembre(MEMBRE2);
    const { s, message } = await apresDelai([a, b]);
    await s.cliquer(a, 'tempvoice:reclamer', { ou: 'salon', message });
    const tardif = await s.cliquer(b, 'tempvoice:reclamer', { ou: 'salon', message });
    expect(tardif.i.deferReply).toHaveBeenCalled();
    expect(tardif.dernier).toContain(`<@${MEMBRE}> est déjà propriétaire`);
    expect(proprietaire()).toBe(MEMBRE);
  });

  test('annulation par un modérateur : le salon redevient à récupérer', async () => {
    const a = fauxMembre(MEMBRE);
    const modo = fauxMembre(MODO, { staff: true });
    const { s, message } = await apresDelai([a, modo]);
    await s.cliquer(a, 'tempvoice:reclamer', { ou: 'salon', message });

    // Un membre ordinaire ne peut pas annuler.
    const refus = await s.cliquer(fauxMembre(MEMBRE2), `tempvoice:reclam_annuler:${MEMBRE}:${SALON}`, { ou: 'salon', message });
    expect(refus.i.reply).toHaveBeenCalled();
    expect(proprietaire()).toBe(MEMBRE);
    // Le réclamant, propriétaire désormais, passe la garde du panneau : la règle
    // du staff est revue dans le traitement lui-même.
    const parLuiMeme = await s.cliquer(a, `tempvoice:reclam_annuler:${MEMBRE}:${SALON}`, { ou: 'salon', message });
    expect(parLuiMeme.dernier).toContain('Seuls les modérateurs');
    expect(proprietaire()).toBe(MEMBRE);

    const annule = await s.cliquer(modo, `tempvoice:reclam_annuler:${MEMBRE}:${SALON}`, { ou: 'salon', message });
    expect(proprietaire()).toBe(PROPRIO);
    expect(annule.dernier).toContain(`annulée par <@${MODO}>`);
    expect(journal().at(-1)).toMatchObject({
      action: 'Annuler une réclamation',
      membre: expect.stringContaining(`<@${MODO}>`),
      proprietaire: `<@${MEMBRE}> → <@${PROPRIO}>`,
    });
    expect(derniereEdition(message).components).toEqual([]);
    // Un nouveau message, bouton actif.
    const nouveaux = messagesRecuperer(s.postes);
    expect(nouveaux).toHaveLength(2);
    expect(composantsDe(nouveaux[1]!.charge).find((c) => c.custom_id === 'tempvoice:reclamer')?.disabled).toBeFalsy();
    // Le bouton d'annulation, lui, est consommé.
    const second = await s.cliquer(modo, `tempvoice:reclam_annuler:${MEMBRE}:${SALON}`, { ou: 'salon', message });
    expect(second.dernier).toContain("n'est plus valable");
  });

  test("le bouton d'annulation expire au bout de 10 minutes", async () => {
    const a = fauxMembre(MEMBRE);
    const modo = fauxMembre(MODO, { staff: true });
    const { s, message } = await apresDelai([a, modo]);
    await s.cliquer(a, 'tempvoice:reclamer', { ou: 'salon', message });
    jest.advanceTimersByTime(10 * 60 * 1000);
    await vider();
    expect(idsDe(derniereEdition(message))).not.toContain(`tempvoice:reclam_annuler:${MEMBRE}:${SALON}`);
    const tardif = await s.cliquer(modo, `tempvoice:reclam_annuler:${MEMBRE}:${SALON}`, { ou: 'salon', message });
    expect(tardif.dernier).toContain("n'est plus valable");
    expect(proprietaire()).toBe(MEMBRE);
  });

  test('salon supprimé pendant le délai : minuteries annulées, rien ne lève', async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([proprio, membre]);
    await s.quitter(proprio);
    await s.quitter(membre);

    expect(s.channel.delete).toHaveBeenCalled();
    expect(texteEmbed(derniereEdition(proprio.mp[0]!))).toContain('Le salon a été supprimé');
    expect(actions()).toContain('Passation annulée : salon supprimé');
    await avancer(31_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
  });

  test('salon supprimé avec le message posté', async () => {
    const a = fauxMembre(MEMBRE);
    const { s } = await apresDelai([a]);
    await s.quitter(a);
    expect(s.channel.delete).toHaveBeenCalled();
    expect(actions()).toContain('Message « Récupérer le salon » retiré : salon supprimé');
  });
});

describe('redémarrage : les étapes en mémoire sont perdues, l\'état reste cohérent', () => {
  test('MP et message d\'avant le redémarrage : réponse éphémère propre, le panneau reste utilisable', async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([proprio, membre]);
    await s.quitter(proprio);
    const mpAvant = proprio.mp[0]!;
    await avancer(31_000);
    const [messageAvant] = messagesRecuperer(s.postes);

    // Nouveau processus : une autre instance du module, sans aucune étape.
    jest.useRealTimers();
    const neuf = await import(`../../events/tempVoice.js?redemarrage=${Date.now()}`) as typeof import('../../events/tempVoice.js');
    jest.useFakeTimers();
    const ecouteurs = new Map<string, (...args: unknown[]) => unknown>();
    neuf.registerTempVoiceListener({
      on: (e: string, l: (...a: unknown[]) => unknown) => { ecouteurs.set(e, l); },
      once: () => undefined,
      isReady: () => false,
      guilds: { cache: new Map() },
    } as unknown as Client);
    neuf.tempChannels.set(SALON, { creatorId: PROPRIO });
    s.ecouteurs.set(Events.InteractionCreate, ecouteurs.get(Events.InteractionCreate)!);

    const choixPerime = await s.cliquer(proprio, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE], ou: 'mp', message: mpAvant });
    expect(choixPerime.dernier).toContain("n'est plus valable");
    expect(neuf.tempChannels.get(SALON)?.creatorId).toBe(PROPRIO);

    // L'ancien message cliqué fait une récupération ordinaire, et se met à jour.
    const prise = await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: messageAvant! });
    expect(prise.dernier).toContain('a récupéré la propriété');
    expect(neuf.tempChannels.get(SALON)?.creatorId).toBe(MEMBRE);
    expect(texteEmbed(derniereEdition(messageAvant!))).toContain(`Récupéré par <@${MEMBRE}>`);
    neuf.tempChannels.delete(SALON);
  });
});

describe('réglages appliqués par le bot', () => {
  test("claimWho = 'moderators' : le membre est refusé, le modérateur passe", async () => {
    ligne = { claimWho: 'moderators' };
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const modo = fauxMembre(MODO, { staff: true });
    const s = scene([proprio, membre, modo]);
    await s.quitter(proprio);
    await avancer(31_000);

    expect((await s.cliquer(membre, 'tempvoice:claim')).dernier).toContain('Seuls les modérateurs');
    expect(proprietaire()).toBe(PROPRIO);
    await s.cliquer(modo, 'tempvoice:claim');
    expect(proprietaire()).toBe(MODO);
  });

  test('moderatorClaimOverride = false : pas de bouton d\'annulation', async () => {
    ligne = { moderatorClaimOverride: false };
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([proprio, membre]);
    await s.quitter(proprio);
    await avancer(31_000);
    const [message] = messagesRecuperer(s.postes);
    await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: message! });
    expect(idsDe(derniereEdition(message!))).toEqual(['tempvoice:reclamer']);
  });

  test('claimEmbedEnabled = false : aucun message, le bouton du panneau suffit', async () => {
    ligne = { claimEmbedEnabled: false };
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([proprio, membre]);
    await s.quitter(proprio);
    await avancer(31_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
    expect(actions()).toContain('Récupération ouverte (bouton du panneau)');
    await s.cliquer(membre, 'tempvoice:claim');
    expect(proprietaire()).toBe(MEMBRE);
  });

  test('deleteWhenEmpty = false : le salon vide reste, le premier qui entre le récupère', async () => {
    ligne = { deleteWhenEmpty: false };
    const proprio = fauxMembre(PROPRIO);
    const s = scene([proprio]);
    await s.quitter(proprio);
    expect(s.channel.delete).not.toHaveBeenCalled();
    expect(tempChannels.has(SALON)).toBe(true);
    const [message] = messagesRecuperer(s.postes);
    expect(message).toBeDefined();

    const arrivant = fauxMembre(MEMBRE);
    s.guild.members.cache.set(MEMBRE, arrivant);
    await s.entrer(arrivant);
    await s.cliquer(arrivant, 'tempvoice:reclamer', { ou: 'salon', message: message! });
    expect(proprietaire()).toBe(MEMBRE);
  });

  test('handoverDelaySeconds = 10 : le message arrive à 10 s, pas avant', async () => {
    ligne = { handoverDelaySeconds: 10 };
    const proprio = fauxMembre(PROPRIO);
    const s = scene([proprio, fauxMembre(MEMBRE)]);
    await s.quitter(proprio);
    await avancer(9_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
    await avancer(2_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(1);
  });

  test('V1 et V2 : le MP et le message suivent le jeu de composants', async () => {
    for (const composants of ['V1', 'V2'] as const) {
      ligne = { panelComponents: composants };
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio, fauxMembre(MEMBRE)]);
      await s.quitter(proprio);
      await avancer(31_000);
      const [message] = messagesRecuperer(s.postes);
      const marques = [proprio.mp[0]!.charge, message!.charge].map((c) => (c as Record<symbol, unknown>)[SANS_CONVERSION] === true);
      expect(marques).toEqual(composants === 'V1' ? [true, true] : [false, false]);
      // Embed + boutons dans les deux cas : la conversion V2 se fait à l'envoi.
      expect(texteEmbed(message!.charge)).toContain('Le propriétaire est parti');
      tempChannels.delete(SALON);
    }
  });

  test('panneau CLASSIC et FLAT, V1 et V2 : « Récupérer » s\'ouvre au membre après le délai', async () => {
    for (const panelMode of ['CLASSIC', 'FLAT'] as const) {
      for (const panelComponents of ['V1', 'V2'] as const) {
        ligne = { panelMode, panelComponents };
        const proprio = fauxMembre(PROPRIO);
        const membre = fauxMembre(MEMBRE);
        const s = scene([proprio, membre]);
        await s.quitter(proprio);

        const pendant = await s.cliquer(membre, 'tempvoice:propriete', { ou: 'salon' });
        const avant = (pendant.i.editReply.mock.calls.at(-1)?.[0]) as unknown;
        expect(composantsDe(avant).find((c) => c.custom_id === 'tempvoice:claim')?.disabled).toBe(true);

        await avancer(31_000);
        const apres = (await s.cliquer(membre, 'tempvoice:propriete', { ou: 'salon' })).i.editReply.mock.calls.at(-1)?.[0];
        expect(composantsDe(apres).find((c) => c.custom_id === 'tempvoice:claim')?.disabled).toBeFalsy();
        await s.cliquer(membre, 'tempvoice:claim');
        expect(proprietaire()).toBe(MEMBRE);
        tempChannels.delete(SALON);
      }
    }
  });

  test('fr et en : textes traduits, aucune clé brute', async () => {
    for (const language of ['fr', 'en'] as const) {
      guildConfig = { ...guildConfig, language };
      const proprio = fauxMembre(PROPRIO);
      const membre = fauxMembre(MEMBRE);
      const s = scene([proprio, membre]);
      await s.quitter(proprio);
      const refus = await s.cliquer(membre, 'tempvoice:claim');
      await avancer(31_000);
      const [message] = messagesRecuperer(s.postes);
      const textes = [
        texteEmbed(proprio.mp[0]!.charge),
        refus.dernier,
        texteEmbed(derniereEdition(proprio.mp[0]!)),
        texteEmbed(message!.charge),
        ...composantsDe(message!.charge).map((c) => String(c.label)),
      ].join('\n');
      expect(textes).not.toContain('panel_tempvoice');
      expect(textes).toContain(language === 'fr' ? 'Choisis ton successeur' : 'Choose your successor');
      expect(textes).toContain(language === 'fr' ? 'réessaie dans' : 'try again in');
      expect(textes).toContain(language === 'fr' ? 'Récupérer le salon' : 'Claim the channel');
      tempChannels.delete(SALON);
    }
  });
});

// ─── Dashboard : normaliseur, GET/PATCH, et le bot qui suit sans redémarrer ───

function requete(methode: string, corps: Record<string, unknown>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = methode;
  req.url = `/api/dashboard/guilds/${GUILD}/channels-management`;
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(corps));
  req.push(null);
  return req;
}

async function route(methode: 'GET' | 'PATCH', corps: Record<string, unknown> = {}) {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as ServerResponse & { corps: string };
  let statut = 200;
  res.corps = '';
  Object.defineProperty(res, 'statusCode', { get: () => statut, set: (c: number) => { statut = c; } });
  res.setHeader = () => res;
  res.writeHead = (c: number) => { statut = c; return res; };
  res.end = ((morceau?: unknown) => { if (morceau) res.corps += String(morceau); return res; }) as never;
  await handleChannelsManagementRoutes({
    req: requete(methode, corps),
    res,
    parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management'],
    url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management`),
    client: {
      guilds: {
        cache: new Map([[GUILD, {
          id: GUILD, name: 'Serveur', preferredLocale: 'fr',
          channels: { cache: new Map() }, roles: { cache: new Map() },
          members: { cache: new Map(), fetch: mock(async () => null) },
        }]]),
      },
    } as unknown as Client,
    user: { userId: 'u', username: 'Admin' } as AuthClaims,
    guildId: GUILD,
    access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
    method: methode,
    auditUser: 'Admin',
    moduleKey: 'channels-management',
  } as never);
  return { statut, corps: res.corps ? JSON.parse(res.corps) as Record<string, unknown> : {} };
}

describe('dashboard : les six réglages de passation', () => {
  test('normaliseur : valeurs valides, limites et invalides', () => {
    expect(normalizeTempVoiceModPermissionsInput({
      handoverDmEnabled: false, handoverDelaySeconds: 10, claimEmbedEnabled: false,
      claimWho: 'moderators', moderatorClaimOverride: false, deleteWhenEmpty: false,
    })).toEqual({ data: {
      handoverDmEnabled: false, handoverDelaySeconds: 10, claimEmbedEnabled: false,
      claimWho: 'moderators', moderatorClaimOverride: false, deleteWhenEmpty: false,
    } });
    expect(normalizeTempVoiceModPermissionsInput({ handoverDelaySeconds: 300 })).toEqual({ data: { handoverDelaySeconds: 300 } });
    for (const invalide of [9, 301, 30.5, '30', null]) {
      const r = normalizeTempVoiceModPermissionsInput({ handoverDelaySeconds: invalide }) as { error?: string };
      expect(r.error).toContain('Délai de passation (handoverDelaySeconds)');
      expect(r.error).toContain('de 10 à 300');
      expect(r.error).toContain("Rien n'a été enregistré");
    }
    expect((normalizeTempVoiceModPermissionsInput({ claimWho: 'tous' }) as { error?: string }).error)
      .toContain('Qui peut récupérer le salon (claimWho) : « tous »');
    // Booléens : tout ce qui n'est pas `true` vaut `false`, comme les interrupteurs voisins.
    expect(normalizeTempVoiceModPermissionsInput({ deleteWhenEmpty: 'oui' })).toEqual({ data: { deleteWhenEmpty: false } });
  });

  test('GET : sans ligne, les défauts du schéma ; une ligne invalide est relue au défaut', async () => {
    const vide = await route('GET');
    expect(vide.corps.tempVoiceModPermissions).toMatchObject({
      handoverDmEnabled: true, handoverDelaySeconds: 30, claimEmbedEnabled: true,
      claimWho: 'present', moderatorClaimOverride: true, deleteWhenEmpty: true,
    });
    ligne = { handoverDmEnabled: false, handoverDelaySeconds: 45, claimEmbedEnabled: true, claimWho: 'tout-le-monde', moderatorClaimOverride: false, deleteWhenEmpty: false };
    const lue = await route('GET');
    expect(lue.corps.tempVoiceModPermissions).toMatchObject({
      handoverDmEnabled: false, handoverDelaySeconds: 45, claimWho: 'present', moderatorClaimOverride: false, deleteWhenEmpty: false,
    });
  });

  test('PATCH invalide : 400 en français, rien n\'est écrit', async () => {
    prismaMock.tempVoiceModPermissionsConfig.upsert.mockClear();
    const r = await route('PATCH', { tempVoiceModPermissions: { handoverDelaySeconds: 5 } });
    expect(r.statut).toBe(400);
    expect(String(r.corps.error)).toContain('de 10 à 300');
    expect(prismaMock.tempVoiceModPermissionsConfig.upsert).not.toHaveBeenCalled();
  });

  test('de bout en bout : chaque PATCH change le comportement du bot sans redémarrage', async () => {
    const patcher = async (reglages: Record<string, unknown>) => {
      const r = await route('PATCH', { tempVoiceModPermissions: reglages });
      expect(r.statut).toBe(200);
    };

    // handoverDmEnabled = false → message immédiat, aucun MP.
    await patcher({ handoverDmEnabled: false });
    {
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio, fauxMembre(MEMBRE)]);
      await s.quitter(proprio);
      expect(proprio.mp).toHaveLength(0);
      expect(messagesRecuperer(s.postes)).toHaveLength(1);
      tempChannels.delete(SALON);
    }

    // handoverDelaySeconds = 10 → le délai est respecté.
    await patcher({ handoverDmEnabled: true, handoverDelaySeconds: 10 });
    {
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio, fauxMembre(MEMBRE)]);
      await s.quitter(proprio);
      expect(proprio.mp).toHaveLength(1);
      await avancer(9_000);
      expect(messagesRecuperer(s.postes)).toHaveLength(0);
      await avancer(2_000);
      expect(messagesRecuperer(s.postes)).toHaveLength(1);
      tempChannels.delete(SALON);
    }

    // claimWho = 'moderators' → membre refusé.
    await patcher({ claimWho: 'moderators' });
    {
      const proprio = fauxMembre(PROPRIO);
      const membre = fauxMembre(MEMBRE);
      const s = scene([proprio, membre]);
      await s.quitter(proprio);
      await avancer(11_000);
      expect((await s.cliquer(membre, 'tempvoice:claim')).dernier).toContain('Seuls les modérateurs');
      expect(proprietaire()).toBe(PROPRIO);
      tempChannels.delete(SALON);
    }

    // moderatorClaimOverride = false → pas de bouton d'annulation.
    await patcher({ claimWho: 'present', moderatorClaimOverride: false });
    {
      const proprio = fauxMembre(PROPRIO);
      const membre = fauxMembre(MEMBRE);
      const s = scene([proprio, membre]);
      await s.quitter(proprio);
      await avancer(11_000);
      const [message] = messagesRecuperer(s.postes);
      await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: message! });
      expect(proprietaire()).toBe(MEMBRE);
      expect(idsDe(derniereEdition(message!))).toEqual(['tempvoice:reclamer']);
      tempChannels.delete(SALON);
    }

    // claimEmbedEnabled = false → aucun message.
    await patcher({ claimEmbedEnabled: false });
    {
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio, fauxMembre(MEMBRE)]);
      await s.quitter(proprio);
      await avancer(11_000);
      expect(messagesRecuperer(s.postes)).toHaveLength(0);
      tempChannels.delete(SALON);
    }

    // deleteWhenEmpty = false → salon conservé ; true → supprimé.
    await patcher({ deleteWhenEmpty: false });
    {
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio]);
      await s.quitter(proprio);
      expect(s.channel.delete).not.toHaveBeenCalled();
      tempChannels.delete(SALON);
    }
    await patcher({ deleteWhenEmpty: true });
    {
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio]);
      await s.quitter(proprio);
      expect(s.channel.delete).toHaveBeenCalled();
    }
  });
});

// ─── Revue 7 : course à la passation, avis, suppression, garde-fous ───

/** Un MP dont l'envoi reste en vol tant que `liberer()` n'est pas appelé (dans l'ordre des envois). */
function mpEnVol(membre: FauxMembre) {
  const portes: Array<() => void> = [];
  membre.send = mock(async (charge: Record<string, unknown>) => {
    const message = fauxMessage(charge);
    membre.mp.push(message);
    await new Promise<void>((resolve) => { portes.push(resolve); });
    return message;
  }) as never;
  return {
    liberer: async (rang = 0) => { portes[rang]?.(); await vider(); },
    envoyes: () => portes.length,
  };
}

async function routeSalon(s: ReturnType<typeof scene>, action: 'DELETE') {
  s.guild.channels.cache.set(SALON, s.channel as never);
  prismaMock.tempVoiceChannel.findUnique.mockImplementation((async () => ({ id: SALON })) as never);
  const req = new IncomingMessage(new Socket());
  req.method = 'PATCH';
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify({ action }));
  req.push(null);
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  res.setHeader = () => res;
  res.writeHead = () => res;
  res.end = (() => res) as never;
  try {
    await handleChannelsManagementRoutes({
      req,
      res,
      parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management', 'temp-voice', 'channels', SALON],
      url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management/temp-voice/channels/${SALON}`),
      client: { guilds: { cache: new Map([[GUILD, s.guild]]) } } as unknown as Client,
      user: { userId: 'u', username: 'Admin' } as AuthClaims,
      guildId: GUILD,
      access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
      method: 'PATCH',
      auditUser: 'Admin',
      moduleKey: 'channels-management',
    } as never);
  } finally {
    prismaMock.tempVoiceChannel.findUnique.mockImplementation((async () => null) as never);
  }
  await vider();
}

describe('revue 7 — 1 : la passation est posée avant la première lecture', () => {
  test("un membre qui clique « Récupérer » pendant l'envoi du MP est refusé", async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const mp = mpEnVol(proprio);
    const s = scene([proprio, membre]);

    const depart = s.quitter(proprio);
    await vider();
    expect(mp.envoyes()).toBe(1);

    const refus = await s.cliquer(membre, 'tempvoice:claim');
    expect(refus.dernier).toContain('réessaie dans');
    expect(proprietaire()).toBe(PROPRIO);

    await mp.liberer();
    await depart;
    expect(proprietaire()).toBe(PROPRIO);
    expect(proprio.mp[0]!.edit).not.toHaveBeenCalled();
    // La passation suit son cours jusqu'au bout.
    await avancer(31_000);
    expect(messagesRecuperer(s.postes)).toHaveLength(1);
  });

  test('un clic qui attend dans la file du salon est revu à son tour', async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([membre]);
    tempChannels.set(SALON, { creatorId: PROPRIO, modeEcriture: 'inVoice' });
    // Le propriétaire entre : surcharge de présence, retirée dans la file à son départ.
    s.guild.members.cache.set(PROPRIO, proprio);
    await s.entrer(proprio);
    let ouvrir!: () => void;
    const porte = new Promise<void>((resolve) => { ouvrir = resolve; });
    s.channel.permissionOverwrites.edit.mockImplementation((async () => { await porte; }) as never);

    const depart = s.quitter(proprio);
    await vider();
    const clic = s.cliquer(membre, 'tempvoice:claim');
    await vider();
    ouvrir();
    const refus = await clic;
    await depart;

    expect(proprietaire()).toBe(PROPRIO);
    expect(refus.dernier).toContain('réessaie dans');
  });

  test('départ, retour, départ rapides : le second MP reste valable, le premier est refermé', async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const mp = mpEnVol(proprio);
    const s = scene([proprio, membre]);

    const depart1 = s.quitter(proprio);
    await vider();
    await s.entrer(proprio);
    const depart2 = s.quitter(proprio);
    await vider();
    expect(mp.envoyes()).toBe(2);

    await mp.liberer(0);
    await mp.liberer(1);
    await Promise.all([depart1, depart2]);

    const [mp1, mp2] = proprio.mp;
    expect(mp1!.edit).toHaveBeenCalled();
    expect(texteEmbed(derniereEdition(mp1!))).toContain('la passation est annulée');
    expect(mp2!.edit).not.toHaveBeenCalled();
    // Le MP valable désigne bien un successeur.
    await s.cliquer(proprio, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE], ou: 'mp', message: mp2 });
    expect(proprietaire()).toBe(MEMBRE);
  });
});

describe('revue 7 — 2, 11 : textes de la récupération', () => {
  test("annulation d'une réclamation sur un serveur anglais : motif traduit", async () => {
    guildConfig = { ...guildConfig, language: 'en' };
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const modo = fauxMembre(MODO, { staff: true });
    const s = scene([proprio, membre, modo]);
    await s.quitter(proprio);
    await avancer(31_000);
    const [message] = messagesRecuperer(s.postes);
    await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: message! });
    envoyerLog.mockClear();
    await s.cliquer(modo, `tempvoice:reclam_annuler:${MEMBRE}:${SALON}`, { ou: 'salon', message: message! });

    const logs = envoyerLog.mock.calls.map((c) => JSON.stringify((c[1] as { toJSON: () => unknown }).toJSON())).join('\n');
    expect(logs).toContain(`Claim by <@${MEMBRE}> cancelled by <@${MODO}>`);
    expect(logs).not.toContain('Réclamation de');
  });

  test('claimWho = moderators : le message ne promet pas le salon au premier membre', async () => {
    for (const language of ['fr', 'en'] as const) {
      guildConfig = { ...guildConfig, language };
      ligne = { claimWho: 'moderators' };
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio, fauxMembre(MEMBRE)]);
      await s.quitter(proprio);
      await avancer(31_000);
      const [message] = messagesRecuperer(s.postes);
      const texte = texteEmbed(message!.charge);
      expect(texte).not.toMatch(/premier membre|first member/);
      expect(texte).toContain(language === 'fr' ? 'Un modérateur peut' : 'A moderator can');
      tempChannels.delete(SALON);
    }
  });
});

describe('revue 7 — 3 : aucune mention non voulue', () => {
  test('un pseudo « @everyone » ne notifie personne (choix du propriétaire et récupération)', async () => {
    const proprio = fauxMembre(PROPRIO);
    const piege = fauxMembre(MEMBRE);
    piege.displayName = '@everyone';
    const s = scene([proprio, piege]);
    await s.quitter(proprio);
    await s.cliquer(proprio, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE], ou: 'mp', message: proprio.mp[0] });
    const annonce = s.postes.at(-1)!.charge;
    expect(String(annonce.content)).toContain('@everyone');
    expect(annonce.allowedMentions).toEqual({ parse: [] });
    tempChannels.delete(SALON);

    // Récupération par le bouton du panneau, sans message dans le chat.
    ligne = { claimEmbedEnabled: false };
    const proprio2 = fauxMembre(PROPRIO);
    const piege2 = fauxMembre(MEMBRE2);
    piege2.displayName = '@everyone';
    const s2 = scene([proprio2, piege2]);
    await s2.quitter(proprio2);
    await avancer(31_000);
    await s2.cliquer(piege2, 'tempvoice:claim');
    expect(proprietaire()).toBe(MEMBRE2);
    const annonce2 = s2.postes.at(-1)!.charge;
    expect(String(annonce2.content)).toContain('@everyone');
    expect(annonce2.allowedMentions).toEqual({ parse: [] });
  });
});

describe('revue 7 — 5 : un salon supprimé arrête la passation', () => {
  const sansDelai = () => {
    expect(actions()).not.toContain('Délai de passation écoulé sans choix');
    expect(actions()).not.toContain('Message « Récupérer le salon » posté');
  };

  test('supprimé à la main (ChannelDelete) pendant la passation : ni MP « délai écoulé », ni log de délai', async () => {
    const proprio = fauxMembre(PROPRIO);
    const s = scene([proprio, fauxMembre(MEMBRE)]);
    await s.quitter(proprio);
    await s.ecouteurs.get(Events.ChannelDelete)?.(s.channel);
    await vider();

    expect(texteEmbed(derniereEdition(proprio.mp[0]!))).toContain('Le salon a été supprimé');
    await avancer(31_000);
    expect(proprio.mp[0]!.edit).toHaveBeenCalledTimes(1);
    sansDelai();
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
  });

  test('fermé depuis le dashboard pendant la passation : même arrêt', async () => {
    const proprio = fauxMembre(PROPRIO);
    const s = scene([proprio, fauxMembre(MEMBRE)]);
    await s.quitter(proprio);
    await routeSalon(s, 'DELETE');

    expect(s.channel.delete).toHaveBeenCalled();
    expect(texteEmbed(derniereEdition(proprio.mp[0]!))).toContain('Le salon a été supprimé');
    await avancer(31_000);
    expect(proprio.mp[0]!.edit).toHaveBeenCalledTimes(1);
    sansDelai();
    expect(messagesRecuperer(s.postes)).toHaveLength(0);
  });
});

describe('revue 7 — 8 : une lecture en panne ne supprime jamais un salon', () => {
  test('réglages illisibles à la sortie du dernier membre : le salon reste', async () => {
    prismaMock.tempVoiceModPermissionsConfig.findUnique.mockImplementation((async () => { throw new Error('base injoignable'); }) as never);
    try {
      const proprio = fauxMembre(PROPRIO);
      const s = scene([proprio]);
      await s.quitter(proprio);
      expect(s.channel.delete).not.toHaveBeenCalled();
      expect(tempChannels.has(SALON)).toBe(true);
    } finally {
      prismaMock.tempVoiceModPermissionsConfig.findUnique.mockImplementation((async () => ligne) as never);
    }
  });
});

describe('revue 7 — 9, 10 : gardes relues au clic', () => {
  test('« Annuler la réclamation » après la désactivation du réglage : refus éphémère', async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const modo = fauxMembre(MODO, { staff: true });
    const s = scene([proprio, membre, modo]);
    await s.quitter(proprio);
    await avancer(31_000);
    const [message] = messagesRecuperer(s.postes);
    await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: message! });
    expect(idsDe(derniereEdition(message!))).toContain(`tempvoice:reclam_annuler:${MEMBRE}:${SALON}`);

    ligne = { moderatorClaimOverride: false };
    const refus = await s.cliquer(modo, `tempvoice:reclam_annuler:${MEMBRE}:${SALON}`, { ou: 'salon', message: message! });
    expect(refus.dernier).toContain("n'est plus valable");
    expect(proprietaire()).toBe(MEMBRE);
  });

  test("un identifiant de bouton cliqué dans un autre serveur ne pilote pas le salon", async () => {
    const proprio = fauxMembre(PROPRIO);
    const membre = fauxMembre(MEMBRE);
    const s = scene([proprio, membre]);
    await s.quitter(proprio);
    await avancer(31_000);

    const autre = '999000000000000001';
    const panneau = await s.cliquer(membre, 'tempvoice:claim', { guildId: autre });
    expect(panneau.dernier).toContain("n'est plus valable");
    expect(proprietaire()).toBe(PROPRIO);
    const [message] = messagesRecuperer(s.postes);
    const carte = await s.cliquer(membre, 'tempvoice:reclamer', { ou: 'salon', message: message!, guildId: autre });
    expect(carte.dernier).toContain("n'est plus valable");
    expect(proprietaire()).toBe(PROPRIO);
  });
});

describe('revue 7 — 6 : le choix de passation appartient au propriétaire parti', () => {
  test('un autre que le propriétaire (même modérateur) ne peut pas désigner le successeur', async () => {
    const proprio = fauxMembre(PROPRIO);
    const modo = fauxMembre(MODO, { staff: true });
    const s = scene([proprio, modo, fauxMembre(MEMBRE2)]);
    await s.quitter(proprio);

    const intrus = await s.cliquer(modo, `tempvoice:leader:${PROPRIO}:${SALON}`, { valeurs: [MEMBRE2], ou: 'mp', message: proprio.mp[0] });
    expect(intrus.dernier).toContain("n'est plus valable");
    expect(proprietaire()).toBe(PROPRIO);
    expect(proprio.mp[0]!.edit).not.toHaveBeenCalled();
  });
});
