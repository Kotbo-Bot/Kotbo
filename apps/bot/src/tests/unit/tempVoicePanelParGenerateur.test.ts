/**
 * La présentation du panneau PAR GÉNÉRATEUR, et surtout sa sortie de secours.
 *
 * Le modèle est un héritage avec surcharge, derrière un interrupteur :
 *   perGeneratorPresentation FAUX → présentation(salon) = réglage serveur, point
 *   perGeneratorPresentation VRAI → surcharge du générateur, sinon serveur
 *
 * Ce fichier ne mesure pas « la surcharge s'applique » — c'est le plus facile.
 * Il mesure les quatre choses qui coûtent cher en production :
 *   1. l'HÉRITAGE PARTIEL : un champ surchargé ne doit pas entraîner les quatre
 *      autres vers le DÉFAUT ; ils héritent du SERVEUR, ce qui n'est pas la même
 *      chose dès que le serveur a réglé quoi que ce soit ;
 *   2. la PORTÉE : deux générateurs du même serveur, l'un en V1 l'autre en V2,
 *      rendus dans le MÊME processus, ne doivent pas se contaminer — ni entre
 *      eux, ni entre deux envois de la même charge (le Symbol de `patchV2` ne
 *      doit pas être consommé) ;
 *   3. la DÉGRADATION : colonne nulle, générateur supprimé, valeur hors
 *      énumération — le panneau doit sortir, avec le réglage du serveur, sans
 *      jamais lever ;
 *   4. l'INTERRUPTEUR : coupé, il IGNORE les surcharges sans les EFFACER, et un
 *      serveur qui n'a jamais rien réglé se comporte exactement comme avant.
 *
 * ── Pourquoi la plupart des tests mesurent une PAIRE ──
 * Un test qui vérifie seulement « interrupteur coupé → réglage serveur » reste
 * VERT si la fonctionnalité entière disparaît : sans surcharges, tout le monde
 * suit le serveur. Ces tests mesurent donc les deux côtés de l'interrupteur dans
 * la même assertion, sur le même générateur : l'écart entre les deux est la
 * seule preuve qui tienne, et il s'effondre aussi bien si le court-circuit
 * disparaît que si l'héritage n'a jamais existé.
 *
 * ── Ce qu'on observe, et pourquoi ──
 * `presentationDuSalon` est privée à `events/tempVoice.ts`. On ne l'observe donc
 * que sur la charge réellement écrite sur Discord, via l'écouteur, exactement
 * comme la production. Deux marqueurs, choisis parce qu'ils ne se confondent avec
 * rien :
 *   — `rangees` : CLASSIC pose UNE rangée de composants, FLAT en empile plusieurs ;
 *   — `v1` : le réglage V1 fait poser la marque `kotbo.sansConversionV2` sur la
 *     charge, et lui seul (voir `reecrirePanneau`).
 * Réimplémenter la règle dans le test ne prouverait rien du tout.
 *
 * ── MESURÉ : chaque test échoue bien si on retire le comportement neuf ──
 * Six mutations du PRODUIT, appliquées puis annulées (empreintes SHA-256
 * vérifiées après restauration). Chacun des quinze tests est tombé sous au
 * moins une :
 *   A `presentationPourGenerateur` rend toujours le réglage serveur (héritage
 *     supprimé) ................................ 2,4,5,6,7,8,10,13,14,15 (10 fail)
 *   B le court-circuit de l'interrupteur retiré ET `parGenerateur` forcé à vrai
 *     (la sortie de secours ne coupe plus) ................. 13,14,15 (3 fail)
 *   C `lireSurchargesPresentation` passe par `normaliserReglagesPresentation`
 *     (« hérite » devient « impose le défaut ») ................. 1,3 (2 fail)
 *   D `validateGeneratorPresentationOverrides` rend toujours `null`
 *     (la route accepte tout) ..................................... 11 (1 fail)
 *   E `generatorChannelId` écrit à `null` à la création ........... 12 (1 fail)
 *   F la présentation lue pour un guildId EN DUR (fuite entre serveurs)
 *     ........................................................ 9,10 (2 fail)
 * Note mesurée sur B : retirer le SEUL court-circuit de `presentationDuSalon`
 * sans forcer `parGenerateur` ne fait tomber aucun test — ce test est bien une
 * économie de lecture et non une seconde règle, comme son commentaire l'affirme.
 */
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Events, MessageFlags, VoiceChannel, type Client } from 'discord.js';

import type { AuthClaims, DashboardAccess } from '../../api/shared.js';
import { completeModuleMock } from '../helpers/moduleMock.js';
import {
  DEFAULT_NAME_TEMPLATE,
  lireSurchargesPresentation,
  normaliserReglagesPresentation,
  PRESENTATION_PAR_DEFAUT,
  presentationParGenerateurActive,
  presentationPourGenerateur,
  resolveTempVoiceGenerators,
  type ReglagesPresentation,
  type TempVoiceGuildConfig,
} from '../../services/features/tempVoiceService';
import { logger } from '../../utils/logger.js';

const GUILD = '120000000000000000';
const GUILD_B = '120000000000000009';
const OWNER = '220000000000000000';
const PRESENT = '230000000000000000';
const BOT = '330000000000000000';

/** Le générateur principal (celui des colonnes à plat de `Guild`) ne surcharge
 *  jamais rien : le réglage du serveur EST le sien. Les trois autres vivent dans
 *  le JSON `tempVoiceGenerators` et peuvent surcharger. */
const GEN_PRINCIPAL = '510000000000000001';
const GEN_V1 = '510000000000000002';
const GEN_V2 = '510000000000000003';
const GEN_FLAT = '510000000000000004';

// ═══════════════════════════════════════════════════════════════════════════
// Mocks de modules — posés AVANT l'import de l'écouteur et de la route
// ═══════════════════════════════════════════════════════════════════════════

