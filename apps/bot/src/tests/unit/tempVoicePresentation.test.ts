/**
 * Les cinq réglages de présentation, prouvés par exécution.
 *
 * Le reste de la suite couvre la route qui les écrit et le court-circuit V1/V2.
 * Ici on vérifie ce qui décide de l'apparence : que chaque valeur produise
 * réellement un rendu DIFFÉRENT, et non qu'elle soit simplement acceptée. Une
 * disposition qui rendrait la même image qu'une autre passerait toutes les
 * vérifications de type sans que personne ne voie la différence.
 *
 * ── Deuxième moitié du fichier (T12 à T21) ──
 * Les onze premiers tests ne touchent que des fonctions PURES : ils prouvent
 * que les valeurs existent, qu'elles se normalisent et qu'elles rendent des
 * images distinctes. Aucun ne prouve ce qui casse vraiment :
 *   — la règle « natif ou image », qui existe en trois versions différentes
 *     dans le dépôt (`dispositionNative` dans le service, `etatRenduNativement`
 *     dans l'écouteur, et le commentaire de `PanneauRendu` qui dit encore
 *     « le seul cas natif (GRID3 en V1) ») ;
 *   — la promesse écrite du mode FLAT : « AUCUN `UserSelectMenu` ici : pas de
 *     recherche dans le serveur » ;
 *   — l'isolation par serveur, que la clé `guildId String @id` garantit en base
 *     mais que rien ne garantit en mémoire ;
 *   — le fait que `{count}` et `{game}` ne sont PAS des jetons supportés.
 *
 * Ces règles ne sont pas exportées : `etatRenduNativement`, `rangeesPlates` et
 * `reecrirePanneau` sont privés à `events/tempVoice.ts`. On ne les observe donc
 * que sur la charge réellement envoyée à Discord — ce qui part en production.
 * Un test qui réimplémenterait la règle ne prouverait rien du tout.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { ComponentType, Events, MessageFlags, type Client } from 'discord.js';

import { completeModuleMock } from '../helpers/moduleMock.js';
import {
  DEFAULT_NAME_TEMPLATE,
  DISPOSITIONS_ETAT,
  ecrireSurchargesPresentation,
  JEUX_COMPOSANTS,
  lireSurchargesPresentation,
  MODES_PANNEAU,
  nomFichierEtat,
  normaliserReglagesPresentation,
  normalizeTempVoiceGeneratorsInput,
  planReservation,
  presentationParGenerateurActive,
  presentationPourGenerateur,
  PRESENTATION_PAR_DEFAUT,
  renderChannelName,
  REPLIS_RESERVATION,
  resolveTempVoiceGenerators,
  TEINTES_ETAT,
  type RepliReservation,
  type TempVoiceGuildConfig,
} from '../../services/features/tempVoiceService';
import {
  rendreEtatPng,
  type DispositionImage,
  type TeinteImage,
} from '../../services/features/tempVoicePanelImage';
import { logger } from '../../utils/logger.js';

/** Les six valeurs du panneau, telles que la maquette les a arrêtées. */
const VALEURS = [
  { libelle: 'État', valeur: 'Ouvert', icone: 'ktb_unlock' },
  { libelle: 'Places', valeur: '3 / 8', icone: 'ktb_profile' },
  { libelle: 'Écriture', valeur: 'Fermé', icone: 'ktb_msg' },
  { libelle: 'Autorisés', valeur: '@VIP', icone: 'ktb_check' },
  { libelle: 'Bannis', valeur: '2', icone: 'ktb_ban' },
  { libelle: 'Réservé', valeur: '@Modérateur', icone: 'ktb_shield' },
];

const empreinte = (png: Buffer) => createHash('sha256').update(png).digest('hex');

describe('les valeurs de présentation sont bien celles de la maquette', () => {
  test('aucune valeur en trop, aucune qui manque', () => {
    expect([...MODES_PANNEAU]).toEqual(['CLASSIC', 'FLAT']);
    expect([...DISPOSITIONS_ETAT]).toEqual(['GRID3', 'GRID2', 'TABLE', 'CARDS']);
    expect([...TEINTES_ETAT]).toEqual(['NEUTRAL', 'DARK', 'LIGHT']);
    expect([...JEUX_COMPOSANTS]).toEqual(['V1', 'V2']);
    expect([...REPLIS_RESERVATION]).toEqual(['MEMBERS', 'ANY_ROLE', 'FORBIDDEN']);
  });

  test('le défaut reproduit le comportement livré avant ces réglages', () => {
    expect(PRESENTATION_PAR_DEFAUT).toEqual({
      mode: 'CLASSIC',
      disposition: 'GRID3',
      teinte: 'NEUTRAL',
      composants: 'V2',
      repliReservation: 'ANY_ROLE',
    });
  });
});

describe('chaque disposition rend une image DIFFÉRENTE', () => {
  test('les quatre dispositions ne se confondent pas deux à deux', async () => {
    const vues = new Map<string, DispositionImage>();
    for (const disposition of DISPOSITIONS_ETAT) {
      const png = await rendreEtatPng(VALEURS, disposition as DispositionImage, 'NEUTRAL');
      const cle = empreinte(png);
      // Deux dispositions qui rendent le même PNG : le réglage ne sert à rien.
      expect(vues.get(cle) ?? disposition).toBe(disposition);
      vues.set(cle, disposition as DispositionImage);
    }
    expect(vues.size).toBe(DISPOSITIONS_ETAT.length);
  }, 30_000);

  test('les trois teintes ne se confondent pas non plus', async () => {
    const vues = new Set<string>();
    for (const teinte of TEINTES_ETAT) {
      vues.add(empreinte(await rendreEtatPng(VALEURS, 'GRID3', teinte as TeinteImage)));
    }
    expect(vues.size).toBe(TEINTES_ETAT.length);
  }, 30_000);
});

