/**
 * PARITÉ MAQUETTE ↔ PRODUCTION — les quinze preuves du panneau des salons
 * vocaux temporaires.
 *
 * Ce fichier ne mesure QUE des comportements qui n'existaient pas avant les
 * cinq réglages (`panelMode`, `stateLayout`, `stateColors`, `panelComponents`,
 * `reservationFallbackMode`). Chaque test porte en commentaire ce qu'il faudrait
 * retirer du produit pour le faire échouer : un test qui passerait aussi sur
 * l'ancienne version ne prouverait rien et n'a pas sa place ici.
 *
 * TROIS CHOSES QUE CE FICHIER OBSERVE ET QUE RIEN D'AUTRE N'OBSERVE
 *
 *  1. DEUX SERVEURS DANS LE MÊME PROCESSUS (T1 à T3). `patchV2` patche les
 *     prototypes de discord.js GLOBALEMENT, pour tout le processus : il n'y a
 *     qu'un seul `VoiceChannel.prototype.send` pour tous les serveurs. La seule
 *     chose qui distingue un rendu V1 d'un rendu V2 est une clé Symbol posée
 *     sur LA CHARGE (`Symbol.for('kotbo.sansConversionV2')`). Les charges sont
 *     donc passées par le `send` RÉELLEMENT patché — pas par
 *     `transformPayload` appelé à la main : c'est le prototype global qui est
 *     le point de contamination, et lui seul prouve l'isolation.
 *
 *  2. LA GÉOMÉTRIE DES QUATRE DISPOSITIONS (T4 à T7). Les dimensions du PNG
 *     découlent du nombre de colonnes du plan : 1 colonne (TABLE) donne la
 *     carte la plus étroite et la plus haute, 3 colonnes espacées et encadrées
 *     (CARDS) la plus large. Comparer des empreintes sha256 prouve seulement
 *     que deux images diffèrent ; comparer les géométries prouve qu'elles
 *     diffèrent COMME LA MAQUETTE le demande.
 *
 *  3. CE QUE LA ROUTE REFUSE (T14, T15). Les cinq colonnes sont des `String`
 *     Prisma sans enum : la base n'arbitre rien. Le seul garde-fou est le 400
 *     de la route, et les `@default(...)` du schéma sont recopiés à la main
 *     dans quatre autres fichiers — T15 compare le schéma au code plutôt que
 *     de recopier une sixième fois les mêmes littéraux.
 *
 * `etatRenduNativement`, `rangeesPlates` et `reecrirePanneau` ne sont pas
 * exportés : on les observe sur la charge réellement écrite vers Discord, ce
 * qui part en production. Un test qui réimplémenterait leurs règles ne
 * prouverait rien.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
  ComponentType,
  Events,
  Message,
  MessageFlags,
  VoiceChannel,
  type Client,
} from 'discord.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// Type seul : effacé à la compilation, donc il ne charge pas `api/shared.ts`
// avant que les `mock.module` plus bas n'aient pris effet (les imports statiques
// sont hissés ; la constante `DASHBOARD_ACCESS_ADMIN` est donc importée
// dynamiquement, après les mocks).
import type { AuthClaims, DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import {
  DISPOSITIONS_ETAT,
  JEUX_COMPOSANTS,
  PRESENTATION_PAR_DEFAUT,
  REPLIS_RESERVATION,
  TEINTES_ETAT,
  planReservation,
  type DispositionEtat,
} from '../../services/features/tempVoiceService.js';
import { logger } from '../../utils/logger.js';

const GUILD_A = '100000000000000001';
const GUILD_B = '100000000000000002';
const OWNER = '200000000000000000';
const PRESENT = '210000000000000000';
const BOT = '300000000000000000';
const ROLE_RESERVABLE = '700000000000000000';

// ═══════════════════════════════════════════════════════════════════════════
// Harnais — la base, le cache, et le panneau tel que Discord le reçoit
// ═══════════════════════════════════════════════════════════════════════════

/** Lignes `TempVoiceModPermissionsConfig`, UNE PAR SERVEUR (`guildId String @id`).
 *  Servir la même ligne à tous les serveurs rendrait T1 et T2 verts sans rien
 *  prouver : c'est exactement la panne qu'ils cherchent. */
const lignesParServeur = new Map<string, Record<string, unknown> | null>();
const configsParServeur = new Map<string, Record<string, unknown> | null>();

/** Ligne `Guild` servie à la route du dashboard (T14, T15). */
let ligneGuild: Record<string, unknown> | null = null;

const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async (args: { where: { guildId: string } }) => lignesParServeur.get(args.where.guildId) ?? null),
    upsert: mock(async () => ({})),
  },
  tempVoiceAccessRequestConfig: {
    findUnique: mock(async () => null as Record<string, unknown> | null),
    upsert: mock(async () => ({})),
  },
  tempVoiceChannel: {
    findMany: mock(async () => [] as Array<Record<string, unknown>>),
    findUnique: mock(async () => null as Record<string, unknown> | null),
    create: mock(async () => ({})),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
  },
  guild: {
    findUnique: mock(async () => ligneGuild),
    update: mock(async () => ({})),
  },
  stickyMessage: { findMany: mock(async () => [] as Array<Record<string, unknown>>) },
  dashboardAuditLog: { create: mock(async () => ({})) },
};

const cheminCache = path.resolve(import.meta.dir, '../../utils/cache.ts');
const mockCache = () => completeModuleMock(cheminCache, {
  getCachedGuild: mock(async (guildId: string) => configsParServeur.get(guildId) ?? null),
  cache: { invalidateGuild: mock(async () => undefined) },
});

for (const relatif of ['../../utils/db']) {
  const fabrique = () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() });
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}
mock.module(cheminCache, mockCache);
mock.module(path.resolve(import.meta.dir, '../../utils/cache.js'), mockCache);

/**
 * ⚠️ CORRECTIF D'ENVIRONNEMENT, PAS UN MOCK — à retirer dès que les liens de
 * `node_modules` de ce worktree sont refaits.
 *
 * MESURÉ dans ce worktree : `node_modules/@kotbo/contracts` est un lien
 * symbolique vers `<autre checkout>/packages/contracts`, et non vers le
 * `packages/contracts` DE CE worktree. Le paquet visé n'exporte pas
 * `RPG_ITEM_RARITIES`, que le code d'ici importe : tout fichier qui charge
 * `api/shared.ts` échoue donc au chargement, sur
 * « Export named 'RPG_ITEM_RARITIES' not found ». C'est antérieur à ce
 * fichier — `channelsManagementRoute.test.ts` échoue à l'identique.
 *
 * Ce `mock.module` ne remplace rien : il redonne au spécificateur
 * `@kotbo/contracts` le VRAI module de ce worktree, celui que `bun` aurait
 * résolu sans le lien croisé. Sans lui, T14 et T15 ne pourraient pas être
 * exécutés du tout.
 */