/** Lignes `TempVoiceModPermissionsConfig`, UNE PAR SERVEUR (`guildId String @id`).
 *  Servir la même ligne à tout le monde rendrait les tests de portée verts sans
 *  rien prouver. */
const lignesParServeur = new Map<string, Record<string, unknown> | null>();
/** Configuration `Guild` servie par le cache, une par serveur : c'est elle qui
 *  porte `tempVoiceGenerators`, donc les surcharges. */
const configsParServeur = new Map<string, Record<string, unknown> | null>();
/** Tout ce qui a été écrit dans `TempVoiceChannel` : c'est là qu'on lit si
 *  `generatorChannelId` a bien été posé à la création. */
const salonsEnregistres: Array<Record<string, unknown>> = [];

const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async (args: { where: { guildId: string } }) =>
      lignesParServeur.get(args.where.guildId) ?? null),
    upsert: mock(async () => ({})),
  },
  tempVoiceAccessRequestConfig: {
    findUnique: mock(async () => null as Record<string, unknown> | null),
    upsert: mock(async () => ({})),
  },
  tempVoiceChannel: {
    findMany: mock(async () => [] as Array<Record<string, unknown>>),
    findUnique: mock(async () => null as Record<string, unknown> | null),
    create: mock(async (args: { data: Record<string, unknown> }) => {
      salonsEnregistres.push(args.data);
      return args.data;
    }),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
  },
  // La route de sauvegarde lit et écrit `Guild`, et journalise.
  guild: {
    findUnique: mock(async () => null as Record<string, unknown> | null),
    update: mock(async () => ({})),
  },
  dashboardAuditLog: { create: mock(async () => ({})) },
  dashboardFeatureConfig: { upsert: mock(async () => ({})) },
};

const cheminCache = path.resolve(import.meta.dir, '../../utils/cache.ts');
const mockCache = () => completeModuleMock(cheminCache, {
  getCachedGuild: mock(async (guildId: string) => configsParServeur.get(guildId) ?? null),
  cache: { invalidateGuild: mock(async () => undefined) },
});

const mocksModules: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() })],
  ['../../utils/cache', mockCache],
];

for (const [relatif, fabrique] of mocksModules) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

/**
 * ⚠️ CORRECTIF D'ENVIRONNEMENT, PAS UN MOCK — à retirer dès que les liens de
 * `node_modules` de ce worktree sont refaits. Même remède que
 * `tempVoicePanelParite.test.ts`, pour la même cause.
 *
 * MESURÉ ici : `node_modules/@kotbo/contracts` est un lien symbolique vers le
 * `packages/contracts` d'un AUTRE checkout, qui n'exporte pas
 * `RPG_ITEM_RARITIES` — que le code d'ici importe. Tout fichier qui charge
 * `api/shared.ts` échoue donc au chargement, `channelsManagementRoute.test.ts`
 * compris (antérieur à ce fichier, et cassé à l'identique).
 *
 * Ce `mock.module` ne remplace rien : il redonne au spécificateur
 * `@kotbo/contracts` le VRAI module de ce worktree, celui que `bun` aurait
 * résolu sans le lien croisé. Sans lui, AUCUN des quinze tests ne pourrait être
 * exécuté : l'échec est au chargement du fichier.
 */
const contractsDuWorktree = await import(
  path.resolve(import.meta.dir, '../../../../../packages/contracts/src/index.ts')
);
mock.module('@kotbo/contracts', () => contractsDuWorktree);

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');
const { DASHBOARD_ACCESS_ADMIN } = await import('../../api/shared.js');
const { handleChannelsManagementRoutes } = await import(
  '../../api/routes/dashboard/modules/channels-management.js'
);

/**
 * Les avertissements du module, sans `mock.module` sur `../../utils/logger`.
 *
 * `logger` est un objet partagé : on remplace la seule méthode qu'on observe et
 * on la rend en fin de fichier. Mocker le module entier ferait disparaître ses
 * autres exports pour les fichiers de test chargés ensuite.
 */
const avertissements: string[] = [];
const warnOriginal = logger.warn;
logger.warn = ((_tag: string, ...args: unknown[]) => {
  avertissements.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
}) as typeof logger.warn;
afterAll(() => { logger.warn = warnOriginal; });

// ═══════════════════════════════════════════════════════════════════════════
// Harnais : le panneau tel que Discord le reçoit
// ═══════════════════════════════════════════════════════════════════════════

/** La marque d'échappatoire de `patchV2`, lue comme le fait le patch lui-même. */
const MARQUE_SANS_V2 = Symbol.for('kotbo.sansConversionV2');
const porteLaMarque = (charge: unknown): boolean =>
  Boolean(charge) && typeof charge === 'object'
  && Object.getOwnPropertySymbols(charge as object).includes(MARQUE_SANS_V2);

let compteurSalons = 0;
/** Un identifiant NEUF par rendu : l'écouteur garde de l'état par salon
 *  (panneau mémorisé, avertissements déjà dits), et le réutiliser ferait
 *  dépendre un test du précédent. */
const prochainId = (): string => `46000000000000${String(1000 + (compteurSalons += 1))}`;

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