describe('normaliserReglagesPresentation', () => {
  test('une ligne de base complète est relue telle quelle', () => {
    expect(normaliserReglagesPresentation({
      panelMode: 'FLAT',
      stateLayout: 'CARDS',
      stateColors: 'LIGHT',
      panelComponents: 'V1',
      reservationFallbackMode: 'MEMBERS',
    })).toEqual({
      mode: 'FLAT', disposition: 'CARDS', teinte: 'LIGHT',
      composants: 'V1', repliReservation: 'MEMBERS',
    });
  });

  test('chaque valeur hors union retombe sur son défaut, une par une', () => {
    // Champ par champ : une normalisation qui ne raterait qu'un seul champ
    // passerait inaperçue si on les invalidait tous ensemble.
    const cas: Array<[string, keyof typeof PRESENTATION_PAR_DEFAUT]> = [
      ['panelMode', 'mode'],
      ['stateLayout', 'disposition'],
      ['stateColors', 'teinte'],
      ['panelComponents', 'composants'],
      ['reservationFallbackMode', 'repliReservation'],
    ];
    for (const [colonne, champ] of cas) {
      const lu = normaliserReglagesPresentation({ [colonne]: 'N_IMPORTE_QUOI' });
      expect(lu[champ]).toBe(PRESENTATION_PAR_DEFAUT[champ]);
    }
  });

  test('une ligne absente ou illisible vaut le défaut, sans jeter', () => {
    for (const raw of [null, undefined, 42, 'texte', []]) {
      expect(normaliserReglagesPresentation(raw)).toEqual(PRESENTATION_PAR_DEFAUT);
    }
  });
});