const contractsDuWorktree = await import(
  path.resolve(import.meta.dir, '../../../../../packages/contracts/src/index.ts')
);
mock.module('@kotbo/contracts', () => contractsDuWorktree);

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');
const { DASHBOARD_ACCESS_ADMIN } = await import('../../api/shared.js');
const { handleChannelsManagementRoutes } = await import('../../api/routes/dashboard/modules/channels-management.js');

/**
 * Les avertissements du module, sans `mock.module` sur `../../utils/logger` :
 * `logger` est un objet partagé, on remplace la seule méthode observée et on la
 * rend en fin de fichier. Mocker le module entier ferait disparaître ses autres
 * exports pour les fichiers de test chargés ensuite.
 */
const avertissements: string[] = [];
const warnOriginal = logger.warn;
logger.warn = ((_tag: string, ...args: unknown[]) => {
  avertissements.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
}) as typeof logger.warn;
afterAll(() => { logger.warn = warnOriginal; });

/** La marque d'échappatoire de `patchV2`, lue exactement comme le patch la lit. */
const MARQUE_SANS_V2 = Symbol.for('kotbo.sansConversionV2');
const porteLaMarque = (charge: unknown): boolean =>
  Boolean(charge) && typeof charge === 'object'
  && Object.getOwnPropertySymbols(charge as object).includes(MARQUE_SANS_V2);

function surchargeNulle(allow = 0n, deny = 0n) {
  return {
    allow: { bitfield: allow, has: (bit: bigint) => (allow & bit) === bit },
    deny: { bitfield: deny, has: (bit: bigint) => (deny & bit) === bit },
  };
}

function fauxMembre(id: string, estBot = false) {
  return {
    id,
    displayName: `membre-${id}`,
    user: { id, bot: estBot, tag: `m${id}#0001`, username: `m${id}` },
    permissions: { has: () => false },
    roles: { cache: { has: () => false } },
    guild: { ownerId: '999999999999999999' },
    voice: { channelId: null as string | null },
    send: mock(async () => undefined),
  };
}

/** Le message du panneau tel que Discord le rend, et tout ce qu'on lui écrit. */
function fauxPanneau(estV2 = false) {
  const charges: Array<Record<string, unknown>> = [];
  return {
    charges,
    message: {
      id: '777000000000000001',
      flags: { has: (drapeau: number) => estV2 && drapeau === MessageFlags.IsComponentsV2 },
      edit: mock(async (charge: Record<string, unknown>) => { charges.push(charge); return undefined; }),
      delete: mock(async () => undefined),
    },
  };
}

function fauxSalon(
  id: string,
  panneau: ReturnType<typeof fauxPanneau>,
  options: { guildId?: string; presents?: string[] } = {},
) {
  const guildId = options.guildId ?? GUILD_A;
  const presents = options.presents ?? [OWNER];
  const membres = new Map<string, unknown>(presents.map((m) => [m, fauxMembre(m)]));
  const membresServeur = new Map<string, unknown>(membres);
  if (!membresServeur.has(OWNER)) membresServeur.set(OWNER, fauxMembre(OWNER));

  const channel = {
    id,
    type: 2, // ChannelType.GuildVoice
    name: `salon-${id}`,
    userLimit: 0,
    members: membres,
    // `retrouverPanneau` demande le message par son identifiant quand il le
    // connaît, sinon les vingt-cinq derniers : les deux formes sont servies.
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
    send: mock(async () => ({ id: '888888888888888888' })),
    parentId: null as string | null,
    parent: null as unknown,
    guild: {
      id: guildId,
      name: `Serveur ${guildId}`,
      available: true,
      ownerId: '999999999999999999',
      roles: { everyone: { id: guildId }, cache: new Map<string, unknown>() },
      members: {
        me: { id: BOT, permissions: { has: () => true } },
        cache: membresServeur,
        fetch: mock(async (cible: unknown) =>
          (typeof cible === 'string' ? membresServeur.get(cible) ?? null : null)),
      },
      channels: { cache: new Map<string, unknown>(), fetch: mock(async () => null) },
    },
  };

  tempChannels.set(id, { creatorId: OWNER, panneauId: panneau.message.id });
  return channel;
}

type Ecouteurs = Map<string, (...args: unknown[]) => unknown>;