/** Le message du panneau, et tout ce qu'on lui écrit. */
function fauxPanneau(estV2 = false) {
  const charges: Array<Record<string, unknown>> = [];
  return {
    charges,
    message: {
      id: '777100000000000001',
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
  const guildId = options.guildId ?? GUILD;
  const presents = options.presents ?? [OWNER, PRESENT];
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
    // connaît, et sinon les vingt-cinq derniers : les deux formes sont servies.
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
function lignePresentation(champs: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    panelMode: 'CLASSIC',
    stateLayout: 'GRID3',
    stateColors: 'NEUTRAL',
    panelComponents: 'V2',
    reservationFallbackMode: 'ANY_ROLE',
    ...champs,
  };
}

/** La configuration `Guild` d'un serveur, générateurs additionnels compris. */
function configAvecGenerateurs(generateurs: unknown[]): Record<string, unknown> {
  return {
    tempVoiceEnabled: true,
    baseStaffRoleId: null,
    moderatorRoleId: null,
    testStaffRoleId: null,
    tempVoiceChannelId: GEN_PRINCIPAL,
    tempVoiceCategoryId: null,
    tempVoiceNameTemplate: DEFAULT_NAME_TEMPLATE,
    tempVoiceDefaults: {},
    tempVoiceGenerators: generateurs,
  };
}

interface RenduPanneau {
  ecrit: boolean;
  /** CLASSIC pose UNE rangée, FLAT en empile plusieurs. */
  rangees: number;
  /** Vrai quand la charge porte la marque « sans conversion V2 » : réglage V1. */
  v1: boolean;
  charge: Record<string, unknown> | undefined;
}

/**
 * Le panneau réellement écrit sur Discord pour un salon venant d'un générateur
 * donné. `generateurId` absent = `TempVoiceChannel.generatorChannelId` nul,
 * c'est-à-dire un salon né avant la colonne.
 */
async function panneauPour(options: {
  ligne: Record<string, unknown> | null;
  guildId?: string;
  generateurs?: unknown[];
  generateurId?: string;
}): Promise<RenduPanneau> {
  const guildId = options.guildId ?? GUILD;
  const id = prochainId();
  lignesParServeur.set(guildId, options.ligne);
  configsParServeur.set(guildId, configAvecGenerateurs(options.generateurs ?? []));

  const panneau = fauxPanneau(false);
  const channel = fauxSalon(id, panneau, { guildId });
  // `fauxSalon` vient de poser l'entrée mémoire : on y ajoute d'où vient le
  // salon, ce que `createTempChannel` fait en vrai depuis `generator.channelId`.
  const entree = tempChannels.get(id);
  if (entree && options.generateurId) entree.generateurId = options.generateurId;

  const { client, ecouteurs } = fauxClient();
  registerTempVoiceListener(client);
  await rejouerEntree(ecouteurs, channel);
  const ecrit = await jusqua(() => panneau.charges.length > 0);
  // Les échecs de réécriture partent en `logger.warn`, capturé ici : sans ce
  // rappel, un panneau jamais écrit ne donnerait qu'un `false` sans cause.
  if (!ecrit) console.warn(`[T] aucune charge écrite pour ${id} :`, avertissements.slice(-3));

  tempChannels.delete(id);
  const charge = panneau.charges[0];
  return {
    ecrit,
    rangees: (charge?.components as unknown[] | undefined)?.length ?? 0,
    v1: porteLaMarque(charge),
    charge,
  };
}

/**
 * Passe une charge par le `send` RÉELLEMENT patché (les prototypes discord.js
 * sont patchés à l'import de `utils/patchV2`, que l'écouteur importe). L'appel
 * d'origine échoue sur un `this` factice, mais la transformation est déjà faite :
 * la charge est mutée sur place, donc on inspecte l'objet qu'on a fourni.
 */
function envoiPatche<T extends object>(payload: T): T {
  try {
    const retour = (VoiceChannel.prototype.send as (...args: unknown[]) => unknown)
      .call({} as never, payload);
    if (retour && typeof (retour as Promise<unknown>).catch === 'function') {
      (retour as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Attendu : seul le passage par transformPayload nous intéresse.
  }
  return payload;
}

// ═══════════════════════════════════════════════════════════════════════════
// Harnais : la route de sauvegarde du dashboard
// ═══════════════════════════════════════════════════════════════════════════

function requeteRoute(body: Record<string, unknown>): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = 'PATCH';
  req.url = `/api/dashboard/guilds/${GUILD}/channels-management`;
  req.headers = { 'content-type': 'application/json' };
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

interface ReponseRoute extends ServerResponse { body: string }

function reponseRoute(): ReponseRoute {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket)) as ReponseRoute;
  let code = 200;
  let corps = '';
  Object.defineProperty(res, 'statusCode', { get: () => code, set: (v: number) => { code = v; } });
  res.setHeader = () => res;
  res.getHeader = () => undefined;
  res.writeHead = (statusCode: number) => { code = statusCode; return res; };
  res.end = (chunk?: unknown) => {
    if (chunk) corps += String(chunk);
    res.body = corps;
    return res;
  };
  return res;
}

async function sauvegarder(body: Record<string, unknown>): Promise<ReponseRoute> {
  const res = reponseRoute();
  const client = {
    guilds: {
      cache: new Map<string, unknown>([[GUILD, {
        id: GUILD,
        name: 'Serveur test',
        preferredLocale: 'en',
        channels: { cache: new Map<string, unknown>() },
        roles: { cache: new Map<string, unknown>() },
        members: { cache: new Map<string, unknown>(), fetch: mock(async () => null) },
      }]]),
    },
  } as unknown as Client;

  await handleChannelsManagementRoutes({
    req: requeteRoute(body),
    res,
    parts: ['api', 'dashboard', 'guilds', GUILD, 'channels-management'],
    url: new URL(`http://localhost/api/dashboard/guilds/${GUILD}/channels-management`),
    client,
    user: { userId: 'user-1', username: 'Admin' } as AuthClaims,
    guildId: GUILD,
    access: DASHBOARD_ACCESS_ADMIN as DashboardAccess,
    method: 'PATCH',
    auditUser: 'Admin',
    moduleKey: 'channels-management',
  });
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// Le serveur de référence : les CINQ champs réglés HORS défaut
//
// C'est la seule façon de distinguer « hérite du serveur » de « retombe sur le
// défaut ». Avec un serveur laissé au défaut, les deux implémentations rendraient
// exactement la même chose et l'héritage ne serait pas mesuré.
// ═══════════════════════════════════════════════════════════════════════════
const SERVEUR_TOUT_REGLE: ReglagesPresentation = normaliserReglagesPresentation({
  panelMode: 'FLAT',
  stateLayout: 'CARDS',
  stateColors: 'DARK',
  panelComponents: 'V1',
  reservationFallbackMode: 'MEMBERS',
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 à 3 — l'héritage, champ par champ
// ─────────────────────────────────────────────────────────────────────────────

describe('héritage — un générateur ne casse pas ce que le serveur a réglé', () => {
  test('1 — sans aucune surcharge, les CINQ champs viennent du serveur', () => {
    // ÉCHOUE si l'héritage retombe sur `PRESENTATION_PAR_DEFAUT` au lieu du
    // réglage serveur : les cinq champs du serveur sont tous hors défaut, donc
    // un seul qui s'y ramènerait ferait échouer l'égalité. ÉCHOUE aussi à la
    // compilation si `presentationPourGenerateur` disparaît.
    const sansSurcharge = resolveTempVoiceGenerators({
      tempVoiceEnabled: true,
      tempVoiceChannelId: GEN_PRINCIPAL,
      tempVoiceCategoryId: null,
      tempVoiceNameTemplate: DEFAULT_NAME_TEMPLATE,
      tempVoiceGenerators: [{ channelId: GEN_FLAT, nameTemplate: 'Salon de {user}' }],
    } as TempVoiceGuildConfig, GUILD).find((g) => g.channelId === GEN_FLAT);

    // Le générateur existe et ne porte AUCUNE surcharge : sans ça, l'égalité
    // ci-dessous serait vraie faute d'avoir trouvé le générateur.
    expect(sansSurcharge?.channelId).toBe(GEN_FLAT);
    expect(sansSurcharge?.surchargesPresentation).toEqual({});

    expect(presentationPourGenerateur(SERVEUR_TOUT_REGLE, sansSurcharge, true))
      .toEqual(SERVEUR_TOUT_REGLE);
    // Et ce n'est PAS le défaut : la valeur de l'assertion ci-dessus en dépend.
    expect(SERVEUR_TOUT_REGLE).not.toEqual(PRESENTATION_PAR_DEFAUT);
  });

  test('2 — surcharge PARTIELLE : le champ surchargé change, les quatre autres héritent', () => {
    // LE test de l'héritage. ÉCHOUE si un champ non surchargé retombe sur son
    // défaut (bug le plus probable : passer les surcharges par
    // `normaliserReglagesPresentation`, qui comble chaque trou par le défaut),
    // et ÉCHOUE si le champ surchargé n'est pas pris.
    //
    // Les cinq champs un par un : une implémentation qui n'en raterait qu'un
    // seul passerait un test qui les surchargerait tous ensemble.
    const cas: Array<[keyof ReglagesPresentation, ReglagesPresentation[keyof ReglagesPresentation]]> = [
      ['mode', 'CLASSIC'],
      ['disposition', 'GRID2'],
      ['teinte', 'LIGHT'],
      ['composants', 'V2'],
      ['repliReservation', 'FORBIDDEN'],
    ];

    for (const [champ, valeur] of cas) {
      // La surcharge doit bien DIFFÉRER du serveur, sinon le cas ne mesure rien.
      expect(SERVEUR_TOUT_REGLE[champ]).not.toBe(valeur);

      const rendu = presentationPourGenerateur(
        SERVEUR_TOUT_REGLE,
        { surchargesPresentation: { [champ]: valeur } },
        true,
      );
      // Le champ dans l'attendu : l'échec nomme le champ fautif.
      expect({ champ, rendu }).toEqual({ champ, rendu: { ...SERVEUR_TOUT_REGLE, [champ]: valeur } });
    }
  });

  test('3 — une surcharge de valeur INCONNUE est ignorée et hérite, sans lever', () => {
    // ÉCHOUE si la valeur brute descend jusqu'au rendu (un `panelComponents:
    // "V3"` partirait vers Discord), et ÉCHOUE si une valeur inconnue fait
    // retomber le champ sur son DÉFAUT au lieu du réglage serveur — le piège :
    // un serveur en FLAT dont le générateur porte un mode fautif reviendrait en
    // CLASSIC sans que personne n'ait rien réglé.
    const brut = {
      panelMode: 'PLEIN_ECRAN',
      stateLayout: 'GRID9',
      stateColors: 'RAINBOW',
      panelComponents: 'V3',
      reservationFallbackMode: 'WHATEVER',
    };

    let surcharges: ReturnType<typeof lireSurchargesPresentation> | undefined;
    expect(() => { surcharges = lireSurchargesPresentation(brut); }).not.toThrow();
    // Aucune clé posée, même pas à `undefined` : une clé à `undefined` écraserait
    // le réglage du serveur au lieu d'en hériter.
    expect(Object.keys(surcharges ?? {})).toEqual([]);

    expect(presentationPourGenerateur(SERVEUR_TOUT_REGLE, { surchargesPresentation: surcharges }, true))
      .toEqual(SERVEUR_TOUT_REGLE);

    // Et par le chemin réel, celui du JSON en base.
    const resolu = resolveTempVoiceGenerators({
      tempVoiceEnabled: true,
      tempVoiceChannelId: GEN_PRINCIPAL,
      tempVoiceCategoryId: null,
      tempVoiceNameTemplate: DEFAULT_NAME_TEMPLATE,
      tempVoiceGenerators: [{ channelId: GEN_V1, ...brut }],
    } as TempVoiceGuildConfig, GUILD).find((g) => g.channelId === GEN_V1);
    expect(resolu?.surchargesPresentation).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 & 5 — la dégradation : le panneau sort TOUJOURS
// ─────────────────────────────────────────────────────────────────────────────

describe('dégradation — colonne nulle ou générateur disparu', () => {
  /** Un générateur qui impose FLAT : l'écart CLASSIC/FLAT se lit au nombre de rangées. */
  const GENERATEURS_FLAT = [{ channelId: GEN_FLAT, panelMode: 'FLAT' }];
  const LIGNE_ALLUMEE = lignePresentation({ perGeneratorPresentation: true });

  test('4 — generatorChannelId NUL : le réglage du serveur, sans erreur', async () => {
    // Paire : le MÊME serveur et le MÊME générateur, la colonne nulle puis
    // renseignée. ÉCHOUE si un salon sans générateur connu lève ou n'écrit
    // rien ; ÉCHOUE aussi si la colonne ne sert à rien (les deux rendus
    // seraient alors identiques).
    const sansColonne = await panneauPour({ ligne: LIGNE_ALLUMEE, generateurs: GENERATEURS_FLAT });
    const avecColonne = await panneauPour({
      ligne: LIGNE_ALLUMEE, generateurs: GENERATEURS_FLAT, generateurId: GEN_FLAT,
    });

    expect({ ecritSans: sansColonne.ecrit, ecritAvec: avecColonne.ecrit })
      .toEqual({ ecritSans: true, ecritAvec: true });
    expect(sansColonne.rangees).toBe(1);
    expect(avecColonne.rangees).toBeGreaterThan(1);
  }, 60_000);

  test('5 — générateur SUPPRIMÉ depuis : le réglage du serveur, sans erreur', async () => {
    // Le cas qui casse en production si on l'oublie : les salons d'un générateur
    // retiré de la configuration vivent encore. ÉCHOUE si `find` sans résultat
    // lève ou empêche l'écriture du panneau.
    avertissements.length = 0;
    const disparu = await panneauPour({
      ligne: LIGNE_ALLUMEE, generateurs: [], generateurId: GEN_FLAT,
    });
    const present = await panneauPour({
      ligne: LIGNE_ALLUMEE, generateurs: GENERATEURS_FLAT, generateurId: GEN_FLAT,
    });

    expect({ ecritDisparu: disparu.ecrit, ecritPresent: present.ecrit })
      .toEqual({ ecritDisparu: true, ecritPresent: true });
    expect(disparu.rangees).toBe(1);
    expect(present.rangees).toBeGreaterThan(1);
    // Un générateur absent est un cas NORMAL, pas un incident : rien ne doit
    // partir dans les journaux d'avertissement du panneau.
    expect(avertissements.filter((m) => /panneau/i.test(m))).toEqual([]);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 à 10 — LA PORTÉE : rien ne fuit d'un générateur, ni d'un serveur, à l'autre
// ─────────────────────────────────────────────────────────────────────────────

describe('portée — deux générateurs, deux serveurs, un seul processus', () => {
  /** Serveur en V2, un générateur qui impose V1, un autre qui impose V2.
   *  Le second surcharge explicitement la MÊME valeur que le serveur : un
   *  héritage qui fuirait du premier vers le second se verrait donc quand même. */
  const LIGNE_V2 = lignePresentation({ panelComponents: 'V2', perGeneratorPresentation: true });
  const DEUX_GENERATEURS = [
    { channelId: GEN_V1, panelComponents: 'V1' },
    { channelId: GEN_V2, panelComponents: 'V2' },
  ];

  const rendre = (generateurId: string) =>
    panneauPour({ ligne: LIGNE_V2, generateurs: DEUX_GENERATEURS, generateurId });

  test('6 — V1 puis V2 : chacun garde sa version', async () => {
    // ÉCHOUE si la surcharge n'est pas appliquée (le V1 rendrait V2, le réglage
    // du serveur), et ÉCHOUE si un état de module (mémoïsation de présentation,
    // drapeau global posé par le rendu V1) contamine le rendu suivant.
    const premier = await rendre(GEN_V1);
    const second = await rendre(GEN_V2);
    expect({ ecrit1: premier.ecrit, ecrit2: second.ecrit }).toEqual({ ecrit1: true, ecrit2: true });
    expect({ v1: premier.v1, v2: second.v1 }).toEqual({ v1: true, v2: false });
  }, 60_000);

  test('7 — V2 puis V1 : l’ordre inverse donne le même résultat', async () => {
    // Le même test dans l'autre sens : c'est l'ordre qui révèle une contamination.
    const premier = await rendre(GEN_V2);
    const second = await rendre(GEN_V1);
    expect({ ecrit1: premier.ecrit, ecrit2: second.ecrit }).toEqual({ ecrit1: true, ecrit2: true });
    expect({ v2: premier.v1, v1: second.v1 }).toEqual({ v2: false, v1: true });
  }, 60_000);

  test('8 — la MÊME charge envoyée deux fois garde sa version : le Symbol n’est pas consommé', async () => {
    // La marque est posée sur la charge, pas sur le message. Si `patchV2` la
    // CONSOMMAIT (un `delete` au premier passage), un panneau construit une fois
    // puis envoyé deux fois — un envoi, puis une édition — repartirait en
    // conversion V2 au second passage : il s'afficherait en V1 puis basculerait
    // en V2 tout seul. Bug déjà corrigé : ce test est là pour qu'il ne revienne pas.
    const enV1 = await rendre(GEN_V1);
    const enV2 = await rendre(GEN_V2);
    expect({ ecritV1: enV1.ecrit, ecritV2: enV2.ecrit }).toEqual({ ecritV1: true, ecritV2: true });
    const chargeV1 = enV1.charge as Record<string, unknown>;

    const premier = envoiPatche(chargeV1) as { flags?: unknown; embeds?: unknown[] };
    expect(premier.flags).toBeUndefined();
    const second = envoiPatche(chargeV1) as { flags?: unknown; embeds?: unknown[] };
    expect(second.flags).toBeUndefined();
    // La marque est toujours là : c'est elle qui protège le troisième passage.
    expect(porteLaMarque(chargeV1)).toBe(true);

    // Et le témoin : la charge du générateur V2, NON marquée, se fait bien
    // convertir. Sans lui, « flags absent » pourrait venir d'un patch inerte.
    const temoin = envoiPatche({ ...(enV2.charge as Record<string, unknown>) }) as { flags?: unknown };
    expect(temoin.flags).toContain(MessageFlags.IsComponentsV2);
  }, 60_000);

  test('9 — deux SERVEURS en V1 et V2 simultanément : aucune régression', async () => {
    // La portée par serveur était déjà acquise avant ce chantier : ce test dit
    // que le nouveau chemin de résolution ne l'a pas cassée. ÉCHOUE si la
    // présentation est mémoïsée au niveau du module (le second serveur
    // recevrait celle du premier), dans un sens comme dans l'autre.
    const ligneA = lignePresentation({ guildId: GUILD, panelComponents: 'V1' });
    const ligneB = lignePresentation({ guildId: GUILD_B, panelComponents: 'V2' });

    const a = await panneauPour({ ligne: ligneA, guildId: GUILD });
    const b = await panneauPour({ ligne: ligneB, guildId: GUILD_B });
    // Relus APRÈS l'autre : c'est l'ordre qui révèle une mémoïsation.
    const aApresB = await panneauPour({ ligne: ligneA, guildId: GUILD });
    const bApresA = await panneauPour({ ligne: ligneB, guildId: GUILD_B });

    expect([a.ecrit, b.ecrit, aApresB.ecrit, bApresA.ecrit]).toEqual([true, true, true, true]);
    expect({ a: a.v1, b: b.v1, aApresB: aApresB.v1, bApresA: bApresA.v1 })
      .toEqual({ a: true, b: false, aApresB: true, bApresA: false });
  }, 120_000);

  test('10 — croisement : serveur V1 avec générateur V2, serveur V2 avec générateur V1', async () => {
    // Les quatre rendus doivent être corrects EN MÊME TEMPS. ÉCHOUE si la
    // surcharge est cherchée sur le mauvais serveur, si l'interrupteur d'un
    // serveur décide pour l'autre, ou si la surcharge n'existe pas.
    const serveurV1 = lignePresentation({
      guildId: GUILD, panelComponents: 'V1', perGeneratorPresentation: true,
    });
    const serveurV2 = lignePresentation({
      guildId: GUILD_B, panelComponents: 'V2', perGeneratorPresentation: true,
    });

    const aSansGen = await panneauPour({ ligne: serveurV1, guildId: GUILD, generateurs: [{ channelId: GEN_V2, panelComponents: 'V2' }] });
    const aAvecGen = await panneauPour({ ligne: serveurV1, guildId: GUILD, generateurs: [{ channelId: GEN_V2, panelComponents: 'V2' }], generateurId: GEN_V2 });
    const bSansGen = await panneauPour({ ligne: serveurV2, guildId: GUILD_B, generateurs: [{ channelId: GEN_V1, panelComponents: 'V1' }] });
    const bAvecGen = await panneauPour({ ligne: serveurV2, guildId: GUILD_B, generateurs: [{ channelId: GEN_V1, panelComponents: 'V1' }], generateurId: GEN_V1 });

    expect([aSansGen.ecrit, aAvecGen.ecrit, bSansGen.ecrit, bAvecGen.ecrit])
      .toEqual([true, true, true, true]);
    expect({
      'A sans générateur (serveur V1)': aSansGen.v1,
      'A surchargé en V2': aAvecGen.v1,
      'B sans générateur (serveur V2)': bSansGen.v1,
      'B surchargé en V1': bAvecGen.v1,
    }).toEqual({
      'A sans générateur (serveur V1)': true,
      'A surchargé en V2': false,
      'B sans générateur (serveur V2)': false,
      'B surchargé en V1': true,
    });
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11 & 12 — les deux bouts de la chaîne : l'écriture, et la trace du générateur
// ─────────────────────────────────────────────────────────────────────────────

describe('écriture — la route et la création du salon', () => {
  test('11 — la route REFUSE (400) une surcharge hors énumération, sans repli silencieux', async () => {
    // Deux régimes assumés pour la même donnée : TOLÉRANT en lecture (une valeur
    // fautive vaut « hérite », un panneau doit toujours sortir), REJETÉ en
    // écriture (sinon la page annonce « enregistré » et rien n'a changé).
    //
    // ÉCHOUE si `validateGeneratorPresentationOverrides` disparaît : la route
    // rendrait alors 200 et `normalizeTempVoiceGeneratorsInput` laisserait
    // tomber la valeur en silence — exactement le réglage fantôme à éviter.
    prismaMock.guild.findUnique = mock(async () => ({ tempVoiceEnabled: false }) as never);
    const ecrituresAvant = (prismaMock.guild.update.mock.calls as unknown[][]).length;

    const refus = await sauvegarder({
      tempVoiceEnabled: false,
      tempVoiceGenerators: [
        { channelId: GEN_V1, nameTemplate: 'Salon de {user}' },
        { channelId: GEN_V2, panelComponents: 'V3' },
      ],
    });

    expect(refus.statusCode).toBe(400);
    const erreur = String(JSON.parse(refus.body).error ?? '');
    // L'erreur doit NOMMER le générateur fautif et le champ : « invalide »
    // tout court laisserait chercher dans vingt-cinq générateurs.
    expect(erreur).toContain('panelComponents');
    expect(erreur).toContain('#2');
    // Rejet TOTAL : pas d'écriture partielle du générateur valide.
    expect((prismaMock.guild.update.mock.calls as unknown[][]).length).toBe(ecrituresAvant);

    // Témoin : la MÊME forme avec une valeur valide n'est pas refusée. Sans lui,
    // une route qui refuserait tout passerait l'assertion du 400.
    const accepte = await sauvegarder({
      tempVoiceEnabled: false,
      tempVoiceGenerators: [
        { channelId: GEN_V1, nameTemplate: 'Salon de {user}' },
        { channelId: GEN_V2, panelComponents: 'V1' },
      ],
    });
    expect(accepte.statusCode).not.toBe(400);
    // Et la surcharge valide est bien descendue jusqu'à l'écriture.
    // Le mock est type `[][]` : ses arguments ne sont pas decrits. On passe
    // par `unknown` plutot que de forcer une conversion entre deux types qui
    // ne se recouvrent pas — TypeScript refuse le raccourci, et il a raison.
    const ecrites = (prismaMock.guild.update.mock.calls as unknown as Array<[{ data?: Record<string, unknown> }]>)
      .at(-1)?.[0]?.data?.tempVoiceGenerators as Array<Record<string, unknown>> | undefined;
    expect(ecrites?.find((g) => g.channelId === GEN_V2)?.panelComponents).toBe('V1');
  }, 60_000);

  test('12 — generatorChannelId est ÉCRIT à la création, avec le générateur réellement emprunté', async () => {
    // Le générateur n'est à portée qu'ICI : `TempVoiceChannel` n'en garde aucune
    // autre trace, et personne ne peut le deviner après coup (deux générateurs
    // peuvent viser la même catégorie et le même gabarit).
    //
    // ÉCHOUE si la colonne n'est pas écrite, et ÉCHOUE si on y écrit le
    // générateur PRINCIPAL au lieu de celui par lequel la personne est passée :
    // c'est bien GEN_FLAT, un additionnel, qui est emprunté ici.
    lignesParServeur.set(GUILD, lignePresentation());
    configsParServeur.set(GUILD, configAvecGenerateurs([{ channelId: GEN_FLAT }]));

    const idCree = prochainId();
    const postees: Array<Record<string, unknown>> = [];
    const salonCree = {
      id: idCree,
      name: 'salon neuf',
      type: 2,
      userLimit: 0,
      members: new Map<string, unknown>(),
      parentId: null as string | null,
      permissionOverwrites: { cache: new Map<string, unknown>([[GUILD, surchargeNulle()]]) },
      permissionsFor: () => ({ has: () => true }),
      delete: mock(async () => undefined),
      send: mock(async (charge: Record<string, unknown>) => {
        postees.push(charge);
        return { id: '888100000000000002' };
      }),
      guild: null as unknown,
    };

    const guild = {
      id: GUILD,
      name: 'Serveur test',
      available: true,
      ownerId: '999999999999999999',
      roles: { everyone: { id: GUILD }, cache: new Map<string, unknown>() },
      members: {
        me: { id: BOT, permissions: { has: () => true } },
        cache: new Map<string, unknown>(),
        fetch: mock(async () => null),
      },
      channels: { cache: new Map<string, unknown>(), create: mock(async () => salonCree) },
    };
    salonCree.guild = guild;

    const membre = {
      id: OWNER,
      displayName: 'Tojii',
      user: { id: OWNER, bot: false, tag: 'tojii#0001', username: 'tojii' },
      guild,
      permissions: { has: () => false },
      roles: { cache: { has: () => true } },
      send: mock(async () => undefined),
    };

    const avant = salonsEnregistres.length;
    const { client, ecouteurs } = fauxClient();
    registerTempVoiceListener(client);
    await ecouteurs.get(Events.VoiceStateUpdate)?.(
      { channelId: null, channel: null },
      {
        member: membre,
        guild,
        // La personne entre dans le générateur ADDITIONNEL, pas le principal.
        channelId: GEN_FLAT,
        channel: null,
        setChannel: mock(async () => undefined),
        disconnect: mock(async () => undefined),
      },
    );
    const enregistre = await jusqua(() => salonsEnregistres.length > avant);
    if (!enregistre) console.warn('[T12] aucun salon enregistré :', avertissements.slice(-3));

    expect(enregistre).toBe(true);
    const ligne = salonsEnregistres.at(-1) as Record<string, unknown>;
    expect({ id: ligne.id, guildId: ligne.guildId, generatorChannelId: ligne.generatorChannelId })
      .toEqual({ id: idCree, guildId: GUILD, generatorChannelId: GEN_FLAT });
    // La mémoire porte la même chose : c'est elle que lit le panneau à chaque
    // clic, sans relire la base.
    expect(tempChannels.get(idCree)?.generateurId).toBe(GEN_FLAT);
    tempChannels.delete(idCree);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13 à 15 — L'INTERRUPTEUR : la sortie de secours
// ─────────────────────────────────────────────────────────────────────────────

describe("l'interrupteur perGeneratorPresentation — la sortie de secours", () => {
  /** Un générateur qui surcharge les cinq champs : si l'interrupteur ne coupait
   *  rien, aucune de ces cinq valeurs ne pourrait passer inaperçue. */
  const SURCHARGE_TOTALE = [{
    channelId: GEN_FLAT,
    panelMode: 'FLAT',
    stateLayout: 'CARDS',
    stateColors: 'DARK',
    panelComponents: 'V1',
    reservationFallbackMode: 'FORBIDDEN',
  }];

  test('13 — COUPÉ, un générateur qui porte des surcharges est IGNORÉ', async () => {
    // S'IL N'Y A PAS DE SORTIE DE SECOURS, C'EST ICI QUE ÇA SE VOIT. La paire
    // est mesurée dans le même test parce que le seul écart entre les deux
    // rendus est l'interrupteur : coupé → le rendu CLASSIC/V2 du serveur ;
    // allumé → le FLAT/V1 du générateur.
    //
    // ÉCHOUE si le court-circuit disparaît (le rendu coupé passerait en FLAT),
    // et ÉCHOUE si l'héritage n'existe pas (le rendu allumé resterait CLASSIC).
    const coupe = await panneauPour({
      ligne: lignePresentation({ perGeneratorPresentation: false }),
      generateurs: SURCHARGE_TOTALE,
      generateurId: GEN_FLAT,
    });
    const allume = await panneauPour({
      ligne: lignePresentation({ perGeneratorPresentation: true }),
      generateurs: SURCHARGE_TOTALE,
      generateurId: GEN_FLAT,
    });

    expect({ ecritCoupe: coupe.ecrit, ecritAllume: allume.ecrit })
      .toEqual({ ecritCoupe: true, ecritAllume: true });
    // Coupé : le réglage du serveur, tel quel — une rangée, et pas de V1.
    expect({ rangees: coupe.rangees, v1: coupe.v1 }).toEqual({ rangees: 1, v1: false });
    // Allumé : les surcharges du générateur, sur le MÊME serveur.
    expect(allume.rangees).toBeGreaterThan(1);
    expect(allume.v1).toBe(true);

    // La règle pure, sur le même jeu : coupé, la fonction rend la référence même
    // du réglage serveur — donc elle n'a rien recomposé, donc rien n'a été lu.
    const surcharges = lireSurchargesPresentation(SURCHARGE_TOTALE[0]);
    expect(presentationPourGenerateur(SERVEUR_TOUT_REGLE, { surchargesPresentation: surcharges }, false))
      .toBe(SERVEUR_TOUT_REGLE);
  }, 60_000);

  test('14 — COUPÉ puis RALLUMÉ : les surcharges sont retrouvées INTACTES', async () => {
    // Couper IGNORE, ça n'EFFACE PAS. Effacer serait une perte de données
    // silencieuse : on ne pourrait plus rallumer sans tout ressaisir.
    //
    // ÉCHOUE si quelque chose sur le chemin de lecture mute le JSON du
    // générateur (normalisation en place, suppression des clés quand
    // l'interrupteur est coupé), et ÉCHOUE si le rallumage ne rend pas les
    // surcharges d'origine.
    const generateurs = structuredClone(SURCHARGE_TOTALE);
    const empreinte = structuredClone(SURCHARGE_TOTALE);

    const avant = await panneauPour({
      ligne: lignePresentation({ perGeneratorPresentation: true }),
      generateurs, generateurId: GEN_FLAT,
    });
    const coupe = await panneauPour({
      ligne: lignePresentation({ perGeneratorPresentation: false }),
      generateurs, generateurId: GEN_FLAT,
    });
    const apres = await panneauPour({
      ligne: lignePresentation({ perGeneratorPresentation: true }),
      generateurs, generateurId: GEN_FLAT,
    });

    expect([avant.ecrit, coupe.ecrit, apres.ecrit]).toEqual([true, true, true]);
    // Le passage par « coupé » n'a rien touché en base.
    expect(generateurs).toEqual(empreinte);
    // Et le rendu du rallumage est EXACTEMENT celui d'avant la coupure.
    expect({ rangees: apres.rangees, v1: apres.v1 })
      .toEqual({ rangees: avant.rangees, v1: avant.v1 });
    expect(coupe.rangees).toBe(1);
    expect(apres.rangees).toBeGreaterThan(1);
  }, 120_000);

  test('15 — le défaut est FAUX : un serveur qui n’a jamais rien réglé ne change pas', async () => {
    // Au déploiement, AUCUN serveur existant ne doit changer de comportement.
    // ÉCHOUE si le défaut passe à vrai en base, si une ligne absente est
    // interprétée comme « allumé », ou si quelque chose de non booléen allume
    // l'interrupteur.
    const schema = readFileSync(
      path.resolve(import.meta.dir, '../../../../../packages/database/prisma/temp-voice-access.prisma'),
      'utf8',
    );
    expect(schema).toMatch(/perGeneratorPresentation\s+Boolean\s+@default\(false\)/);

    // Seul `true` allume. Une ligne d'avant la colonne, un `null`, un "true"
    // textuel : tout vaut le comportement livré. Le sens de la panne va vers le
    // comportement actuel, jamais vers le nouveau.
    for (const raw of [null, undefined, 42, 'texte', [], {},
      { perGeneratorPresentation: null }, { perGeneratorPresentation: 'true' },
      { perGeneratorPresentation: 1 }]) {
      expect(presentationParGenerateurActive(raw)).toBe(false);
    }
    expect(presentationParGenerateurActive({ perGeneratorPresentation: true })).toBe(true);

    // Et sur le rendu réel : AUCUNE ligne en base, un générateur qui surcharge
    // tout. Le serveur garde son panneau d'avant ce chantier.
    const jamaisRegle = await panneauPour({
      ligne: null,
      generateurs: [{ channelId: GEN_FLAT, panelMode: 'FLAT', panelComponents: 'V1' }],
      generateurId: GEN_FLAT,
    });
    expect(jamaisRegle.ecrit).toBe(true);
    expect({ rangees: jamaisRegle.rangees, v1: jamaisRegle.v1 })
      .toEqual({ rangees: 1, v1: false });
    // Témoin : la même chose avec l'interrupteur explicitement allumé change le
    // rendu. Sans lui, « rien ne change » serait vrai faute de surcharge lisible.
    const allume = await panneauPour({
      ligne: lignePresentation({ perGeneratorPresentation: true }),
      generateurs: [{ channelId: GEN_FLAT, panelMode: 'FLAT', panelComponents: 'V1' }],
      generateurId: GEN_FLAT,
    });
    expect(allume.rangees).toBeGreaterThan(1);
    expect(allume.v1).toBe(true);
  }, 60_000);
});