describe('planReservation — ce que fait « Réserver » selon qui clique', () => {
  const RESERVABLES = ['role-mod', 'role-vip'];

  test('sans liste posée par l’administration, le menu reste libre', () => {
    for (const repli of REPLIS_RESERVATION) {
      expect(planReservation(['role-membre'], [], repli).type).toBe('tous_roles');
    }
  });

  test('un seul rôle réservable porté : le bouton vise ce rôle', () => {
    const plan = planReservation(['role-mod', 'role-couleur'], RESERVABLES, 'ANY_ROLE');
    expect(plan.type).toBe('role_unique');
  });

  test('plusieurs rôles réservables portés : un menu de CES rôles, et d’eux seuls', () => {
    const plan = planReservation(['role-mod', 'role-vip', 'role-couleur'], RESERVABLES, 'ANY_ROLE');
    expect(plan.type).toBe('menu_roles');
    // Le menu ne doit proposer que les rôles prévus par l'administration —
    // pas `role-couleur`, que la personne porte sans qu'il soit réservable.
    if (plan.type === 'menu_roles') expect([...plan.roleIds].sort()).toEqual([...RESERVABLES].sort());
  });

  test('aucun rôle réservable porté : le repli décide, et les trois diffèrent', () => {
    const sansRole = ['role-membre'];
    const types = REPLIS_RESERVATION.map((repli) => planReservation(sansRole, RESERVABLES, repli).type);
    // Trois replis, trois comportements : sinon le réglage serait décoratif.
    expect(new Set(types).size).toBe(REPLIS_RESERVATION.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T19 à T21 — trois règles pures que rien ne couvrait
// ═══════════════════════════════════════════════════════════════════════════

describe('T19 — le nom du fichier joint', () => {
  test('T19 — deux rendus du MÊME salon, même disposition et même teinte, donnent deux noms', () => {
    // Discord met les pièces jointes en cache PAR NOM : réutiliser le nom
    // ressert l'ancienne image, et le réglage paraît inopérant alors qu'il a
    // bien été appliqué. Le seul remède est un nom neuf à chaque rendu.
    const graine = { salonId: '400000000000000000', disposition: 'CARDS' as const, teinte: 'DARK' as const };
    const noms = [nomFichierEtat(graine), nomFichierEtat(graine), nomFichierEtat(graine)];
    expect(new Set(noms).size).toBe(3);
    for (const nom of noms) expect(nom).toMatch(/^etat-400000000000000000-cards-dark-\d+\.png$/);

    // Ces images s'écrivent sur disque : un point conservé laisserait passer
    // une séquence `..`.
    const hostile = nomFichierEtat({ salonId: '../../etc/passwd', disposition: 'GRID2', teinte: 'LIGHT' });
    expect(hostile).not.toContain('..');
    expect(hostile).not.toContain('/');
    expect(hostile.endsWith('.png')).toBe(true);
  });
});

describe('T20 — les jetons du gabarit de nom', () => {
  test('T20 — seul {user} est substitué : {count} et {game} restent LITTÉRAUX', () => {
    // Personne n'a implémenté ces jetons. Les croire supportés produirait des
    // noms de salon comme « 🔊 {count} de Tojii » sans que rien ne prévienne :
    // ce test est là pour que quiconque les ajoute le fasse exprès.
    expect(renderChannelName('🔊 {count} de {user}', 'Tojii')).toBe('🔊 {count} de Tojii');
    expect(renderChannelName('{game} — {user}', 'Tojii')).toBe('{game} — Tojii');
    // Et le gabarit livré, lui, ne porte que {user}. Il reste en FRANÇAIS et hors
    // de Paraglide : un nom de salon est écrit dans Discord puis rangé en base
    // (`Guild.tempVoiceNameTemplate`), pas rendu à chaque affichage — il ne peut
    // donc pas suivre la langue du serveur, et doit valoir le défaut de la base.
    expect(DEFAULT_NAME_TEMPLATE).toBe('🔊 Salon de {user}');
    expect(DEFAULT_NAME_TEMPLATE.match(/\{[a-z]+\}/g)).toEqual(['{user}']);
  });
});

describe('T21 — un repli de réservation hors union', () => {
  test('T21 — colonne String sans enum : une valeur inventée rend « tous_roles » et ne jette pas', () => {
    // `reservationFallbackMode` est une colonne `String` Prisma : une migration
    // ratée, un cast d'appelant ou une écriture manuelle peut y mettre
    // n'importe quoi. Un `switch` exhaustif sans `default` rendrait alors
    // `undefined`, et le bouton « Réserver » lèverait un TypeError sur
    // `plan.type` — le panneau cesserait de répondre.
    const inconnus: unknown[] = ['MEMBRES_ET_ROLES', 'members', '', undefined, null, 0, {}, []];
    for (const valeur of inconnus) {
      const appel = () => planReservation(['role-membre'], ['role-mod'], valeur as RepliReservation);
      expect(appel).not.toThrow();
      expect(appel().type).toBe('tous_roles');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Harnais : le panneau tel que Discord le reçoit
//
// `etatRenduNativement`, `rangeesPlates` et `reecrirePanneau` ne sont pas
// exportés. On passe donc par l'écouteur, exactement comme la production : une
// entrée en vocal déclenche la réécriture du panneau, et le faux message
// retient la charge qui lui a été écrite.
// ═══════════════════════════════════════════════════════════════════════════

const GUILD = '100000000000000000';
const GUILD_B = '100000000000000009';
const OWNER = '200000000000000000';
const PRESENT = '210000000000000000';
const BOT = '300000000000000000';
const GENERATOR = '500000000000000000';
const ROLE_RESERVABLE = '700000000000000000';

/** Lignes `TempVoiceModPermissionsConfig`, UNE PAR SERVEUR : c'est la table qui
 *  porte les cinq colonnes de présentation, clé `guildId String @id`. Servir la
 *  même ligne à tout le monde rendrait T18 vert sans rien prouver. */
const lignesParServeur = new Map<string, Record<string, unknown> | null>();
/** Configuration serveur servie par le cache, une par serveur. */
const configsParServeur = new Map<string, Record<string, unknown> | null>();

const prismaMock = {
  tempVoiceModPermissionsConfig: {
    findUnique: mock(async (args: { where: { guildId: string } }) => lignesParServeur.get(args.where.guildId) ?? null),
    upsert: mock(async () => ({})),
  },
  tempVoiceAccessRequestConfig: {
    findUnique: mock(async () => null as Record<string, unknown> | null),
  },
  tempVoiceChannel: {
    findMany: mock(async () => [] as Array<Record<string, unknown>>),
    findUnique: mock(async () => null as Record<string, unknown> | null),
    create: mock(async () => ({})),
    update: mock(async () => ({})),
    delete: mock(async () => ({})),
  },
};

const cheminCache = path.resolve(import.meta.dir, '../../utils/cache.ts');
const mockCache = () => completeModuleMock(cheminCache, {
  getCachedGuild: mock(async (guildId: string) => configsParServeur.get(guildId) ?? null),
  cache: { invalidateGuild: mock(async () => undefined) },
});

const mocksModules: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/cache', mockCache],
];

for (const [relatif, fabrique] of mocksModules) {
  mock.module(path.resolve(import.meta.dir, `${relatif}.ts`), fabrique);
  mock.module(path.resolve(import.meta.dir, `${relatif}.js`), fabrique);
}

const { registerTempVoiceListener, tempChannels } = await import('../../events/tempVoice.js');

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

/** La marque d'échappatoire de `patchV2`, lue comme le fait le patch lui-même. */
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
  const guildId = options.guildId ?? GUILD;
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
    // connaît, et sinon les vingt-cinq derniers : les deux formes sont servies,
    // sans quoi la seconde lèverait sur une itération de non-itérable et
    // l'échec ne se verrait que dans un avertissement.
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

function servirServeur(guildId: string, ligne: Record<string, unknown> | null): void {
  lignesParServeur.set(guildId, ligne);
  configsParServeur.set(guildId, {
    tempVoiceEnabled: true,
    baseStaffRoleId: null,
    moderatorRoleId: null,
    testStaffRoleId: null,
  });
}

/** Réécrit le panneau d'un salon et rend la charge que Discord a réellement reçue. */
async function panneauEcrit(
  ligne: Record<string, unknown> | null,
  options: { id: string; guildId?: string; estV2?: boolean; presents?: string[] },
) {
  const guildId = options.guildId ?? GUILD;
  servirServeur(guildId, ligne);
  const panneau = fauxPanneau(options.estV2 ?? false);
  const channel = fauxSalon(options.id, panneau, { guildId, presents: options.presents });
  const { client, ecouteurs } = fauxClient();
  registerTempVoiceListener(client);
  await rejouerEntree(ecouteurs, channel);
  const ecrit = await jusqua(() => panneau.charges.length > 0);
  // Les échecs de réécriture partent en `logger.warn`, qui est capturé ici : sans
  // ce rappel, un panneau jamais écrit ne donnerait qu'un `false` sans cause.
  if (!ecrit) console.warn(`[T] aucune charge écrite pour ${options.id} :`, avertissements.slice(-3));
  return { panneau, channel, ecouteurs, ecrit, charge: panneau.charges[0] };
}

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
 * `builder.options`, une liste de sous-constructeurs) : les lire dans `data`
 * seul ferait paraître vide un menu qui propose deux personnes.
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

// ═══════════════════════════════════════════════════════════════════════════
// T12 & T13 — la carte d'état : native ou en image
// ═══════════════════════════════════════════════════════════════════════════

describe('T12/T13 — natif ou image : la table de vérité complète', () => {
  test('T12 — 4 dispositions × 2 jeux de composants × 3 teintes = 24 cas, aucun laissé au hasard', async () => {
    // La règle EFFECTIVE est celle de `etatRenduNativement`, pas celle de
    // `dispositionNative` : le panneau livré est déjà servi en V2 avec six
    // champs inline, donc GRID3 + NEUTRAL reste natif quel que soit le jeu de
    // composants — sans quoi tous les serveurs en service basculeraient en PNG
    // au simple déploiement. Les 24 cas sont énumérés un par un : une règle qui
    // ne raterait qu'un seul triplet passerait un test global.
    let cas = 0;
    for (const disposition of DISPOSITIONS_ETAT) {
      for (const composants of JEUX_COMPOSANTS) {
        for (const teinte of TEINTES_ETAT) {
          cas += 1;
          const id = `41000000000000${String(1000 + cas)}`;
          const { charge, ecrit } = await panneauEcrit(
            lignePresentation({ stateLayout: disposition, stateColors: teinte, panelComponents: composants }),
            { id },
          );
          expect(ecrit).toBe(true);
          const natif = !('files' in (charge ?? {}));
          const attendu = disposition === 'GRID3' && (composants === 'V1' || teinte === 'NEUTRAL');
          // Le triplet est dans l'attendu : l'échec nomme le cas fautif.
          expect({ disposition, composants, teinte, natif })
            .toEqual({ disposition, composants, teinte, natif: attendu });
          tempChannels.delete(id);
        }
      }
    }
    expect(cas).toBe(24);
  }, 180_000);

  test('T13 — le cas livré (V2 + GRID3 + NEUTRAL) est NATIF, pas une image', async () => {
    // Le dashboard décrivait ce cas comme une image. S'il en était une, chaque
    // réécriture enverrait ~30 Ko de PNG là où six champs inline suffisent, et
    // la présentation de tous les serveurs déjà en service changerait sans que
    // personne ne l'ait demandé.
    for (const [nom, ligne] of [
      ['ligne absente en base', null],
      ['ligne écrite aux valeurs par défaut', lignePresentation()],
    ] as Array<[string, Record<string, unknown> | null]>) {
      const id = nom === 'ligne absente en base' ? '410000000000002001' : '410000000000002002';
      const { charge, ecrit } = await panneauEcrit(ligne, { id });
      expect(ecrit).toBe(true);
      expect({ nom, image: 'files' in (charge ?? {}) }).toEqual({ nom, image: false });
      // Et la carte porte bien les six valeurs, sinon « natif » ne voudrait rien dire.
      const embeds = (charge?.embeds ?? []) as Array<{ data?: { fields?: unknown[]; image?: unknown } }>;
      expect(embeds[0]?.data?.fields?.length).toBe(6);
      expect(embeds[0]?.data?.image).toBeUndefined();
      tempChannels.delete(id);
    }
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T14 & T15 — l'échappatoire V1 de patchV2
// ═══════════════════════════════════════════════════════════════════════════

describe('T14/T15 — la marque « sans conversion V2 »', () => {
  /** Le chemin d'ENVOI : un salon qui naît, et le panneau qu'on y poste. */
  async function panneauPoste(ligne: Record<string, unknown> | null) {
    lignesParServeur.set(GUILD, ligne);
    configsParServeur.set(GUILD, {
      tempVoiceEnabled: true,
      tempVoiceChannelId: GENERATOR,
      tempVoiceCategoryId: null,
      tempVoiceNameTemplate: DEFAULT_NAME_TEMPLATE,
      tempVoiceDefaults: {},
      baseStaffRoleId: null,
      moderatorRoleId: null,
      testStaffRoleId: null,
    });

    const postees: Array<Record<string, unknown>> = [];
    const ID_CREE = '420000000000000001';
    const salonCree = {
      id: ID_CREE,
      name: 'salon neuf',
      type: 2,
      userLimit: 0,
      members: new Map<string, unknown>(),
      guild: { id: GUILD, members: { me: { id: BOT } } },
      permissionOverwrites: { cache: new Map<string, unknown>([[GUILD, surchargeNulle()]]) },
      delete: mock(async () => undefined),
      send: mock(async (charge: Record<string, unknown>) => { postees.push(charge); return { id: '888000000000000001' }; }),
    };

    const guild = {
      id: GUILD,
      name: 'Serveur test',
      available: true,
      ownerId: '999999999999999999',
      roles: { everyone: { id: GUILD } },
      members: { me: { permissions: { has: () => true } }, fetch: mock(async () => null) },
      channels: { cache: new Map<string, unknown>(), create: mock(async () => salonCree) },
    };

    const membre = {
      id: OWNER,
      displayName: 'Tojii',
      user: { id: OWNER, bot: false, tag: 'tojii#0001', username: 'tojii' },
      guild,
      roles: { cache: { has: () => true } },
      send: mock(async () => undefined),
    };

    const { client, ecouteurs } = fauxClient();
    registerTempVoiceListener(client);
    await ecouteurs.get(Events.VoiceStateUpdate)?.(
      { channelId: null, channel: null },
      {
        member: membre, guild, channelId: GENERATOR, channel: null,
        setChannel: mock(async () => undefined),
        disconnect: mock(async () => undefined),
      },
    );
    await jusqua(() => postees.length > 0);
    tempChannels.delete(ID_CREE);
    return postees[0];
  }

  test('T14 — la marque est posée si et seulement si le réglage vaut V1, à l’envoi comme à l’édition, et sur ce message seul', async () => {
    // ─── À l'ENVOI : un message neuf ne peut pas déjà porter IsComponentsV2,
    //     donc le réglage V1 s'applique toujours. ───
    const posteV1 = await panneauPoste(lignePresentation({ panelComponents: 'V1' }));
    const posteV2 = await panneauPoste(lignePresentation({ panelComponents: 'V2' }));
    expect(posteV1).toBeDefined();
    expect(posteV2).toBeDefined();
    expect({ envoiV1: porteLaMarque(posteV1), envoiV2: porteLaMarque(posteV2) })
      .toEqual({ envoiV1: true, envoiV2: false });

    // ─── À l'ÉDITION d'un panneau encore en V1 : même règle. ───
    const editeV1 = await panneauEcrit(lignePresentation({ panelComponents: 'V1' }), { id: '430000000000000001' });
    const editeV2 = await panneauEcrit(lignePresentation({ panelComponents: 'V2' }), { id: '430000000000000002' });
    expect({ ecritV1: editeV1.ecrit, ecritV2: editeV2.ecrit }).toEqual({ ecritV1: true, ecritV2: true });
    expect({ editionV1: porteLaMarque(editeV1.charge), editionV2: porteLaMarque(editeV2.charge) })
      .toEqual({ editionV1: true, editionV2: false });
    tempChannels.delete('430000000000000001');
    tempChannels.delete('430000000000000002');

    // ─── Et AUCUN autre message du module, même quand V1 est réglé. ───
    // La marque ne vaut que pour le panneau public. `patchV2` ne la retire PAS
    // (délibérément : une charge envoyée puis éditée doit rester en V1), donc un
    // éphémère marqué changerait de rendu sans que personne ne l'ait demandé.
    const id = '430000000000000003';
    const seul = await panneauEcrit(lignePresentation({ panelComponents: 'V1' }), { id });
    expect(porteLaMarque(seul.charge)).toBe(true);
    const autres = [
      ...(await cliquer(seul.ecouteurs, seul.channel, 'salon')),
      ...(await cliquer(seul.ecouteurs, seul.channel, 'membres')),
      ...(await cliquer(seul.ecouteurs, seul.channel, 'propriete')),
    ];
    expect(autres.length).toBeGreaterThan(0);
    expect(autres.filter(porteLaMarque)).toEqual([]);
    tempChannels.delete(id);
  }, 120_000);

  test('T15 — V1 demandé sur un message déjà en Components V2 : charge intacte, un seul avertissement, qui ressort après oubli du salon', async () => {
    // Le drapeau IsComponentsV2 ne se RETIRE pas d'un message existant : tenter
    // l'édition en V1 la ferait refuser et le panneau resterait figé sur un état
    // périmé. On garde donc V2 pour CE message — mais on le dit, une fois par
    // salon, parce que le panneau se réécrit en rafale.
    const id = '430000000000000004';
    avertissements.length = 0;
    const { panneau, channel, ecouteurs, ecrit } = await panneauEcrit(
      lignePresentation({ panelComponents: 'V1' }),
      { id, estV2: true },
    );
    expect(ecrit).toBe(true);

    // Le comptage porte sur l'identifiant du salon et sur le nom du drapeau de
    // l'API Discord, jamais sur la phrase : ce panneau se traduit, `IsComponentsV2`
    // non. Un test accroché au français se casserait à la première traduction
    // sans que rien ne soit réellement régressé.
    const compteAvertissements = () =>
      avertissements.filter((m) => m.includes(id) && /Components ?V2/.test(m)).length;

    // La charge repart telle quelle : ni marque, ni drapeau retiré.
    expect(porteLaMarque(panneau.charges[0])).toBe(false);
    expect(compteAvertissements()).toBe(1);

    // Deuxième réécriture du MÊME salon : rien de plus dans les journaux.
    await rejouerEntree(ecouteurs, channel, OWNER);
    expect(await jusqua(() => panneau.charges.length >= 2)).toBe(true);
    expect(porteLaMarque(panneau.charges[1])).toBe(false);
    expect(compteAvertissements()).toBe(1);

    // Le salon meurt : `oublierSalon` doit effacer sa marque de signalement,
    // sinon un salon recréé plus tard au même identifiant resterait muet.
    channel.members.clear();
    await ecouteurs.get(Events.VoiceStateUpdate)?.(
      { channelId: id, channel },
      { channelId: null, channel: null, guild: channel.guild, member: fauxMembre(OWNER) },
    );
    expect(channel.delete).toHaveBeenCalled();
    expect(tempChannels.has(id)).toBe(false);

    // Un salon de nouveau vivant au même identifiant : l'avertissement ressort.
    tempChannels.set(id, { creatorId: OWNER, panneauId: panneau.message.id });
    channel.members.set(OWNER, fauxMembre(OWNER));
    await rejouerEntree(ecouteurs, channel, OWNER);
    expect(await jusqua(() => panneau.charges.length >= 3)).toBe(true);
    expect(compteAvertissements()).toBe(2);
    tempChannels.delete(id);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T16 & T17 — ce que le mode FLAT promet
// ═══════════════════════════════════════════════════════════════════════════

describe('T16/T17 — mode FLAT : pas de recherche dans le serveur', () => {
  test('T16 — aucun UserSelect atteignable depuis le panneau public, chemin « Propriété → Transférer » compris', async () => {
    // La promesse est écrite au-dessus de `rangeesPlates` : « AUCUN
    // `UserSelectMenu` ici : pas de recherche dans le serveur, les actions ne
    // visent que les présents ». Elle ne tient que si on la suit jusqu'au bout :
    // le panneau public porte un bouton « Propriété », qui ouvre un bouton
    // « Transférer le salon », qui ouvre un sélecteur de personne. Un test qui
    // s'arrêterait aux rangées plates validerait la promesse sans l'avoir suivie.
    const id = '440000000000000001';
    const { charge, channel, ecouteurs, ecrit } = await panneauEcrit(
      lignePresentation({ panelMode: 'FLAT' }),
      { id, presents: [OWNER, PRESENT] },
    );
    expect(ecrit).toBe(true);

    const atteignables = composantsDe(
      charge,
      await cliquer(ecouteurs, channel, 'propriete'),
      await cliquer(ecouteurs, channel, 'transfer'),
    );
    // Le harnais doit avoir vu quelque chose, sinon l'absence d'UserSelect ne
    // prouverait que l'absence de composants.
    expect(atteignables.length).toBeGreaterThan(3);

    const recherches = atteignables
      .filter((c) => c.type === ComponentType.UserSelect)
      .map((c) => String(c.custom_id));
    expect(recherches).toEqual([]);

    // Le sélecteur de transfert doit avoir été ATTEINT, et être un menu
    // d'options — sinon « aucun UserSelect » serait vrai faute d'avoir cliqué.
    // C'est cette assertion-ci qui échoue sur le code d'avant le correctif :
    // `tempvoice:transfer_select` y était un `UserSelectMenuBuilder` (type 5).
    const transfert = atteignables.find((c) => c.custom_id === 'tempvoice:transfer_select');
    expect(transfert?.type).toBe(ComponentType.StringSelect);
    expect(((transfert?.options ?? []) as Array<{ value?: string }>).length).toBeGreaterThan(0);
    tempChannels.delete(id);
  }, 60_000);

  test('T17 — repli MEMBERS : le choix des personnes est borné aux PRÉSENTS', async () => {
    // `reservationFallbackMode = MEMBERS` ouvre aujourd'hui un `UserSelectMenu`,
    // qui cherche dans TOUT le serveur. En mode FLAT c'est l'exact contraire de
    // ce que le panneau annonce. Deux issues acceptables : borner le sélecteur
    // aux présents (ce que ce test exige), ou assumer la recherche — et alors
    // c'est l'aide du mode FLAT qui doit cesser de promettre le contraire.
    const id = '440000000000000002';
    const presents = [OWNER, PRESENT];
    const { channel, ecouteurs, ecrit } = await panneauEcrit(
      lignePresentation({
        panelMode: 'FLAT',
        reservationFallbackMode: 'MEMBERS',
        reservableRoleIds: [ROLE_RESERVABLE],
      }),
      { id, presents },
    );
    expect(ecrit).toBe(true);

    const reponses = await cliquer(ecouteurs, channel, 'reserve');
    const choix = composantsDe(reponses)
      .filter((c) => String(c.custom_id ?? '').startsWith('tempvoice:reserve'));
    // Le repli MEMBERS doit bien proposer quelque chose : sans composant, le
    // bouton « Réserver » ne ferait rien et le test serait vert pour rien.
    expect(choix.length).toBeGreaterThan(0);
    // Le composant est nommé, pour que l'assertion porte sur CE sélecteur et pas
    // sur un autre qui traînerait dans la réponse. Sur le code d'avant le
    // correctif, `tempvoice:reserve_membres` était un `UserSelectMenuBuilder`.
    expect(choix.map((c) => String(c.custom_id))).toContain('tempvoice:reserve_membres');
    expect(choix.filter((c) => c.type === ComponentType.UserSelect)).toEqual([]);

    // Et ce qui est proposé ne sort pas du salon.
    const proposes = choix.flatMap((c) => ((c.options ?? []) as Array<{ value?: string }>)
      .map((o) => String(o.value)));
    expect(proposes.length).toBeGreaterThan(0);
    expect(proposes.filter((v) => !presents.includes(v))).toEqual([]);
    tempChannels.delete(id);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// T18 — un réglage par serveur, et rien qui fuite d'un serveur à l'autre
// ═══════════════════════════════════════════════════════════════════════════

describe('T18 — isolation par serveur', () => {
  test('T18 — deux serveurs, deux présentations : chacun rend la sienne, dans les deux sens', async () => {
    // `TempVoiceModPermissionsConfig` a `guildId String @id` : un enregistrement
    // par serveur. La base le garantit, la mémoire non — une mémoïsation de
    // module (cache de présentation, variable de fichier) servirait au second
    // serveur la présentation du premier, et personne ne s'en apercevrait tant
    // que les deux serveurs ne sont pas réglés différemment.
    const sobre = lignePresentation({ guildId: GUILD, panelMode: 'CLASSIC', stateLayout: 'GRID3', stateColors: 'NEUTRAL' });
    const charge = lignePresentation({ guildId: GUILD_B, panelMode: 'FLAT', stateLayout: 'CARDS', stateColors: 'DARK' });

    const a = await panneauEcrit(sobre, { id: '450000000000000001', guildId: GUILD, presents: [OWNER, PRESENT] });
    const b = await panneauEcrit(charge, { id: '450000000000000002', guildId: GUILD_B, presents: [OWNER, PRESENT] });
    // Relu APRÈS l'autre : c'est l'ordre qui révèle une mémoïsation.
    const aApresB = await panneauEcrit(sobre, { id: '450000000000000003', guildId: GUILD, presents: [OWNER, PRESENT] });
    const bApresA = await panneauEcrit(charge, { id: '450000000000000004', guildId: GUILD_B, presents: [OWNER, PRESENT] });

    for (const [nom, lu] of [['A', a], ['A après B', aApresB]] as const) {
      expect({ nom, image: 'files' in (lu.charge ?? {}), rangees: (lu.charge?.components as unknown[])?.length })
        .toEqual({ nom, image: false, rangees: 1 });
    }
    for (const [nom, lu] of [['B', b], ['B après A', bApresA]] as const) {
      expect({ nom, image: 'files' in (lu.charge ?? {}) }).toEqual({ nom, image: true });
      // FLAT empile plusieurs rangées : une seule signalerait le panneau CLASSIC.
      expect((lu.charge?.components as unknown[])?.length).toBeGreaterThan(1);
    }

    for (const id of ['450000000000000001', '450000000000000002', '450000000000000003', '450000000000000004']) {
      tempChannels.delete(id);
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Héritage de la présentation par générateur, derrière son interrupteur
//
// Ce qui compte ici n'est pas qu'une surcharge s'applique — c'est que
// `perGeneratorPresentation` soit une vraie sortie de secours : coupé, il doit
// ramener le serveur à son rendu d'avant SANS effacer les surcharges, et sans
// qu'aucune d'elles ne soit même lue. Un test qui ne vérifierait que le cas
// « allumé » laisserait passer un interrupteur qui ne coupe rien.
//
// Les quatre derniers tests ne touchent pas aux fonctions pures : ils font
// écrire un vrai panneau par l'écouteur (même harnais que le reste du fichier)
// et regardent la charge réellement envoyée à Discord. `presentationDuSalon` est
// privée à `events/tempVoice.ts` ; la réimplémenter ne prouverait rien.
// ─────────────────────────────────────────────────────────────────────────────

/** Le générateur additionnel qui surcharge, et le principal qui ne surcharge rien. */
const GEN_PRINCIPAL = '400000000000000001';
const GEN_ADDITIONNEL = '400000000000000002';

/** Le serveur en CLASSIC : un générateur qui n'impose rien doit l'y laisser. */
const SERVEUR_CLASSIC = normaliserReglagesPresentation(lignePresentation());

function configAvecGenerateurs(generateurs: unknown[]): Record<string, unknown> {
  return {
    tempVoiceEnabled: true,
    baseStaffRoleId: null,
    moderatorRoleId: null,
    testStaffRoleId: null,
    tempVoiceChannelId: GEN_PRINCIPAL,
    tempVoiceNameTemplate: DEFAULT_NAME_TEMPLATE,
    tempVoiceGenerators: generateurs,
  };
}

/**
 * Le panneau réellement écrit pour un salon venant d'un générateur donné.
 *
 * Copie assumée de `panneauEcrit` : celui-ci écrase `configsParServeur` avec une
 * configuration SANS générateur, et pose l'entrée mémoire sans `generateurId`.
 * Les deux sont justement ce qu'on veut piloter ici.
 */
async function panneauDuGenerateur(options: {
  id: string;
  ligne: Record<string, unknown> | null;
  generateurs: unknown[];
  generateurId?: string;
}) {
  lignesParServeur.set(GUILD, options.ligne);
  configsParServeur.set(GUILD, configAvecGenerateurs(options.generateurs));

  const panneau = fauxPanneau(false);
  const channel = fauxSalon(options.id, panneau, { presents: [OWNER, PRESENT] });
  // `fauxSalon` vient de poser l'entrée mémoire : on y ajoute d'où vient le
  // salon, ce que `createTempChannel` fait en vrai depuis `generator.channelId`.
  const entree = tempChannels.get(options.id);
  if (entree && options.generateurId) entree.generateurId = options.generateurId;

  const { client, ecouteurs } = fauxClient();
  registerTempVoiceListener(client);
  await rejouerEntree(ecouteurs, channel);
  const ecrit = await jusqua(() => panneau.charges.length > 0);
  if (!ecrit) console.warn(`[T] aucune charge écrite pour ${options.id} :`, avertissements.slice(-3));

  tempChannels.delete(options.id);
  const charge = panneau.charges[0];
  return {
    ecrit,
    // FLAT empile plusieurs rangées, CLASSIC n'en pose qu'une : c'est la marque
    // la moins ambiguë de la présentation réellement appliquée.
    rangees: (charge?.components as unknown[] | undefined)?.length ?? 0,
  };
}

describe("l'interrupteur perGeneratorPresentation", () => {
  test('coupé, il rend le réglage du serveur TEL QUEL, sans lire une seule surcharge', () => {
    // Un générateur qui surcharge les cinq champs, pour qu'un héritage qui
    // fuirait se voie immédiatement.
    const generateur = {
      surchargesPresentation: {
        mode: 'FLAT', disposition: 'CARDS', teinte: 'DARK',
        composants: 'V1', repliReservation: 'FORBIDDEN',
      },
    } as const;

    const rendu = presentationPourGenerateur(SERVEUR_CLASSIC, generateur, false);
    expect(rendu).toEqual(SERVEUR_CLASSIC);
    // Même référence : la fonction n'a rien recomposé, donc rien n'a été lu.
    expect(rendu).toBe(SERVEUR_CLASSIC);
  });

  test('allumé, chaque surcharge sapplique et le reste hérite du serveur', () => {
    const rendu = presentationPourGenerateur(
      SERVEUR_CLASSIC,
      { surchargesPresentation: { mode: 'FLAT', teinte: 'DARK' } },
      true,
    );
    expect(rendu).toEqual({
      mode: 'FLAT',
      teinte: 'DARK',
      // Les trois non surchargés viennent du SERVEUR, pas d'un défaut recalculé.
      disposition: SERVEUR_CLASSIC.disposition,
      composants: SERVEUR_CLASSIC.composants,
      repliReservation: SERVEUR_CLASSIC.repliReservation,
    });
  });

  test('le couper puis le rallumer rend exactement les mêmes surcharges', () => {
    const generateur = { surchargesPresentation: { mode: 'FLAT' as const } };

    const allume = presentationPourGenerateur(SERVEUR_CLASSIC, generateur, true);
    const coupe = presentationPourGenerateur(SERVEUR_CLASSIC, generateur, false);
    const rallume = presentationPourGenerateur(SERVEUR_CLASSIC, generateur, true);

    expect(coupe.mode).toBe(SERVEUR_CLASSIC.mode);
    // Couper IGNORE, n'EFFACE PAS : la surcharge est intacte après le passage.
    expect(generateur.surchargesPresentation).toEqual({ mode: 'FLAT' });
    expect(rallume).toEqual(allume);
  });

  test('générateur absent, nul, ou sans surcharge : le réglage du serveur, sans jeter', () => {
    for (const generateur of [null, undefined, {}, { surchargesPresentation: undefined }]) {
      expect(presentationPourGenerateur(SERVEUR_CLASSIC, generateur, true)).toEqual(SERVEUR_CLASSIC);
    }
  });

  test('seul `true` allume : tout le reste vaut le comportement livré', () => {
    const faux: unknown[] = [null, undefined, 42, 'texte', [], {},
      { perGeneratorPresentation: null }, { perGeneratorPresentation: 'true' },
      { perGeneratorPresentation: 1 }];
    for (const raw of faux) expect(presentationParGenerateurActive(raw)).toBe(false);
    expect(presentationParGenerateurActive({ perGeneratorPresentation: true })).toBe(true);
  });
});

describe('les surcharges dans le JSON du générateur', () => {
  test('une clé inconnue est ABSENTE, pas ramenée au défaut du serveur', () => {
    // Le piège : un serveur réglé en FLAT dont le générateur porte un mode
    // fautif. Retomber sur « le défaut » le ramènerait en CLASSIC ; la bonne
    // réponse est d'hériter, donc FLAT.
    const serveurFlat = normaliserReglagesPresentation(lignePresentation({ panelMode: 'FLAT' }));
    const surcharges = lireSurchargesPresentation({ panelMode: 'N_IMPORTE_QUOI', stateColors: 'DARK' });

    expect('mode' in surcharges).toBe(false);
    expect(presentationPourGenerateur(serveurFlat, { surchargesPresentation: surcharges }, true))
      .toEqual({ ...serveurFlat, teinte: 'DARK' });
  });

  test('les deux écritures sont lues, et une absence ne pose jamais de clé', () => {
    expect(lireSurchargesPresentation({
      panelMode: 'FLAT', stateLayout: 'CARDS', stateColors: 'LIGHT',
      panelComponents: 'V1', reservationFallbackMode: 'MEMBERS',
    })).toEqual({
      mode: 'FLAT', disposition: 'CARDS', teinte: 'LIGHT',
      composants: 'V1', repliReservation: 'MEMBERS',
    });
    // Forme applicative acceptée aussi, comme `normaliserReglagesPresentation`.
    expect(lireSurchargesPresentation({ mode: 'FLAT' })).toEqual({ mode: 'FLAT' });
    // `Object.keys` et non `toEqual({})`, qui passerait aussi avec cinq clés à
    // `undefined` — or celles-là écraseraient le réglage du serveur.
    for (const raw of [null, undefined, 42, 'texte', [], {}]) {
      expect(Object.keys(lireSurchargesPresentation(raw))).toEqual([]);
    }
  });

  test('un enregistrement du dashboard ne perd PAS les surcharges déjà posées', () => {
    // Le vrai risque : `normalizeTempVoiceGeneratorsInput` reconstruit un objet
    // neuf et laisse tomber ce qu'il ne nomme pas. Toucher au gabarit de nom
    // d'un générateur effacerait alors sa présentation, sans rien afficher.
    const [stocke] = normalizeTempVoiceGeneratorsInput([{
      channelId: GEN_ADDITIONNEL,
      nameTemplate: 'Salon de {user}',
      panelMode: 'FLAT',
      stateColors: 'DARK',
      panelComponents: 'PAS_UNE_VALEUR',
    }]);

    expect(stocke?.panelMode).toBe('FLAT');
    expect(stocke?.stateColors).toBe('DARK');
    // La valeur hors énumération ne ressort pas : clé absente = hérite.
    expect('panelComponents' in (stocke ?? {})).toBe(false);
    // Et le tour complet redonne ce qui a été écrit.
    expect(ecrireSurchargesPresentation(lireSurchargesPresentation(stocke)))
      .toEqual({ panelMode: 'FLAT', stateColors: 'DARK' });
  });

  test('la résolution porte les surcharges des additionnels, le principal nen a pas', () => {
    const generateurs = resolveTempVoiceGenerators({
      tempVoiceEnabled: true,
      tempVoiceChannelId: GEN_PRINCIPAL,
      tempVoiceCategoryId: null,
      tempVoiceNameTemplate: DEFAULT_NAME_TEMPLATE,
      tempVoiceGenerators: [{ channelId: GEN_ADDITIONNEL, panelMode: 'FLAT' }],
    } as TempVoiceGuildConfig, GUILD);

    const principal = generateurs.find((g) => g.primary);
    const additionnel = generateurs.find((g) => g.channelId === GEN_ADDITIONNEL);

    // Le réglage du serveur EST celui du principal : lui donner des surcharges
    // ferait deux sources pour une seule vérité.
    expect(principal?.surchargesPresentation).toBeUndefined();
    expect(additionnel?.surchargesPresentation).toEqual({ mode: 'FLAT' });
  });
});

describe('le panneau réellement écrit suit son générateur', () => {
  const GENERATEURS = [{ channelId: GEN_ADDITIONNEL, panelMode: 'FLAT' }];

  test('interrupteur COUPÉ : le salon garde le rendu CLASSIC du serveur', async () => {
    const { ecrit, rangees } = await panneauDuGenerateur({
      id: '460000000000000001',
      ligne: lignePresentation({ perGeneratorPresentation: false }),
      generateurs: GENERATEURS,
      generateurId: GEN_ADDITIONNEL,
    });
    expect(ecrit).toBe(true);
    expect(rangees).toBe(1);
  }, 60_000);

  test('interrupteur ALLUMÉ : le même salon passe en FLAT', async () => {
    const { ecrit, rangees } = await panneauDuGenerateur({
      id: '460000000000000002',
      ligne: lignePresentation({ perGeneratorPresentation: true }),
      generateurs: GENERATEURS,
      generateurId: GEN_ADDITIONNEL,
    });
    expect(ecrit).toBe(true);
    // Le seul écart avec le test précédent est l'interrupteur.
    expect(rangees).toBeGreaterThan(1);
  }, 60_000);

  test("allumé mais salon d'avant la colonne : le réglage du serveur, sans erreur", async () => {
    const { ecrit, rangees } = await panneauDuGenerateur({
      id: '460000000000000003',
      ligne: lignePresentation({ perGeneratorPresentation: true }),
      generateurs: GENERATEURS,
      // Pas de `generateurId` : `TempVoiceChannel.generatorChannelId` est nul.
    });
    expect(ecrit).toBe(true);
    expect(rangees).toBe(1);
  }, 60_000);

  test('allumé mais générateur DISPARU de la configuration : le serveur, sans erreur', async () => {
    const { ecrit, rangees } = await panneauDuGenerateur({
      id: '460000000000000004',
      ligne: lignePresentation({ perGeneratorPresentation: true }),
      // Le salon vient d'un générateur que l'administrateur a retiré depuis.
      generateurs: [],
      generateurId: GEN_ADDITIONNEL,
    });
    expect(ecrit).toBe(true);
    expect(rangees).toBe(1);
  }, 60_000);
});