function fauxClient() {
  const ecouteurs: Ecouteurs = new Map();
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

/** Une entrée en vocal : c'est ce qui déclenche la réécriture du panneau. */
async function rejouerEntree(
  ecouteurs: Ecouteurs,
  channel: ReturnType<typeof fauxSalon>,
  membreId = PRESENT,
): Promise<void> {
  await ecouteurs.get(Events.VoiceStateUpdate)?.(
    { channelId: null, channel: null },
    { channelId: channel.id, channel, guild: channel.guild, member: fauxMembre(membreId) },
  );
}

/** La ligne que le dashboard écrit : les noms de COLONNES, pas la forme applicative. */
function ligneBase(guildId: string, champs: Record<string, unknown> = {}) {
  return {
    guildId,
    canRename: true,
    canChangeLimit: true,
    canLock: true,
    canChangeWriteMode: true,
    canKickOrBan: true,
    canReserve: true,
    canTransfer: true,
    panelCompactMode: false,
    reservableRoleIds: [] as string[],
    reservationOverflow: 'ASK',
    reservationFallbackChannelId: null,
    panelMode: 'CLASSIC',
    stateLayout: 'GRID3',
    stateColors: 'NEUTRAL',
    panelComponents: 'V2',
    reservationFallbackMode: 'ANY_ROLE',
    ...champs,
  };
}

function servirServeur(guildId: string, ligne: Record<string, unknown> | null): void {
  lignesParServeur.set(guildId, ligne);
  configsParServeur.set(guildId, {
    tempVoiceEnabled: true,
    baseStaffRoleId: null,
    moderatorRoleId: null,
    testStaffRoleId: null,
  });
}

let prochainSalon = 0;
const salonsOuverts: string[] = [];

/** Réécrit le panneau d'un salon et rend la charge que Discord a réellement reçue. */
async function panneauEcrit(
  ligne: Record<string, unknown> | null,
  options: { guildId?: string; estV2?: boolean; presents?: string[] } = {},
) {
  const guildId = options.guildId ?? GUILD_A;
  prochainSalon += 1;
  const id = `46000000000000${String(1000 + prochainSalon)}`;
  salonsOuverts.push(id);
  servirServeur(guildId, ligne);
  const panneau = fauxPanneau(options.estV2 ?? false);
  const channel = fauxSalon(id, panneau, { guildId, presents: options.presents });
  const { client, ecouteurs } = fauxClient();
  registerTempVoiceListener(client);
  await rejouerEntree(ecouteurs, channel);
  const ecrit = await jusqua(() => panneau.charges.length > 0);
  // Les échecs de réécriture partent en `logger.warn`, capturé ici : sans ce
  // rappel, un panneau jamais écrit ne donnerait qu'un `false` sans cause.
  if (!ecrit) console.warn(`[parite] aucune charge écrite pour ${id} :`, avertissements.slice(-3));
  return { id, panneau, channel, ecouteurs, ecrit, charge: panneau.charges[0] };
}

afterAll(() => { for (const id of salonsOuverts) tempChannels.delete(id); });

/** Un clic de bouton, et tout ce que le module a répondu. */
async function cliquer(
  ecouteurs: Ecouteurs,
  channel: ReturnType<typeof fauxSalon>,
  action: string,
): Promise<Array<Record<string, unknown>>> {
  const reponses: Array<Record<string, unknown>> = [];
  const noter = mock(async (charge: Record<string, unknown>) => { reponses.push(charge); });
  const interaction = {
    guildId: channel.guild.id,
    customId: `tempvoice:${action}`,
    channel,
    guild: channel.guild,
    member: channel.guild.members.cache.get(OWNER),
    user: { id: OWNER, bot: false },
    deferred: false,
    replied: false,
    isButton: () => true,
    isModalSubmit: () => false,
    isRoleSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isMessageComponent: () => true,
    isRepliable: () => true,
    message: { edit: noter },
    deferUpdate: mock(async () => { interaction.deferred = true; }),
    deferReply: mock(async () => { interaction.deferred = true; }),
    reply: mock(async (charge: Record<string, unknown>) => { reponses.push(charge); interaction.replied = true; }),
    editReply: noter,
    followUp: noter,
    showModal: mock(async () => undefined),
  };
  await ecouteurs.get(Events.InteractionCreate)?.(interaction);
  return reponses;
}

/**
 * Les composants de plusieurs charges, à plat, tels que discord.js les porte.
 *
 * ⚠️ `StringSelectMenuBuilder` garde ses options HORS de `data` (dans
 * `builder.options`) : les lire dans `data` seul ferait paraître vide un menu
 * qui propose deux personnes.
 */
function composantsDe(...charges: unknown[]): Array<Record<string, unknown>> {
  const plats: Array<Record<string, unknown>> = [];
  for (const charge of charges.flat(2)) {
    const rangees = (charge as { components?: Array<{ components?: unknown[] }> })?.components ?? [];
    for (const rangee of rangees) {
      for (const brut of rangee.components ?? []) {
        const composant = brut as {
          data?: Record<string, unknown>;
          options?: Array<{ data?: Record<string, unknown> }>;
        };
        if (!composant?.data) continue;
        const brutes = composant.options
          ?? (composant.data.options as Array<{ data?: Record<string, unknown> }> | undefined)
          ?? [];
        plats.push({ ...composant.data, options: brutes.map((option) => option?.data ?? option) });
      }
    }
  }
  return plats;
}

const idsDe = (composants: Array<Record<string, unknown>>): string[] =>
  composants.map((c) => String(c.custom_id ?? ''));

/**
 * Passe la charge par le `send` RÉELLEMENT patché — les prototypes de discord.js
 * sont patchés à l'import de `patchV2`, que `events/tempVoice.ts` importe.
 * L'appel d'origine échoue sur un `this` factice, mais la transformation est
 * déjà faite à ce moment-là : la charge est mutée SUR PLACE, on inspecte donc
 * l'objet fourni. C'est le seul point de contamination possible entre serveurs,
 * puisqu'il n'y a qu'un prototype pour tout le processus.
 */
function envoiPatche<T extends object>(payload: T): T {
  try {
    const retour = (VoiceChannel.prototype.send as (...args: unknown[]) => unknown)
      .call({} as never, payload);
    if (retour && typeof (retour as Promise<unknown>).catch === 'function') {
      (retour as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Attendu : seul le passage par le patch nous intéresse.
  }
  return payload;
}

/** Même principe pour `Message.prototype.edit`, avec une cible déjà en V2. */
function editionPatchee<T extends object>(payload: T, cible: unknown): T {
  try {
    const retour = (Message.prototype.edit as (...args: unknown[]) => unknown)
      .call(cible as never, payload);
    if (retour && typeof (retour as Promise<unknown>).catch === 'function') {
      (retour as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Attendu.
  }
  return payload;
}

/** V1 ou V2 selon ce que discord.js a RÉELLEMENT reçu, pas selon l'intention. */
function versionRecue(charge: unknown): 'V1' | 'V2' {
  const p = charge as { embeds?: unknown[]; components?: unknown[]; flags?: unknown };
  const drapeauPose = Array.isArray(p?.flags)
    ? p.flags.includes(MessageFlags.IsComponentsV2)
    : typeof p?.flags === 'number' && (p.flags & MessageFlags.IsComponentsV2) !== 0;
  return drapeauPose ? 'V2' : 'V1';
}

/** Dimensions d'un PNG, lues dans son IHDR — aucune dépendance de décodage. */
function dimensionsPng(png: Buffer): { largeur: number; hauteur: number } {
  return { largeur: png.readUInt32BE(16), hauteur: png.readUInt32BE(20) };
}

/** La pièce jointe d'une charge : son nom et la géométrie de son image. */
function imageDe(charge: Record<string, unknown> | undefined) {
  const pieces = (charge?.files ?? []) as Array<{ name?: string | null; attachment?: unknown }>;
  if (pieces.length === 0) return null;
  const octets = pieces[0]?.attachment;
  if (!Buffer.isBuffer(octets)) return null;
  return { nom: String(pieces[0]?.name ?? ''), octets, ...dimensionsPng(octets) };
}

// ═══════════════════════════════════════════════════════════════════════════
// T1 à T3 — DEUX SERVEURS SIMULTANÉS, le point le plus important
//
// `patchV2` patche les prototypes de discord.js GLOBALEMENT : un seul
// `VoiceChannel.prototype.send` pour tout le processus, donc pour tous les
// serveurs. Rien ne sépare un rendu V1 d'un rendu V2 que la clé Symbol posée
// sur la charge. Ces trois tests font passer les charges de DEUX serveurs par
// ce prototype unique, entrelacées, et vérifient qu'aucune ne teinte l'autre.
// ═══════════════════════════════════════════════════════════════════════════

describe('T1/T2/T3 — guilde A en V1 et guilde B en V2 dans le même processus', () => {
  const A_EN_V1 = () => ligneBase(GUILD_A, { panelComponents: 'V1', panelMode: 'CLASSIC' });
  const B_EN_V2 = () => ligneBase(GUILD_B, { panelComponents: 'V2', panelMode: 'FLAT', stateLayout: 'CARDS', stateColors: 'DARK' });

  test('T1 — la charge de A ressort en V1 et celle de B en V2, du même prototype patché', async () => {
    // ÉCHOUE SI : `sansConversionV2(charge2)` est retiré de `reecrirePanneau`,
    // si l'échappatoire `estSansConversionV2` est retirée de `transformPayload`,
    // ou si un réglage est lu ailleurs que par serveur. Sans le réglage
    // `panelComponents`, les DEUX charges ressortiraient en V2 : c'était le
    // comportement d'avant, `patchV2` convertissant tout sans bascule.
    const a = await panneauEcrit(A_EN_V1(), { guildId: GUILD_A, presents: [OWNER, PRESENT] });
    const b = await panneauEcrit(B_EN_V2(), { guildId: GUILD_B, presents: [OWNER, PRESENT] });
    expect({ aEcrit: a.ecrit, bEcrit: b.ecrit }).toEqual({ aEcrit: true, bEcrit: true });

    // L'intention : la marque n'est posée que sur la charge de A.
    expect({ marqueA: porteLaMarque(a.charge), marqueB: porteLaMarque(b.charge) })
      .toEqual({ marqueA: true, marqueB: false });

    // Le fait : ce que discord.js reçoit après le prototype GLOBAL.
    const recuA = envoiPatche(a.charge as object) as Record<string, unknown>;
    const recuB = envoiPatche(b.charge as object) as Record<string, unknown>;
    expect({ A: versionRecue(recuA), B: versionRecue(recuB) }).toEqual({ A: 'V1', B: 'V2' });

    // A garde ses embeds classiques, B ne les a plus (repliés en conteneurs V2).
    expect(Array.isArray(recuA.embeds) && (recuA.embeds as unknown[]).length).toBe(1);
    expect(recuB.embeds).toBeUndefined();
  }, 120_000);

  test('T2 — entrelacés A, B, A, B : chacun garde SA version et SA présentation', async () => {
    // ÉCHOUE SI : une mémoïsation de module retient la présentation du dernier
    // serveur lu (`lireReglagesAdmin` relit la base à chaque appel — ce test est
    // le garde-fou qui interdit d'y ajouter un cache par module), ou si la
    // marque était posée sur un objet partagé plutôt que sur chaque charge.
    // L'ordre alterné est ce qui révèle une fuite : A seul, puis B seul,
    // passerait même avec une variable de fichier.
    const lus = [];
    for (const tour of [0, 1]) {
      lus.push({
        tour,
        serveur: 'A',
        ...(await panneauEcrit(A_EN_V1(), { guildId: GUILD_A, presents: [OWNER, PRESENT] })),
      });
      lus.push({
        tour,
        serveur: 'B',
        ...(await panneauEcrit(B_EN_V2(), { guildId: GUILD_B, presents: [OWNER, PRESENT] })),
      });
    }
    expect(lus.filter((l) => l.ecrit).length).toBe(4);

    // La version reçue, dans l'ordre réel des envois.
    const versions = lus.map((l) => ({
      serveur: l.serveur,
      version: versionRecue(envoiPatche(l.charge as object)),
    }));
    expect(versions).toEqual([
      { serveur: 'A', version: 'V1' },
      { serveur: 'B', version: 'V2' },
      { serveur: 'A', version: 'V1' },
      { serveur: 'B', version: 'V2' },
    ]);

    // Et la présentation : A est CLASSIC/GRID3/NEUTRAL (une rangée, aucune
    // image), B est FLAT/CARDS/DARK (plusieurs rangées, une image).
    // Si l'une empruntait la présentation de l'autre, ces deux colonnes se
    // croiseraient sans qu'aucune erreur ne soit levée.
    const forme = lus.map((l) => ({
      serveur: l.serveur,
      image: Boolean(imageDe(l.charge)),
      plusieursRangees: ((l.charge?.components as unknown[]) ?? []).length > 1,
    }));
    expect(forme).toEqual([
      { serveur: 'A', image: false, plusieursRangees: false },
      { serveur: 'B', image: true, plusieursRangees: true },
      { serveur: 'A', image: false, plusieursRangees: false },
      { serveur: 'B', image: true, plusieursRangees: true },
    ]);
  }, 180_000);

  test('T3 — la marque n’est pas consommée : deux envois puis une édition gardent V1', async () => {
    // ÉCHOUE SI : `transformPayload` retire la marque après lecture (c'était la
    // première version). La charge du panneau est construite UNE fois puis
    // repassée — un envoi, puis des éditions : une marque à usage unique
    // laisserait le panneau basculer de V1 à V2 tout seul au second passage,
    // sans qu'aucune erreur ne l'explique.
    const a = await panneauEcrit(A_EN_V1(), { guildId: GUILD_A, presents: [OWNER, PRESENT] });
    expect(a.ecrit).toBe(true);
    const charge = a.charge as object;

    const passages = [
      versionRecue(envoiPatche(charge)),
      versionRecue(envoiPatche(charge)),
      // Édition vers un message DÉJÀ en Components V2 : le chemin qui reconvertit
      // de force (`transformUpdatePayload`) doit lui aussi respecter la marque.
      versionRecue(editionPatchee(charge, { flags: { has: (f: number) => f === MessageFlags.IsComponentsV2 } })),
    ];
    expect(passages).toEqual(['V1', 'V1', 'V1']);
    expect(porteLaMarque(charge)).toBe(true);

    // Et le miroir : la charge NON marquée de B se convertit, elle, dès le
    // premier passage — sinon « reste en V1 » serait vrai faute de conversion.
    const b = await panneauEcrit(B_EN_V2(), { guildId: GUILD_B, presents: [OWNER, PRESENT] });
    expect(versionRecue(envoiPatche(b.charge as object))).toBe('V2');
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T4 à T7 — les quatre stateLayout
// ═══════════════════════════════════════════════════════════════════════════

describe('T4/T5/T6/T7 — les quatre dispositions', () => {
  /** Une guilde réglée sur une disposition, en V1, teinte imposée. */
  const surDisposition = (disposition: DispositionEtat, teinte = 'DARK', composants = 'V1') =>
    ligneBase(GUILD_A, { stateLayout: disposition, stateColors: teinte, panelComponents: composants });

  test('T4 — GRID3 + V1 : rendu NATIF, six champs inline, aucune pièce jointe', async () => {
    // ÉCHOUE SI : `etatRenduNativement` cesse de reconnaître GRID3+V1, ou si
    // `carteEtat` cesse de poser les six champs. Sans le réglage, le panneau
    // n'avait de toute façon aucun `files` — c'est donc la PAIRE (natif ici,
    // image en T5) qui prouve le comportement neuf, et T5 porte l'autre moitié.
    const { charge, ecrit } = await panneauEcrit(surDisposition('GRID3'), { presents: [OWNER, PRESENT] });
    expect(ecrit).toBe(true);
    expect(imageDe(charge)).toBeNull();

    const embeds = (charge?.embeds ?? []) as Array<{ data?: { fields?: unknown[]; image?: unknown } }>;
    expect(embeds[0]?.data?.fields?.length).toBe(6);
    expect(embeds[0]?.data?.image).toBeUndefined();
  }, 60_000);

  test('T5 — GRID2, TABLE, CARDS : une image chacun, nommée d’après la disposition', async () => {
    // ÉCHOUE SI : le rendu image (`carteEtatImage`, `tempVoicePanelImage.ts`)
    // disparaît, ou si le nom du fichier cesse de porter la disposition. Le nom
    // est ce qui permet de savoir, sur un panneau en production, QUELLE
    // disposition a réellement été rendue — et Discord met les pièces jointes
    // en cache PAR NOM, donc un nom réutilisé resservirait l'ancienne image.
    const vus: Array<{
      disposition: string; nom: string; image: boolean; pointe: boolean; videLesAnciennes: boolean;
    }> = [];
    for (const disposition of ['GRID2', 'TABLE', 'CARDS'] as const) {
      const { charge, ecrit } = await panneauEcrit(surDisposition(disposition), { presents: [OWNER, PRESENT] });
      expect(ecrit).toBe(true);
      const image = imageDe(charge);
      const embeds = (charge?.embeds ?? []) as Array<{ data?: { image?: { url?: string } } }>;
      vus.push({
        disposition,
        nom: image?.nom ?? '',
        image: Boolean(image),
        // L'embed doit POINTER la pièce jointe : une image envoyée sans
        // `attachment://` s'afficherait en pied de message, pas dans la carte.
        pointe: embeds[0]?.data?.image?.url === `attachment://${image?.nom}`,
        // Sur une ÉDITION, Discord CONSERVE les pièces jointes du message :
        // sans `attachments: []`, la nouvelle carte s'ajoute et l'ANCIENNE
        // reste affichée — le panneau montre deux états, dont un faux.
        videLesAnciennes: Array.isArray(charge?.attachments)
          && (charge!.attachments as unknown[]).length === 0,
      });
    }
    expect(vus).toEqual([
      { disposition: 'GRID2', nom: expect.stringContaining('-grid2-dark-'), image: true, pointe: true, videLesAnciennes: true },
      { disposition: 'TABLE', nom: expect.stringContaining('-table-dark-'), image: true, pointe: true, videLesAnciennes: true },
      { disposition: 'CARDS', nom: expect.stringContaining('-cards-dark-'), image: true, pointe: true, videLesAnciennes: true },
    ]);
  }, 120_000);

  test('T6 — les quatre dispositions rendent quatre GÉOMÉTRIES différentes', async () => {
    // ÉCHOUE SI : deux dispositions rendent la même mise en page — le réglage
    // serait décoratif. La géométrie, et non une empreinte sha256, parce qu'elle
    // dit ce que la maquette demande : le nombre de COLONNES décide de la
    // largeur (2 < 3 < 3 espacées et encadrées) et le nombre de RANGÉES décide
    // de la hauteur (GRID3 et CARDS rangent six valeurs sur deux rangées, GRID2
    // sur trois et TABLE sur six).
    //
    // MESURÉ le 27/09 : GRID3 697×296, GRID2 501×432, TABLE 518×440,
    // CARDS 810×320. Les seules relations asserties ci-dessous sont celles qui
    // gardent plus de 100 px de marge — TABLE n'est PAS la plus étroite
    // (518 > 501 : sa ligne unique met le libellé À CÔTÉ de la valeur au lieu de
    // l'empiler), et elle ne dépasse GRID2 en hauteur que de 8 px, ce qu'un
    // changement de police suffirait à inverser. Asserter ces deux-là aurait
    // donné un test qui casse sans régression.
    const geometries = new Map<string, { largeur: number; hauteur: number }>();
    for (const disposition of DISPOSITIONS_ETAT) {
      // GRID3 n'est rendu en image qu'en V2 : en V1 il est natif (T4).
      const composants = disposition === 'GRID3' ? 'V2' : 'V1';
      const { charge, ecrit } = await panneauEcrit(
        surDisposition(disposition, 'DARK', composants),
        { presents: [OWNER, PRESENT] },
      );
      expect(ecrit).toBe(true);
      const image = imageDe(charge);
      expect({ disposition, image: Boolean(image) }).toEqual({ disposition, image: true });
      geometries.set(disposition, { largeur: image!.largeur, hauteur: image!.hauteur });
    }

    // Quatre dispositions, quatre géométries distinctes.
    const empreintes = new Set([...geometries.values()].map((g) => `${g.largeur}x${g.hauteur}`));
    expect(empreintes.size).toBe(DISPOSITIONS_ETAT.length);

    const g = (nom: string) => geometries.get(nom)!;
    // Largeur : deux colonnes < trois colonnes serrées < trois colonnes
    // espacées et encadrées. Aucune dimension en dur — une police ou un libellé
    // plus long les déplace toutes ensemble, l'ordre reste.
    expect(g('GRID2').largeur).toBeLessThan(g('GRID3').largeur);
    expect(g('GRID3').largeur).toBeLessThan(g('CARDS').largeur);

    // Hauteur : les deux dispositions à DEUX rangées sont strictement plus
    // basses que celles à trois et six rangées.
    const deuxRangees = Math.max(g('GRID3').hauteur, g('CARDS').hauteur);
    const plusDeRangees = Math.min(g('GRID2').hauteur, g('TABLE').hauteur);
    expect(deuxRangees).toBeLessThan(plusDeRangees);
  }, 180_000);

  test('T7 — table de vérité natif/image : les 8 couples disposition × composants en teinte livrée', async () => {
    // ÉCHOUE SI : la règle effective change. Elle N'EST PAS celle annoncée
    // (« GRID3 + V1 est le seul cas natif ») : `etatRenduNativement` ajoute une
    // exception pour le rendu LIVRÉ — GRID3 + teinte NEUTRAL reste natif même
    // en V2, sans quoi tous les serveurs déjà en service basculeraient en PNG
    // au simple déploiement, et chaque réécriture enverrait ~30 Ko qui
    // n'existaient pas. `dispositionNative` (le service) et le commentaire de
    // `PanneauRendu` disent encore « GRID3 en V1 » : c'est cette divergence-là
    // que la table ci-dessous fixe noir sur blanc.
    const table: Array<{ disposition: string; composants: string; natif: boolean }> = [];
    for (const disposition of DISPOSITIONS_ETAT) {
      for (const composants of JEUX_COMPOSANTS) {
        const { charge, ecrit } = await panneauEcrit(
          surDisposition(disposition, PRESENTATION_PAR_DEFAUT.teinte, composants),
          { presents: [OWNER, PRESENT] },
        );
        expect({ disposition, composants, ecrit }).toEqual({ disposition, composants, ecrit: true });
        table.push({ disposition, composants, natif: imageDe(charge) === null });
      }
    }
    expect(table).toEqual([
      { disposition: 'GRID3', composants: 'V1', natif: true },
      // L'exception assumée : le rendu livré ne bascule pas en image.
      { disposition: 'GRID3', composants: 'V2', natif: true },
      { disposition: 'GRID2', composants: 'V1', natif: false },
      { disposition: 'GRID2', composants: 'V2', natif: false },
      { disposition: 'TABLE', composants: 'V1', natif: false },
      { disposition: 'TABLE', composants: 'V2', natif: false },
      { disposition: 'CARDS', composants: 'V1', natif: false },
      { disposition: 'CARDS', composants: 'V2', natif: false },
    ]);
  }, 180_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T8 & T9 — les trois stateColors
// ═══════════════════════════════════════════════════════════════════════════

describe('T8/T9 — les teintes ne touchent que les rendus en image', () => {
  test('T8 — les trois teintes changent les couleurs de l’image, jamais sa mise en page', async () => {
    // ÉCHOUE SI : `stateColors` cesse d'atteindre `rendreEtatPng` (trois images
    // identiques : le réglage serait mort), ou si une teinte déplace la mise en
    // page (même contenu, mêmes dimensions attendues — un changement de
    // géométrie voudrait dire que la teinte fait autre chose que teinter).
    const rendus = new Map<string, { octets: Buffer; largeur: number; hauteur: number }>();
    for (const teinte of TEINTES_ETAT) {
      const { charge, ecrit } = await panneauEcrit(
        ligneBase(GUILD_A, { stateLayout: 'GRID2', stateColors: teinte, panelComponents: 'V1' }),
        { presents: [OWNER, PRESENT] },
      );
      expect({ teinte, ecrit }).toEqual({ teinte, ecrit: true });
      const image = imageDe(charge);
      expect({ teinte, image: Boolean(image) }).toEqual({ teinte, image: true });
      // Le nom porte la teinte : c'est ce qui permet de savoir, en production,
      // laquelle a réellement été rendue.
      expect(image!.nom).toContain(`-${teinte.toLowerCase()}-`);
      rendus.set(teinte, image!);
    }

    const octets = new Set([...rendus.values()].map((r) => r.octets.toString('base64')));
    expect(octets.size).toBe(TEINTES_ETAT.length);

    const geometries = new Set([...rendus.values()].map((r) => `${r.largeur}x${r.hauteur}`));
    expect(geometries.size).toBe(1);
  }, 180_000);

  test('T9 — sur GRID3 + V1 (natif) les trois teintes ne changent RIEN', async () => {
    // ÉCHOUE SI : une teinte finit par déclencher une image sur le cas natif,
    // ou par colorer l'embed. C'est la contrepartie de T8 : le schéma promet
    // « aucun effet sur les embeds ou les Components V2, qui suivent le thème
    // Discord du client », et la route émet même un avertissement dédié quand
    // une teinte est enregistrée sur GRID3+V1. Une teinte qui agirait quand
    // même ferait de cet avertissement un mensonge.
    const observees: Array<{ teinte: string; image: boolean; couleur: unknown; champs: unknown }> = [];
    for (const teinte of TEINTES_ETAT) {
      const { charge, ecrit } = await panneauEcrit(
        ligneBase(GUILD_A, { stateLayout: 'GRID3', stateColors: teinte, panelComponents: 'V1' }),
        { presents: [OWNER, PRESENT] },
      );
      expect({ teinte, ecrit }).toEqual({ teinte, ecrit: true });
      const embeds = (charge?.embeds ?? []) as Array<{ data?: Record<string, unknown> }>;
      observees.push({
        teinte,
        image: imageDe(charge) !== null,
        couleur: embeds[0]?.data?.color,
        champs: (embeds[0]?.data?.fields as unknown[])?.length,
      });
    }
    // Les trois lignes doivent être identiques hors le nom de la teinte.
    const sansNom = observees.map(({ teinte: _t, ...reste }) => JSON.stringify(reste));
    expect(new Set(sansNom).size).toBe(1);
    expect(observees.every((o) => o.image === false && o.champs === 6)).toBe(true);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T10 & T11 — panelMode CLASSIC contre FLAT
// ═══════════════════════════════════════════════════════════════════════════

describe('T10/T11 — CLASSIC et FLAT : messages et composants', () => {
  test('T10 — CLASSIC : une rangée, trois portes, et un message de PLUS pour verrouiller', async () => {
    // ÉCHOUE SI : le panneau public CLASSIC gagne ou perd un bouton. C'est le
    // témoin du comportement livré : `panelMode` par défaut vaut CLASSIC
    // précisément pour qu'un déploiement ne change rien. Si ce test tombe, tous
    // les serveurs qui n'ont rien réglé ont vu leur panneau changer.
    const { charge, channel, ecouteurs, ecrit } = await panneauEcrit(
      ligneBase(GUILD_A, { panelMode: 'CLASSIC' }),
      { presents: [OWNER, PRESENT] },
    );
    expect(ecrit).toBe(true);

    expect(((charge?.components as unknown[]) ?? []).length).toBe(1);
    const publics = composantsDe(charge);
    expect(idsDe(publics)).toEqual(['tempvoice:salon', 'tempvoice:membres', 'tempvoice:propriete']);
    // Le verrou n'est PAS sur le message public en CLASSIC.
    expect(idsDe(publics)).not.toContain('tempvoice:bascule_verrou');

    // Verrouiller coûte donc un message de plus : l'éphémère « Channel ».
    const ephemeres = await cliquer(ecouteurs, channel, 'salon');
    expect(ephemeres.length).toBe(1);
    expect(idsDe(composantsDe(ephemeres))).toContain('tempvoice:bascule_verrou');
  }, 60_000);

  test('T11 — FLAT : quatre rangées, le verrou sur le message public, ZÉRO éphémère', async () => {
    // ÉCHOUE SI : `rangeesPlates` disparaît (le mode retomberait sur CLASSIC en
    // silence), si une rangée se perd, ou si un `UserSelectMenu` s'y glisse —
    // la promesse écrite du mode est « AUCUN UserSelectMenu ici : pas de
    // recherche dans le serveur, les actions ne visent que les présents ».
    const { charge, ecrit } = await panneauEcrit(
      ligneBase(GUILD_A, { panelMode: 'FLAT' }),
      { presents: [OWNER, PRESENT] },
    );
    expect(ecrit).toBe(true);

    // Quatre rangées : actions, propriété+réglages, mode d'écriture, présents.
    expect(((charge?.components as unknown[]) ?? []).length).toBe(4);

    const publics = composantsDe(charge);
    const ids = idsDe(publics);
    // Ce que FLAT met sur le message public et que CLASSIC gardait derrière une
    // porte : agir ne demande plus aucun message supplémentaire.
    for (const attendu of [
      'tempvoice:bascule_verrou',
      'tempvoice:limit',
      'tempvoice:rename',
      'tempvoice:reserve',
      'tempvoice:propriete',
      'tempvoice:reglages',
    ]) {
      expect(ids).toContain(attendu);
    }
    // Et les deux portes de CLASSIC n'y sont plus : tout est déjà là.
    expect(ids).not.toContain('tempvoice:salon');
    expect(ids).not.toContain('tempvoice:membres');

    // Aucune recherche dans le serveur.
    expect(publics.filter((c) => c.type === ComponentType.UserSelect)).toEqual([]);
    // Le menu des présents propose bien les présents, non bots.
    const menus = publics.filter((c) => c.type === ComponentType.StringSelect);
    expect(menus.length).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T12 & T13 — reservationFallbackMode
// ═══════════════════════════════════════════════════════════════════════════

describe('T12/T13 — les trois replis du bouton « Réserver »', () => {
  /** Un rôle réservable est LISTÉ et la personne qui clique n'en porte aucun :
   *  c'est la seule situation où le repli tranche (cf. `planReservation`). */
  const avecRepli = (repli: string) => ligneBase(GUILD_A, {
    reservationFallbackMode: repli,
    reservableRoleIds: [ROLE_RESERVABLE],
    panelMode: 'FLAT',
  });

  test('T12 — MEMBERS, ANY_ROLE, FORBIDDEN : trois comportements NOMMÉS et distincts', async () => {
    // ÉCHOUE SI : `reservationFallbackMode` n'atteint plus `planReservation`,
    // ou si deux replis finissent par se comporter pareil. Avant ce réglage il
    // n'y avait qu'un comportement : le menu libre de tous les rôles du
    // serveur — donc deux des trois lignes ci-dessous n'existaient pas.
    const observes: Array<{ repli: string; ids: string[]; typeSelecteur: unknown; repond: boolean }> = [];
    for (const repli of REPLIS_RESERVATION) {
      const { channel, ecouteurs, ecrit } = await panneauEcrit(avecRepli(repli), { presents: [OWNER, PRESENT] });
      expect({ repli, ecrit }).toEqual({ repli, ecrit: true });

      const reponses = await cliquer(ecouteurs, channel, 'reserve');
      const selecteurs = composantsDe(reponses)
        .filter((c) => String(c.custom_id ?? '').startsWith('tempvoice:reserve'));
      observes.push({
        repli,
        ids: idsDe(selecteurs),
        typeSelecteur: selecteurs[0]?.type,
        // Le bouton répond toujours quelque chose : un repli muet serait un
        // bouton mort, indiscernable d'un refus.
        repond: reponses.length > 0,
      });
    }

    expect(observes).toEqual([
      // MEMBERS : on choisit des PERSONNES, parmi les présents, pas un rôle.
      { repli: 'MEMBERS', ids: ['tempvoice:reserve_membres'], typeSelecteur: ComponentType.StringSelect, repond: true },
      // ANY_ROLE : le menu des rôles, comportement livré.
      { repli: 'ANY_ROLE', ids: ['tempvoice:reserve_select'], typeSelecteur: ComponentType.RoleSelect, repond: true },
      // FORBIDDEN : un refus motivé, et RIEN à cliquer.
      { repli: 'FORBIDDEN', ids: [], typeSelecteur: undefined, repond: true },
    ]);
  }, 180_000);

  test('T13 — FORBIDDEN refuse vraiment ; sans rôle réservable listé, le repli est INERTE', async () => {
    // ÉCHOUE SI : FORBIDDEN laisse passer un sélecteur (le refus serait
    // décoratif), ou si le repli s'applique alors qu'aucun rôle réservable
    // n'est listé — un serveur qui n'a jamais rempli `reservableRoleIds` se
    // retrouverait privé de réservation par un réglage qu'il n'a pas compris.
    const { channel, ecouteurs, ecrit } = await panneauEcrit(avecRepli('FORBIDDEN'), { presents: [OWNER, PRESENT] });
    expect(ecrit).toBe(true);
    const reponses = await cliquer(ecouteurs, channel, 'reserve');
    expect(reponses.length).toBeGreaterThan(0);
    // AUCUN composant, pas seulement aucun sélecteur de réservation : un menu
    // d'un autre nom rendrait la réservation possible par la porte de côté.
    expect(composantsDe(reponses)).toEqual([]);

    // Sans rôle réservable listé, les trois replis rendent le MÊME plan :
    // `reservableRoleIds` vide vaut « aucune restriction », le repli ne
    // s'applique pas. Mesuré sur la fonction pure, puis sur le panneau.
    const plansSansListe = REPLIS_RESERVATION.map((r) => planReservation(['role-quelconque'], [], r).type);
    expect(new Set(plansSansListe)).toEqual(new Set(['tous_roles']));

    const libre = await panneauEcrit(
      ligneBase(GUILD_A, { reservationFallbackMode: 'FORBIDDEN', reservableRoleIds: [], panelMode: 'FLAT' }),
      { presents: [OWNER, PRESENT] },
    );
    expect(libre.ecrit).toBe(true);
    const reponsesLibres = await cliquer(libre.ecouteurs, libre.channel, 'reserve');
    expect(idsDe(composantsDe(reponsesLibres))).toContain('tempvoice:reserve_select');
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T14 & T15 — la route du dashboard
// ═══════════════════════════════════════════════════════════════════════════

describe('T14/T15 — ce que la route accepte et ce qu’elle sert par défaut', () => {
  const GUILD_CONFIG_ROW = {
    autoThreadEnabled: false,
    autoThreadChannels: [],
    autoThreadBotsEnabled: false,
    statsEnabled: false,
    statsConfig: null,
    tempVoiceEnabled: true,
    tempVoiceChannelId: null,
    tempVoiceCategoryId: null,
    tempVoiceNameTemplate: '🔊 Salon de {user}',
    tempVoiceRequiredRoleId: null,
    tempVoiceDefaults: null,
    tempVoiceGenerators: null,
    honeypotEnabled: false,
    honeypotChannelId: null,
    honeypotSanction: 'WARN',
    honeypotReinvite: false,
    wordStatsEnabled: false,
  };

  function requete(body: Record<string, unknown>): IncomingMessage {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = 'PATCH';
    req.url = `/api/dashboard/guilds/${GUILD_A}/channels-management`;
    req.headers = { 'content-type': 'application/json' };
    req.push(JSON.stringify(body));
    req.push(null);
    return req;
  }

  interface Reponse extends ServerResponse { body: string }

  function reponse(): Reponse {
    const socket = new Socket();
    const res = new ServerResponse(new IncomingMessage(socket)) as Reponse;
    let code = 200;
    let corps = '';
    Object.defineProperty(res, 'statusCode', { get: () => code, set: (c: number) => { code = c; } });
    res.setHeader = () => res;
    res.getHeader = () => undefined;
    res.writeHead = (c: number) => { code = c; return res; };
    res.end = (chunk?: unknown) => { if (chunk) corps += String(chunk); res.body = corps; return res; };
    return res;
  }

  const clientVide = () => ({
    guilds: {
      cache: new Map<string, unknown>([[GUILD_A, {
        id: GUILD_A,
        name: 'Serveur A',
        preferredLocale: 'en',
        channels: { cache: new Map<string, unknown>() },
        roles: { cache: new Map<string, unknown>() },
        members: { cache: new Map<string, unknown>(), fetch: mock(async () => null) },
      }]]),
    },
  } as unknown as Client);

  async function appeler(method: 'GET' | 'PATCH', body: Record<string, unknown>) {
    ligneGuild = GUILD_CONFIG_ROW;
    const res = reponse();
    await handleChannelsManagementRoutes({
      req: requete(body),
      res,
      parts: ['api', 'dashboard', 'guilds', GUILD_A, 'channels-management'],
      url: new URL(`http://localhost/api/dashboard/guilds/${GUILD_A}/channels-management`),
      client: clientVide(),
      user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
      guildId: GUILD_A,
      access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
      method,
      auditUser: 'Admin',
      moduleKey: 'channels-management',
    } as never);
    return res;
  }

  const CINQ_CHAMPS = [
    ['panelMode', 'PLEIN_ECRAN'],
    ['stateLayout', 'GRID9'],
    ['stateColors', 'RAINBOW'],
    ['panelComponents', 'V3'],
    ['reservationFallbackMode', 'MEMBRES'],
  ] as const;

  test('T14 — une valeur inconnue est REFUSÉE en 400, champ par champ, et rien n’est écrit', async () => {
    // ÉCHOUE SI : un seul des cinq champs retombe silencieusement sur son
    // défaut côté route. Le rabattre en silence donne le pire des cas : la page
    // annonce « enregistré », la base garde l'ancienne valeur, le panneau ne
    // change pas, et rien ne le signale. Les champs sont invalidés UN PAR UN :
    // les invalider tous ensemble laisserait passer une validation manquante
    // sur quatre d'entre eux.
    const verdicts: Array<{ champ: string; code: number; nomme: boolean; ecritures: number }> = [];
    for (const [champ, valeur] of CINQ_CHAMPS) {
      const avant = (prismaMock.tempVoiceModPermissionsConfig.upsert.mock.calls as unknown[][]).length;
      const res = await appeler('PATCH', {
        tempVoiceModPermissions: { ...ligneBase(GUILD_A), [champ]: valeur },
      });
      const erreur = String(JSON.parse(res.body || '{}').error ?? '');
      verdicts.push({
        champ,
        code: res.statusCode,
        // Le message doit NOMMER le champ ET la valeur refusée : sans ça,
        // l'administrateur voit « 400 » sur un formulaire à onze réglages.
        nomme: erreur.includes(champ) && erreur.includes(valeur),
        ecritures: (prismaMock.tempVoiceModPermissionsConfig.upsert.mock.calls as unknown[][]).length - avant,
      });
    }
    expect(verdicts).toEqual(CINQ_CHAMPS.map(([champ]) => ({ champ, code: 400, nomme: true, ecritures: 0 })));

    // Et le témoin : un corps entièrement valide, lui, passe — sinon le 400
    // ci-dessus pourrait venir de n'importe quoi d'autre dans la requête.
    const ok = await appeler('PATCH', { tempVoiceModPermissions: ligneBase(GUILD_A, { panelMode: 'FLAT' }) });
    expect(ok.statusCode).toBe(200);
  }, 60_000);

  test('T15 — les défauts du schéma Prisma, de la route et du service sont les MÊMES, et servis à une guilde sans ligne', async () => {
    // ÉCHOUE SI : les `@default(...)` du schéma et l'une de leurs copies
    // divergent. Ces cinq valeurs sont recopiées à la main dans cinq endroits
    // (schéma Prisma, route, service, `moderation.ts`, `ChannelsManagement.svelte`)
    // et RIEN ne les comparait : une valeur changée ici seule donne un panneau
    // qui rend autre chose que ce que la base contient, sans aucune erreur.
    // Le schéma est lu comme un TEXTE, jamais évalué : c'est la source de
    // vérité de la base, et la seule qui décide de ce qu'une première
    // insertion écrira.
    const schema = readFileSync(
      path.resolve(import.meta.dir, '../../../../../packages/database/prisma/temp-voice-access.prisma'),
      'utf8',
    );
    const bloc = schema.slice(schema.indexOf('model TempVoiceModPermissionsConfig'));
    const defautSchema = (colonne: string): string | null =>
      bloc.match(new RegExp(`\\n\\s*${colonne}\\s+String\\s+@default\\("([^"]+)"\\)`))?.[1] ?? null;

    // Les trois sources comparees plus bas ne rendent pas le meme type :
    // `string | null` pour le schema lu au regex, des litteraux stricts pour le
    // service, `unknown` pour le JSON de la route. Chaque comparaison est donc
    // elargie a `Record<string, unknown>` — la comparaison, elle, porte sur les
    // valeurs, et reste aussi stricte.
    const attendu = {
      panelMode: 'CLASSIC',
      stateLayout: 'GRID3',
      stateColors: 'NEUTRAL',
      panelComponents: 'V2',
      reservationFallbackMode: 'ANY_ROLE',
    };

    // 1. Le schéma Prisma.
    expect({
      panelMode: defautSchema('panelMode'),
      stateLayout: defautSchema('stateLayout'),
      stateColors: defautSchema('stateColors'),
      panelComponents: defautSchema('panelComponents'),
      reservationFallbackMode: defautSchema('reservationFallbackMode'),
    } as Record<string, unknown>).toEqual(attendu);

    // 2. Le service du bot, qui décide de la tête du panneau.
    expect({
      panelMode: PRESENTATION_PAR_DEFAUT.mode,
      stateLayout: PRESENTATION_PAR_DEFAUT.disposition,
      stateColors: PRESENTATION_PAR_DEFAUT.teinte,
      panelComponents: PRESENTATION_PAR_DEFAUT.composants,
      reservationFallbackMode: PRESENTATION_PAR_DEFAUT.repliReservation,
    } as Record<string, unknown>).toEqual(attendu);

    // 3. La route, pour une guilde qui n'a JAMAIS rien réglé : aucune ligne en
    // base, et pourtant les cinq défauts servis — la page doit montrer l'état
    // réel, pas des cases vides.
    lignesParServeur.set(GUILD_A, null);
    prismaMock.tempVoiceModPermissionsConfig.findUnique = mock(async () => null);
    const res = await appeler('GET', {});
    expect(res.statusCode).toBe(200);
    const servi = JSON.parse(res.body).tempVoiceModPermissions as Record<string, unknown>;
    expect({
      panelMode: servi.panelMode,
      stateLayout: servi.stateLayout,
      stateColors: servi.stateColors,
      panelComponents: servi.panelComponents,
      reservationFallbackMode: servi.reservationFallbackMode,
    } as Record<string, unknown>).toEqual(attendu);

    // 4. Et le panneau du bot, pour cette même guilde sans ligne : le rendu
    // livré, natif, six champs inline — aucun PNG, aucun basculement.
    const { charge, ecrit } = await panneauEcrit(null, { presents: [OWNER, PRESENT] });
    expect(ecrit).toBe(true);
    expect(imageDe(charge)).toBeNull();
    const embeds = (charge?.embeds ?? []) as Array<{ data?: { fields?: unknown[] } }>;
    expect(embeds[0]?.data?.fields?.length).toBe(6);
    expect(porteLaMarque(charge)).toBe(false);
  }, 60_000);
});
